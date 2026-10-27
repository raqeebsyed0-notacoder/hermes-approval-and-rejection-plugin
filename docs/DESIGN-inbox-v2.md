# Approval Inbox — Pane Design Contract v2

Target: Hermes Desktop `/approval-inbox` page + sidebar entry. Audience: the Founder,
triaging approval requests in seconds. One belief per screen: **what needs my
decision right now**.

## Layout

1. Header row: title button, pending-count badge, search field, refresh button.
2. Filter row: `Needs decision | Approved | Rejected | All` (counts in labels).
3. Scroll list: pending first (newest first), then decided (newest first).

## Components (all proven: imported by hermes-newswire on this same Desktop)

SearchField, SegmentedControl, Button, Badge, EmptyState, ErrorState, Input,
ConfirmDialog, Separator, ScrollArea, GlyphSpinner. No other UI imports.

## States

- Loading (first paint): centered GlyphSpinner.
- Error: ErrorState + Retry button (invalidates the inbox query).
- Empty per filter: EmptyState with tailored copy (search-no-match vs
  nothing-pending vs nothing-decided).
- Card busy: buttons disabled, label flips to `Working…`; decide failure
  surfaces via `host.notify` error toast.
- Approve is two-step (ConfirmDialog naming the artifact + version); reject is
  two-step (reason input, then Reject).

## Rules

- Filter + search persist in `ctx.storage` (`inboxPrefs`), per newswire pattern.
- Relative time primary, absolute on hover via `title` attr.
- Decided cards dim slightly; decision, note, actor, and time stay readable.
- No custom motion; no new SDK surface; area identifiers stay imported
  (`routes`, `sidebar.nav`, `palette` — never quoted strings).
- Visual PASS belongs to the Founder's eyes on his Desktop; gates prove code,
  never pixels.
