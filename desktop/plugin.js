/**
 * Hermes Approval Inbox — desktop plugin.
 *
 * One surface for approval requests routed through the default agent.
 * Mirrors the hermes-newswire pane pattern:
 *   themed header, item cards with status badges, loading/empty/error
 *   states, preview/open action, refresh control, and error notify.
 *
 * Backend (dashboard/plugin_api.py) mounts at /api/plugins/approval-inbox/.
 *
 * Design notes (Founder order 2026-10-27):
 *   - Decision carries the reason: reject is a two-step (open reason input,
 *     send with note). The backend /decide already takes `note`.
 *   - Decided rows show decision + note + actor.
 *   - Pending / approved / rejected badges; approve/reject only while pending.
 *   - No bare divs where a themed component belongs.
 */

import {
  ErrorState, GlyphSpinner, host, Input,
  ScrollArea, useQuery, queryClient,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const ID = 'approval-inbox'
const PAGE_PATH = '/approval-inbox'

// Assigned in register(ctx) — components can't see ctx directly.
let rest = null

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
    `.${ID}-count { flex: none; font-size: 0.75rem; color: var(--ui-text-secondary); }`,
    `.${ID}-actions { display: flex; align-items: center; gap: 0.5rem; flex: none; }`,
    `.${ID}-refresh { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 1.25rem; height: 1.25rem; background: none; border: 0; cursor: pointer; color: var(--ui-text-secondary); border-radius: 0.25rem; padding: 0; font-size: 0.75rem; }`,
    `.${ID}-refresh:hover { background: var(--chrome-action-hover); color: var(--ui-text-primary); }`,
    `.${ID}-refresh:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }`,
    /* body */
    `.${ID}-body { flex: 1 1 auto; min-height: 0; }`,
    `.${ID}-scroll { flex: 1 1 auto; overflow: auto; padding: 0.5rem; }`,
    /* item card */
    `.${ID}-card { border: 1px solid var(--ui-stroke-secondary); border-radius: 0.5rem; padding: 0.75rem 0.875rem; margin-bottom: 0.5rem; background: var(--ui-bg-card); cursor: default; }`,
    `.${ID}-card:hover { border-color: var(--ui-accent); }`,
    `.${ID}-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }`,
    `.${ID}-status { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.6875rem; font-weight: 600; padding: 0.125rem 0.5rem; border-radius: 999px; letter-spacing: 0.02em; }`,
    `.${ID}-status-pending { color: #b45309; background: #fef3c7; }`,
    `.${ID}-status-approved { color: #047857; background: #d1fae5; }`,
    `.${ID}-status-rejected { color: #b91c1c; background: #fee2e2; }`,
    `.${ID}-dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; }`,
    `.${ID}-meta { display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.75rem; color: var(--ui-text-secondary); }`,
    `.${ID}-metaRow { display: flex; gap: 0.5rem; align-items: baseline; }`,
    `.${ID}-metaLabel { flex: none; min-width: 4.5rem; color: var(--ui-text-quaternary); font-weight: 500; }`,
    `.${ID}-preview { display: inline-flex; align-items: center; gap: 0.25rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--ui-stroke-tertiary); color: var(--ui-accent); text-decoration: none; font-size: 0.75rem; }`,
    `.${ID}-preview:hover { color: var(--ui-text-primary); }`,
    /* decision controls */
    `.${ID}-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--ui-stroke-tertiary); }`,
    `.${ID}-reasonRow { display: flex; gap: 0.5rem; align-items: center; flex: 1; min-width: 0; }`,
    `.${ID}-reasonRow input { flex: 1; min-width: 0; font: inherit; font-size: 0.75rem; color: var(--ui-text-primary); background: var(--ui-bg-card); border: 1px solid var(--ui-stroke-secondary); border-radius: 0.375rem; padding: 0.25rem 0.5rem; }`,
    `.${ID}-reasonRow input:focus-visible { outline: 1px solid var(--ui-accent); outline-offset: -1px; }`,
    `.${ID}-note { font-size: 0.75rem; color: var(--ui-text-secondary); white-space: pre-line; line-height: 1.4; }`,
    `.${ID}-time { font-size: 0.6875rem; color: var(--ui-text-quaternary); white-space: nowrap; }`,
    /* empty / error */
    `.${ID}-empty { padding: 1.5rem; text-align: center; color: var(--ui-text-secondary); }`,
    `.${ID}-error { padding: 1rem; color: var(--ui-red, #e5484d); }`,
    `.${ID}-error button { margin-top: 0.5rem; }`,
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

// Bridge backend HTTPException details ("409: {"detail":"…"}") into the message.
function errText(e) {
  const raw = String(e?.message || e || '')
  const m = /"message"\s*:\s*"(?:[^"\\]|\\.)*"/.exec(raw)
  if (m) {
    try { return JSON.parse(`"${m[1]}"`) } catch { /* fall through */ }
  }
  return raw.slice(0, 300)
}

// ─────────────────────────────────────────────────────────────────────────
// Data hook
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

// ─────────────────────────────────────────────────────────────────────────
// Item card
// ─────────────────────────────────────────────────────────────────────────

function ItemCard({ item }) {
  const [busy, setBusy] = useState(false)
  const [rejectNote, setRejectNote] = useState(item.decision?.note || '')
  const [rejectOpen, setRejectOpen] = useState(false)
  const art = item.artifact || {}
  const decision = item.decision || {}
  const decided = item.status !== 'pending'
  const preview = item.preview_url || art.preview_url || art.name

  const decide = async (decisionValue) => {
    setBusy(true)
    const note = decisionValue === 'reject' ? rejectNote : (decision.note || '')
    await rest('/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_id: item.msg_id, decision: decisionValue, note, artifact_version: art.version }),
    })
      .catch((e) => {
        const msg = errText(e) || 'request failed'
        host?.notify?.({ kind: 'error', message: msg })
      })
      .finally(() => setBusy(false))
  }

  return jsxs('div', { className: `${ID}-card`, children: [
    /* header: status badge + relative time */
    jsxs('div', { className: `${ID}-head`, children: [
      jsx('span', {
        className: `${ID}-status ${decided ? `${ID}-status-${item.status}` : `${ID}-status-pending`}`,
        children: [
          jsx('span', { className: `${ID}-dot`, style: { backgroundColor: decided ? (item.status === 'approved' ? '#047857' : '#b91c1c') : '#b45309' } }),
          jsx('span', { children: decided ? item.status : 'pending' }),
        ],
      }),
      jsx('span', { className: `${ID}-time`, children: relTime(item.ts) || absTime(item.ts) || '' }),
    ]}),

    /* metadata rows */
    jsxs('div', { className: `${ID}-meta`, children: [
      jsx('div', { className: `${ID}-metaRow`, children: [ jsx('span', { className: `${ID}-metaLabel`, children: 'Type' }), jsx('span', { children: item.type || '-' }) ] }),
      jsx('div', { className: `${ID}-metaRow`, children: [ jsx('span', { className: `${ID}-metaLabel`, children: 'Owner' }), jsx('span', { children: item.owner || '-' }) ] }),
      jsx('div', { className: `${ID}-metaRow`, children: [ jsx('span', { className: `${ID}-metaLabel`, children: 'Work' }), jsx('span', { children: item.work_id || '-' }) ] }),
      jsx('div', { className: `${ID}-metaRow`, children: [ jsx('span', { className: `${ID}-metaLabel`, children: 'Artifact' }), jsx('span', { children: art.name ? `${art.name} v${art.version || '-'}` : 'none on record' }) ] }),
      jsx('div', { className: `${ID}-metaRow`, children: [ jsx('span', { className: `${ID}-metaLabel`, children: 'Next action' }), jsx('span', { children: item.next_action || '-' }) ] }),
      preview ? jsx('a', { href: String(preview), target: '_blank', rel: 'noopener noreferrer', className: `${ID}-preview`, children: [ 'Preview/Open' ] }) : null,
    ]}),

    /* decision controls */
    !decided ? jsx('div', { className: `${ID}-actions`, children: [
      jsx('button', { size: 'sm', onClick: () => decide('approve'), disabled: busy, children: busy ? 'Working…' : 'Approve' }),
      jsx('button', { size: 'sm', variant: 'ghost', onClick: () => setRejectOpen(v => !v), disabled: busy, children: 'Reject' }),
      rejectOpen ? jsx('div', { className: `${ID}-reasonRow`, children: [
        jsx(Input, { value: rejectNote, onChange: (e) => setRejectNote(typeof e === 'string' ? e : e?.target?.value ?? ''), placeholder: 'Why reject?' }),
        jsx('button', { size: 'sm', onClick: () => { decide('reject'); setRejectOpen(false) }, disabled: busy, children: busy ? 'Working…' : 'Reject' }),
      ] }) : null,
    ] }) : jsxs('div', { className: `${ID}-actions`, children: [
      jsx('span', { className: `${ID}-metaRow`, children: [
        jsx('span', { className: `${ID}-metaLabel`, children: 'Decided' }),
        jsx('span', { className: `${ID}-metaLabel`, children: decision.decision || '-' }),
      ] }),
      decision.note ? jsx('div', { className: `${ID}-note`, children: decision.note }) : null,
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

function InboxPane() {
  const q = useItems()
  const items = q.data || []
  const error = q.isError ? errText(q.error) : null

  return jsxs('div', { className: `${ID}`, children: [
    /* themed header */
    jsxs('div', { className: `${ID}-header`, children: [
      jsx('button', { className: `${ID}-brand`, onClick: () => { if (host?.navigate) host.navigate(PAGE_PATH) }, children: [
        jsx('span', { className: `${ID}-title`, children: 'Approval Inbox' }),
      ] }),
      jsx('span', { className: `${ID}-count`, children: `${items.length} pending` }),
      jsx('button', { size: 'xs', variant: 'ghost', onClick: () => { queryClient.invalidateQueries({ queryKey: [ID] }) }, disabled: q.isPending, children: 'Refresh' }),
    ]}),

    /* scrollable body */
    jsx('div', { className: `${ID}-body`, children: [
      jsx(ScrollArea, { className: `${ID}-scroll`, children: [
        q.isLoading && items.length === 0 ? jsx('div', { className: 'grid h-full place-items-center', children: jsx(GlyphSpinner, {}) }) : null,
        error ? jsx('div', { className: `${ID}-error`, children: error }) : null,
        items.length === 0 && !q.isLoading && !error ? jsx('div', { className: `${ID}-empty`, children: 'No approvals are waiting for a decision.' }) : null,
        items.map((it) => jsx(ItemCard, { item: it, key: it.msg_id })),
      ]}),
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
  defaultEnabled: false,

  register(ctx) {
    ensureStyles()
    rest = ctx.rest

    ctx.registerMany([
      {
        id: 'page',
        area: 'ROUTES_AREA',
        data: { path: PAGE_PATH },
        render: () => jsx(InboxPane, {}),
      },
      {
        id: 'nav',
        area: 'SIDEBAR_NAV_AREA',
        order: 60,
        data: { codicon: 'inbox', label: 'Approval Inbox', path: PAGE_PATH },
      },
    ])
  },
}
