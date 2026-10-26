# Hermes Approval Inbox

Hermes Desktop plugin providing a single approval inbox for any work needing a
decision (task, post, reel/video, PDF, or generic artifact). Approvals are
routed through the default agent only; specialists never contact the Founder.

Approvals live in the Desktop inbox (this plugin). There is no SiYuan
dependency and no external approval authority.

## Install

```bash
git clone https://github.com/raqeebsyed0-notacoder/hermes-approval-and-rejection-plugin.git \
  ~/.hermes/plugins/approval-inbox
```

Enable the backend in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - approval-inbox
```

Restart the desktop serve child so the backend mounts at
`/api/plugins/approval-inbox/`.

## Verify

```bash
env -u PYTHONPATH python -m pytest tests/ -q
node --check desktop/plugin.js
hermes plugins validate . --json
```
