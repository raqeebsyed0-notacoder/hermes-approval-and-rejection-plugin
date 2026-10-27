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
HERMES_HOME = os.environ.get("HERMES_HOME", "/home/euphoria/euphoria-v2/.hermes")
TRIGGER_BOARD = os.environ.get("APPROVAL_INBOX_BOARD", "default")

# Attachment policy: what the inbox will carry and show inline.
ALLOWED_TYPES = {
    "image/png", "image/jpeg", "image/webp", "image/gif",
    "video/mp4", "video/webm",
    "application/pdf",
}
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_INLINE_BYTES = 8 * 1024 * 1024
MAX_VIDEO_INLINE_BYTES = 20 * 1024 * 1024

# Bounded in-memory ops log: writes and errors only, never reads.
OPLOG: deque = deque(maxlen=200)


def _oplog(op, status, detail=""):
    OPLOG.append({"ts": datetime.now(timezone.utc).isoformat(),
                  "op": op, "status": status, "detail": (detail or "")[:300]})


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
    return "application/octet-stream"


def _store_attachments(msg_id, attachments):
    total = 0
    stored = []
    for a in attachments or []:
        name = _safe_name(a.get("name"))
        ctype = (a.get("content_type") or _guess_type(name)).split(";")[0].strip()
        if ctype not in ALLOWED_TYPES:
            raise HTTPException(status_code=400, detail=f"attachment type not allowed: {ctype}")
        try:
            raw = base64.b64decode(a.get("data_b64") or "", validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail=f"attachment is not valid base64: {name}")
        if len(raw) > MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail=f"attachment too large (max 15MB): {name}")
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise HTTPException(status_code=400, detail="attachments exceed 30MB total")
        d = _msg_files_dir(msg_id)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "wb") as fh:
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


def _trigger_default(decision, req, note, actor):
    """Wake the default agent with the Founder's verdict (exactly-once per msg)."""
    if os.environ.get("APPROVAL_INBOX_NO_TRIGGER") == "1":
        return {"triggered": False, "reason": "disabled by env"}
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
        proc = subprocess.run(
            ["hermes", "kanban", "--board", TRIGGER_BOARD, "create",
             "--assignee", "default",
             "--idempotency-key", f"approval-{req.get('msg_id')}",
             "--body", packet, title],
            capture_output=True, text=True, env=env, timeout=60)
        if proc.returncode != 0:
            _oplog("trigger", "failed", (proc.stderr or "")[:200])
            return {"triggered": False, "reason": (proc.stderr or "kanban create failed")[:200]}
        _oplog("trigger", decision, req.get("msg_id") or "")
        return {"triggered": True, "task": (proc.stdout or "").strip()[:200]}
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
    return {"entries": list(OPLOG)[-limit:], "n": len(OPLOG)}


@router.get("/files/{msg_id}/{name}")
def serve_file(msg_id: str, name: str):
    safe_msg = re.sub(r"[^A-Za-z0-9._-]", "_", msg_id or "")[:64]
    safe_name = _safe_name(name)
    if safe_name != name:
        raise HTTPException(status_code=404, detail="not found")
    path = os.path.join(FILES_DIR, safe_msg, safe_name)
    if not os.path.isfile(path):
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
        _oplog("decide", "failed", (err or "")[:200])
        raise HTTPException(status_code=500, detail={"rc": rc, "stderr": err, "stdout": out})
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
    # Wake the default agent with the verdict — the decision must travel,
    # not just sit in the ledger. A trigger failure never voids the decision.
    trigger = _trigger_default(payload.decision, req, payload.note, actor)
    return {"ok": True, "msg_id": payload.msg_id, "decision": payload.decision,
            "actor": actor, "actor_source": actor_source,
            "stdout": out, "trigger": trigger}
