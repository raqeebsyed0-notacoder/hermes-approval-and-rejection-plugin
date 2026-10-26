import os, json, shutil, tempfile
import pytest

TMP = tempfile.mkdtemp(prefix="approval-inbox-test-")
MAIL_HOME = os.path.join(TMP, "mail")
REPO = "/home/euphoria/euphoria-v2"
os.makedirs(os.path.join(MAIL_HOME, "mailbox", "founder"), exist_ok=True)
os.makedirs(os.path.join(MAIL_HOME, "mailbox", "default"), exist_ok=True)
os.makedirs(os.path.join(MAIL_HOME, "bin"), exist_ok=True)
# copy agent-mail + sibling
shutil.copy(os.path.join(REPO, "work", "mail", "bin", "agent-mail"), os.path.join(MAIL_HOME, "bin", "agent-mail"))
shutil.copy(os.path.join(REPO, "work", "mail", "bin", "mail_presentation.py"), os.path.join(MAIL_HOME, "bin", "mail_presentation.py"))
shutil.copy(os.path.join(REPO, "work", "mail", "roster.json"), os.path.join(MAIL_HOME, "roster.json"))

os.environ["EUPHORIA_REPO"] = REPO
os.environ["AGENT_MAIL_HOME"] = MAIL_HOME
os.environ["AGENT_MAIL_BIN"] = os.path.join(MAIL_HOME, "bin", "agent-mail")
os.environ["APPROVAL_INBOX_DATA"] = os.path.join(TMP, "plugin-data")
os.environ["AGENT_MAIL_EXTERNAL_ENABLED"] = "false"

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

# mock OAE server
class _H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        body = b'{"queued": true, "id": "x", "messageId": "y"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

_srv = HTTPServer(("127.0.0.1", 31100), _H)
threading.Thread(target=_srv.serve_forever, daemon=True).start()

os.makedirs(os.path.join(MAIL_HOME, "_openagent-eval", "src"), exist_ok=True)
with open(os.path.join(MAIL_HOME, "_openagent-eval", "src", ".env"), "w") as fh:
    fh.write("API_KEYS=testkey\nMAIL_PASSWORD=testpw\n")
os.chmod(os.path.join(MAIL_HOME, "bin", "agent-mail"), 0o755)

from fastapi.testclient import TestClient
from dashboard.plugin_api import router
from fastapi import FastAPI

app = FastAPI()
app.include_router(router, prefix="/api/plugins/approval-inbox")
client = TestClient(app)


@pytest.fixture
def c():
    return client


@pytest.fixture(autouse=True)
def reset():
    # clear ledger/approvals/mailboxes between tests
    for f in ("ledger.jsonl", "approvals.jsonl"):
        p = os.path.join(MAIL_HOME, f)
        if os.path.exists(p):
            os.remove(p)
    for d in ("founder", "default"):
        dd = os.path.join(MAIL_HOME, "mailbox", d)
        for fn in os.listdir(dd):
            os.remove(os.path.join(dd, fn))
    pd = os.environ["APPROVAL_INBOX_DATA"]
    if os.path.exists(pd):
        shutil.rmtree(pd)
    yield
