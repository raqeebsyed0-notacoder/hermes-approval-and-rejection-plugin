/**
 * Hermes Approval Inbox — desktop plugin.
 *
 * One surface for approval requests routed through the default agent.
 * Mirrors the hermes-newswire pane pattern:
 *   themed header, search + status filter, item cards with badges,
 *   loading/empty/error states, preview/open action, refresh control.
 *
 * Backend (dashboard/plugin_api.py) mounts at /api/plugins/approval-inbox/.
 *
 * Design notes (Founder order 2026-10-27):
 *   - Decision carries the reason: reject is a two-step (open reason input,
 *     send with note). Approve is two-step too (confirm dialog naming the
 *     artifact). The backend /decide already takes `note`.
 *   - Decided rows show decision + note + actor.
 *   - Pending / approved / rejected badges; approve/reject only while pending.
 *   - No bare divs where a themed component belongs.
 *   - Contract: docs/DESIGN-inbox-v2.md.
 */

import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorState, GlyphSpinner,
  host, Input, PALETTE_AREA, ROUTES_AREA, ScrollArea, SearchField,
  SegmentedControl, SIDEBAR_NAV_AREA, queryClient,
  useMutation, useQuery,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'approval-inbox'
const PAGE_PATH = '/approval-inbox'

// Assigned in register(ctx) — components can't see ctx directly.
let rest = null
let storeGet = null
let storeSet = null

// ─────────────────────────────────────────────────────────────────────────
// Styles (content-compared, hot-reload safe)
// ─────────────────────────────────────────────────────────────────────────

function ensureStyles() {
  const css = [
    /* root */
    `.${ID} { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--ui-text-primary); }`,
    /* themed header */
    `.${ID}-header { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--ui-stroke-secondary); flex: none; }`,
    `.${ID}-brand { display: inline-flex; align-items: center; gap: 0.375rem; flex: none; cursor: pointer; padding: 0; border: 0; background: none; font: inherit; color: var(--ui-text-primary); }`,
    `.${ID}-brand:hover { background: var(--chrome-action-hover); }`,
    `.${ID}-brand:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }`,
    `.${ID}-title { font-weight: 600; font-size: 0.875rem; line-height: 1.2; }`,
    `.${ID}-filters { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--ui-stroke-secondary); flex: none; flex-wrap: wrap; }`,
    /* body */
    `.${ID}-body { flex: 1 1 auto; min-height: 0; }`,
    `.${ID}-scroll { flex: 1 1 auto; overflow: auto; padding: 0.5rem; }`,
    `.${ID}-list { display: flex; flex-direction: column; gap: 0.5rem; }`,
    `.${ID}-section { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-text-quaternary); padding: 0.5rem 0.25rem 0; }`,
    /* item card */
    `.${ID}-card { border: 1px solid var(--ui-stroke-secondary); border-radius: 0.5rem; padding: 0.75rem 0.875rem; background: var(--ui-bg-card); cursor: default; }`,
    `.${ID}-card:hover { border-color: var(--ui-accent); }`,
    `.${ID}-card-decided { opacity: 0.82; }`,
    `.${ID}-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }`,
    `.${ID}-subject { font-weight: 600; font-size: 0.8125rem; line-height: 1.35; margin-top: 0.375rem; overflow-wrap: anywhere; }`,
    `.${ID}-dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; display: inline-block; margin-right: 0.375rem; }`,
    `.${ID}-meta { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.75rem; color: var(--ui-text-secondary); margin-top: 0.375rem; }`,
    `.${ID}-metaRow { display: flex; gap: 0.5rem; align-items: baseline; }`,
    `.${ID}-metaLabel { flex: none; min-width: 4.5rem; color: var(--ui-text-quaternary); font-weight: 500; }`,
    `.${ID}-preview { display: inline-flex; align-items: center; gap: 0.25rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--ui-stroke-tertiary); color: var(--ui-accent); text-decoration: none; font-size: 0.75rem; }`,
    `.${ID}-preview:hover { color: var(--ui-text-primary); }`,
    /* decision controls */
    `.${ID}-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--ui-stroke-tertiary); flex-wrap: wrap; }`,
    `.${ID}-reasonRow { display: flex; gap: 0.5rem; align-items: center; flex: 1; min-width: 0; flex-basis: 100%; }`,
    `.${ID}-note { font-size: 0.75rem; color: var(--ui-text-secondary); white-space: pre-line; line-height: 1.4; overflow-wrap: anywhere; }`,
    `.${ID}-time { font-size: 0.6875rem; color: var(--ui-text-quaternary); white-space: nowrap; }`,
    /* attachment previews */
    `.${ID}-prev { display: flex; flex-direction: column; gap: 0.375rem; margin-top: 0.5rem; }`,
    `.${ID}-prevGrid { display: flex; gap: 0.375rem; overflow-x: auto; padding-bottom: 0.125rem; }`,
    `.${ID}-prevThumb { flex: none; width: 4.5rem; height: 4.5rem; object-fit: cover; border-radius: 0.375rem; border: 1px solid var(--ui-stroke-secondary); cursor: zoom-in; background: var(--ui-bg-card); }`,
    `.${ID}-prevThumb:hover { border-color: var(--ui-accent); }`,
    `.${ID}-prevFull { width: 100%; max-height: 22rem; object-fit: contain; border-radius: 0.375rem; border: 1px solid var(--ui-stroke-secondary); cursor: zoom-out; background: var(--ui-bg-card); }`,
    `.${ID}-prevVideo { width: 100%; max-height: 20rem; border-radius: 0.375rem; border: 1px solid var(--ui-stroke-secondary); background: #000; }`,
    `.${ID}-prevPdf { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--ui-text-secondary); }`,
    `.${ID}-prevDoc { width: 100%; min-height: 20rem; border-radius: 0.375rem; border: 1px solid var(--ui-stroke-secondary); background: var(--ui-bg-card); }`,
    `.${ID}-prevName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 12rem; }`,
  ].join('\n')

  let style = document.getElementById(`${ID}-styles`)
  if (!style) {
    style = document.createElement('style')
    style.id = `${ID}-styles`
    document.head.appendChild(style)
  }
  if (style.textContent !== css) {
    style.textContent = css
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function relTime(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function absTime(iso) {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Bridge backend HTTPException details ("409: {\"detail\":\"…\"}") into the message.
function errText(e) {
  const raw = String(e?.message || e || '')
  const m = /"message"\s*:\s*"(?:[^"\\]|\\.)*"/.exec(raw)
  if (m) {
    try { return JSON.parse(`"${m[1]}"`) } catch { /* fall through */ }
  }
  return raw.slice(0, 300)
}

function asText(v) {
  return typeof v === 'string' ? v : (v?.target?.value ?? '')
}

function itemTitle(item) {
  if (item.subject) return item.subject
  const art = item.artifact || {}
  if (art.name) return `${item.type || 'approval'}: ${art.name} v${art.version || '?'}`
  return `${item.type || 'approval'} request`
}

function matches(item, needle) {
  if (!needle) return true
  const hay = [
    item.subject, item.type, item.owner, item.work_id,
    item.originating_agent, item.next_action,
    item.artifact && item.artifact.name, item.artifact && item.artifact.version,
    item.decision && item.decision.note,
  ].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(needle.toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────────
// Data hook + decide mutation
// ─────────────────────────────────────────────────────────────────────────

function useItems() {
  return useQuery({
    queryKey: [ID, 'items'],
    queryFn: async () => {
      const out = await rest('/items')
      return Array.isArray(out?.items) ? out.items : []
    },
    refetchInterval: 5000,
    staleTime: 10000,
    retry: 1,
  })
}

function useDecide() {
  return useMutation({
    mutationFn: ({ item, decision, note }) => rest('/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_id: item.msg_id,
        decision,
        note: note || '',
        artifact_version: (item.artifact || {}).version,
      }),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: [ID] }) },
    onError: (e) => { host?.notify?.({ kind: 'error', message: errText(e) || 'request failed' }) },
  })
}

function usePreview(msgId, hasFiles) {
  return useQuery({
    queryKey: [ID, 'preview', msgId],
    queryFn: async () => {
      const out = await rest(`/preview/${msgId}`)
      return Array.isArray(out?.items) ? out.items : []
    },
    staleTime: 60000,
    retry: 1,
    enabled: !!hasFiles,
  })
}

function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// ─────────────────────────────────────────────────────────────────────────
// Item card
// ─────────────────────────────────────────────────────────────────────────

const DOT = { pending: '#b45309', approved: '#047857', rejected: '#b91c1c' }

function StatusBadge({ status }) {
  return jsx(Badge, { variant: 'outline', children: [
    jsx('span', { className: `${ID}-dot`, style: { backgroundColor: DOT[status] || DOT.pending } }),
    jsx('span', { children: status }),
  ] })
}

function PreviewBlock({ msgId, hasFiles }) {
  const pv = usePreview(msgId, hasFiles)
  const [expanded, setExpanded] = useState(null)
  if (!hasFiles || pv.isLoading || pv.isError) return null
  const files = pv.data || []
  if (files.length === 0) return null
  const images = files.filter(f => f.kind === 'image' && f.data_url)
  const videos = files.filter(f => f.kind === 'video' && f.data_url)
  const pdfs = files.filter(f => f.kind === 'pdf')
  const rest = files.filter(f => !f.data_url && f.kind !== 'pdf')
  const big = expanded ? files.find(f => f.name === expanded) : null
  return jsxs('div', { className: `${ID}-prev`, children: [
    big && big.kind === 'image' ? jsx('img', { className: `${ID}-prevFull`, src: big.data_url, alt: big.name, onClick: () => setExpanded(null) }) : null,
    images.length > 0 ? jsx('div', { className: `${ID}-prevGrid`, children:
      images.map(f => jsx('img', { className: `${ID}-prevThumb`, src: f.data_url, alt: f.name, title: `${f.name} · tap to enlarge`, onClick: () => setExpanded(expanded === f.name ? null : f.name), key: f.name }))
    }) : null,
    ...videos.map(f => jsx('video', { className: `${ID}-prevVideo`, src: f.data_url, controls: true, preload: 'metadata', key: f.name })),
    ...pdfs.map(f => jsxs('div', { children: [
      jsxs('div', { className: `${ID}-prevPdf`, children: [
        f.thumb_url ? jsx('img', { className: `${ID}-prevThumb`, src: f.thumb_url, alt: `${f.name} first page`, title: `${f.name}${f.pages ? ` · ${f.pages} pages` : ''} · tap to read`, onClick: () => setExpanded(expanded === f.name ? null : f.name) }) : null,
        jsx('span', { className: `${ID}-prevName`, children: `${f.name}${f.pages ? ` · ${f.pages}p` : ''} · ${fmtSize(f.size)}` }),
        f.data_url ? jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setExpanded(expanded === f.name ? null : f.name), children: expanded === f.name ? 'Close' : 'Read' }) : null,
      ] }),
      expanded === f.name && f.data_url ? jsx('embed', { className: `${ID}-prevDoc`, src: f.data_url, type: 'application/pdf' }) : null,
    ], key: f.name })),
    ...rest.map(f => jsx('div', { className: `${ID}-prevPdf`, children: jsx('span', { className: `${ID}-prevName`, children: `${f.name} · ${fmtSize(f.size)} (too large to preview inline)` }), key: f.name })),
  ] })
}

function ItemCard({ item, decide, busy }) {
  const [rejectNote, setRejectNote] = useState((item.decision && item.decision.note) || '')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [approveOpen, setApproveOpen] = useState(false)
  const art = item.artifact || {}
  const decision = item.decision || {}
  const decided = item.status !== 'pending'
  const preview = item.preview_url || art.preview_url
  const title = itemTitle(item)

  const sendReject = () => {
    decide.mutate({ item, decision: 'reject', note: rejectNote })
    setRejectOpen(false)
  }

  return jsxs('div', { className: `${ID}-card${decided ? ` ${ID}-card-decided` : ''}`, children: [
    /* header: status badge + relative time */
    jsxs('div', { className: `${ID}-head`, children: [
      jsx(StatusBadge, { status: decided ? item.status : 'pending' }),
      jsx('span', { className: `${ID}-time`, title: absTime(item.ts), children: relTime(item.ts) || absTime(item.ts) || '' }),
    ]}),

    /* subject line */
    jsx('div', { className: `${ID}-subject`, children: title }),

    /* metadata rows */
    jsxs('div', { className: `${ID}-meta`, children: [
      jsx('div', { className: `${ID}-metaRow`, children: [jsx('span', { className: `${ID}-metaLabel`, children: 'Owner' }), jsx('span', { children: item.owner || item.originating_agent || '-' })] }),
      item.work_id ? jsx('div', { className: `${ID}-metaRow`, children: [jsx('span', { className: `${ID}-metaLabel`, children: 'Work' }), jsx('span', { children: item.work_id })] }) : null,
      art.name ? jsx('div', { className: `${ID}-metaRow`, children: [jsx('span', { className: `${ID}-metaLabel`, children: 'Artifact' }), jsx('span', { children: `${art.name} v${art.version || '?'}` })] }) : null,
      item.next_action ? jsx('div', { className: `${ID}-metaRow`, children: [jsx('span', { className: `${ID}-metaLabel`, children: 'Next action' }), jsx('span', { children: item.next_action })] }) : null,
      preview ? jsx('a', { href: String(preview), target: '_blank', rel: 'noopener noreferrer', className: `${ID}-preview`, children: 'Open preview' }) : null,
      (item.attachments && item.attachments.length > 0) ? jsx(PreviewBlock, { msgId: item.msg_id, hasFiles: true }) : null,
    ]}),

    /* decision controls */
    !decided ? jsxs('div', { className: `${ID}-actions`, children: [
      jsx(Button, { size: 'sm', onClick: () => setApproveOpen(true), disabled: busy || decide.isPending, children: (busy || decide.isPending) ? 'Working…' : 'Approve' }),
      jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => setRejectOpen(v => !v), disabled: busy || decide.isPending, children: 'Reject' }),
      rejectOpen ? jsxs('div', { className: `${ID}-reasonRow`, children: [
        jsx(Input, { value: rejectNote, onChange: (e) => setRejectNote(asText(e)), placeholder: 'Why reject? (sent with the decision)', 'aria-label': 'Rejection reason' }),
        jsx(Button, { size: 'sm', variant: 'outline', onClick: sendReject, disabled: busy || decide.isPending, children: (busy || decide.isPending) ? 'Working…' : 'Send rejection' }),
      ] }) : null,
      jsx(ConfirmDialog, {
        open: approveOpen,
        onClose: () => setApproveOpen(false),
        title: `Approve “${art.name || title}”?`,
        description: art.version ? `Version ${art.version}${item.next_action ? ` · next: ${item.next_action}` : ''}` : (item.next_action ? `Next: ${item.next_action}` : 'This records the approval.'),
        confirmLabel: 'Approve',
        onConfirm: async () => { decide.mutate({ item, decision: 'approve', note: '' }); setApproveOpen(false) },
      }),
    ] }) : jsxs('div', { className: `${ID}-actions`, children: [
      jsx(StatusBadge, { status: item.status }),
      decision.note ? jsx('div', { className: `${ID}-note`, style: { flexBasis: '100%' }, children: decision.note }) : null,
      jsx('span', { className: `${ID}-metaRow`, children: [
        jsx('span', { className: `${ID}-metaLabel`, children: 'By' }),
        jsx('span', { children: decision.by || item.originating_agent || '-' }),
      ] }),
      decision.ts ? jsx('span', { className: `${ID}-time`, children: '· ' + absTime(decision.ts) }) : null,
    ] }),
  ] })
}

// ─────────────────────────────────────────────────────────────────────────
// Pane
// ─────────────────────────────────────────────────────────────────────────

const FILTERS = [
  { id: 'need', label: 'Needs decision' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
]

function InboxPane() {
  const q = useItems()
  const decide = useDecide()
  const items = q.data || []
  const error = q.isError ? errText(q.error) : null

  const [prefs, setPrefsRaw] = useState(() => {
    try { return (storeGet && storeGet('inboxPrefs', {})) || {} } catch { return {} }
  })
  const setPrefs = (p) => {
    setPrefsRaw(p)
    try { storeSet && storeSet('inboxPrefs', p) } catch { /* prefs are best-effort */ }
  }
  const needle = prefs.q || ''
  const filter = prefs.filter || 'need'
  const setNeedle = (v) => setPrefs({ ...prefs, q: v })
  const setFilter = (v) => setPrefs({ ...prefs, filter: v })

  const pending = items.filter(i => i.status === 'pending')
  const counts = {
    need: pending.length,
    approved: items.filter(i => i.status === 'approved').length,
    rejected: items.filter(i => i.status === 'rejected').length,
    all: items.length,
  }

  const byNewest = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))
  let visible = items.filter(i => matches(i, needle)).sort(byNewest)
  if (filter === 'need') visible = visible.filter(i => i.status === 'pending')
  if (filter === 'approved') visible = visible.filter(i => i.status === 'approved')
  if (filter === 'rejected') visible = visible.filter(i => i.status === 'rejected')
  // Pending always floats above decided when browsing everything.
  if (filter === 'all') {
    const rank = (i) => (i.status === 'pending' ? 0 : 1)
    visible = [...visible].sort((a, b) => rank(a) - rank(b) || byNewest(a, b))
  }

  const emptyCopy = needle
    ? { title: 'No matching requests', description: 'Try a different search.' }
    : filter === 'need'
      ? { title: 'Nothing waiting', description: 'No approvals need your decision right now.' }
      : { title: 'Nothing here yet', description: 'Decided requests will appear under their filters.' }

  return jsxs('div', { className: `${ID}`, children: [
    /* themed header */
    jsxs('div', { className: `${ID}-header`, children: [
      jsx('button', { className: `${ID}-brand`, onClick: () => { if (host?.navigate) host.navigate(PAGE_PATH) }, children: [
        jsx('span', { className: `${ID}-title`, children: 'Approval Inbox' }),
      ] }),
      jsx(Badge, { variant: 'outline', children: `${pending.length} to review` }),
      jsx('span', { style: { flex: 1 } }),
      jsx(SearchField, {
        value: needle,
        onChange: (v) => setNeedle(asText(v)),
        placeholder: 'Search subject, owner, artifact…',
        'aria-label': 'Search approval requests',
        containerClassName: 'w-56',
      }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { queryClient.invalidateQueries({ queryKey: [ID] }) }, disabled: q.isPending, 'aria-label': 'Refresh inbox', children: q.isPending ? 'Refreshing…' : 'Refresh' }),
    ]}),

    /* filter row */
    jsx('div', { className: `${ID}-filters`, children:
      jsx(SegmentedControl, {
        value: filter,
        onChange: setFilter,
        options: FILTERS.map(f => ({ id: f.id, label: `${f.label} (${counts[f.id] ?? 0})` })),
      }),
    }),

    /* scrollable body */
    jsx('div', { className: `${ID}-body`, children: [
      jsx(ScrollArea, { className: `${ID}-scroll`, children:
        q.isLoading && items.length === 0
          ? jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(GlyphSpinner, {}) })
          : error
            ? jsxs('div', { className: 'grid h-full place-items-center gap-2 p-4', children: [
              jsx(ErrorState, { title: 'Could not load approvals', description: error }),
              jsx(Button, { size: 'xs', variant: 'outline', onClick: () => { queryClient.invalidateQueries({ queryKey: [ID] }) }, children: 'Retry' }),
            ] })
            : visible.length === 0
              ? jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(EmptyState, { title: emptyCopy.title, description: emptyCopy.description }) })
              : jsxs('div', { className: `${ID}-list`, children: [
                filter === 'all' && pending.length > 0 && counts.approved + counts.rejected > 0
                  ? jsx('div', { className: `${ID}-section`, children: `Needs decision (${pending.length})` }) : null,
                ...visible.map((it) => jsx(ItemCard, { item: it, decide, busy: decide.isPending, key: it.msg_id })),
              ] }),
      }),
    ]}),
  ] })
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Approval Inbox',
  description: 'One desktop inbox for approval requests routed through the default agent.',
  defaultEnabled: true,

  register(ctx) {
    ensureStyles()
    rest = ctx.rest
    if (ctx.storage) {
      storeGet = (key, fallback) => ctx.storage.get(key, fallback)
      storeSet = (key, value) => ctx.storage.set(key, value)
    }

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        render: () => jsx(InboxPane, {}),
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { codicon: 'inbox', label: 'Approval Inbox', path: PAGE_PATH },
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          label: 'Approval Inbox: Open',
          keywords: ['approval', 'inbox', 'approvals'],
          run: () => { if (host?.navigate) host.navigate(PAGE_PATH) },
        },
      },
    ])
  },
}
