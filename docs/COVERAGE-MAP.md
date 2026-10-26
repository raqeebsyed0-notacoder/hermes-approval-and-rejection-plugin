# Approval/Rejection Coverage Map (source-grounded, non-exhaustive)

Plugin: approval-inbox (prototype; Desktop install/activation held pending design review).

Authoritative stores reused (not replaced):
- Agent mail approvals: work/mail/approvals.jsonl (append-only decisions)
- Agent mail ledger/mailbox: work/mail/ledger.jsonl, work/mail/mailbox/<agent>/
- Work control: kanban tasks (this repo)

Coverage (approval/rejection flows found):
- Mail approvals: requests to founder, decisions recorded in approvals.jsonl, replies to requester. Covered by plugin items list + decide.
- Kanban tasks: task status transitions; approvals may be represented as task review. Plugin does not mutate kanban; routes via default agent.
- Content/posts/reels/PDFs/artifacts: require request metadata (type, owner, artifact version/hash, preview, next action). Plugin submit format supports these.

Gaps / not claimed exhaustive:
- Current canon may be missing or conflicting for some modules; no claim of exhaustive coverage.
- Desktop installation/activation held.
- External-action wiring held; approve records decision + sidecar metadata only, routing via default agent.
- Rejection does not trigger action; item retained.