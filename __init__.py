"""Approval Inbox plugin package."""


def register(ctx) -> None:
    """No-op registration for the capability probe.

    This plugin's surfaces are the dashboard API router (dashboard/) and
    the desktop renderer (desktop/); it does not register core agent
    tools/hooks/middleware. The probe requires a register() to exist; it
    records nothing, matching the empty capabilities block in plugin.yaml
    and the catalog entry.
    """
    return None
