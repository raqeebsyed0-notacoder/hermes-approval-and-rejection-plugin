"""Live-session injection: a decision must reach the session the user is running in.

Invariants under test (0.9.2):
  1. The gate is fail-closed: without plugins.entries.approval-inbox.allow_gateway_injection
     a decision never touches an injector.
  2. The session picked is the most recently active NON-lazy one hosted by this process.
  3. With the gate on and a live session present, the decision is injected into that session.
  4. _trigger_default prefers the live session and does NOT create a board card.
  5. With no live session reachable it still falls back to the board-card route.
"""
import sys
import types

import dashboard.plugin_api as papi


def _fake_gateway(sessions):
    """Install a stand-in tui_gateway.server holding the given _sessions dict."""
    srv = types.ModuleType("tui_gateway.server")
    srv._sessions = sessions
    pkg = types.ModuleType("tui_gateway")
    pkg.server = srv
    sys.modules["tui_gateway"] = pkg
    sys.modules["tui_gateway.server"] = srv
    return srv


def _fake_manager(return_value=True):
    class Mgr:
        def __init__(self):
            self.calls = []
        def inject_tui_message(self, **kw):
            self.calls.append(kw)
            return return_value
    return Mgr()


def _open_gate(monkeypatch):
    """Turn the real gate on the honest way: the config the plugin actually reads."""
    import hermes_cli.config as hcfg
    monkeypatch.setattr(
        hcfg, "load_config_readonly",
        lambda *a, **k: {"plugins": {"entries": {"approval-inbox": {"allow_gateway_injection": True}}}})


def _req(msg_id="m20261103-000001"):
    return {"msg_id": msg_id, "subject": "S", "work_id": "w",
            "artifact": {"name": "a", "version": "v1"}, "next_action": "go"}


def test_gate_fails_closed_without_the_config_key(monkeypatch):
    import hermes_cli.config as hcfg
    import hermes_cli.plugins as hplug

    monkeypatch.setattr(hcfg, "load_config_readonly", lambda *a, **k: {})
    mgr = _fake_manager()
    monkeypatch.setattr(hplug, "get_plugin_manager", lambda: mgr)
    _fake_gateway({"a": {"session_key": "k", "last_active": 1.0}})

    assert papi._gateway_injection_allowed() is False
    assert papi._inject_live_session("hello") is None
    assert mgr.calls == []  # nothing was ever handed to an injector


def test_picks_most_recent_nonlazy_session(monkeypatch):
    _fake_gateway({
        "a": {"session_key": "k-old", "last_active": 100.0},
        "b": {"session_key": "k-new", "last_active": 900.0},
        "c": {"session_key": "k-lazy", "last_active": 9999.0, "lazy": True},
        "d": {"session_key": "", "last_active": 9999.0},
    })
    assert papi._live_session_key() == "k-new"


def test_injects_decision_into_the_live_session(monkeypatch):
    import hermes_cli.plugins as hplug

    _open_gate(monkeypatch)
    mgr = _fake_manager(return_value=True)
    monkeypatch.setattr(hplug, "get_plugin_manager", lambda: mgr)
    _fake_gateway({"a": {"session_key": "k-live", "last_active": 5.0}})

    assert papi._inject_live_session("Founder decision: REJECT") == "k-live"
    assert len(mgr.calls) == 1
    assert mgr.calls[0]["session_key"] == "k-live"
    assert mgr.calls[0]["plugin_id"] == "approval-inbox"
    assert "REJECT" in mgr.calls[0]["content"]


def test_trigger_prefers_live_session_over_board_card(monkeypatch):
    import hermes_cli.plugins as hplug

    monkeypatch.delenv("APPROVAL_INBOX_NO_TRIGGER", raising=False)
    _open_gate(monkeypatch)
    mgr = _fake_manager(return_value=True)
    monkeypatch.setattr(hplug, "get_plugin_manager", lambda: mgr)
    _fake_gateway({"a": {"session_key": "k-live", "last_active": 5.0}})

    def boom(*a, **k):
        raise AssertionError("board-card route must not run when the live session answers")

    monkeypatch.setattr(papi.subprocess, "run", boom)

    out = papi._trigger_default("reject", _req(), "fonts unreadable", "default")
    assert out["triggered"] is True
    assert out["via"] == "live_session"
    assert out["session_key"] == "k-live"
    assert "REJECT" in mgr.calls[0]["content"]
    assert "fonts unreadable" in mgr.calls[0]["content"]


def test_falls_back_to_board_card_when_no_live_session(monkeypatch):
    monkeypatch.delenv("APPROVAL_INBOX_NO_TRIGGER", raising=False)
    _open_gate(monkeypatch)
    _fake_gateway({})  # Desktop closed: no session to reach

    calls = []

    class FakeProc:
        returncode = 0
        stdout = "Created t_abc123  (ready, assignee=default)"
        stderr = ""

    class FakeDispatch:
        returncode = 0
        stdout = "Spawned:      1\n  - t_abc123  ->  default"
        stderr = ""

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return FakeDispatch() if "dispatch" in cmd else FakeProc()

    monkeypatch.setattr(papi.subprocess, "run", fake_run)

    out = papi._trigger_default("reject", _req("m20261103-000002"), "", "default")
    assert out["triggered"] is True
    assert out.get("via") != "live_session"
    assert calls, "the board-card route must still run when no session is reachable"
