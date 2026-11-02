/**
 * Hermes Approval Inbox — desktop plugin.
 *
 * Single-column inbox (the pane design contract): header row (title, pending
 * count, search, refresh) → filter row (counts in the labels) → the request
 * list → the selected request's detail, with the Retry-Studio / Audit-Trail
 * section stacked beneath it. No fixed-width side panes: every block is
 * `w-full min-w-0`, so the panel renders correctly at any pane width instead
 * of crushing a text column to one character per line.
 *
 * Reuses proven data hooks and UI components. No external AI calls, no
 * external image URLs, no demo data.
 *
 * Styling is native: every colour resolves to one of the Desktop's own
 * `--ui-*` theme custom properties, every action is an SDK `Button` /
 * `SegmentedControl` / `ConfirmDialog`, and the layout uses the same class
 * utilities the app's bundled panels use. No injected stylesheet, no literal
 * colour, so the surface follows the app's light/dark themes for free.
 *
 * Backend: dashboard/plugin_api.py at /api/plugins/approval-inbox/.
 */

import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorState, GlyphSpinner,
  captureGatewayFileDownload,
  host, Input, PALETTE_AREA, ROUTES_AREA, ScrollArea, SearchField,
  SegmentedControl, SIDEBAR_NAV_AREA, queryClient,
  useMutation, useQuery,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect } from 'react'

const ID = 'approval-inbox'
const PAGE_PATH = '/approval-inbox'
const APP_VERSION = '0.9.0'

let rest = null
let storeGet = null
let storeSet = null

// Theme tokens defined by the Desktop stylesheet. The app's own panels colour
// themselves with these; using them here keeps the inbox in theme (light and
// dark) instead of pinned to a literal.
const T = {
  accent: 'var(--ui-accent)',
  accent2: 'var(--ui-accent-secondary)',
  red: 'var(--ui-red)',
  orange: 'var(--ui-orange)',
  yellow: 'var(--ui-yellow)',
  green: 'var(--ui-green)',
  purple: 'var(--ui-purple)',
  blue: 'var(--ui-blue)',
  cyan: 'var(--ui-cyan)',
  base: 'var(--ui-bg-primary)',
  past: 'var(--ui-text-quaternary)',
}

// Tints are derived from the token itself (no second literal, no opacity hack).
function tint(token, pct) {
  return `color-mix(in srgb, ${token} ${pct}%, transparent)`
}

const TYPE_TOKEN = {
  post: T.accent, task: T.accent, reel: T.red, pdf: T.orange,
  artifact: T.accent, md: T.purple, excel: T.green, mp4: T.red,
  png: T.blue, jpg: T.cyan,
}

function typeToken(type) {
  return TYPE_TOKEN[(type || 'artifact').toLowerCase()] || T.accent
}

function typeStyle(type) {
  const c = typeToken(type)
  return { color: c, backgroundColor: tint(c, 14), borderColor: tint(c, 38) }
}

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

function decodeDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return ''
  const m = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return dataUrl
  try {
    return atob(m[2])
  } catch {
    return dataUrl
  }
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

function renderSimpleMd(text) {
  if (!text) return ''
  let s = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(/^### (.*$)/gim, '<h3>$1</h3>')
       .replace(/^## (.*$)/gim, '<h2>$1</h2>')
       .replace(/^# (.*$)/gim, '<h1>$1</h1>')
       .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
       .replace(/\*(.*?)\*/g, '<em>$1</em>')
       .replace(/^\- (.*$)/gim, '<li>$1</li>')
       .replace(/^&gt; (.*$)/gim, '<blockquote>$1</blockquote>')
       .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  s = s.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')
  return `<p>${s}</p>`
}

function getTypeLabel(type) {
  const t = (type || 'artifact').toLowerCase()
  const map = { post: 'Post', task: 'Task', reel: 'Reel', pdf: 'PDF', artifact: 'Artifact', md: 'MD', excel: 'XLS', mp4: 'MP4', png: 'PNG', jpg: 'JPG' }
  return map[t] || (t.length <= 4 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))
}

function typeIcon(type) {
  const t = (type || 'artifact').toLowerCase()
  const map = {
    pdf: 'codicon-file-pdf', md: 'codicon-markdown', html: 'codicon-code',
    png: 'codicon-file-media', jpg: 'codicon-file-media', jpeg: 'codicon-file-media',
    svg: 'codicon-file-media', mp4: 'codicon-play-circle', reel: 'codicon-play-circle',
    post: 'codicon-edit', task: 'codicon-checklist', excel: 'codicon-table',
    release: 'codicon-tag', artifact: 'codicon-file',
  }
  return map[t] || 'codicon-file'
}

// Approval text per artifact format: what the reviewer is looking at, and what
// approving it actually does. One line, format-specific.
const FORMAT_COPY = {
  'application/pdf': 'PDF document — check the version and the page count before approving.',
  'text/html': 'HTML page — open the rendered page; approving publishes this build.',
  'image/png': 'Raster image (PNG) — check resolution and legibility at full size; approving releases this asset.',
  'image/jpeg': 'Raster image (JPG) — check for compression artifacts at full size; approving releases this asset.',
  'image/webp': 'Raster image (WEBP) — check it at full size; approving releases this asset.',
  'image/gif': 'Animated image (GIF) — check the loop; approving releases this asset.',
  'image/svg+xml': 'Vector graphic (SVG) — scales to any size; approving releases this graphic.',
  'text/markdown': 'Markdown document — read it end to end; approving publishes this text.',
  'video/mp4': 'Video (MP4) — watch the cut to the end before approving.',
  'video/webm': 'Video (WEBM) — watch the cut to the end before approving.',
}

function formatCopy(contentType) {
  return FORMAT_COPY[contentType] || ''
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.round(sec % 60)).padStart(2, '0')}`
}

function showToast(message, kind = 'info') {
  host?.notify?.({ kind, message })
}

const DOT = { pending: T.yellow, approved: T.green, rejected: T.red }

function metricChip(label, count, token) {
  return jsxs(Badge, { variant: 'outline', children: [
    jsx('span', { className: 'size-2 shrink-0 rounded-full', style: { backgroundColor: token } }),
    jsxs('span', { children: [label, ': ', String(count)] }),
  ] })
}

function StatusBadge({ status }) {
  return jsxs(Badge, { variant: 'outline', children: [
    jsx('span', { className: 'size-2 shrink-0 rounded-full', style: { backgroundColor: DOT[status] || DOT.pending } }),
    jsx('span', { children: status }),
  ] })
}

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
      body: {
        msg_id: item.msg_id,
        decision,
        note: note || '',
        artifact_version: (item.artifact || {}).version,
      },
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [ID] })
      const t = data && data.trigger
      if (t && t.triggered) {
        const d = t.dispatch
        const msg = (d && d.ok)
          ? `Decision sent — the default agent was woken (${t.task || 'task created'})`
          : `Decision sent (${t.task || 'task created'}). Wake-up call: ${(d && d.detail) || 'pending — check ops log'}`
        host?.notify?.({ kind: (d && d.ok) ? 'success' : 'warning', message: msg })
      } else if (t) {
        host?.notify?.({ kind: 'error', message: `Decision saved, but the wake-up call failed: ${t.reason || 'unknown reason'}` })
      }
    },
    onError: (e) => { host?.notify?.({ kind: 'error', message: errText(e) || 'request failed' }) },
  })
}

// The SDK's file-save door, captured alongside each preview read (the documented
// pattern: capture immediately before the REST read and keep the action with the
// data) and keyed by file name. It carries that read's connection/profile scope, so
// it is never captured at click time; a save always streams the gateway's own
// persisted path through Electron's authenticated bridge and native dialog.
const doorByFile = {}

function usePreview(msgId, hasFiles) {
  return useQuery({
    queryKey: [ID, 'preview', msgId],
    queryFn: async () => {
      const door = typeof captureGatewayFileDownload === 'function' ? captureGatewayFileDownload() : null
      const out = await rest(`/preview/${msgId}`)
      const items = Array.isArray(out?.items) ? out.items : []
      if (door) for (const f of items) if (f && f.name) doorByFile[f.name] = door
      return items
    },
    staleTime: 60000,
    retry: 1,
    enabled: !!hasFiles,
  })
}

// One PDF page as an image. The Desktop ships no PDF viewer inside a plugin pane, so
// the page travels from the backend as its rendered bytes and is drawn as an image —
// inside the SDK's absolute-http(s)/data: contract, with no extra dependency.
function usePdfPage(msgId, name, n, enabled) {
  return useQuery({
    queryKey: [ID, 'page', msgId, name, n],
    queryFn: async () => {
      const out = await rest(`/page/${encodeURIComponent(msgId)}/${encodeURIComponent(name)}?n=${n}`)
      return out && out.data_url ? out : null
    },
    staleTime: 300000,
    retry: 1,
    enabled: !!enabled && !!name,
  })
}

function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

const VIEWPORT = 'w-full max-w-full overflow-auto rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-4'

// The plugin's own backend namespace. Kept only for the documented file route —
// note that a plugin may render absolute http(s): or data: URLs only, so nothing
// here is used as a rendered src.
const API_BASE = '/api/plugins/approval-inbox'
function fileUrl(msgId, name) {
  return `${API_BASE}/files/${encodeURIComponent(msgId || '')}/${encodeURIComponent(name || '')}`
}

// Transparent artwork (a white logo, a cut-out PNG) is invisible on the dark
// surface. Every image therefore sits on a token-built contrast plate, the way an
// asset viewer shows art on a transparency grid. No literal colour is introduced.
const PLATE = 'grid place-items-center rounded-md border border-(--ui-stroke-secondary) p-1'
const PLATE_STYLE = {
  backgroundImage: 'repeating-conic-gradient(color-mix(in srgb, var(--ui-text-primary) 7%, transparent) 0% 25%, transparent 0% 50%)',
  backgroundSize: '12px 12px',
}

function PreviewBlock({ msgId, hasFiles, onFullscreen }) {
  const pv = usePreview(msgId, hasFiles)
  const [expanded, setExpanded] = useState(null)
  const [dims, setDims] = useState({})
  const [pages, setPages] = useState({})
  const curPage = (expanded && pages[expanded]) || 1
  const pageQ = usePdfPage(msgId, expanded, curPage, !!expanded)
  if (!hasFiles || pv.isLoading) return null
  if (pv.isError) {
    const status = pv.error && (pv.error.status || pv.error.statusCode)
    const oldBackend = status === 404
    return jsxs('div', { className: 'flex flex-col items-start gap-2 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-2', children: [
      jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: oldBackend
          ? 'Preview needs the new backend — fully quit and reopen your Desktop app, then come back.'
          : 'Could not load the preview.' }),
      jsx(Button, { size: 'xs', variant: 'outline', onClick: () => pv.refetch(), children: 'Retry preview' }),
    ] })
  }
  const files = pv.data || []
  if (files.length === 0) return null
  const images = files.filter(f => f.kind === 'image' && f.data_url)
  const videos = files.filter(f => f.kind === 'video' && f.data_url)
  const pdfs = files.filter(f => f.kind === 'pdf')
  const mds = files.filter(f => f.kind === 'md' && f.data_url)
  const htmls = files.filter(f => f.kind === 'html' && f.data_url)
  const rest = files.filter(f => !f.data_url && !['pdf', 'md', 'html'].includes(f.kind))
  const big = expanded ? files.find(f => f.name === expanded) : null
  const copy = formatCopy(files[0] && files[0].content_type)
  return jsxs('div', { className: 'flex w-full flex-col gap-3', children: [
    copy ? jsxs('div', { className: 'flex w-full items-start gap-2 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-2 text-xs text-(--ui-text-secondary)', children: [
      jsx('span', { className: `codicon ${typeIcon(files[0].kind)} mt-0.5 shrink-0`, 'aria-hidden': 'true' }),
      jsx('span', { className: 'min-w-0 flex-1', children: copy }),
    ]}) : null,
    big && big.kind === 'image' ? jsx('div', { className: PLATE, style: PLATE_STYLE, children:
      jsx('img', { className: 'w-full cursor-pointer rounded-sm', src: big.data_url, alt: big.name, onClick: () => setExpanded(null) }) }) : null,
    images.length > 0 ? jsx('div', { className: 'flex w-full flex-wrap gap-2', children:
      images.map(f => jsxs('div', { className: 'flex w-28 flex-col gap-1', children: [
        jsx('div', { className: PLATE, style: PLATE_STYLE, children:
          jsx('img', { className: 'h-24 w-24 cursor-pointer rounded-sm', src: f.data_url, alt: f.name, title: `${f.name} · click to enlarge`,
            onClick: () => setExpanded(expanded === f.name ? null : f.name),
            onLoad: (e) => setDims(d => ({ ...d, [f.name]: `${e.target.naturalWidth}×${e.target.naturalHeight}` })) }) }),
        jsx('span', { className: 'w-24 truncate text-[0.625rem] text-(--ui-text-quaternary)', title: `${f.name} · ${fmtSize(f.size)}`,
          children: [dims[f.name] ? `${dims[f.name]} · ` : '', f.content_type === 'image/svg+xml' ? 'SVG' : fmtSize(f.size)].join('') }),
      ]}, f.name))
    }) : null,
    ...videos.map(f => jsxs('div', { className: 'flex w-full flex-col gap-1', children: [
      jsx('video', { className: 'w-full rounded-md border border-(--ui-stroke-secondary)', src: f.data_url, controls: true, preload: 'metadata',
        onLoadedMetadata: (e) => setDims(d => ({ ...d, [f.name]: fmtDuration(e.target.duration) })) }),
      jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: [f.name, dims[f.name] ? ` · ${dims[f.name]}` : '', ` · ${fmtSize(f.size)}`].join('') }),
    ]}, f.name)),
    ...pdfs.map(f => jsxs('div', { className: 'flex flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-2', children: [
      jsxs('div', { className: 'flex items-center gap-2', children: [
        f.thumb_url ? jsx('img', { className: 'h-24 w-24 cursor-pointer rounded-md border border-(--ui-stroke-secondary)', src: f.thumb_url, alt: `${f.name} first page`, title: `${f.name}${f.pages ? ` · ${f.pages} pages` : ''} · tap to read`, onClick: () => setExpanded(expanded === f.name ? null : f.name) }) : null,
        jsx('span', { className: 'min-w-0 flex-1 break-all text-xs text-(--ui-text-secondary)', children: `${f.name}${f.pages ? ` · ${f.pages}p` : ''} · ${fmtSize(f.size)}` }),
      jsx('div', { className: 'flex items-center gap-1.5', children: [
        // Save. The SDK's documented file-save door, when the preview read captured
        // one, streams the backend's own persisted path through Electron's
        // authenticated bridge and native save dialog. The data: anchor stays as the
        // fallback so the control never dead-ends, and the same bytes are behind it.
        f.data_url || f.stored_path ? jsx('a', { href: f.data_url || '#', download: f.name, className: 'shrink-0',
          onClick: (e) => {
            const door = doorByFile[f.name]
            if (door && f.stored_path) { e.preventDefault(); try { door(f.stored_path, f.name) } catch (_) {} }
          },
          children: jsx(Button, { size: 'xs', variant: 'ghost', asChild: false, children: f.pages ? `Save (${f.pages}p)` : 'Save' }) }) : null,
        f.pages ? jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => setExpanded(expanded === f.name ? null : f.name), children: expanded === f.name ? 'Close' : 'Read here' }) : null,
      ] }),
      ] }),
      expanded === f.name ? jsxs('div', { className: 'flex w-full flex-col gap-2', children: [
        pageQ.isError
          ? jsx('div', { className: 'rounded-sm border border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-secondary)', children: 'This page could not be rendered here. Use Save, then open the file in your reader.' })
          : pageQ.data && pageQ.data.data_url
            ? jsx('div', { className: PLATE, style: PLATE_STYLE, children:
                jsx('img', { className: 'w-full rounded-sm', src: pageQ.data.data_url, alt: `${f.name} page ${curPage}` }) })
            : jsxs('div', { className: 'flex items-center gap-2 rounded-sm border border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-secondary)', children: [
                jsx(GlyphSpinner, {}), jsx('span', { children: 'Rendering page…' }),
              ] }),
        jsxs('div', { className: 'flex items-center gap-2', children: [
          jsx(Button, { size: 'xs', variant: 'ghost', disabled: curPage <= 1,
            onClick: () => setPages(p => ({ ...p, [f.name]: Math.max(1, (p[f.name] || 1) - 1) })), children: 'Prev' }),
          jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: `Page ${curPage} of ${f.pages || (pageQ.data && pageQ.data.pages) || '?'}` }),
          jsx(Button, { size: 'xs', variant: 'ghost', disabled: !!f.pages && curPage >= f.pages,
            onClick: () => setPages(p => ({ ...p, [f.name]: (p[f.name] || 1) + 1 })), children: 'Next' }),
          jsx('span', { className: 'ml-auto truncate text-[0.625rem] text-(--ui-text-quaternary)', title: `${f.name} · ${fmtSize(f.size)}`,
            children: `${fmtSize(f.size)} · Save to open in your reader` }),
        ] }),
      ]}) : null,
    ], key: f.name })),
    ...mds.map(f => jsxs('div', { className: 'w-full overflow-hidden rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary)', children: [
      jsxs('div', { className: 'flex items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) px-2 py-1', children: [
        jsx('span', { className: 'text-xs font-semibold tracking-wide uppercase text-(--ui-text-quaternary)', children: 'MARKDOWN' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { if (expanded === f.name) { setExpanded(null); } else { onFullscreen(f); } }, children: expanded === f.name ? 'Close' : 'Fullscreen' }),
      ] }),
      jsx('div', { className: expanded === f.name ? VIEWPORT : `${VIEWPORT} max-h-40 overflow-hidden`, dangerouslySetInnerHTML: { __html: renderSimpleMd(decodeDataUrl(f.data_url)) } })
    ], key: f.name })),
    ...htmls.map(f => jsxs('div', { className: 'w-full overflow-hidden rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary)', children: [
      jsxs('div', { className: 'flex items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) px-2 py-1', children: [
        jsx('span', { className: 'text-xs font-semibold tracking-wide uppercase text-(--ui-text-quaternary)', children: 'HTML' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { if (expanded === f.name) { setExpanded(null); } else { onFullscreen(f); } }, children: expanded === f.name ? 'Close' : 'Fullscreen' }),
      ] }),
      jsx('div', { className: expanded === f.name ? VIEWPORT : `${VIEWPORT} max-h-40 overflow-hidden`, dangerouslySetInnerHTML: { __html: decodeDataUrl(f.data_url) } })
    ], key: f.name })),
    ...rest.map(f => jsx('div', { className: 'rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-2 text-xs text-(--ui-text-secondary)', children: `${f.name} · ${fmtSize(f.size)} (too large to preview inline)`, key: f.name })),
  ] })
}

function normaliseStatus(status) {
  // The packet's status must already be canonical; this guard keeps an older
  // backend (or a raw decision verb) from putting a decided request back into
  // the pending bucket, which is how a finished approval reappeared as new.
  const s = String(status || '').trim().toLowerCase()
  const map = { approve: 'approved', approved: 'approved', reject: 'rejected', rejected: 'rejected', reget: 'reget', 're-get': 'reget', rework: 'reget' }
  return map[s] || s || 'pending'
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'reget', label: 'Re-Get' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

function groupHeader(label, count) {
  return jsxs('div', { className: 'mt-1 flex items-center gap-2 px-1 text-[0.625rem] font-semibold uppercase tracking-wide text-(--ui-text-quaternary)', children: [
    jsx('span', { children: label }),
    jsx('span', { children: String(count) }),
  ] })
}

function FeedRow({ item, selected, onSelect }) {
  const decided = item.status !== 'pending'
  // Keyboard navigation moves the selection; the list follows it without the
  // reviewer reaching for the scrollbar. Done by lookup on the row's own id
  // attribute: the plugin host's react shim exports useState/useEffect/useMemo
  // only, so useRef is not available to a disk plugin.
  useEffect(() => {
    if (!selected || typeof document === 'undefined') return
    const el = document.querySelector(`[data-msg-id="${item.msg_id}"]`)
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return jsxs('div', {
    'data-msg-id': item.msg_id,
    className: `flex w-full min-w-0 cursor-pointer gap-2 rounded-md border border-transparent p-2 outline-none hover:bg-(--ui-row-hover-background) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--ui-accent)${selected ? ' bg-(--ui-row-active-background) border-(--ui-stroke-secondary)' : ''}${decided ? ' opacity-60' : ''}`,
    onClick: () => onSelect(item.msg_id),
    role: 'button',
    tabIndex: 0,
    'aria-selected': !!selected,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(item.msg_id) } },
    children: [
      jsxs('div', { className: 'flex min-w-0 flex-1 flex-col gap-1', children: [
        jsxs('div', { className: 'flex min-w-0 items-center justify-between gap-2', children: [
          jsx('span', { className: 'min-w-0 flex-1 truncate text-xs font-semibold', title: itemTitle(item), children: itemTitle(item) }),
          jsx('span', { className: 'shrink-0 whitespace-nowrap text-xs text-(--ui-text-quaternary)', title: absTime(item.ts), children: relTime(item.ts) || absTime(item.ts) }),
        ]}),
        jsxs('div', { className: 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1', children: [
          jsx(StatusBadge, { status: decided ? item.status : 'pending' }),
          jsx('span', { className: 'shrink-0 whitespace-nowrap text-xs font-bold uppercase tracking-wide', style: { color: typeToken(item.type) }, children: getTypeLabel(item.type) }),
          jsxs('span', { className: 'shrink-0 whitespace-nowrap rounded-sm bg-(--ui-bg-quaternary) px-1 py-0.5 text-xs font-bold text-(--ui-text-quaternary)', children: ['v', (item.artifact || {}).version || '?'] }),
          item.owner ? jsx('span', { className: 'min-w-0 truncate text-xs text-(--ui-text-quaternary)', title: `${item.owner}${item.work_id ? ` · ${item.work_id}` : ''}`, children: item.owner }) : null,
        ]}),
      ]}),
    ]
  })
}

function RequestList({ items, selectedId, onSelect, needle }) {
  // Arrow keys walk the list the reviewer is looking at, in the order shown.
  const move = (delta) => {
    if (!items.length) return
    const i = items.findIndex(it => it.msg_id === selectedId)
    const next = i < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + delta))
    onSelect(items[next].msg_id)
  }
  return jsxs('div', { className: 'flex w-full min-w-0 flex-col bg-(--ui-sidebar-surface-background)', onKeyDown: (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  }, children: [
    jsx(ScrollArea, { className: 'w-full overflow-auto', children:
      items.length === 0
        ? jsx(EmptyState, {
            title: needle ? 'No matching requests' : 'Nothing in this view',
            description: needle ? 'Try a different search term.' : 'Switch the filter back to All to see every request.',
          })
        : jsxs('div', { className: 'flex w-full min-w-0 flex-col gap-1 p-2', children: [
            groupHeader('Needs decision', items.filter(i => i.status === 'pending').length),
            ...items.filter(i => i.status === 'pending').map(it => jsx(FeedRow, { item: it, selected: it.msg_id === selectedId, onSelect, key: it.msg_id })),
            items.some(i => i.status !== 'pending') ? groupHeader('Decided', items.filter(i => i.status !== 'pending').length) : null,
            ...items.filter(i => i.status !== 'pending').map(it => jsx(FeedRow, { item: it, selected: it.msg_id === selectedId, onSelect, key: it.msg_id })),
          ]})
    }),
  ] })
}

function CenterWorkspace({ item, decide, busy, zoom, onZoomChange, onFullscreen, onApproveClick, onRejectClick, rejectOpen, rejectNote, onRejectNoteChange, sendReject, onBack, panelTab, onPanelTabChange, retryNote, onRetryNoteChange, onRetrySubmit, retryBusy }) {
  const msgId = item?.msg_id
  const hasFiles = (item?.attachments?.length || 0) > 0
  const pv = usePreview(msgId, hasFiles)
  const art = item?.artifact || {}
  const decision = item?.decision || {}
  const decided = item?.status !== 'pending'
  const [approveOpen, setApproveOpen] = useState(false)

  if (!item) {
    return jsxs('div', { className: 'flex flex-1 min-h-0 min-w-0 flex-col', children: [
      jsx(EmptyState, {
        title: 'No artifact selected',
        description: 'Select a request from the inbox to review it and take action.',
      }),
    ] })
  }

  const previewFiles = pv.data || []
  const mainImage = previewFiles.find(f => f.kind === 'image' && f.data_url)
  const mainVideo = previewFiles.find(f => f.kind === 'video' && f.data_url)

  return jsxs('div', { className: 'flex w-full min-w-0 flex-col', children: [
    jsxs('div', { className: 'flex w-full shrink-0 flex-col gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2', children: [
      jsxs('div', { className: 'flex min-w-0 items-center gap-2', children: [
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => onBack && onBack(null), 'aria-label': 'Back to the request list', children: '‹ Back' }),
        jsx('span', { className: 'shrink-0 whitespace-nowrap text-xs font-bold uppercase tracking-wide', style: { color: typeToken(item.type) }, children: getTypeLabel(item.type) }),
        jsx('div', { className: 'min-w-0 flex-1 truncate text-sm font-semibold', title: itemTitle(item), children: itemTitle(item) }),
        jsx(StatusBadge, { status: decided ? item.status : 'pending' }),
      ]}),
      jsx('div', { className: 'min-w-0 text-xs text-(--ui-text-secondary)', children:
        `Artifact: ${art.name || '-'} · submitted ${absTime(item.ts)} · v${art.version || '?'}`,
      }),
      !decided ? jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
        jsx(Button, { size: 'sm', onClick: onApproveClick, disabled: busy || decide.isPending, children: (busy || decide.isPending) ? 'Working…' : 'Approve' }),
        jsx(Button, { size: 'sm', variant: 'ghost', onClick: onRejectClick, disabled: busy || decide.isPending, children: rejectOpen ? 'Cancel rejection' : 'Reject' }),
      ]}) : jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
        jsx(StatusBadge, { status: item.status }),
        decision.note ? jsxs('span', { className: 'text-xs text-(--ui-text-secondary)', children: [decision.note, ' · ', absTime(decision.ts)] }) : null,
      ]}),
      rejectOpen ? jsxs('div', { className: 'flex w-full min-w-0 flex-wrap items-center gap-2', children: [
        jsx(Input, { className: 'min-w-0 flex-1', value: rejectNote, onChange: (e) => onRejectNoteChange(asText(e)), placeholder: 'Reason for rejection…', 'aria-label': 'Rejection reason' }),
        jsx(Button, { size: 'sm', variant: 'outline', onClick: sendReject, disabled: busy || decide.isPending, children: 'Send rejection' }),
      ]}) : null,
    ]}),
    jsx(ConfirmDialog, {
      open: approveOpen,
      onClose: () => setApproveOpen(false),
      title: `Approve "${art.name || itemTitle(item)}"?`,
      description: art.version ? `Version ${art.version}${item.next_action ? ` · next: ${item.next_action}` : ''}` : (item.next_action ? `Next: ${item.next_action}` : 'This records the approval.'),
      confirmLabel: 'Approve',
      onConfirm: async () => { decide.mutate({ item, decision: 'approve', note: '' }); setApproveOpen(false) },
    }),
    jsx('div', { className: 'flex flex-1 flex-col items-center gap-3 overflow-auto p-4', children: pv.isLoading && hasFiles ? jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(GlyphSpinner, {}) }) : (
      jsxs('div', { className: 'flex w-full flex-col', children: [
        jsxs('div', { className: 'flex items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) pb-2', children: [
          jsx('span', { className: 'shrink-0 whitespace-nowrap text-xs font-semibold tracking-wide uppercase text-(--ui-text-quaternary)', children: `${(item.type || 'artifact').toUpperCase()} Viewport` }),
          (mainImage || mainVideo) ? jsxs('div', { className: 'flex items-center gap-1', children: [
            jsx(Button, { size: 'icon-xs', variant: 'ghost', onClick: () => onZoomChange(Math.max(0.5, zoom - 0.1)), 'aria-label': 'Zoom out', children: '−' }),
            jsx(Button, { size: 'icon-xs', variant: 'ghost', onClick: () => onZoomChange(Math.min(2.5, zoom + 0.1)), 'aria-label': 'Zoom in', children: '+' }),
            jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => onZoomChange(1), children: 'Reset' }),
            jsx(Button, { size: 'xs', variant: 'outline', onClick: () => { const f = mainImage || mainVideo; if (f) onFullscreen(f) }, children: 'Fullscreen' }),
          ]}) : null,
        ]}),
        (item.next_action || item.subject) ? jsxs('div', { className: 'mt-2 w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) p-3 text-xs leading-5 text-(--ui-text-secondary)', children: [
          jsxs('h3', { className: 'mb-1 text-xs font-semibold text-(--ui-text-primary)', children: ['Context: ', itemTitle(item)] }),
          renderSimpleMd(item.next_action || ''),
        ]}) : null,
        hasFiles ? jsx('div', { className: 'mt-2 w-full', children: jsx(PreviewBlock, { msgId, hasFiles: true, onFullscreen }) }) : null,
      ] })
    )}),
  ] })
}

function RightPanel({ item, tab, onTabChange, retryNote, onRetryNoteChange, onRetrySubmit, retryBusy }) {
  const TABS = [{ id: 'retry', label: 'Retry Studio' }, { id: 'history', label: 'Audit Trail' }]

  if (!item) {
    return jsxs('div', { className: 'flex w-full min-w-0 flex-col border-t border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background)', children: [
      jsx('div', { className: 'flex shrink-0 border-b border-(--ui-stroke-secondary) p-2', children:
        jsx(SegmentedControl, { className: 'w-full', value: tab, onChange: (id) => onTabChange(id), options: TABS })
      }),
      jsx('div', { className: 'flex-1 overflow-auto p-3', children:
        jsx(EmptyState, {
          title: 'No artifact selected',
          description: 'Select a request to use Retry Studio and read its audit trail.',
        })
      }),
    ] })
  }

  const art = item.artifact || {}
  const nextVer = String((parseInt(art.version || '1')) + 1)
  const decided = item.status !== 'pending'
  const chips = ['Remove Em-dashes', 'High-contrast typography', 'Shorten subtext', 'Punchy headline']

  return jsxs('div', { className: 'flex w-full min-w-0 flex-col border-t border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background)', children: [
    jsx('div', { className: 'flex shrink-0 border-b border-(--ui-stroke-secondary) p-2', children:
      jsx(SegmentedControl, { className: 'w-full', value: tab, onChange: (id) => onTabChange(id), options: TABS })
    }),
    jsx('div', { className: 'flex-1 overflow-auto p-3', children:
      tab === 'retry' ? jsxs('div', { children: [
        jsxs('div', { className: 'mb-2 flex items-center justify-between gap-2', children: [
          jsx('label', { className: 'text-xs font-bold text-(--ui-text-primary)', children: 'Retry instructions' }),
          jsxs('span', { className: 'rounded-full border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-xs font-bold text-(--ui-accent)', children: ['Next: v', nextVer] }),
        ]}),
        jsx('p', { className: 'mb-2 text-xs text-(--ui-text-quaternary)', children: 'Add instructions to refine the artifact before re-triggering the producing lane.' }),
        jsxs('div', { className: 'mb-2 flex flex-wrap gap-1', children: [
          ...chips.map(c => jsx(Button, { key: c, size: 'xs', variant: 'chip', onClick: () => onRetryNoteChange(v => v ? `${v}, ${c}` : c), children: c })),
        ]}),
        jsx('textarea', { className: 'w-full resize-y rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-editor) p-2 text-xs text-(--ui-text-primary)', value: retryNote, onChange: (e) => onRetryNoteChange(e.target.value), placeholder: 'Enter explicit guidelines to eliminate issues or adjust layout/copy…', rows: 5 }),
        decided ? jsx('div', { className: 'mt-2 text-xs text-(--ui-text-quaternary)', children: 'This item has already been decided. Submit will create a new pending version.' }) : null,
        jsx(Button, { className: 'mt-2 w-full', size: 'sm', onClick: onRetrySubmit, disabled: retryBusy || !retryNote.trim(), children: retryBusy ? 'Submitting…' : 'Request new version' }),
      ]}) : jsxs('div', { children: [
        jsxs('div', { className: 'relative border-l border-(--ui-stroke-secondary) pl-3 pb-2', children: [
          jsx('div', { className: 'absolute size-2 rounded-full', style: { left: '-0.25rem', top: '0.25rem', backgroundColor: T.past } }),
          jsxs('div', { children: [
            jsx('span', { className: 'text-xs font-semibold', children: 'Submitted' }),
            jsx('span', { className: 'ml-1 text-xs text-(--ui-text-quaternary)', children: absTime(item.ts) }),
          ]}),
        ]}),
        decided && item.decision ? jsxs('div', { className: 'relative border-l border-transparent pl-3', children: [
          jsx('div', { className: 'absolute size-2 rounded-full', style: { left: '-0.25rem', top: '0.25rem', backgroundColor: item.status === 'approved' ? T.green : T.red } }),
          jsxs('div', { children: [
            jsxs('span', { className: 'text-xs font-semibold', children: [item.status === 'approved' ? 'Approved' : 'Rejected'] }),
            jsx('span', { className: 'ml-1 text-xs text-(--ui-text-quaternary)', children: absTime(item.decision.ts) }),
          ]}),
          item.decision.note ? jsx('div', { className: 'mt-0.5 text-xs leading-4 text-(--ui-text-secondary)', children: item.decision.note }) : null,
          jsxs('div', { className: 'mt-0.5 text-xs text-(--ui-text-quaternary)', children: ['Decided by ', item.decision.by || item.originating_agent || '-'] }),
        ]}) : null,
      ]})
    }),
  ] })
}

function FullscreenModal({ file, onClose }) {
  if (!file) return null
  return jsxs('div', {
    className: 'fixed inset-0 z-50 flex items-center justify-center p-4',
    style: { backgroundColor: tint(T.base, 92) },
    onClick: onClose,
    children: [
      jsxs('div', {
        className: 'relative flex flex-col overflow-hidden rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated)',
        style: { width: '100%', maxWidth: '72rem', maxHeight: '90vh' },
        onClick: (e) => e.stopPropagation(),
        children: [
          jsxs('div', { className: 'flex items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) p-3', children: [
            jsxs('span', { className: 'text-sm font-semibold', children: [file.name, ' — full view'] }),
            jsx(Button, { size: 'xs', variant: 'outline', onClick: onClose, children: 'Close' }),
          ]}),
          jsx('div', { className: 'flex flex-1 items-center justify-center overflow-auto p-4', children:
            file.kind === 'image' ? jsx('img', { src: file.data_url, style: { maxHeight: '80vh', maxWidth: '100%', objectFit: 'contain' } })
            : file.kind === 'video' ? jsx('video', { src: file.data_url, controls: true, style: { maxHeight: '80vh', maxWidth: '100%' } })
            : file.kind === 'pdf' ? jsx('embed', { src: file.data_url, type: 'application/pdf', style: { width: '100%', height: '70vh' } })
            : file.kind === 'md' ? jsx('div', { className: VIEWPORT, dangerouslySetInnerHTML: { __html: renderSimpleMd(decodeDataUrl(file.data_url)) } })
            : file.kind === 'html' ? jsx('div', { className: VIEWPORT, dangerouslySetInnerHTML: { __html: decodeDataUrl(file.data_url) } })
            : jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'Full preview not available for this file type.' })
          }),
        ]}),
    ] })
}

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
    try { storeSet && storeSet('inboxPrefs', p) } catch { /* best-effort */ }
  }

  const [selectedId, setSelectedId] = useState(null)
  const [rightTab, setRightTab] = useState('retry')
  const [fullscreen, setFullscreen] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [approveOpen, setApproveOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [retryNote, setRetryNote] = useState('')
  const [retryBusy, setRetryBusy] = useState(false)

  const needle = prefs.q || ''
  const filter = prefs.filter || 'all'
  const setNeedle = (v) => setPrefs({ ...prefs, q: v })
  const setFilter = (v) => setPrefs({ ...prefs, filter: v })

  // Canonical statuses, once, here. Every filter, count, pill and sort below
  // reads from `rows`, so a decision verb can never land a finished request back
  // in the pending bucket.
  const rows = items.map(i => ({ ...i, status: normaliseStatus(i.status) }))

  const pending = rows.filter(i => i.status === 'pending')
  const counts = {
    all: rows.length,
    pending: pending.length,
    reget: rows.filter(i => i.status === 'reget').length,
    approved: rows.filter(i => i.status === 'approved').length,
    rejected: rows.filter(i => i.status === 'rejected').length,
  }

  const byNewest = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))
  let visible = rows.filter(i => matches(i, needle)).sort(byNewest)
  if (filter === 'pending') visible = visible.filter(i => i.status === 'pending')
  if (filter === 'approved') visible = visible.filter(i => i.status === 'approved')
  if (filter === 'rejected') visible = visible.filter(i => i.status === 'rejected')
  if (filter === 'reget') visible = visible.filter(i => i.status === 'reget')
  if (filter === 'all') {
    const rank = (i) => (i.status === 'pending' ? 0 : 1)
    visible = [...visible].sort((a, b) => rank(a) - rank(b) || byNewest(a, b))
  }

  const selectedItem = selectedId ? rows.find(i => i.msg_id === selectedId) : null
  const busy = decide.isPending || retryBusy
  const reload = () => { queryClient.invalidateQueries({ queryKey: [ID] }) }

  useEffect(() => {
    if (selectedId && !items.some(i => i.msg_id === selectedId)) {
      setSelectedId(null)
    }
    setZoom(1)
    setFullscreen(null)
    setRejectOpen(false)
    setApproveOpen(false)
    setRejectNote('')
    setRetryNote('')
    setRetryBusy(false)
  }, [selectedId])

  const sendReject = () => {
    if (!selectedItem) return
    decide.mutate({ item: selectedItem, decision: 'reject', note: rejectNote })
    setRejectOpen(false)
    setRejectNote('')
  }

  const handleRetrySubmit = async () => {
    if (!selectedItem || !retryNote.trim()) return
    setRetryBusy(true)
    try {
      await decide.mutateAsync({
        item: selectedItem,
        decision: 'reject',
        note: `Re-get requested: ${retryNote.trim()}`
      })
      const curVer = parseInt((selectedItem.artifact?.version || '1').toString())
      await rest('/submit', {
        method: 'POST',
        body: {
          type: selectedItem.type || 'artifact',
          owner: selectedItem.owner || 'default',
          work_id: selectedItem.work_id,
          subject: `Re-get: ${selectedItem.subject || selectedItem.artifact?.name || 'Artifact'}`,
          artifact: {
            name: selectedItem.artifact?.name,
            version: String(curVer + 1),
            hash: selectedItem.artifact?.hash,
            preview_url: selectedItem.artifact?.preview_url,
          },
          preview_url: selectedItem.artifact?.preview_url,
          next_action: selectedItem.next_action,
        }
      })
      queryClient.invalidateQueries({ queryKey: [ID] })
      setRetryNote('')
      showToast('New version submitted for review', 'success')
    } catch (e) {
      showToast(errText(e) || 'Rework request failed', 'error')
    } finally {
      setRetryBusy(false)
    }
  }

  const emptyCopy = needle
    ? { title: 'No matching requests', description: 'Try a different search term.' }
    : filter === 'all'
      ? { title: 'Nothing here yet', description: 'Approval requests appear here as soon as your lanes raise one.' }
      : { title: 'Nothing in this view', description: 'Switch the filter back to All to see every request.' }

  return jsxs('div', { className: 'flex h-full min-h-0 w-full min-w-0 flex-col text-(--ui-text-primary)',
    onKeyDown: (e) => { if (e.key === 'Escape' && selectedId) { e.preventDefault(); setSelectedId(null) } },
    children: [
    jsxs('div', { className: 'flex w-full shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2', children: [
      jsx(Button, { size: 'sm', variant: 'ghost', className: 'font-semibold', onClick: () => { if (host?.navigate) host.navigate(PAGE_PATH) }, children: 'Approval Inbox' }),
      jsx(Badge, { variant: 'outline', children: `${counts.pending} pending` }),
      jsx('span', { className: 'flex-1' }),
      jsx(SearchField, {
        value: needle,
        onChange: (v) => setNeedle(asText(v)),
        placeholder: 'Search subject, owner, artifact…',
        'aria-label': 'Search approval requests',
        containerClassName: 'w-64 max-w-full',
      }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: reload, disabled: q.isPending, 'aria-label': 'Refresh inbox', children: q.isPending ? 'Refreshing…' : 'Refresh' }),
    ]}),
    jsx('div', { className: 'w-full shrink-0 overflow-x-auto border-b border-(--ui-stroke-secondary) px-3 py-2', children:
      jsx(SegmentedControl, {
        className: 'w-full',
        sizing: 'content',
        value: filter,
        onChange: (id) => setFilter(id),
        options: FILTERS.map(f => ({ id: f.id, label: `${f.label} (${counts[f.id] ?? 0})` })),
      })
    }),
    jsxs('div', { className: 'flex flex-1 min-h-0 w-full min-w-0 flex-col', children: [
      q.isLoading && items.length === 0
        ? jsx('div', { className: 'flex flex-1 min-h-0 flex-col', children: jsx('div', { className: 'grid h-full place-items-center p-4', children: jsx(GlyphSpinner, {}) }) })
        : error && !selectedItem
          ? jsx('div', { className: 'flex flex-1 min-h-0 items-center justify-center p-4', children:
              jsx(ErrorState, {
                title: 'Could not load approvals',
                description: error,
                children: jsx(Button, { size: 'sm', variant: 'outline', onClick: reload, children: 'Retry' }),
              })
            })
          : selectedItem
            ? jsx(CenterWorkspace, { item: selectedItem, decide, busy, zoom, onZoomChange: setZoom, onFullscreen: setFullscreen, onBack: setSelectedId, onApproveClick: () => setApproveOpen(true), onRejectClick: () => setRejectOpen(true), rejectOpen, rejectNote, onRejectNoteChange: setRejectNote, sendReject })
            : jsx(RequestList, { items: visible, selectedId, onSelect: setSelectedId, needle }),
      selectedItem && jsx(RightPanel, { item: selectedItem, tab: rightTab, onTabChange: setRightTab, retryNote, onRetryNoteChange: setRetryNote, onRetrySubmit: handleRetrySubmit, retryBusy }),
    ]}),
    jsx(FullscreenModal, { file: fullscreen, onClose: () => setFullscreen(null) }),
    selectedItem && jsx(ConfirmDialog, {
      open: approveOpen,
      onClose: () => setApproveOpen(false),
      title: `Approve "${selectedItem.artifact?.name || itemTitle(selectedItem)}"?`,
      description: selectedItem.artifact?.version ? `Version ${selectedItem.artifact.version}${selectedItem.next_action ? ` · next: ${selectedItem.next_action}` : ''}` : (selectedItem.next_action ? `Next: ${selectedItem.next_action}` : 'This records the approval.'),
      confirmLabel: 'Approve',
      onConfirm: async () => { decide.mutate({ item: selectedItem, decision: 'approve', note: '' }); setApproveOpen(false) },
    }),
  ] })
}

export default {
  id: ID,
  name: 'Approval Inbox',
  description: 'Single-column approval inbox: header, filters, request list, and the selected request in context.',
  defaultEnabled: true,

  // Testability hook: the render check mounts these directly (the host ignores
  // extra exports). No behaviour changes.
  __test: { FeedRow, RequestList, PreviewBlock, typeToken, normaliseStatus, groupHeader },

  register(ctx) {
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
