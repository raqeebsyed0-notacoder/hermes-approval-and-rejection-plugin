import os
import json


def test_health(c):
    r = c.get("/api/plugins/approval-inbox/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_submit_visible_pending(c):
    payload = {
        "type": "post",
        "owner": "social_content",
        "work_id": "t_test1",
        "artifact": {"name": "landing-post", "version": "v1", "hash": "abc", "preview_url": "http://example.com/p"},
        "next_action": "publish post",
    }
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    assert r.status_code == 200
    msg_id = r.json()["msg_id"]
    assert msg_id
    r2 = c.get("/api/plugins/approval-inbox/items?status=pending")
    assert r2.status_code == 200
    items = r2.json()["items"]
    assert any(i["msg_id"] == msg_id for i in items)
    it = next(i for i in items if i["msg_id"] == msg_id)
    assert it["type"] == "post"
    assert it["owner"] == "social_content"
    assert it["artifact"]["version"] == "v1"
    assert it["next_action"] == "publish post"


def test_approve_records_and_routes(c):
    payload = {
        "type": "task",
        "owner": "code",
        "work_id": "t_test2",
        "artifact": {"name": "build", "version": "v2", "hash": "def"},
        "next_action": "deploy",
    }
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    msg_id = r.json()["msg_id"]
    r2 = c.post("/api/plugins/approval-inbox/decide", json={"msg_id": msg_id, "decision": "approve", "artifact_version": "v2", "note": "go"})
    assert r2.status_code == 200
    # item no longer pending
    r3 = c.get("/api/plugins/approval-inbox/items?status=pending")
    assert not any(i["msg_id"] == msg_id for i in r3.json()["items"])
    # approved version sidecar exists
    data_dir = os.environ["APPROVAL_INBOX_DATA"]
    vf = os.path.join(data_dir, "approved_versions.jsonl")
    assert os.path.exists(vf)
    lines = [json.loads(x) for x in open(vf)]
    assert any(x["msg_id"] == msg_id and x["authorized"] is True for x in lines)
    # default agent received reply
    mb = os.path.join(os.environ["AGENT_MAIL_HOME"], "mailbox", "default")
    files = os.listdir(mb)
    assert len(files) >= 1
    # verify msg_id appears in a default mailbox reply body
    reply_found = False
    for f in files:
        try:
            with open(os.path.join(mb, f), encoding="utf-8") as fh:
                if msg_id in fh.read():
                    reply_found = True
                    break
        except Exception:
            pass
    assert reply_found, "msg_id not found in default mailbox reply"


def test_changed_version_refused(c):
    payload = {
        "type": "pdf",
        "owner": "legal",
        "work_id": "t_test3",
        "artifact": {"name": "contract", "version": "v1", "hash": "h1"},
        "next_action": "send pdf",
    }
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    msg_id = r.json()["msg_id"]
    r2 = c.post("/api/plugins/approval-inbox/decide", json={"msg_id": msg_id, "decision": "approve", "artifact_version": "v2"})
    assert r2.status_code == 409


def test_reject_no_sidecar(c):
    payload = {
        "type": "reel",
        "owner": "social_content",
        "work_id": "t_test4",
        "artifact": {"name": "reel", "version": "v1", "hash": "r1"},
        "next_action": "post reel",
    }
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    msg_id = r.json()["msg_id"]
    r2 = c.post("/api/plugins/approval-inbox/decide", json={"msg_id": msg_id, "decision": "reject", "note": "not now"})
    assert r2.status_code == 200
    data_dir = os.environ["APPROVAL_INBOX_DATA"]
    vf = os.path.join(data_dir, "approved_versions.jsonl")
    if os.path.exists(vf):
        lines = [json.loads(x) for x in open(vf)]
        assert not any(x["msg_id"] == msg_id for x in lines)
    # item still exists (not deleted)
    r3 = c.get("/api/plugins/approval-inbox/items")
    assert any(i["msg_id"] == msg_id for i in r3.json()["items"])


import os
import py_compile
import sys
import subprocess


def test_lint_clean():
    """Flake8 E/F rules (max-line 120) if available, else py_compile all plugin files."""
    plugin_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = []
    for root, dirs, files in os.walk(plugin_dir):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for fn in files:
            if fn.endswith(".py"):
                targets.append(os.path.join(root, fn))
    # try flake8 first (optional dependency)
    flake8_available = False
    try:
        probe = subprocess.run(
            [sys.executable, "-m", "flake8", "--version"],
            capture_output=True, text=True, timeout=30,
        )
        flake8_available = (probe.returncode == 0)
    except FileNotFoundError:
        flake8_available = False

    if flake8_available:
        proc = subprocess.run(
            [sys.executable, "-m", "flake8", "--select=E,F", "--max-line-length=120"] + targets,
            capture_output=True, text=True, timeout=60,
        )
        assert proc.returncode == 0, "flake8 failures:\n" + proc.stdout + "\n" + proc.stderr
    else:
        for path in targets:
            py_compile.compile(path, doraise=True)
