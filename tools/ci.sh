#!/bin/bash
# Approval Inbox CI: backend suite + ESM gate + UI smoke + plugin validation.
# Run on every commit and before pushing: bash tools/ci.sh
set -e
cd "$(dirname "$0")/.."
VENV=/home/euphoria/euphoria-v2/apps/hermes/source-v2026.8.27/.venv/bin
echo "== pytest =="
PYTHONPATH="$PWD" $VENV/pytest tests/ -q -p no:cacheprovider
echo "== version sync =="
YV=$(grep -m1 '^version:' plugin.yaml | awk '{print $2}')
JV=$(python3 -c "import json; print(json.load(open('dashboard/manifest.json'))['version'])")
AV=$(grep -m1 "APP_VERSION = " desktop/plugin.js | sed "s/.*'\(.*\)'.*/\1/")
echo "plugin.yaml=$YV manifest=$JV plugin.js=$AV"
[ "$YV" = "$JV" ] && [ "$YV" = "$AV" ] || { echo "VERSION DRIFT"; exit 1; }
echo VERSIONS_OK
echo "== ESM gate (strict: plain --check is a known false clean on ESM) =="
node --input-type=module --check < desktop/plugin.js && echo ESM_OK
echo "== UI smoke =="
node tests/ui-smoke/surface-check.mjs
node tests/ui-smoke/load-smoke.mjs
echo "== validate =="
hermes plugins validate "$PWD"
echo "CI PASS"
