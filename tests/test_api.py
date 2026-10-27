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


import base64

PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
MIN_PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"


def _submit_with_files(c):
    payload = {
        "type": "post",
        "owner": "social_content",
        "work_id": "t_files1",
        "artifact": {"name": "launch-post", "version": "v1"},
        "next_action": "publish post",
        "attachments": [
            {"name": "frame1.png", "content_type": "image/png", "data_b64": PNG_1PX},
            {"name": "brief.pdf", "content_type": "application/pdf",
             "data_b64": base64.b64encode(MIN_PDF).decode("ascii")},
        ],
    }
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert len(body["attachments"]) == 2
    return body["msg_id"]


def test_submit_attachments_visible_in_items(c):
    msg_id = _submit_with_files(c)
    r = c.get("/api/plugins/approval-inbox/items?status=pending")
    it = next(i for i in r.json()["items"] if i["msg_id"] == msg_id)
    kinds = sorted(a["kind"] for a in it["attachments"])
    assert kinds == ["image", "pdf"]


def test_preview_packet_and_file_bytes(c):
    msg_id = _submit_with_files(c)
    r = c.get(f"/api/plugins/approval-inbox/preview/{msg_id}")
    assert r.status_code == 200
    items = {i["name"]: i for i in r.json()["items"]}
    assert items["frame1.png"]["data_url"].startswith("data:image/png;base64,")
    assert items["brief.pdf"]["kind"] == "pdf"
    f = c.get(f"/api/plugins/approval-inbox/files/{msg_id}/frame1.png")
    assert f.status_code == 200
    assert f.content == base64.b64decode(PNG_1PX)
    bad = c.get(f"/api/plugins/approval-inbox/files/{msg_id}/..%2Fsecret")
    assert bad.status_code in (404, 422)


def test_bad_attachment_rejected(c):
    payload = {"type": "post", "owner": "x", "work_id": "t_bad",
               "artifact": {"name": "a", "version": "v1"},
               "attachments": [{"name": "run.exe", "content_type": "application/x-msdownload",
                                "data_b64": base64.b64encode(b"mz").decode("ascii")}]}
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    assert r.status_code == 400


def test_note_capped_at_500(c):
    payload = {"type": "post", "owner": "x", "work_id": "t_note",
               "artifact": {"name": "a", "version": "v1"}}
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    msg_id = r.json()["msg_id"]
    r2 = c.post("/api/plugins/approval-inbox/decide",
                json={"msg_id": msg_id, "decision": "reject", "note": "x" * 600})
    assert r2.status_code == 422


def test_decide_reports_trigger_and_actor(c):
    payload = {"type": "post", "owner": "x", "work_id": "t_trig",
               "artifact": {"name": "a", "version": "v1"}}
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    msg_id = r.json()["msg_id"]
    r2 = c.post("/api/plugins/approval-inbox/decide",
                json={"msg_id": msg_id, "decision": "reject", "note": "not yet"})
    assert r2.status_code == 200
    body = r2.json()
    assert body["actor"] == "default"
    assert body["actor_source"] == "default"
    assert body["trigger"]["triggered"] is False
    r3 = c.get("/api/plugins/approval-inbox/ops/log?limit=10")
    assert r3.status_code == 200
    ops = [(e["op"], e["status"]) for e in r3.json()["entries"]]
    assert ("decide", "reject") in ops


def test_submit_survives_oae_failure_when_local_delivered(c, monkeypatch):
    import dashboard.plugin_api as papi

    fake_id = "m20261027-000001"
    ledger = os.path.join(os.environ["AGENT_MAIL_HOME"], "ledger.jsonl")
    with open(ledger, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"msg_id": fake_id, "ts": "2026-10-27 00:00:00 +0300",
                             "from": "default", "to": ["founder"],
                             "subject": "OAE resilience probe", "kind": "approval",
                             "task_id": "t_oae", "body": "<!-- approval-inbox:v1 {} -->",
                             "delivery": "local"}) + "\n")

    def fake_run(args):
        return 6, f"delivered  {fake_id}  default \u2192 founder  [local]\nOAE FAIL: down", "!! OAE down"

    monkeypatch.setattr(papi, "_run_agent_mail", fake_run)
    r = c.post("/api/plugins/approval-inbox/submit",
               json={"type": "post", "owner": "x", "work_id": "t_oae",
                     "artifact": {"name": "a", "version": "v1"},
                     "attachments": [{"name": "frame1.png", "content_type": "image/png",
                                      "data_b64": PNG_1PX}]})
    assert r.status_code == 200
    body = r.json()
    assert body["msg_id"] == fake_id
    assert "oae_warning" in body
    assert len(body["attachments"]) == 1


def test_trigger_builds_exactly_once_task(c, monkeypatch):
    import dashboard.plugin_api as papi

    monkeypatch.delenv("APPROVAL_INBOX_NO_TRIGGER", raising=False)
    calls = []
    envs = []

    class FakeProc:
        returncode = 0
        stdout = "t_abc123"
        stderr = ""

    def fake_run(cmd, **kw):
        calls.append(cmd)
        envs.append(kw.get("env") or {})
        return FakeProc()

    monkeypatch.setattr(papi.subprocess, "run", fake_run)
    req = {"msg_id": "m20261027-000002", "subject": "S", "work_id": "w",
           "artifact": {"name": "a", "version": "v1"}, "next_action": "go"}
    out = papi._trigger_default("approve", req, "ok", "default")
    assert out == {"triggered": True, "task": "t_abc123"}
    cmd = calls[0]
    assert "--assignee" in cmd and "default" in cmd
    assert "approval-m20261027-000002" in cmd
    assert "--board" in cmd
    assert envs[0].get("HERMES_HOME")


def test_trigger_failure_never_raises(c, monkeypatch):
    import dashboard.plugin_api as papi

    def fake_run(cmd, **kw):
        raise FileNotFoundError("no hermes on PATH")

    monkeypatch.setattr(papi.subprocess, "run", fake_run)
    req = {"msg_id": "m20261027-000003", "subject": "S", "work_id": "w",
           "artifact": {}, "next_action": None}
    out = papi._trigger_default("reject", req, "", "default")
    assert out["triggered"] is False
    assert out["reason"]


def test_oversize_image_lists_but_does_not_inline(c):
    big = b"\x89PNG\r\n\x1a\n" + (b"\x00" * (9 * 1024 * 1024))
    payload = {"type": "post", "owner": "x", "work_id": "t_big",
               "artifact": {"name": "a", "version": "v1"},
               "attachments": [{"name": "huge.png", "content_type": "image/png",
                                "data_b64": base64.b64encode(big).decode("ascii")}]}
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    assert r.status_code == 200
    msg_id = r.json()["msg_id"]
    pv = c.get(f"/api/plugins/approval-inbox/preview/{msg_id}").json()
    item = next(i for i in pv["items"] if i["name"] == "huge.png")
    assert item["data_url"] is None
    assert item["size"] == len(big)
