"""Approval Inbox plugin backend — reads the authoritative agent-mail approval ledger."""
import json
import os
import re
import subprocess
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from typing import Optional
from pydantic import BaseModel

REPO = os.environ.get("EUPHORIA_REPO", "/home/euphoria/euphoria-v2")
MAIL_HOME = os.environ.get("AGENT_MAIL_HOME", os.path.join(REPO, "work", "mail"))
AGENT_MAIL = os.environ.get("AGENT_MAIL_BIN", os.path.join(MAIL_HOME, "bin", "agent-mail"))
DATA_DIR = os.environ.get("APPROVAL_INBOX_DATA", os.path.join(REPO, "work", "approval-inbox"))
VERSIONS_FILE = os.path.join(DATA_DIR, "approved_versions.jsonl")

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
        raise HTTPException(status_code=500, detail={"rc": rc, "stderr": err, "stdout": out})
    msg_id = _extract_msg_id(out)
    return {"ok": True, "msg_id": msg_id, "stdout": out}


class DecidePayload(BaseModel):
    msg_id: str
    decision: str
    note: str = ""
    artifact_version: Optional[str] = None


@router.post("/decide")
def decide(payload: DecidePayload):
    if payload.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be approve or reject")
    # find request
    req = next((x for x in _requests() if x["msg_id"] == payload.msg_id), None)
    if req is None:
        raise HTTPException(status_code=404, detail="request not found")
    if req["status"] != "pending":
        raise HTTPException(status_code=409, detail="already decided")
    req_version = (req.get("artifact") or {}).get("version")
    if payload.decision == "approve":
        if payload.artifact_version is not None and req_version is not None and payload.artifact_version != req_version:
            raise HTTPException(status_code=409, detail="artifact version changed; approval invalid")
    rc, out, err = _run_agent_mail([
        "approve", "--msg-id", payload.msg_id, "--decision", payload.decision,
        "--note", payload.note or "", "--task-id", str(req.get("work_id") or "-"),
    ])
    if rc != 0:
        raise HTTPException(status_code=500, detail={"rc": rc, "stderr": err, "stdout": out})
    # record approved version sidecar (plugin metadata, not business canon)
    if payload.decision == "approve":
        os.makedirs(DATA_DIR, exist_ok=True)
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "msg_id": payload.msg_id,
            "work_id": req.get("work_id"),
            "artifact": req.get("artifact"),
            "next_action": req.get("next_action"),
            "authorized": True,
        }
        with open(VERSIONS_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return {"ok": True, "msg_id": payload.msg_id, "decision": payload.decision, "stdout": out}
