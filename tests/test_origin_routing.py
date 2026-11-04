"""Origin decides where the Founder's answer goes (Founder ruling 2026-11-04).

An approval that CAME FROM PAPERCLIP is answered IN PAPERCLIP — approve/reject/review land on
the issue. An item an AGENT raised into the inbox goes to the live session instead. These are
the invariants that must not drift: getting this backwards sends a Paperclip verdict into a
chat session and leaves the issue untouched.
"""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_api():
    spec = importlib.util.spec_from_file_location(
        "approval_inbox_api", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["approval_inbox_api"] = mod
    spec.loader.exec_module(mod)
    return mod


api = _load_api()


def _fake_calls(calls, issue=None):
    """Stand-in for _paperclip_call: records every request, answers the issue lookup."""
    def call(method, url, key, payload=None):
        calls.append((method, url, payload))
        if method == "GET":
            return {"issues": [issue or {"id": "iss1", "identifier": "EUP-361"}]}
        return {}
    return call


def test_a_paperclip_issue_id_is_paperclip_origin():
    assert api._origin_of({"work_id": "EUP-361"}) == "paperclip"


def test_a_non_issue_work_id_is_agent_origin():
    assert api._origin_of({"work_id": "pending-work-2026-11-03-v3"}) == "agent"
    assert api._origin_of({"work_id": "t_c031c6dc"}) == "agent"


def test_a_declared_origin_wins_over_the_identifier():
    assert api._origin_of({"work_id": "EUP-9", "meta": {"origin": "agent"}}) == "agent"


def test_paperclip_item_never_reaches_the_live_session(monkeypatch):
    monkeypatch.delenv("APPROVAL_INBOX_NO_TRIGGER", raising=False)
    injected = []
    monkeypatch.setattr(api, "_inject_live_session",
                        lambda text: (injected.append(text), "sess")[1])
    monkeypatch.setattr(api, "_trigger_paperclip",
                        lambda d, r, n, a: {"triggered": True, "via": "paperclip"})
    out = api._trigger_default("approve", {"work_id": "EUP-361", "msg_id": "m1"}, "", "founder")
    assert out["via"] == "paperclip"
    assert injected == [], "a Paperclip verdict must not be injected into the live session"


def test_agent_item_still_goes_to_the_live_session(monkeypatch):
    monkeypatch.delenv("APPROVAL_INBOX_NO_TRIGGER", raising=False)
    monkeypatch.setattr(api, "_inject_live_session", lambda text: "sess-1")
    out = api._trigger_default("approve",
                              {"work_id": "pending-work-2026-11-03-v3", "msg_id": "m2"},
                              "", "founder")
    assert out == {"triggered": True, "via": "live_session", "session_key": "sess-1"}


def test_approve_closes_the_issue(monkeypatch):
    calls = []
    monkeypatch.setattr(api, "_paperclip_cfg", lambda: ("http://pc", "k", "co"))
    monkeypatch.setattr(api, "_paperclip_call", _fake_calls(calls))
    out = api._trigger_paperclip("approve", {"work_id": "EUP-361", "msg_id": "m1"},
                                 "verified live", "founder")
    assert out["triggered"] is True and out["via"] == "paperclip"
    method, url, payload = calls[-1]
    assert method == "PATCH" and url.endswith("/issues/iss1")
    assert payload["status"] == "done"
    assert "verified live" in payload["comment"]
    assert "APPROVED" in payload["comment"]


def test_reject_returns_the_issue_to_its_owner_with_the_reason(monkeypatch):
    calls = []
    monkeypatch.setattr(api, "_paperclip_cfg", lambda: ("http://pc", "k", "co"))
    monkeypatch.setattr(api, "_paperclip_call", _fake_calls(calls))
    api._trigger_paperclip("reject", {"work_id": "EUP-361", "msg_id": "m1"},
                           "still invisible on my screen", "founder")
    _, _, payload = calls[-1]
    assert payload["status"] == "todo"
    assert "still invisible on my screen" in payload["comment"]


def test_review_is_a_note_and_never_changes_the_status(monkeypatch):
    calls = []
    monkeypatch.setattr(api, "_paperclip_cfg", lambda: ("http://pc", "k", "co"))
    monkeypatch.setattr(api, "_paperclip_call", _fake_calls(calls))
    out = api._trigger_paperclip("review", {"work_id": "EUP-361", "msg_id": "m1"},
                                 "add the smoke test first", "founder")
    _, _, payload = calls[-1]
    assert "status" not in payload, "a review must not decide the issue"
    assert "REVIEW NOTE" in payload["comment"]
    assert out["status"] == "(unchanged)"


def test_a_missing_issue_is_reported_not_swallowed(monkeypatch):
    calls = []
    monkeypatch.setattr(api, "_paperclip_cfg", lambda: ("http://pc", "k", "co"))
    monkeypatch.setattr(api, "_paperclip_call",
                        _fake_calls(calls, issue={"id": "other", "identifier": "EUP-999"}))
    out = api._trigger_paperclip("approve", {"work_id": "EUP-361", "msg_id": "m1"}, "", "founder")
    assert out["triggered"] is False and "not found" in out["reason"]


def test_an_unconfigured_paperclip_is_blocked_loudly(monkeypatch):
    monkeypatch.setattr(api, "_paperclip_cfg", lambda: ("", "", ""))
    out = api._trigger_paperclip("approve", {"work_id": "EUP-361", "msg_id": "m1"}, "", "founder")
    assert out["triggered"] is False and "not configured" in out["reason"]
