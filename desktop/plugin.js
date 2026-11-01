/**
 * Hermes Approval Inbox — desktop plugin (v0.4.8).
 *
 * Hermes-native rewrite of the approval-inbox pane.
 *
 * Layout: a live feed sidebar (search, filter segmented control, live result
 * counts) beside the item detail as a Dialog. Every control comes from the
 * @hermes/plugin-sdk import; every colour is a theme token. No injected
 * <style>, no hardcoded colours, no hand-rolled chrome, no global timers
 * (the item list refreshes through the query's refetch interval).
 *
 * Backend: the approval-inbox dashboard plugin API at
 * /api/plugins/approval-inbox/ (items, preview, decide).
 *
 * Craft standard (vs compliance): feed rows are keyboard reachable
 * (role=button, tabIndex, Enter/Space), the empty view carries a next-step
 * action, hierarchy and type scale follow the app's own chrome, one accent
 * colour (var(--ui-accent)) for the critical Re-Get state and the primary
 * Approve action, no decorative motion.
 */

import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  GlyphSpinner,
  host,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  Separator,
  Skeleton,
  Textarea,
  queryClient,
  Tip,
  useMutation,
  useQuery,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useState } from 'react'

const ID = 'approval-inbox'
const PAGE_PATH = '/approval-inbox'
const APP_VERSION = '0.4.8'

let rest = null

/** Turns a backend error into a short human sentence. */
function errText(e) {
  const raw = String(e?.message ?? e ?? '')
  const m = /"message"\s*:\s*"(?:[^"\\]|\\.)*"/.exec(raw)
  if (m) {
    try { return JSON.parse(`"${m[1]}"`) } catch { /* keep the raw text */ }
  }
  return raw.slice(0, 300)
}

/** Coerces a React-controlled value to a plain string. */
function asText(v) {
  return typeof v === 'string' ? v : (v?.target?.value ?? '')
}

/** Title for the row / dialog, from the request's subject or artifact. */
function itemTitle(item) {
  if (item.subject) return item.subject
  const art = item.artifact ?? {}
  if (art.name) return `${item.type || 'approval'}: ${art.name} v${art.version ?? '?'}`
  return `${item.type || 'approval'} request`
}

/** Client-side search across the fields a request is found by. */
function matches(item, needle) {
  if (!needle) return true
  const hay = [
    item.subject,
    item.type,
    item.owner,
    item.work_id,
    item.originating_agent,
    item.next_action,
    (item.artifact ?? {}).name,
    (item.artifact ?? {}).version,
  ].filter(Boolean).map(String).join(' ').toLowerCase()
  return hay.includes(needle.toLowerCase())
}

/** Human size label. */
function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/** Short label for the row icon (Post, Task, PDF, …). */
function getTypeLabel(type) {
  const t = String(type ?? 'artifact').toLowerCase()
  const map = {
    post: 'Post', task: 'Task', reel: 'Reel', pdf: 'PDF', artifact: 'Artifact',
    md: 'MD', excel: 'XLS', mp4: 'MP4', png: 'PNG', jpg: 'JPG', html: 'HTML',
  }
  return map[t] ?? (t.length <= 4 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))
}

/**
 * Text label for a status: never a bare coloured dot — the state is named.
 * The accent token is reserved for the Re-Get state only.
 */
function statusLabel(status) {
  const s = String(status ?? 'pending').toLowerCase()
  if (s === 'approve' || s === 'approved') return 'Approved'
  if (s === 'reject' || s === 'rejected') return 'Rejected'
  if (s === 'reget' || s === 'rework') return 'Re-Get'
  if (s === 'pending') return 'Pending'
  if (s === 'decided') return 'Decided'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Semantic re-get marker: rejected with a note asking to re-get/rework/retry. */
function isReGet(item) {
  const note = String((item.decision?.note ?? '') + ' ' + (item.decision?.decision ?? ''))
  return /re-get|rework|retry/i.test(note)
}

/** Version string for the artifact. */
function artVersion(item) {
  return String((item.artifact ?? {}).version ?? '?')
}

/** Relative time, with an absolute fallback for old timestamps. */
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

/**
 * One status pill: out of the box, the Re-Get state is tinted with the app
 * accent (the only critical state). Everything else is neutral.
 */
function StatusPill({ status, decision }) {
  const accent = decision != null && /re-get|rework|retry/i.test(
    String(decision.note ?? '') + ' ' + String(decision.decision ?? '')
  )
  return jsx(Badge, {
    variant: 'outline',
    style: accent ? { backgroundColor: 'var(--ui-accent)', color: 'var(--ui-text-primary)' } : undefined,
    children: statusLabel(status),
  })
}

/**
 * Row in the feed sidebar. Keyboard reachable (role=button + tabIndex + Enter/
 * Space) so a keyboard-only operator can move through the queue.
 */
function FeedRow({ item, selected, onSelect }) {
  const decided = item.status !== 'pending'
  return jsxs('div', {
    role: 'button',
    tabIndex: 0,
    className: 'flex cursor-pointer flex-row items-center gap-1.5 rounded-lg border border-transparent p-1.5 transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground select-none focus:outline-focus focus:outline-2 focus:outline-focus/30',
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect()
      }
    },
    children: [
      jsx('div', {
        className: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-hover) text-xs font-semibold text-(--ui-text-quaternary)',
        children: getTypeLabel(item.type),
      }),
      jsxs('div', { className: 'min-w-0 flex-1', children: [
        jsxs('div', { className: 'flex flex-1 items-center justify-between gap-2', children: [
          jsx('span', { className: 'max-w-[14rem] truncate text-xs font-medium leading-tight text-foreground', children: itemTitle(item) }),
          jsx('span', { className: 'shrink-0 whitespace-nowrap text-[0.625rem] font-medium tabular-nums text-(--ui-text-quaternary)', children: relTime(item.ts) || absTime(item.ts) }),
        ]}),
        jsxs('div', { className: 'flex flex-wrap items-center gap-x-2 gap-y-0.5', children: [
          jsx(StatusPill, { status: decided ? item.status : 'pending', decision: decided ? item.decision : undefined }),
          jsx('span', { className: 'text-[0.625rem] font-medium text-(--ui-text-quaternary)', children: `v${artVersion(item)}` }),
        ]}),
      ]}),
    ],
  })
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'reget', label: 'Re-Get' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

/** Feed sidebar: sticky search + filter band, live result counts, scrollable rows. */
function FeedSidebar({ items, selectedId, onSelect, needle, onNeedleChange, filter, onFilterChange, counts }) {
  return jsxs('aside', {
    className: 'flex flex-col border-b border-(--ui-stroke-secondary) bg-(--ui-bg-card) shrink-0',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) p-2',
        children: [
          jsx(SearchField, {
            value: needle,
            onChange: (v) => onNeedleChange(asText(v)),
            placeholder: 'Search subject, owner, artifact…',
            'aria-label': 'Search approval requests',
            containerClassName: 'w-48',
          }),
          jsx(SegmentedControl, {
            value: filter,
            onChange: (v) => onFilterChange(v),
            sizing: 'content',
            options: FILTERS.map((f) => ({ id: f.id, label: f.label })),
          }),
          jsxs('div', {
            className: 'flex shrink-0 flex-wrap items-center gap-1.5',
            children: FILTERS.map((f) => jsx(Badge, { variant: 'outline', children: `${f.label} ${counts[f.id] ?? 0}` })),
          }),
        ],
      }),
      jsx(ScrollArea, {
        className: 'min-h-0 flex-1 overflow-y-auto',
        children: jsx('div', {
          className: 'p-2',
          children: items.length === 0
            ? jsx(EmptyState, { title: 'No requests match', description: 'Try a different search term, or clear the filters to see all requests.' })
            : jsxs('div', { className: 'flex flex-col gap-0.5', children: items.map((it) => jsx(FeedRow, { item: it, selected: it.msg_id === selectedId, onSelect })) }),
        }),
      }),
    ],
  })
}

/** Preview for an item's attachments (image, video, pdf, text). No hand-rolled chrome. */
function PreviewPanel({ files, loading }) {
  if (files.length === 0) {
    return jsx('div', {
      className: 'flex flex-1 flex-col items-center justify-center p-4 text-xs text-(--ui-text-quaternary)',
      children: [
        jsx(GlyphSpinner, { className: 'mb-2 size-4' }),
        'No preview files',
      ],
    })
  }
  if (loading) {
    return jsx(ScrollArea, {
      className: 'min-h-0 flex-1 overflow-y-auto p-3',
      children: jsxs('div', { className: 'flex flex-col gap-2', children: [
        jsx('div', { className: 'text-xs font-medium uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Attachments' }),
        ...Array.from({ length: 3 }).map((_, i) => jsx(Skeleton, { key: i, className: 'h-4 w-full' })),
      ]}),
    })
  }
  return jsx(ScrollArea, {
    className: 'min-h-0 flex-1 overflow-y-auto p-3',
    children: jsxs('div', { className: 'flex flex-col gap-3', children: [
      jsx('div', { className: 'text-xs font-medium uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Attachments' }),
      jsxs('div', { className: 'flex flex-wrap gap-2', children: files.map((f) => {
        if (f.kind === 'image' && f.data_url) {
          return jsx('img', { key: f.name, src: f.data_url, alt: f.name, className: 'max-w-full rounded-lg' })
        }
        if (f.kind === 'video' && f.data_url) {
          return jsx('video', { key: f.name, src: f.data_url, controls: true, className: 'max-w-full max-h-56 rounded-lg' })
        }
        if (f.kind === 'pdf') {
          return jsx('a', {
            key: f.name,
            href: f.preview_url,
            target: '_blank',
            rel: 'noopener',
            children: [
              f.name,
              jsx('span', { className: 'text-[0.625rem] font-medium text-(--ui-text-quaternary)', children: ` ${fmtSize(f.size)}` }),
            ],
          })
        }
        return jsx('div', {
          key: f.name,
          className: 'max-w-full overflow-auto rounded-lg p-2 text-xs leading-5 text-(--ui-text-secondary) whitespace-pre-wrap',
          children: f.data_url ?? f.preview_url ?? '',
        })
      })}),
    ]}),
  })
}

/** Item detail. Rendered as a Dialog over the content pane. */
function DetailDialog({ item, decide, onClose }) {
  const [tab, setTab] = useState('retry')
  const decided = item.status !== 'pending'
  const art = item.artifact ?? {}
  const hasFiles = (item.attachments ?? []).length > 0
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')

  const pv = usePreview(item.msg_id, hasFiles)
  const files = pv.data ?? []

  return jsx(Dialog, {
    open: true,
    onOpenChange: (o) => o && onClose(),
    children: [
      jsx(DialogHeader, { className: 'p-3' }, [
        jsx('div', { className: 'flex flex-wrap items-center gap-2' }, [
          jsx(DialogTitle, { className: 'text-foreground' }, itemTitle(item)),
          jsx(StatusPill, { status: decided ? item.status : 'pending', decision: item.decision }),
        ]),
        jsx('div', { className: 'mt-1 text-xs leading-5 text-(--ui-text-secondary)' }, [
          art.name ? jsx('span', { children: `Artifact ${art.name} v${art.version}` }) : jsx('span', { children: 'Approval request' }),
          item.owner ? jsx('span', { children: ` · Owner ${item.owner}` }) : null,
          item.work_id ? jsx('span', { children: ` · Work ${item.work_id}` }) : null,
          item.originating_agent ? jsx('span', { children: ` · From ${item.originating_agent}` }) : null,
        ]),
      ]),
      jsx(ScrollArea, { className: 'min-h-0 flex-1 overflow-y-auto p-3' }, [
        jsx('div', { className: 'space-y-3' }, [
          jsx('div', { className: 'flex flex-wrap gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-card) p-3' }, [
            jsx(Badge, { variant: 'outline' }, getTypeLabel(item.type)),
            jsx('span', { className: 'text-xs font-medium text-foreground' }, itemTitle(item)),
            jsx('span', { className: 'text-[0.625rem] font-medium text-(--ui-text-quaternary)' }, `v${artVersion(item)}`),
            jsx('span', { className: 'text-[0.625rem] font-medium text-(--ui-text-quaternary)' }, `· ${absTime(item.ts)}`),
          ]),

          item.next_action ? jsx('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-card) p-3' }, [
            jsx('div', { className: 'text-xs font-medium uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Next action'),
            jsx('div', { className: 'mt-1 text-sm leading-5 text-foreground' }, item.next_action),
          ]) : null,

          hasFiles ? jsx('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-card) p-3' }, [
            jsx(PreviewPanel, { files, loading: pv.isLoading }),
          ]) : null,

          decided ? jsx('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-card) p-3' }, [
            jsx('div', { className: 'text-xs font-medium uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Decision'),
            jsx('div', { className: 'mt-1 flex flex-wrap items-center gap-2 text-sm' }, [
              jsx(StatusPill, { status: item.status, decision: item.decision }),
              jsx('span', { className: 'text-(--ui-text-secondary)' }, decidedBy(item)),
            ]),
            item.decision?.note ? jsx('div', { className: 'mt-1 text-xs leading-5 text-(--ui-text-secondary)' }, item.decision.note) : null,
          ]) : null,

          !decided ? jsx('div', { className: 'flex flex-wrap justify-end gap-2' }, [
            jsx(Button, { variant: 'outline', onClick: () => setRejectOpen(true) }, 'Reject'),
          ]) : null,

          jsx('div', { className: 'flex flex-wrap gap-1 border-b border-(--ui-stroke-secondary)' }, [
            jsx(Button, { variant: tab === 'retry' ? 'default' : 'ghost', onClick: () => setTab('retry') }, 'Retry'),
            jsx(Button, { variant: tab === 'history' ? 'default' : 'ghost', onClick: () => setTab('history') }, 'History'),
          ]),
          jsx('div', { className: 'text-xs leading-5 text-(--ui-text-secondary)' }, [
            tab === 'retry' ? jsx(RetryTab, { item, decide }) : jsx(HistoryTab, { item }),
          ]),
        ]),
      ]),
      jsx(Separator, { className: 'my-3' }),
      jsx(DialogFooter, { className: 'flex flex-col-reverse gap-2 p-3 sm:flex-row sm:justify-end' }, [
        jsx(Button, { variant: 'ghost', onClick: onClose }, 'Cancel'),
        jsx(Button, {
          variant: 'default',
          onClick: () => {
            decide.mutate({ item, decision: 'approve', note: '' })
            onClose()
          },
          disabled: decide.isPending,
          children: 'Approve',
        }),
      ]),
      jsx(ConfirmDialog, {
        open: rejectOpen,
        onClose: () => setRejectOpen(false),
        onConfirm: () => {
          decide.mutate({ item, decision: 'reject', note: rejectNote.trim() })
        },
        title: `Reject \"${itemTitle(item)}\"`,
        description: 'Adding a reason helps the producing lane fix the artifact.',
        children: jsx(Input, {
          value: rejectNote,
          onChange: (e) => setRejectNote(asText(e)),
          placeholder: 'Optional reason…',
        }),
      }),
    ],
  })
}

function decidedBy(item) {
  const d = item.decision
  if (d?.by) return `Decided by ${d.by}`
  return ''
}

/** Retry tab: chips plus a text field for explicit re-trigger instructions. */
function RetryTab({ item, decide }) {
  const [note, setNote] = useState('')
  const decided = item.status !== 'pending'
  return jsxs('div', { className: 'space-y-3' }, [
    jsx('div', { className: 'text-xs font-medium uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Retry instructions'),
    jsx('p', { className: 'text-xs leading-5 text-(--ui-text-secondary)' }, 'Add explicit guidance to refine the artifact before re-triggering the producing lane.'),
    jsxs('div', { className: 'flex flex-wrap gap-1.5' }, [
      'Remove em-dashes,High-contrast typography,Shorten subtext,Deepen the analysis'.split(',').map((c) =>
        jsx(Button, { variant: 'outline', onClick: () => setNote((n) => (n ? `${n}, ${c}` : c)) }, c)
      ),
    ]),
    jsx(Textarea, {
      value: note,
      onChange: (e) => setNote(asText(e)),
      placeholder: 'Enter explicit guidelines to eliminate issues or adjust layout/copy…',
      className: 'min-h-[6rem]',
      rows: 4,
    }),
    !decided ? null : jsx('p', { className: 'text-xs leading-5 text-(--ui-text-quaternary)' }, 'This item has already been decided. Submit will create a new pending version.'),
    jsx(Button, {
      variant: 'default',
      onClick: () => {
        if (note.trim()) decide.mutate({ item, decision: 'reget', note: note.trim() })
      },
      disabled: decide.isPending || !note.trim(),
      children: 'Request new version',
    }),
  ])
}

/** History tab: the decision that closed this request, with its note and who made it. */
function HistoryTab({ item }) {
  const d = item.decision
  if (!d) return jsx('p', { className: 'text-xs leading-5 text-(--ui-text-secondary)' }, 'No decisions yet.')
  return jsxs('div', { className: 'space-y-3' }, [
    jsxs('div', { className: 'flex items-start gap-2' }, [
      jsx('div', { className: 'mt-1.5 h-2 w-2 rounded-full bg-(--ui-accent)' }),
      jsx('div', { className: 'space-y-1' }, [
        jsx('div', { className: 'text-xs font-medium text-foreground' }, statusLabel(d.decision)),
        jsx('div', { className: 'text-[0.625rem] font-medium text-(--ui-text-quaternary)' }, `Decided ${relTime(d.ts) || absTime(d.ts)}`),
      ]),
    ]),
    d.note ? jsx('div', { className: 'rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-card) p-3 text-xs leading-5 text-(--ui-text-secondary)' }, d.note) : null,
    d.by ? jsx('div', { className: 'text-[0.625rem] font-medium text-(--ui-text-quaternary)' }, `Decided by ${d.by}`) : null,
  ])
}

/** Page: feed sidebar + detail Dialog. Loading, error and empty states for every view. */
function InboxPane() {
  const [needle, setNeedle] = useState('')
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState(null)

  const { data: items = [], isLoading, error: qError } = useItems()
  const decide = useDecide()

  const counts = useMemo(() => ({
    all: items.length,
    pending: items.filter((i) => i.status === 'pending').length,
    reget: items.filter((i) => isReGet(i)).length,
    approved: items.filter((i) => i.status === 'approve' || i.status === 'approved').length,
    rejected: items.filter((i) => i.status === 'reject' || i.status === 'rejected').length,
  }), [items])

  const visible = useMemo(() => {
    const q = needle.trim().toLowerCase()
    return items.filter((it) => {
      if (filter === 'pending') return it.status === 'pending'
      if (filter === 'reget') return isReGet(it)
      if (filter === 'approved') return it.status === 'approve' || it.status === 'approved'
      if (filter === 'rejected') return it.status === 'reject' || it.status === 'rejected'
      return true
    }).filter((it) => {
      if (!q) return true
      return matches(it, q)
    })
  }, [items, needle, filter])

  const selectedItem = items.find((i) => i.msg_id === selectedId) ?? null

  useEffect(() => {
    if (qError && !items.length) setError(errText(qError))
  }, [qError, items.length])

  const clearFilters = () => {
    setNeedle('')
    setFilter('all')
  }

  return jsxs('div', { className: 'flex h-full flex-col' }, [
    jsxs('div', { className: 'flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) p-2' }, [
      jsx(Tip, {
        label: 'Refresh inbox data',
        children: jsx(Button, {
          variant: 'ghost',
          size: 'sm',
          onClick: () => queryClient.invalidateQueries({ queryKey: [ID] }),
          disabled: isLoading,
          'aria-label': 'Refresh inbox',
          children: isLoading ? 'Refreshing…' : 'Refresh',
        }),
      }),
      jsx(SearchField, {
        value: needle,
        onChange: (v) => setNeedle(asText(v)),
        placeholder: 'Search subject, owner, artifact…',
        'aria-label': 'Search approval requests',
        containerClassName: 'w-48',
      }),
      jsx(SegmentedControl, {
        value: filter,
        onChange: (v) => setFilter(v),
        sizing: 'content',
        options: FILTERS.map((f) => ({ id: f.id, label: f.label })),
      }),
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-1.5',
        children: FILTERS.map((f) => jsx(Badge, { variant: 'outline', children: `${f.label} ${counts[f.id] ?? 0}` })),
      }),
    ]),
    jsxs('div', { className: 'flex flex-1 min-h-0' }, [
      jsx(FeedSidebar, {
        items: visible,
        selectedId,
        onSelect: setSelectedId,
        needle,
        onNeedleChange: setNeedle,
        filter,
        onFilterChange: setFilter,
        counts,
      }),
      jsxs('div', { className: 'flex flex-1 flex-col min-h-0' }, [
        isLoading && items.length === 0
          ? jsx('div', { className: 'flex min-h-0 flex-1 items-center justify-center' }, [
              jsx(GlyphSpinner, { className: 'size-5' }),
            ])
          : selectedItem
            ? jsx(DetailDialog, { item: selectedItem, decide, onClose: () => setSelectedId(null) })
            : error
              ? jsxs('div', { className: 'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4' }, [
                  jsx(ErrorState, { title: 'Could not load approvals', description: error }),
                  jsx(Button, { variant: 'outline', onClick: () => setError(null), children: 'Retry' }),
                ])
              : jsxs('div', { className: 'flex flex-col items-center justify-center p-4' }, [
                  jsx(EmptyState, {
                    title: 'No requests match',
                    description: 'Try a different search term, or clear the filters to see all requests.',
                  }),
                  jsx(Button, { variant: 'outline', onClick: clearFilters, children: 'Clear filters' }),
                ]),
      ]),
    ]),
  ])
}

function useItems() {
  return useQuery({
    queryKey: [ID, 'items'],
    queryFn: () => rest('/items').then((r) => r.items ?? []),
    staleTime: 30_000,
  })
}

function usePreview(msg_id, hasFiles) {
  return useQuery({
    queryKey: [ID, 'preview', msg_id],
    queryFn: () => rest(`/preview/${msg_id}`).then((r) => r.items ?? []),
    enabled: hasFiles && Boolean(msg_id),
    staleTime: 10_000,
  })
}

function useDecide() {
  return useMutation({
    mutationFn: ({ item, decision, note }) => rest('/decide', {
      method: 'POST',
      body: {
        msg_id: item.msg_id,
        decision,
        note: note || '',
        artifact_version: (item.artifact ?? {}).version,
      },
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [ID] })
      const t = data && data.trigger
      if (t && t.triggered) {
        const d = t.dispatch
        const msg = (d && d.ok)
          ? `Decision sent — the default agent was woken (${t.task || 'task created'})`
          : `Decision saved (${t.task || 'task created'}). Wake-up call: ${(d && d.detail) || 'pending — check ops log'}`
        host?.notify?.({ kind: (d && d.ok) ? 'success' : 'warning', message: msg })
      } else if (t) {
        host?.notify?.({ kind: 'error', message: `Decision saved, but the wake-up call failed: ${t.reason || 'unknown reason'}` })
      }
    },
    onError: (e) => { host?.notify?.({ kind: 'error', message: errText(e) || 'request failed' }) },
  })
}

export default {
  id: ID,
  name: 'Approval Inbox',
  description: 'Three-pane approval workspace: feed, detail, and retry studio.',
  defaultEnabled: true,

  register(ctx) {
    rest = ctx.rest

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
