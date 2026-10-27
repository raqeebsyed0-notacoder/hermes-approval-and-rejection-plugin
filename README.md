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

## Inbox UI (0.4.0)

- Header: title, `N to review` badge, search (subject, owner, artifact),
  refresh.
- Filter row: Needs decision / Approved / Rejected / All, with counts.
  Search + filter are remembered between visits.
- Cards show the artifact itself: image thumbnails (tap to enlarge),
  carousel strips, inline video, PDF first page with full-document reader.
  Pending first, newest first; decided cards dim.
- Approve asks for confirmation naming the artifact; reject takes a reason
  that travels with the decision. Failures surface as an error toast.
- Every decision wakes the default agent: approve carries out exactly the
  next action shown, reject stops it and relays the reason to the owner.
  The ledger record alone never moves work — the trigger does.

## Submitting with files

`POST /submit` accepts `attachments: [{name, content_type, data_b64}]`
(images, video, PDF; 15MB each, 30MB total). Stored per request, served via
`GET /files/{msg_id}/{name}` and previewed via `GET /preview/{msg_id}`
(data URLs the renderer can use directly). A locally-delivered request
never fails just because the external email copy fails — the failure is
returned as a loud `oae_warning`, not a 500.

## CI

`bash tools/ci.sh` — pytest, strict ESM gate
(`node --input-type=module --check`; plain `--check` is a known false
clean on ESM), UI smoke tests, plugin validation.

## Verify

```bash
env -u PYTHONPATH python -m pytest tests/ -q
node --check desktop/plugin.js
hermes plugins validate . --json
```
