"""Approval Inbox plugin backend — reads the authoritative agent-mail approval ledger."""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
from collections import deque
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

REPO = os.environ.get("EUPHORIA_REPO", "/home/euphoria/euphoria-v2")
MAIL_HOME = os.environ.get("AGENT_MAIL_HOME", os.path.join(REPO, "work", "mail"))
AGENT_MAIL = os.environ.get("AGENT_MAIL_BIN", os.path.join(MAIL_HOME, "bin", "agent-mail"))
DATA_DIR = os.environ.get("APPROVAL_INBOX_DATA", os.path.join(REPO, "work", "approval-inbox"))
VERSIONS_FILE = os.path.join(DATA_DIR, "approved_versions.jsonl")
FILES_DIR = os.path.join(DATA_DIR, "files")
SPEND_REGISTER = os.path.join(REPO, "work", "finance", "spend-register.jsonl")
HERMES_HOME = os.environ.get("HERMES_HOME", "/home/euphoria/euphoria-v2/.hermes")
TRIGGER_BOARD = os.environ.get("APPROVAL_INBOX_BOARD", "default")

# Attachment policy: what the inbox will carry and show inline.
ALLOWED_TYPES = {
    "image/png", "image/jpeg", "image/webp", "image/gif",
    "video/mp4", "video/webm",
    "application/pdf",
    "text/markdown", "text/html",
}
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_INLINE_BYTES = 8 * 1024 * 1024
MAX_VIDEO_INLINE_BYTES = 20 * 1024 * 1024

# Durable ops log: append-only file in DATA_DIR, plus bounded in-memory cache.
OPLOG_PATH = os.path.join(DATA_DIR, "ops.log")
_OPLOG_INMEM: deque = deque(maxlen=200)


def _oplog(op, status, detail=""):
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "op": op,
        "status": status,
        "detail": (detail or "")[:300],
    }
    _OPLOG_INMEM.append(entry)
    try:
        with open(OPLOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _safe_name(name):
    base = os.path.basename((name or "").strip())
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)[:120]
    return base or "attachment"


def _kind_of(content_type):
    if (content_type or "").startswith("image/"):
        return "image"
    if (content_type or "").startswith("video/"):
        return "video"
    if content_type == "application/pdf":
        return "pdf"
    if content_type in ("text/markdown",):
        return "md"
    if content_type in ("text/html",):
        return "html"
    return "file"

router = APIRouter()


def _ledger_path():
    return os.path.join(MAIL_HOME, "ledger.jsonl")


def _approvals_path():
    return os.path.join(MAIL_HOME, "approvals.jsonl")


def _read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def _parse_meta(body):
    if not body:
        return {}
    m = re.search(r"<!-- approval-inbox:v1\s*(\{.*?\})\s*-->", body, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {}


def _decisions_by_msg():
    d = {}
    for r in _read_jsonl(_approvals_path()):
        d[r.get("msg_id")] = r
    return d


def _msg_files_dir(msg_id):
    return os.path.join(FILES_DIR, re.sub(r"[^A-Za-z0-9._-]", "_", msg_id or "unknown")[:64])


def _within(base, path):
    return os.path.realpath(path).startswith(os.path.realpath(base) + os.sep)


def _sniff(content_type, raw):
    """Magic-byte check so the label matches the bytes, not just the name.

    Strict detectors are kept for images, video and PDF (unchanged):
    png/jpeg/gif are identified by header bytes, mp4/webm by an ftyp box,
    and pdf by the %PDF- magic. Those checks are deliberately not touched.

    text/markdown and text/html are NOT magic-byte gated: a document is
    identified by its payload being valid UTF-8, not by a header. Payloads
    that fail UTF-8 decoding, or that carry NUL bytes (an obvious binary
    signature), are rejected for text types.
    """
    if content_type == "image/png":
        return raw[:8] == b"\x89PNG\r\n\x1a\n"
    if content_type in ("image/jpeg",):
        return raw[:2] == b"\xff\xd8"
    if content_type == "image/gif":
        return raw[:6] in (b"GIF87a", b"GIF89a")
    if content_type == "image/webp":
        return len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    if content_type in ("video/mp4", "video/webm"):
        return len(raw) >= 12 and (raw[4:8] == b"ftyp" or raw[:4] == b"\x1a\x45\xdf\xa3")
    if content_type == "application/pdf":
        return raw[:5] == b"%PDF-"
    if content_type in ("text/markdown", "text/html"):
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            return False
        # A text document cannot contain NUL bytes; their presence is an
        # obvious binary signature.
        return b"\x00" not in raw
    return False


def _attachments_manifest(msg_id):
    d = _msg_files_dir(msg_id)
    if not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        if name == "manifest.json":
            continue
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            continue
        out.append({"name": name, "size": os.path.getsize(p),
                    "content_type": _guess_type(name),
                    "kind": _kind_of(_guess_type(name))})
    return out


def _guess_type(name):
    low = (name or "").lower()
    if low.endswith(".png"):
        return "image/png"
    if low.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if low.endswith(".webp"):
        return "image/webp"
    if low.endswith(".gif"):
        return "image/gif"
    if low.endswith(".mp4"):
        return "video/mp4"
    if low.endswith(".webm"):
        return "video/webm"
    if low.endswith(".pdf"):
        return "application/pdf"
    if low.endswith(".md"):
        return "text/markdown"
    if low.endswith(".html"):
        return "text/html"
    return "application/octet-stream"


def _store_attachments(msg_id, attachments):
    total = 0
    stored = []
    for a in attachments or []:
        name = _safe_name(a.get("name"))
        ctype = (a.get("content_type") or _guess_type(name)).split(";")[0].strip()
        if ctype not in ALLOWED_TYPES:
            raise HTTPException(status_code=400, detail=f"attachment type not allowed: {ctype}")
        b64 = a.get("data_b64") or ""
        if len(b64) > (MAX_TOTAL_BYTES * 4 // 3) + 1024:
            raise HTTPException(status_code=400, detail=f"attachment too large: {name}")
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail=f"attachment is not valid base64: {name}")
        if len(raw) > MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail=f"attachment too large (max 15MB): {name}")
        if not _sniff(ctype, raw):
            raise HTTPException(status_code=400, detail=f"attachment bytes do not match {ctype}: {name}")
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(status_code=400, detail="attachments exceed 30MB total")
        d = _msg_files_dir(msg_id)
        os.makedirs(d, exist_ok=True)
        dest = os.path.join(d, name)
        if not _within(d, dest):
            raise HTTPException(status_code=400, detail="bad attachment name")
        with open(dest, "wb") as fh:
            fh.write(raw)
        stored.append({"name": name, "size": len(raw), "content_type": ctype,
                       "kind": _kind_of(ctype),
                       "sha256": hashlib.sha256(raw).hexdigest()})
    return stored


def _pdf_thumb(pdf_path):
    """First-page PNG thumbnail bytes, or None when rendering is unavailable."""
    try:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "thumb")
            proc = subprocess.run(["pdftoppm", "-png", "-f", "1", "-l", "1",
                                   "-singlefile", "-r", "72", pdf_path, out],
                                  capture_output=True, timeout=30)
            if proc.returncode != 0:
                return None, 0
            with open(out + ".png", "rb") as fh:
                data = fh.read()
            pages = 0
            info = subprocess.run(["pdfinfo", pdf_path], capture_output=True,
                                  text=True, timeout=15)
            m = re.search(r"Pages:\s+(\d+)", info.stdout or "")
            if m:
                pages = int(m.group(1))
            return data, pages
    except Exception:
        return None, 0


def _resolve_actor(request):
    gw = (request.headers.get("x-hermes-user") or "").strip()[:64] if request is not None else ""
    if gw:
        return gw, "gateway"
    return "default", "default"


_HERMES_BIN_CANDIDATES = [
    "/home/euphoria/.local/bin/hermes",
    "/home/euphoria/euphoria-v2/apps/hermes/source-v2026.8.27/.hermes/bin/hermes",
]


def _resolve_hermes_bin():
    """Absolute hermes binary for the trigger subprocess.

    The dashboard serve child runs with a minimal PATH (no user bin dirs),
    so a bare `hermes` dies with FileNotFoundError and the Founder's tap
    ends at the ledger — live-proven 2026-10-27 (two decided cards, zero
    kanban tasks). Resolve once per call; fall back to known install paths.
    """
    found = shutil.which("hermes")
    if found and os.path.isfile(found) and os.access(found, os.X_OK):
        return found
    for cand in _HERMES_BIN_CANDIDATES:
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def _extract_task_id(text):
    m = re.search(r"t_[0-9a-f]{6,}", text or "")
    return m.group(0) if m else (text or "").strip()[:200]


def _trigger_default(decision, req, note, actor):
    """Wake the default agent with the Founder's verdict (exactly-once per msg)."""
    if os.environ.get("APPROVAL_INBOX_NO_TRIGGER") == "1":
        return {"triggered": False, "reason": "disabled by env"}
    hermes_bin = _resolve_hermes_bin()
    if not hermes_bin:
        _oplog("trigger", "failed", "hermes binary not found (PATH + fallbacks)")
        return {"triggered": False,
                "reason": "hermes binary not found on this host — task not created"}
    art = req.get("artifact") or {}
    packet = "\n".join([
        f"Founder decision: {decision.upper()}",
        f"msg_id: {req.get('msg_id')}",
        f"work_id: {req.get('work_id') or '-'}",
        f"subject: {req.get('subject') or '-'}",
        f"artifact: {art.get('name') or '-'} v{art.get('version') or '?'}",
        f"next_action: {req.get('next_action') or '-'}",
        f"note: {note or '(no note)'}",
        f"decided_by: {actor}",
        "Carry out the routing: on approve, perform exactly the next action shown; "
        "on reject, stop that action and relay the reason to the owning agent.",
    ])
    title = f"[{'APPROVED' if decision == 'approve' else 'REJECTED'}] {req.get('subject') or req.get('msg_id')}"
    try:
        env = dict(os.environ)
        env.setdefault("HERMES_HOME", HERMES_HOME)
        # The serve child PATH lacks user bin dirs — make sure the resolved
        # binary's directory survives into the child environment too.
        bindir = os.path.dirname(hermes_bin)
        if bindir and bindir not in env.get("PATH", "").split(os.pathsep):
            env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
        proc = subprocess.run(
            [hermes_bin, "kanban", "--board", TRIGGER_BOARD, "create",
             "--assignee", "default",
             "--idempotency-key", f"approval-{req.get('msg_id')}",
             "--body", packet, title],
            capture_output=True, text=True, env=env, timeout=60)
        if proc.returncode != 0:
            _oplog("trigger", "failed", (proc.stderr or "")[:200])
            return {"triggered": False,
                    "hermes_bin": hermes_bin,
                    "reason": (proc.stderr or "kanban create failed")[:200]}
        task_id = _extract_task_id(proc.stdout)
        _oplog("trigger", decision, req.get("msg_id") or "")
        # A created task still sits in todo until something dispatches it —
        # no daemon watches this board, so run a bounded one-shot dispatch
        # tick. Dispatch trouble is reported, never voids the decision.
        dispatch = {"attempted": True, "ok": False, "detail": "not attempted"}
        try:
            dproc = subprocess.run(
                [hermes_bin, "kanban", "--board", TRIGGER_BOARD,
                 "dispatch", "--max", "1"],
                capture_output=True, text=True, env=env, timeout=120)
            detail = ((dproc.stdout or "") + " " + (dproc.stderr or "")).strip()
            dispatch = {"attempted": True,
                        "ok": dproc.returncode == 0,
                        "detail": detail[:200] or f"exit={dproc.returncode}"}
            _oplog("dispatch", "ok" if dproc.returncode == 0 else "failed",
                   f"{task_id} {dispatch['detail'][:120]}")
        except Exception as e:
            dispatch = {"attempted": True, "ok": False,
                        "detail": str(e)[:200]}
            _oplog("dispatch", "error", str(e)[:200])
        return {"triggered": True, "task": task_id, "hermes_bin": hermes_bin,
                "dispatch": dispatch}
    except Exception as e:
        _oplog("trigger", "error", str(e)[:200])
        return {"triggered": False, "reason": str(e)[:200]}


def _requests():
    items = []
    for rec in _read_jsonl(_ledger_path()):
        if rec.get("kind") != "approval":
            continue
        if "founder" not in (rec.get("to") or []):
            continue
        meta = _parse_meta(rec.get("body", ""))
        decisions = _decisions_by_msg()
        dec = decisions.get(rec.get("msg_id"))
        status = "pending"
        if dec:
            status = dec.get("decision", "decided")
        art = meta.get("artifact") or {}
        items.append({
            "msg_id": rec.get("msg_id"),
            "ts": rec.get("ts"),
            "type": meta.get("type", "artifact"),
            "owner": meta.get("owner", rec.get("from")),
            "originating_agent": rec.get("from"),
            "work_id": meta.get("work_id", rec.get("task_id")),
            "subject": rec.get("subject"),
            "artifact": {
                "name": art.get("name"),
                "version": art.get("version"),
                "hash": art.get("hash"),
                "preview_url": art.get("preview_url") or meta.get("preview_url"),
            },
            "preview_url": art.get("preview_url") or meta.get("preview_url"),
            "attachments": _attachments_manifest(rec.get("msg_id") or ""),
            "next_action": meta.get("next_action"),
            "status": status,
            "decision": dec,
        })
    return items


def _run_agent_mail(args):
    env = dict(os.environ)
    env.setdefault("EUPHORIA_REPO", REPO)
    env.setdefault("AGENT_MAIL_HOME", MAIL_HOME)
    proc = subprocess.run([AGENT_MAIL] + args, capture_output=True, text=True, env=env)
    return proc.returncode, (proc.stdout or "").strip(), (proc.stderr or "").strip()


def _extract_msg_id(stdout):
    for token in stdout.split():
        if token.startswith("m") and "--" not in token:
            # msg ids like m20260927-134030
            if re.fullmatch(r"m\d{8}-\d{6}(?:-\d+)?", token):
                return token
    m = re.search(r"(m\d{8}-\d{6}(?:-\d+)?)", stdout)
    return m.group(1) if m else None


class SubmitPayload(BaseModel):
    type: str = "artifact"
    owner: str = "default"
    work_id: Optional[str] = None
    subject: Optional[str] = None
    artifact: dict = {}
    preview_url: Optional[str] = None
    next_action: str = "approve"
    attachments: list = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)


@router.get("/health")
def health():
    return {"ok": True, "mail_home": MAIL_HOME}


@router.get("/items")
def items(status: str = "all"):
    out = _requests()
    if status and status != "all":
        out = [x for x in out if x["status"] == status]
    return {"items": out, "count": len(out)}


@router.post("/submit")
def submit(payload: SubmitPayload):
    art = payload.artifact or {}
    preview = payload.preview_url or art.get("preview_url")
    meta = {
        "type": payload.type,
        "owner": payload.owner,
        "work_id": payload.work_id,
        "preview_url": preview,
        "next_action": payload.next_action,
        "artifact": {
            "name": art.get("name"),
            "version": art.get("version"),
            "hash": art.get("hash"),
            "preview_url": preview,
        },
    }
    body = (
        f"Approval request ({payload.type})\n"
        f"Owner: {payload.owner}\n"
        f"Work: {payload.work_id}\n"
        f"Artifact: {art.get('name')} v{art.get('version')}\n"
        f"Next action: {payload.next_action}\n\n"
        f"<!-- approval-inbox:v1 {json.dumps(meta)} -->\n"
    )
    subject = payload.subject or f"Approve {payload.type}: {art.get('name')} v{art.get('version')}"
    work_id = payload.work_id or "-"
    rc, out, err = _run_agent_mail([
        "send", "--from", "default", "--to", "founder",
        "--kind", "approval", "--task-id", str(work_id),
        "--subject", subject, "--body", body,
        "--recipient-name", "R Hus (Founder)",
    ])
    if rc != 0:
        # Local delivery may still have succeeded (ledger has the request)
        # while only the external OAE copy failed. The inbox runs on the
        # local ledger, so a locally-delivered request must not 500:
        # store its files, warn loudly, and let the Founder decide.
        maybe_id = _extract_msg_id(out)
        if maybe_id and any(r.get("msg_id") == maybe_id for r in _read_jsonl(_ledger_path())):
            stored = _store_attachments(maybe_id, payload.attachments or [])
            _oplog("submit", "ok-oae-failed", f"{maybe_id} +{len(stored)} files; {err[:120]}")
            return {"ok": True, "msg_id": maybe_id, "stdout": out,
                    "attachments": stored,
                    "oae_warning": (err or "external copy failed")[:300]}
        _oplog("submit", "failed", err[:200])
        raise HTTPException(status_code=500, detail={"rc": rc, "stderr": err, "stdout": out})
    msg_id = _extract_msg_id(out)
    stored = _store_attachments(msg_id or "", payload.attachments or [])
    _oplog("submit", "ok", f"{msg_id} +{len(stored)} files")
    return {"ok": True, "msg_id": msg_id, "stdout": out, "attachments": stored}


class DecidePayload(BaseModel):
    msg_id: str
    decision: str
    note: str = Field(default="", max_length=500)
    artifact_version: Optional[str] = None


@router.get("/ops/log")
def ops_log(limit: int = Query(50, le=200)):
    """Most recent write/error entries. Reads are never logged (noise)."""
    entries = []
    # Load durable disk log first
    try:
        if os.path.exists(OPLOG_PATH):
            with open(OPLOG_PATH, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except Exception:
                        continue
    except Exception:
        pass
    # Append in-memory entries (may overlap disk; dedupe by ts+op+detail)
    seen = {(e.get("ts"), e.get("op"), e.get("detail")) for e in entries}
    for e in _OPLOG_INMEM:
        key = (e.get("ts"), e.get("op"), e.get("detail"))
        if key not in seen:
            entries.append(e)
            seen.add(key)
    return {"entries": entries[-limit:], "n": len(entries)}


@router.get("/files/{msg_id}/{name}")
def serve_file(msg_id: str, name: str):
    safe_msg = re.sub(r"[^A-Za-z0-9._-]", "_", msg_id or "")[:64]
    safe_name = _safe_name(name)
    if safe_name != name:
        raise HTTPException(status_code=404, detail="not found")
    path = os.path.join(FILES_DIR, safe_msg, safe_name)
    if not _within(FILES_DIR, path) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type=_guess_type(safe_name), filename=safe_name)


@router.get("/preview/{msg_id}")
def preview(msg_id: str):
    """Inline preview packet: data URLs the renderer can use directly in
    <img>/<video>/<embed> (rest() is JSON-only, so bytes travel as data URLs)."""
    items = []
    for a in _attachments_manifest(msg_id):
        path = os.path.join(_msg_files_dir(msg_id), a["name"])
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        entry = {"name": a["name"], "content_type": a["content_type"],
                 "kind": a["kind"], "size": size, "data_url": None,
                 "thumb_url": None, "pages": 0}
        cap = MAX_VIDEO_INLINE_BYTES if a["kind"] == "video" else MAX_INLINE_BYTES
        try:
            with open(path, "rb") as fh:
                raw = fh.read(cap + 1)
            if len(raw) <= cap:
                entry["data_url"] = ("data:%s;base64,%s"
                                     % (a["content_type"],
                                        base64.b64encode(raw).decode("ascii")))
            if a["kind"] == "pdf":
                thumb, pages = _pdf_thumb(path)
                entry["pages"] = pages
                if thumb:
                    entry["thumb_url"] = ("data:image/png;base64,"
                                          + base64.b64encode(thumb).decode("ascii"))
        except OSError:
            pass
        items.append(entry)
    return {"msg_id": msg_id, "items": items, "count": len(items)}


@router.post("/decide")
def decide(payload: DecidePayload, request: Request):
    if payload.decision not in ("approve", "reject"):
        _oplog("decide", "rejected-bad-decision", payload.decision[:50])
        raise HTTPException(status_code=400, detail="decision must be approve or reject")
    # find request
    req = next((x for x in _requests() if x["msg_id"] == payload.msg_id), None)
    if req is None:
        _oplog("decide", "rejected-unknown", payload.msg_id[:50])
        raise HTTPException(status_code=404, detail="request not found")
    if req["status"] != "pending":
        _oplog("decide", "rejected-decided", payload.msg_id[:50])
        raise HTTPException(status_code=409, detail="already decided")
    req_version = (req.get("artifact") or {}).get("version")
    if payload.decision == "approve":
        if payload.artifact_version is not None and req_version is not None and payload.artifact_version != req_version:
            _oplog("decide", "rejected-version", payload.msg_id[:50])
            raise HTTPException(status_code=409, detail="artifact version changed; approval invalid")
    actor, actor_source = _resolve_actor(request)
    rc, out, err = _run_agent_mail([
        "approve", "--msg-id", payload.msg_id, "--decision", payload.decision,
        "--note", payload.note or "", "--task-id", str(req.get("work_id") or "-"),
    ])
    if rc != 0:
        combined = f"{err}\n{out}"
        if "already decided" in combined:
            _oplog("decide", "rejected-decided", payload.msg_id[:50])
            raise HTTPException(status_code=409, detail="already decided")
        _oplog("decide", "failed", (err or "")[:200])
        raise HTTPException(status_code=500, detail={"rc": rc, "error": (err or "decision failed")[:200]})
    _oplog("decide", payload.decision, f"{payload.msg_id} by {actor}({actor_source})")
    # record approved version sidecar (plugin metadata, not business canon)
    if payload.decision == "approve":
        os.makedirs(DATA_DIR, exist_ok=True)
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "msg_id": payload.msg_id,
            "work_id": req.get("work_id"),
            "artifact": req.get("artifact"),
            "next_action": req.get("next_action"),
            "actor": actor,
            "actor_source": actor_source,
            "authorized": True,
        }
        with open(VERSIONS_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        # spend register: write spend entry when metadata.spend_usd is present
        spend_usd = (req.get("metadata") or {}).get("spend_usd")
        if spend_usd is not None:
            try:
                os.makedirs(os.path.dirname(SPEND_REGISTER), exist_ok=True)
                month = datetime.now(timezone.utc).strftime("%Y-%m")
                # read current balance for the month
                balance = 0.0
                if os.path.exists(SPEND_REGISTER):
                    with open(SPEND_REGISTER, "r", encoding="utf-8") as fh:
                        for line in fh:
                            line = line.strip()
                            if not line:
                                continue
                            row = json.loads(line)
                            if row.get("month") == month and row.get("entry_type") in ("spend", "refund", "adjustment", "ceiling_update"):
                                if row.get("entry_type") == "ceiling_update":
                                    balance = float(row.get("balance_usd", 0.0))
                                else:
                                    balance += float(row.get("amount_usd", 0.0))
                amount = float(spend_usd)
                spend_rec = {
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "entry_type": "spend",
                    "month": month,
                    "amount_usd": amount,
                    "balance_usd": round(balance + amount, 4),
                    "ceiling_usd": 22.0,
                    "description": f"Approved spend via {req.get('next_action') or req.get('work_id')}",
                    "vendor": (req.get("artifact") or {}).get("name"),
                    "approval_refs": [payload.msg_id, req.get("work_id")],
                    "evidence_paths": [],
                    "actor": actor,
                    "note": f"Auto-recorded from approval {payload.msg_id}",
                }
                with open(SPEND_REGISTER, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(spend_rec, ensure_ascii=False) + "\n")
                _oplog("decide", "spend-register", f"{payload.msg_id} ${amount:.2f}")
            except Exception as exc:  # pragma: no cover - never block approval on ledger failure
                _oplog("decide", "spend-register-failed", str(exc)[:200])
    # Wake the default agent with the verdict — the decision must travel,
    # not just sit in the ledger. A trigger failure never voids the decision.
    trigger = _trigger_default(payload.decision, req, payload.note, actor)
    return {"ok": True, "msg_id": payload.msg_id, "decision": payload.decision,
            "actor": actor, "actor_source": actor_source,
            "stdout": out, "trigger": trigger}
