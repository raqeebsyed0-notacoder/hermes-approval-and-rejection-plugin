/**
 * Hermes Approval Inbox — desktop plugin.
 *
 * Three-pane workspace: feed sidebar, center preview viewport, right
 * Retry-Studio / Audit-Trail panel. Reuses proven data hooks and UI
 * components. No external AI calls, no external image URLs, no demo data.
 *
 * Backend: dashboard/plugin_api.py at /api/plugins/approval-inbox/.
 */

import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorState, GlyphSpinner,
  host, Input, PALETTE_AREA, ROUTES_AREA, ScrollArea, SearchField,
  SegmentedControl, SIDEBAR_NAV_AREA, queryClient,
  useMutation, useQuery,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect } from 'react'

const ID = 'approval-inbox'
const PAGE_PATH = '/approval-inbox'
const APP_VERSION = '0.4.6'

let rest = null
let storeGet = null
let storeSet = null

function ensureStyles() {
  const css = [
    `.${ID} { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--ui-text-primary); }`,
    `.${ID}-header { display:flex; align-items:center; gap:0.5rem; padding:0.5rem 0.75rem; border-bottom:1px solid var(--ui-stroke-secondary); flex:none; flex-wrap:wrap; }`,
    `.${ID}-brand { display:inline-flex; align-items:center; gap:0.375rem; flex:none; cursor:pointer; padding:0; border:0; background:none; font:inherit; color:var(--ui-text-primary); font-weight:600; font-size:0.875rem; }`,
    `.${ID}-brand:hover { background:var(--chrome-action-hover); }`,
    `.${ID}-brand:focus-visible { outline:1px solid var(--ui-accent); outline-offset:-1px; }`,
    `.${ID}-metrics { display:flex; gap:0.375rem; flex-wrap:wrap; }`,
    `.${ID}-metric { display:inline-flex; align-items:center; gap:0.25rem; padding:0.25rem 0.5rem; border-radius:0.375rem; font-size:0.75rem; font-weight:600; background:var(--ui-bg-card); border:1px solid var(--ui-stroke-secondary); }`,
    `.${ID}-metricDot { width:0.5rem; height:0.5rem; border-radius:999px; }`,
    `.${ID}-spacer { flex:1; }`,
    `.${ID}-body { flex:1 1 auto; min-height:0; display:flex; min-height:0; }`,
    `.${ID}-feed { width:22rem; min-width:16rem; border-right:1px solid var(--ui-stroke-secondary); display:flex; flex-direction:column; min-height:0; background:var(--ui-bg-card); }`,
    `.${ID}-feedHead { padding:0.5rem; border-bottom:1px solid var(--ui-stroke-secondary); display:flex; flex-direction:column; gap:0.5rem; flex:none; }`,
    `.${ID}-searchWrap { position:relative; display:flex; align-items:center; }`,
    `.${ID}-searchIcon { position:absolute; left:0.5rem; color:var(--ui-text-quaternary); pointer-events:none; font-size:0.75rem; }`,
    `.${ID}-searchField { flex:1; }`,
    `.${ID}-filterRow { display:flex; gap:0.25rem; overflow-x:auto; }`,
    `.${ID}-filterChip { padding:0.25rem 0.5rem; border-radius:0.375rem; font-size:0.75rem; font-weight:600; border:1px solid var(--ui-stroke-secondary); background:var(--ui-bg-card); color:var(--ui-text-secondary); cursor:pointer; white-space:nowrap; }`,
    `.${ID}-filterChip:hover { border-color:var(--ui-accent); color:var(--ui-text-primary); }`,
    `.${ID}-filterChipActive { background:var(--ui-accent); color:#fff; border-color:var(--ui-accent); }`,
    `.${ID}-feedScroll { flex:1 1 auto; overflow:auto; }`,
    `.${ID}-feedList { display:flex; flex-direction:column; gap:0.25rem; padding:0.5rem; }`,
    `.${ID}-row { display:flex; gap:0.5rem; padding:0.625rem 0.5rem; border-radius:0.5rem; cursor:pointer; border:1px solid transparent; transition:background 0.1s, border-color 0.1s; }`,
    `.${ID}-row:hover { background:var(--ui-bg-hover); }`,
    `.${ID}-rowSelected { background:var(--ui-accent-muted); border-color:var(--ui-accent); }`,
    `.${ID}-rowDecided { opacity:0.75; }`,
    `.${ID}-rowIcon { width:2rem; height:2rem; border-radius:0.375rem; display:flex; align-items:center; justify-content:center; font-size:0.625rem; font-weight:700; flex:none; border:1px solid var(--ui-stroke-secondary); background:var(--ui-bg-card); color:var(--ui-text-secondary); }`,
    `.${ID}-rowBody { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:0.25rem; }`,
    `.${ID}-rowHead { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }`,
    `.${ID}-rowTitle { font-weight:600; font-size:0.8125rem; line-height:1.35; overflow-wrap:anywhere; }`,
    `.${ID}-rowTime { font-size:0.6875rem; color:var(--ui-text-quaternary); white-space:nowrap; }`,
    `.${ID}-rowFoot { display:flex; align-items:center; gap:0.5rem; }`,
    `.${ID}-rowVer { font-size:0.6875rem; font-weight:700; color:var(--ui-text-quaternary); background:var(--ui-bg-hover); padding:0.125rem 0.375rem; border-radius:0.25rem; }`,
    `.${ID}-workspace { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; min-height:0; background:var(--ui-bg-base); }`,
    `.${ID}-inspector { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; padding:0.625rem 0.875rem; border-bottom:1px solid var(--ui-stroke-secondary); flex:none; flex-wrap:wrap; background:var(--ui-bg-card); }`,
    `.${ID}-inspectorLeft { display:flex; align-items:center; gap:0.5rem; min-width:0; flex:1; }`,
    `.${ID}-typeBadge { padding:0.125rem 0.5rem; border-radius:0.25rem; font-size:0.625rem; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; border:1px solid var(--ui-stroke-secondary); color:var(--ui-text-primary); }`,
    `.${ID}-inspectorTitle { font-weight:600; font-size:0.875rem; line-height:1.3; overflow-wrap:anywhere; }`,
    `.${ID}-inspectorMeta { font-size:0.75rem; color:var(--ui-text-secondary); margin-top:0.125rem; }`,
    `.${ID}-toolbar { display:flex; align-items:center; gap:0.5rem; padding:0.5rem 0.875rem; border-bottom:1px solid var(--ui-stroke-tertiary); flex:none; background:var(--ui-bg-card); flex-wrap:wrap; }`,
    `.${ID}-preview { flex:1 1 auto; overflow:auto; padding:1rem; display:flex; flex-direction:column; align-items:center; }`,
    `.${ID}-viewport { width:100%; max-width:56rem; background:var(--ui-bg-card); border-radius:0.5rem; border:1px solid var(--ui-stroke-secondary); padding:1rem; overflow:auto; }`,
    `.${ID}-viewportToolbar { display:flex; align-items:center; justify-content:space-between; padding-bottom:0.5rem; margin-bottom:0.75rem; border-bottom:1px solid var(--ui-stroke-tertiary); }`,
    `.${ID}-viewportLabel { font-size:0.75rem; font-weight:600; color:var(--ui-text-quaternary); text-transform:uppercase; letter-spacing:0.04em; }`,
    `.${ID}-zoomControls { display:flex; gap:0.25rem; }`,
    `.${ID}-zoomBtn { padding:0.25rem 0.5rem; border-radius:0.25rem; font-size:0.75rem; font-weight:600; border:1px solid var(--ui-stroke-secondary); background:var(--ui-bg-hover); color:var(--ui-text-secondary); cursor:pointer; }`,
    `.${ID}-zoomBtn:hover { border-color:var(--ui-accent); color:var(--ui-text-primary); }`,
    `.${ID}-panel { width:22rem; min-width:18rem; border-left:1px solid var(--ui-stroke-secondary); display:flex; flex-direction:column; min-height:0; background:var(--ui-bg-card); }`,
    `.${ID}-panelTabs { display:flex; border-bottom:1px solid var(--ui-stroke-secondary); flex:none; }`,
    `.${ID}-panelTab { flex:1; padding:0.625rem; text-align:center; font-size:0.75rem; font-weight:600; cursor:pointer; border:none; border-bottom:2px solid transparent; color:var(--ui-text-secondary); transition:color 0.1s, border-color 0.1s; background:none; }`,
    `.${ID}-panelTab:hover { color:var(--ui-text-primary); }`,
    `.${ID}-panelTabActive { color:var(--ui-accent); border-bottom-color:var(--ui-accent); }`,
    `.${ID}-panelBody { flex:1 1 auto; overflow:auto; padding:0.75rem; }`,
    `.${ID}-retryLabel { font-size:0.75rem; font-weight:700; color:var(--ui-text-primary); margin-bottom:0.25rem; }`,
    `.${ID}-retryHint { font-size:0.6875rem; color:var(--ui-text-quaternary); margin-bottom:0.5rem; }`,
    `.${ID}-chipRow { display:flex; flex-wrap:wrap; gap:0.25rem; margin-bottom:0.5rem; }`,
    `.${ID}-chip { padding:0.25rem 0.5rem; border-radius:0.375rem; font-size:0.6875rem; font-weight:600; border:1px solid var(--ui-stroke-secondary); background:var(--ui-bg-hover); color:var(--ui-text-secondary); cursor:pointer; }`,
    `.${ID}-chip:hover { border-color:var(--ui-accent); color:var(--ui-text-primary); }`,
    `.${ID}-retryTextarea { width:100%; min-height:6rem; padding:0.5rem; border-radius:0.375rem; border:1px solid var(--ui-stroke-secondary); background:var(--ui-bg-base); color:var(--ui-text-primary); font:inherit; font-size:0.8125rem; resize:vertical; }`,
    `.${ID}-retryTextarea:focus { outline:none; border-color:var(--ui-accent); }`,
    `.${ID}-nextVer { font-size:0.6875rem; font-weight:700; color:var(--ui-accent); background:var(--ui-accent-muted); padding:0.125rem 0.5rem; border-radius:999px; }`,
    `.${ID}-submitBtn { width:100%; padding:0.625rem; border-radius:0.5rem; font-size:0.8125rem; font-weight:700; border:none; cursor:pointer; background:var(--ui-accent); color:#fff; }`,
    `.${ID}-submitBtn:hover:not(:disabled) { filter:brightness(1.1); }`,
    `.${ID}-submitBtn:disabled { opacity:0.6; cursor:not-allowed; }`,
    `.${ID}-timeline { display:flex; flex-direction:column; }`,
    `.${ID}-timelineItem { position:relative; padding-left:1.25rem; padding-bottom:0.75rem; border-left:2px solid var(--ui-stroke-secondary); }`,
    `.${ID}-timelineItem:last-child { border-left-color:transparent; padding-bottom:0; }`,
    `.${ID}-timelineDot { position:absolute; left:-0.375rem; top:0.25rem; width:0.5rem; height:0.5rem; border-radius:999px; background:var(--ui-accent); }`,
    `.${ID}-timelineDotPast { background:var(--ui-text-quaternary); }`,
    `.${ID}-timelineAction { font-size:0.75rem; font-weight:600; color:var(--ui-text-primary); }`,
    `.${ID}-timelineTime { font-size:0.6875rem; color:var(--ui-text-quaternary); margin-left:0.375rem; }`,
    `.${ID}-timelineNote { font-size:0.75rem; color:var(--ui-text-secondary); margin-top:0.125rem; line-height:1.4; }`,
    `.${ID}-timelineActor { font-size:0.6875rem; color:var(--ui-text-quaternary); margin-top:0.125rem; }`,
    `.${ID}-fullscreen { position:fixed; inset:0; background:rgba(0,0,0,0.88); z-index:50; display:flex; align-items:center; justify-content:center; padding:1.5rem; }`,
    `.${ID}-fullscreenInner { position:relative; width:100%; max-width:72rem; max-height:90vh; background:var(--ui-bg-card); border-radius:0.5rem; border:1px solid var(--ui-stroke-secondary); display:flex; flex-direction:column; overflow:hidden; }`,
    `.${ID}-fullscreenHead { display:flex; align-items:center; justify-content:space-between; padding:0.75rem 1rem; border-bottom:1px solid var(--ui-stroke-secondary); }`,
    `.${ID}-fullscreenTitle { font-size:0.875rem; font-weight:600; color:var(--ui-text-primary); }`,
    `.${ID}-fullscreenClose { padding:0.25rem 0.5rem; border-radius:0.25rem; border:1px solid var(--ui-stroke-secondary); background:var(--ui-bg-hover); color:var(--ui-text-secondary); cursor:pointer; font-size:0.75rem; }`,
    `.${ID}-fullscreenBody { flex:1 1 auto; overflow:auto; display:flex; align-items:center; justify-content:center; padding:1rem; }`,
    `.${ID}-empty { text-align:center; padding:2.5rem; max-width:20rem; border:1px dashed var(--ui-stroke-secondary); border-radius:0.75rem; background:var(--ui-bg-card); }`,
    `.${ID}-emptyIcon { display:inline-flex; align-items:center; justify-content:center; width:2.5rem; height:2.5rem; border-radius:0.5rem; margin-bottom:0.75rem; background:var(--ui-accent-muted); color:var(--ui-accent); font-size:1.25rem; }`,
    `.${ID}-emptyTitle { font-size:0.875rem; font-weight:700; color:var(--ui-text-primary); }`,
    `.${ID}-emptyDesc { font-size:0.75rem; color:var(--ui-text-secondary); margin-top:0.25rem; }`,
    `.${ID}-reasonRow { display:flex; gap:0.5rem; align-items:center; flex:1; min-width:0; flex-basis:100%; }`,
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

function getTypeColor(type) {
  const t = (type || 'artifact').toLowerCase()
  const map = { post: '#6366f1', task: '#6366f1', reel: '#e11d48', pdf: '#d97706', artifact: '#6366f1', md: '#9333ea', excel: '#059669', mp4: '#e11d48', png: '#2563eb', jpg: '#2563eb' }
  return map[t] || '#6366f1'
}

function showToast(message, kind = 'info') {
  host?.notify?.({ kind, message })
}

function metricChip(label, count, color) {
  return jsxs('span', { className: `${ID}-metric`, children: [
    jsx('span', { className: `${ID}-metricDot`, style: { backgroundColor: color } }),
    jsxs('span', { children: [label, ': ', String(count)] }),
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

const DOT = { pending: '#b45309', approved: '#047857', rejected: '#b91c1c' }

function StatusBadge({ status }) {
  return jsx(Badge, { variant: 'outline', children: [
    jsx('span', { className: `${ID}-dot`, style: { backgroundColor: DOT[status] || DOT.pending } }),
    jsx('span', { children: status }),
  ] })
}

function PreviewBlock({ msgId, hasFiles, onFullscreen }) {
  const pv = usePreview(msgId, hasFiles)
  const [expanded, setExpanded] = useState(null)
  if (!hasFiles || pv.isLoading) return null
  if (pv.isError) {
    const status = pv.error && (pv.error.status || pv.error.statusCode)
    const oldBackend = status === 404
    return jsxs('div', { className: `${ID}-prev`, children: [
      jsx('div', { className: `${ID}-prevPdf`, children:
        jsx('span', { className: `${ID}-note`, children: oldBackend
          ? 'Preview needs the new backend — fully quit and reopen your Desktop app, then come back.'
          : 'Could not load the preview.' }) }),
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
    ...mds.map(f => jsxs('div', { className: `${ID}-prevDoc`, children: [
      jsxs('div', { className: `${ID}-viewportToolbar`, children: [
        jsx('span', { className: `${ID}-viewportLabel`, children: 'MARKDOWN' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { if (expanded === f.name) { setExpanded(null); } else { onFullscreen(f); } }, children: expanded === f.name ? 'Close' : 'Fullscreen' }),
      ] }),
      expanded === f.name
        ? jsx('div', { className: `${ID}-viewport`, style: { padding: '1rem' }, dangerouslySetInnerHTML: { __html: renderSimpleMd(decodeDataUrl(f.data_url)) } })
        : jsx('div', { className: `${ID}-viewport`, style: { padding: '1rem' }, dangerouslySetInnerHTML: { __html: renderSimpleMd(decodeDataUrl(f.data_url)) } })
    ], key: f.name })),
    ...htmls.map(f => jsxs('div', { className: `${ID}-prevDoc`, children: [
      jsxs('div', { className: `${ID}-viewportToolbar`, children: [
        jsx('span', { className: `${ID}-viewportLabel`, children: 'HTML' }),
        jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { if (expanded === f.name) { setExpanded(null); } else { onFullscreen(f); } }, children: expanded === f.name ? 'Close' : 'Fullscreen' }),
      ] }),
      expanded === f.name
        ? jsx('div', { className: `${ID}-viewport`, style: { padding: '1rem' }, dangerouslySetInnerHTML: { __html: decodeDataUrl(f.data_url) } })
        : jsx('div', { className: `${ID}-viewport`, style: { padding: '1rem' }, dangerouslySetInnerHTML: { __html: decodeDataUrl(f.data_url) } })
    ], key: f.name })),
    ...rest.map(f => jsx('div', { className: `${ID}-prevPdf`, children: jsx('span', { className: `${ID}-prevName`, children: `${f.name} · ${fmtSize(f.size)} (too large to preview inline)` }), key: f.name })),
  ] })
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'reget', label: 'Re-Get' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

function FeedRow({ item, selected, onSelect }) {
  const decided = item.status !== 'pending'
  return jsxs('div', {
    className: `${ID}-row${selected ? ` ${ID}-rowSelected` : ''}${decided ? ` ${ID}-rowDecided` : ''}`,
    onClick: () => onSelect(item.msg_id),
    children: [
      jsx('div', { className: `${ID}-rowIcon`, style: { background: getTypeColor(item.type) + '20', color: getTypeColor(item.type), borderColor: getTypeColor(item.type) + '40' }, children: getTypeLabel(item.type) }),
      jsxs('div', { className: `${ID}-rowBody`, children: [
        jsxs('div', { className: `${ID}-rowHead`, children: [
          jsx('span', { className: `${ID}-rowTitle`, children: itemTitle(item) }),
          jsx('span', { className: `${ID}-rowTime`, title: absTime(item.ts), children: relTime(item.ts) || absTime(item.ts) }),
        ]}),
        jsxs('div', { className: `${ID}-rowFoot`, children: [
          jsx(StatusBadge, { status: decided ? item.status : 'pending' }),
          jsxs('span', { className: `${ID}-rowVer`, children: ['v', (item.artifact || {}).version || '?'] }),
        ]}),
      ]}),
    ]
  })
}

function FeedSidebar({ items, selectedId, onSelect, needle, onNeedleChange, filter, onFilterChange, counts }) {
  return jsxs('div', { className: `${ID}-feed`, children: [
    jsxs('div', { className: `${ID}-feedHead`, children: [
      jsxs('div', { className: `${ID}-searchWrap`, children: [
        jsx('span', { className: `${ID}-searchIcon`, children: 'Search' }),
        jsx(SearchField, {
          value: needle,
          onChange: (v) => onNeedleChange(asText(v)),
          placeholder: 'Search subject, owner, artifact…',
          'aria-label': 'Search approval requests',
          containerClassName: `${ID}-searchField`,
        }),
      ]}),
      jsxs('div', { className: `${ID}-filterRow`, children: [
        ...FILTERS.map(f =>
          jsx('button', {
            key: f.id,
            className: `${ID}-filterChip${filter === f.id ? ` ${ID}-filterChipActive` : ''}`,
            onClick: () => onFilterChange(f.id),
            children: `${f.label} (${counts[f.id] ?? 0})`,
          })
        ),
      ]}),
    ]}),
    jsx(ScrollArea, { className: `${ID}-feedScroll`, children:
      items.length === 0
        ? jsx('div', { className: 'grid h-full place-items-center p-4', children:
            jsx('div', { className: `${ID}-emptyDesc`, style: { textAlign: 'center' }, children: 'No requests match your query.' })
          })
        : jsxs('div', { className: `${ID}-feedList`, children: [
            ...items.map(it => jsx(FeedRow, { item: it, selected: it.msg_id === selectedId, onSelect, key: it.msg_id })),
          ]})
    }),
  ] })
}

function CenterWorkspace({ item, decide, busy, zoom, onZoomChange, onFullscreen, onApproveClick, onRejectClick, rejectOpen, rejectNote, onRejectNoteChange, sendReject }) {
  const msgId = item?.msg_id
  const hasFiles = (item?.attachments?.length || 0) > 0
  const pv = usePreview(msgId, hasFiles)
  const art = item?.artifact || {}
  const decision = item?.decision || {}
  const decided = item?.status !== 'pending'
  const [approveOpen, setApproveOpen] = useState(false)

  if (!item) {
    return jsxs('div', { className: `${ID}-workspace`, children: [
      jsx('div', { className: `${ID}-empty`, children: [
        jsx('div', { className: `${ID}-emptyIcon`, children: 'Artifact' }),
        jsx('div', { className: `${ID}-emptyTitle`, children: 'No Artifact Selected' }),
        jsx('div', { className: `${ID}-emptyDesc`, children: 'Select a request from the inbox to review quality and initiate actions.' }),
      ]}),
    ] })
  }

  const previewFiles = pv.data || []
  const mainImage = previewFiles.find(f => f.kind === 'image' && f.data_url)
  const mainVideo = previewFiles.find(f => f.kind === 'video' && f.data_url)

  return jsxs('div', { className: `${ID}-workspace`, children: [
    jsxs('div', { className: `${ID}-inspector`, children: [
      jsxs('div', { className: `${ID}-inspectorLeft`, children: [
        jsx('span', { className: `${ID}-typeBadge`, style: { background: getTypeColor(item.type) + '18', borderColor: getTypeColor(item.type) + '40', color: getTypeColor(item.type) }, children: getTypeLabel(item.type) }),
        jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
          jsx('div', { className: `${ID}-inspectorTitle`, children: itemTitle(item) }),
          jsxs('div', { className: `${ID}-inspectorMeta`, children: [
            `File: ${art.name || '-'} · ${absTime(item.ts)} · v${art.version || '?'}`,
          ]}),
        ]}),
        jsx(StatusBadge, { status: decided ? item.status : 'pending' }),
      ]}),
      !decided ? jsxs('div', { className: `${ID}-toolbar`, children: [
        jsx(Button, { size: 'sm', onClick: onApproveClick, disabled: busy || decide.isPending, children: (busy || decide.isPending) ? 'Working…' : 'Approve' }),
        jsx(Button, { size: 'sm', variant: 'ghost', onClick: onRejectClick, disabled: busy || decide.isPending, children: rejectOpen ? 'Cancel' : 'Reject' }),
        rejectOpen ? jsxs('div', { className: `${ID}-reasonRow`, children: [
          jsx(Input, { value: rejectNote, onChange: (e) => onRejectNoteChange(asText(e)), placeholder: 'Reason for rejection…', 'aria-label': 'Rejection reason' }),
          jsx(Button, { size: 'sm', variant: 'outline', onClick: sendReject, disabled: busy || decide.isPending, children: 'Send' }),
        ]}) : null,
      ]}) : jsxs('div', { className: `${ID}-toolbar`, children: [
        jsx(StatusBadge, { status: item.status }),
        decision.note ? jsxs('span', { className: `${ID}-inspectorMeta`, children: [decision.note, ' · ', absTime(decision.ts)] }) : null,
      ]}),
    ]}),
    jsx(ConfirmDialog, {
      open: approveOpen,
      onClose: () => setApproveOpen(false),
      title: `Approve "${art.name || itemTitle(item)}"?`,
      description: art.version ? `Version ${art.version}${item.next_action ? ` · next: ${item.next_action}` : ''}` : (item.next_action ? `Next: ${item.next_action}` : 'This records the approval.'),
      confirmLabel: 'Approve',
      onConfirm: async () => { decide.mutate({ item, decision: 'approve', note: '' }); setApproveOpen(false) },
    }),
    jsx('div', { className: `${ID}-preview`, children: pv.isLoading && hasFiles ? jsx('div', { className: 'grid h-full place-items-center', children: jsx(GlyphSpinner, {}) }) : (
      jsxs('div', { className: `${ID}-viewport`, children: [
        jsxs('div', { className: `${ID}-viewportToolbar`, children: [
          jsx('span', { className: `${ID}-viewportLabel`, children: `${(item.type || 'artifact').toUpperCase()} Viewport` }),
          (mainImage || mainVideo) ? jsxs('div', { className: `${ID}-zoomControls`, children: [
            jsx('button', { className: `${ID}-zoomBtn`, onClick: () => onZoomChange(Math.max(0.5, zoom - 0.1)), children: '−' }),
            jsx('button', { className: `${ID}-zoomBtn`, onClick: () => onZoomChange(Math.min(2.5, zoom + 0.1)), children: '+' }),
            jsx('button', { className: `${ID}-zoomBtn`, onClick: () => onZoomChange(1), children: 'Reset' }),
            jsx('button', { className: `${ID}-zoomBtn`, onClick: () => { const f = mainImage || mainVideo; if (f) onFullscreen(f) }, children: 'Fullscreen' }),
          ]}) : null,
        ]}),
        (item.next_action || item.subject) ? jsxs('div', { className: `${ID}-mdContent`, children: [
          jsxs('h3', { children: ['Context: ', itemTitle(item)] }),
          renderSimpleMd(item.next_action || ''),
        ]}) : null,
        hasFiles ? jsx('div', { style: { marginTop: '1rem', width: '100%' }, children: jsx(PreviewBlock, { msgId, hasFiles: true, onFullscreen }) }) : null,
      ] })
    )}),
  ] })
}

function RightPanel({ item, tab, onTabChange, retryNote, onRetryNoteChange, onRetrySubmit, retryBusy }) {
  if (!item) {
    return jsxs('div', { className: `${ID}-panel`, children: [
      jsxs('div', { className: `${ID}-panelTabs`, children: [
        jsx('button', { className: `${ID}-panelTab ${ID}-panelTabActive`, children: 'Retry Studio' }),
        jsx('button', { className: `${ID}-panelTab`, children: 'Audit Trail' }),
      ]}),
      jsx('div', { className: `${ID}-panelBody`, children: 
        jsxs('div', { className: `${ID}-empty`, children: [
          jsx('div', { className: `${ID}-emptyIcon`, children: 'Artifact' }),
          jsx('div', { className: `${ID}-emptyTitle`, children: 'No Artifact Selected' }),
          jsx('div', { className: `${ID}-emptyDesc`, children: 'Select an artifact to use Retry Studio and view audit history.' }),
        ] })
      }),
    ] })
  }

  const art = item.artifact || {}
  const nextVer = String((parseInt(art.version || '1')) + 1)
  const decided = item.status !== 'pending'
  const chips = ['Remove Em-dashes', 'High-contrast typography', 'Shorten subtext', 'Punchy headline']

  return jsxs('div', { className: `${ID}-panel`, children: [
    jsxs('div', { className: `${ID}-panelTabs`, children: [
      jsx('button', { className: `${ID}-panelTab${tab === 'retry' ? ` ${ID}-panelTabActive` : ''}`, onClick: () => onTabChange('retry'), children: 'Retry Studio' }),
      jsx('button', { className: `${ID}-panelTab${tab === 'history' ? ` ${ID}-panelTabActive` : ''}`, onClick: () => onTabChange('history'), children: 'Audit Trail' }),
    ]}),
    jsxs('div', { className: `${ID}-panelBody`, children: [
      tab === 'retry' ? jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }, children: [
          jsx('label', { className: `${ID}-retryLabel`, children: 'Retry instructions' }),
          jsxs('span', { className: `${ID}-nextVer`, children: ['Next: v', nextVer] }),
        ]}),
        jsx('p', { className: `${ID}-retryHint`, children: 'Add instructions to refine the artifact before re-triggering the producing lane.' }),
        jsxs('div', { className: `${ID}-chipRow`, children: [
          ...chips.map(c => jsx('button', { key: c, className: `${ID}-chip`, onClick: () => onRetryNoteChange(v => v ? `${v}, ${c}` : c), children: c })),
        ]}),
        jsx('textarea', { className: `${ID}-retryTextarea`, value: retryNote, onChange: (e) => onRetryNoteChange(e.target.value), placeholder: 'Enter explicit guidelines to eliminate issues or adjust layout/copy…', rows: 5 }),
        decided ? jsx('div', { className: `${ID}-retryHint`, children: 'This item has already been decided. Submit will create a new pending version.' }) : null,
        jsx('button', { className: `${ID}-submitBtn`, onClick: onRetrySubmit, disabled: retryBusy || !retryNote.trim(), children: retryBusy ? 'Submitting…' : 'Request new version' }),
      ]}) : jsxs('div', { children: [
        jsxs('div', { className: `${ID}-timelineItem`, children: [
          jsx('div', { className: `${ID}-timelineDotPast` }),
          jsxs('div', { children: [
            jsx('span', { className: `${ID}-timelineAction`, children: 'Submitted' }),
            jsx('span', { className: `${ID}-timelineTime`, children: absTime(item.ts) }),
          ]}),
        ]}),
        decided && item.decision ? jsxs('div', { className: `${ID}-timelineItem`, children: [
          jsx('div', { className: `${ID}-timelineDot` }),
          jsxs('div', { children: [
            jsxs('span', { className: `${ID}-timelineAction`, children: [item.status === 'approved' ? 'Approved' : 'Rejected'] }),
            jsx('span', { className: `${ID}-timelineTime`, children: absTime(item.decision.ts) }),
          ]}),
          item.decision.note ? jsx('div', { className: `${ID}-timelineNote`, children: item.decision.note }) : null,
          jsxs('div', { className: `${ID}-timelineActor`, children: ['Decided by ', item.decision.by || item.originating_agent || '-'] }),
        ]}) : null,
      ]}),
    ]}),
  ] })
}

function FullscreenModal({ file, onClose }) {
  if (!file) return null
  return jsxs('div', { className: `${ID}-fullscreen`, onClick: onClose, children: [
    jsxs('div', { className: `${ID}-fullscreenInner`, onClick: (e) => e.stopPropagation(), children: [
      jsxs('div', { className: `${ID}-fullscreenHead`, children: [
        jsxs('span', { className: `${ID}-fullscreenTitle`, children: [file.name, ' — full view'] }),
        jsx('button', { className: `${ID}-fullscreenClose`, onClick: onClose, children: 'Close' }),
      ]}),
      jsx('div', { className: `${ID}-fullscreenBody`, children: 
        file.kind === 'image' ? jsx('img', { src: file.data_url, style: { maxHeight: '80vh', maxWidth: '100%', objectFit: 'contain' } })
        : file.kind === 'video' ? jsx('video', { src: file.data_url, controls: true, style: { maxHeight: '80vh', maxWidth: '100%' } })
        : file.kind === 'pdf' ? jsx('embed', { src: file.data_url, type: 'application/pdf', style: { width: '100%', height: '70vh' } })
        : file.kind === 'md' ? jsx('div', { className: `${ID}-viewport`, style: { padding: '1rem' }, dangerouslySetInnerHTML: { __html: renderSimpleMd(decodeDataUrl(file.data_url)) } })
        : file.kind === 'html' ? jsx('div', { className: `${ID}-viewport`, style: { padding: '1rem' }, dangerouslySetInnerHTML: { __html: decodeDataUrl(file.data_url) } })
        : jsx('div', { children: 'Full preview not available for this file type.' })
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

  const pending = items.filter(i => i.status === 'pending')
  const counts = {
    all: items.length,
    pending: pending.length,
    reget: items.filter(i => i.status === 'rejected' && i.decision && /re-get|rework|retry/i.test(i.decision.note || '')).length,
    approved: items.filter(i => i.status === 'approved').length,
    rejected: items.filter(i => i.status === 'rejected').length,
  }

  const byNewest = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))
  let visible = items.filter(i => matches(i, needle)).sort(byNewest)
  if (filter === 'pending') visible = visible.filter(i => i.status === 'pending')
  if (filter === 'approved') visible = visible.filter(i => i.status === 'approved')
  if (filter === 'rejected') visible = visible.filter(i => i.status === 'rejected')
  if (filter === 'reget') visible = visible.filter(i => i.status === 'rejected' && i.decision && /re-get|rework|retry/i.test(i.decision.note || ''))
  if (filter === 'all') {
    const rank = (i) => (i.status === 'pending' ? 0 : 1)
    visible = [...visible].sort((a, b) => rank(a) - rank(b) || byNewest(a, b))
  }

  const selectedItem = selectedId ? items.find(i => i.msg_id === selectedId) : null
  const busy = decide.isPending || retryBusy

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
      ? { title: 'Nothing here yet', description: 'Approval requests will appear here.' }
      : { title: 'Nothing in this view', description: 'No requests match the current filter.' }

  return jsxs('div', { className: `${ID}`, children: [
    jsxs('div', { className: `${ID}-header`, children: [
      jsx('button', { className: `${ID}-brand`, onClick: () => { if (host?.navigate) host.navigate(PAGE_PATH) }, children: 'Approval Inbox' }),
      jsxs('div', { className: `${ID}-metrics`, children: [
        metricChip('Pending', counts.pending, '#b45309'),
        metricChip('Re-Get', counts.reget, '#6366f1'),
        metricChip('Approved', counts.approved, '#047857'),
        metricChip('Rejected', counts.rejected, '#b91c1c'),
      ]}),
      jsx('span', { className: `${ID}-spacer` }),
      jsx(SearchField, {
        value: needle,
        onChange: (v) => setNeedle(asText(v)),
        placeholder: 'Search subject, owner, artifact…',
        'aria-label': 'Search approval requests',
        containerClassName: 'w-56',
      }),
      jsx(Button, { size: 'xs', variant: 'ghost', onClick: () => { queryClient.invalidateQueries({ queryKey: [ID] }) }, disabled: q.isPending, 'aria-label': 'Refresh inbox', children: q.isPending ? 'Refreshing…' : 'Refresh' }),
    ]}),
    jsxs('div', { className: `${ID}-body`, children: [
      jsx(FeedSidebar, { items: visible, selectedId, onSelect: setSelectedId, needle, onNeedleChange: setNeedle, filter, onFilterChange: setFilter, counts }),
      q.isLoading && items.length === 0
        ? jsx('div', { className: `${ID}-workspace`, children: jsx('div', { className: 'grid h-full place-items-center', children: jsx(GlyphSpinner, {}) }) })
        : error
          ? jsxs('div', { className: `${ID}-workspace`, children: [
              jsx(ErrorState, { title: 'Could not load approvals', description: error }),
              jsx(Button, { size: 'xs', variant: 'outline', onClick: () => { queryClient.invalidateQueries({ queryKey: [ID] }) }, children: 'Retry' }),
            ]})
          : selectedItem
            ? jsx(CenterWorkspace, { item: selectedItem, decide, busy, zoom, onZoomChange: setZoom, onFullscreen: setFullscreen, onApproveClick: () => setApproveOpen(true), onRejectClick: () => setRejectOpen(true), rejectOpen, rejectNote, onRejectNoteChange: setRejectNote, sendReject })
            : jsxs('div', { className: `${ID}-workspace`, children: [
                jsx('div', { className: `${ID}-empty`, children: [
                  jsx('div', { className: `${ID}-emptyIcon`, children: 'Artifact' }),
                  jsx('div', { className: `${ID}-emptyTitle`, children: emptyCopy.title }),
                  jsx('div', { className: `${ID}-emptyDesc`, children: emptyCopy.description }),
                ]}),
              ] }),
      jsx(RightPanel, { item: selectedItem, tab: rightTab, onTabChange: setRightTab, retryNote, onRetryNoteChange: setRetryNote, onRetrySubmit: handleRetrySubmit, retryBusy }),
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
  description: 'Three-pane approval workspace: feed, preview, and retry studio.',
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
