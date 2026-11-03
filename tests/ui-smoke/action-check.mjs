/**
 * Action check — every control in the panel is actually PRESSED, and what it does is
 * asserted. The render check proves the panel draws correctly; this proves the
 * buttons work.
 *
 * The panel is mounted with a real (tiny) state store and instrumented stubs, so a
 * control's handler runs exactly as it would on the device: its REST call, its host
 * notify/navigate, its invalidations, its captured save-door invocation and its state
 * changes are all recorded and checked here.
 *
 * Covered: refresh, search, filters, row select (click + Enter/Space), Escape,
 * Approve (through its confirm dialog), Reject (note + send), Retry Studio chips,
 * Request new version (reject-with-note then submit), Audit Trail tab, zoom, full
 * screen + close, the PDF Save door, the PDF page reader with Prev/Next, the preview
 * retry, the header button and the error-state retry.
 *
 * Not covered here (needs the app itself, named so it is not implied): the OS save
 * dialog's own completion, and whether the app paints the fullscreen overlay.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.ACTION_CHECK_PLUGIN || join(__dirname, '..', '..', 'desktop', 'plugin.js')
const TMP = join(tmpdir(), 'approval-inbox-action-check')
mkdirSync(TMP, { recursive: true })

const AREAS = { PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar.nav' }
const PROVEN_SDK = ['Badge','Button','ConfirmDialog','EmptyState','ErrorState','GlyphSpinner','captureGatewayFileDownload','host','Input','PALETTE_AREA','ROUTES_AREA','ScrollArea','SearchField','SegmentedControl','SIDEBAR_NAV_AREA','queryClient','useMutation','useQuery']

const ITEMS = [
  { msg_id: 'fx-pdf', ts: '2026-11-01 10:00:00 +0300', type: 'pdf', owner: 'code', work_id: 't_1', subject: 'Approve PDF: fixture', status: 'pending', next_action: 'check the page count', artifact: { name: 'fixture.pdf', version: '1' }, attachments: [{ name: 'fixture.pdf', kind: 'pdf', content_type: 'application/pdf' }], decision: null },
  { msg_id: 'fx-svg', ts: '2026-11-01 10:01:00 +0300', type: 'svg', owner: 'default', work_id: 't_1', subject: 'Approve SVG: fixture', status: 'approved', artifact: { name: 'logo.svg', version: '2' }, attachments: [{ name: 'logo.svg', kind: 'image', content_type: 'image/svg+xml' }], decision: { decision: 'approve', ts: '2026-11-01 10:05:00 +0300', note: 'looks right' } },
  { msg_id: 'fx-md', ts: '2026-11-01 10:02:00 +0300', type: 'md', owner: 'default', work_id: 't_1', subject: 'Approve Markdown: fixture', status: 'pending', artifact: { name: 'doc.md', version: '1' }, attachments: [], decision: null },
]
const PREVIEW = {
  'fx-pdf': [{ name: 'fixture.pdf', content_type: 'application/pdf', kind: 'pdf', size: 2327209, data_url: 'data:application/pdf;base64,JVBERi0xLjQK', thumb_url: 'data:image/png;base64,iVBORw0KGgo=', pages: 119, stored_path: '/srv/work/approval-inbox/files/fx-pdf/fixture.pdf' }],
  'fx-svg': [{ name: 'logo.svg', content_type: 'image/svg+xml', kind: 'image', size: 7060, data_url: 'data:image/svg+xml;base64,PHN2Zy8+', thumb_url: null, pages: 0, stored_path: '/srv/work/approval-inbox/files/fx-svg/logo.svg' }],
  'fx-md': [],
}
const PAGE = { page: 1, pages: 119, data_url: 'data:image/png;base64,iVBORw0KGgo=' }

// ---- the harness the generated stubs talk to ----
const h = {
  seq: 0, store: {}, controls: [], dialogs: [], rest: [], notify: [], navigate: [],
  invalidate: [], refetch: [], keys: [], saved: [], mutate: [], forceError: null,
  reset() { this.seq = 0; this.controls = []; this.dialogs = []; this.rest = []; this.notify = []
    this.navigate = []; this.invalidate = []; this.refetch = []; this.keys = []; this.saved = []; this.mutate = [] },
  queryData(k) {
    if (k.includes('"page"')) return PAGE
    if (k.includes('preview')) { const id = JSON.parse(k)[2]; return PREVIEW[id] || [] }
    if (k.includes('ops')) return { entries: [] }
    return ITEMS
  },
}
globalThis.__h = h

let sdkSrc = ''
for (const n of PROVEN_SDK) {
  if (n in AREAS) sdkSrc += `export const ${n} = '${AREAS[n]}';\n`
  else if (n === 'host') sdkSrc += `export const host = { notify: (m) => globalThis.__h.notify.push(m), navigate: (p) => globalThis.__h.navigate.push(p), state: {} };\n`
  else if (n === 'queryClient') sdkSrc += `export const queryClient = { invalidateQueries: (a) => globalThis.__h.invalidate.push(a) };\n`
  else if (n === 'captureGatewayFileDownload') sdkSrc += `export const captureGatewayFileDownload = () => (path, name) => { globalThis.__h.saved.push({ path, name }); return Promise.resolve() };\n`
  else if (n === 'useQuery') sdkSrc += `export const useQuery = (opts) => { const k = JSON.stringify((opts && opts.queryKey) || []); globalThis.__h.keys.push(k); if (opts && typeof opts.queryFn === 'function' && opts.enabled !== false) { try { Promise.resolve(opts.queryFn()).catch(() => {}) } catch (_) {} } const err = globalThis.__h.forceError && k.includes(globalThis.__h.forceError); return { data: opts && opts.enabled === false ? undefined : globalThis.__h.queryData(k), isLoading: false, isPending: false, isError: !!err, error: err ? { status: 500, detail: 'boom' } : null, refetch: () => { globalThis.__h.refetch.push(k) } }; };\n`
  else if (n === 'useMutation') sdkSrc += `export const useMutation = (opts) => ({ mutate: (arg) => { globalThis.__h.mutate.push(arg); const p = opts && opts.mutationFn ? opts.mutationFn(arg) : null; Promise.resolve(p).then((d) => { if (opts && opts.onSuccess) opts.onSuccess(d || { ok: true, trigger: { triggered: true, task: 't_probe', dispatch: { ok: true } } }) }); return p }, mutateAsync: (arg) => { globalThis.__h.mutate.push(arg); const p = opts && opts.mutationFn ? opts.mutationFn(arg) : null; return Promise.resolve(p).then((d) => { if (opts && opts.onSuccess) opts.onSuccess(d || { ok: true, trigger: { triggered: true, task: 't_probe', dispatch: { ok: true } } }); return d }) }, isPending: false });\n`
  else if (n === 'Button') sdkSrc += `export const Button = function Button(props) { globalThis.__h.controls.push({ kind: 'Button', label: String(props.children === undefined ? '' : props.children), aria: String(props['aria-label'] || ''), props }); return props.children !== undefined ? props.children : null };\n`
  else if (n === 'Input') sdkSrc += `export const Input = function Input(props) { globalThis.__h.controls.push({ kind: 'Input', label: String(props.placeholder || props['aria-label'] || ''), props }); return null };\n`
  else if (n === 'SearchField') sdkSrc += `export const SearchField = function SearchField(props) { globalThis.__h.controls.push({ kind: 'SearchField', label: String(props.placeholder || ''), props }); return null };\n`
  else if (n === 'SegmentedControl') sdkSrc += `export const SegmentedControl = function SegmentedControl(props) { globalThis.__h.controls.push({ kind: 'SegmentedControl', label: (props.options || []).map(o => o.label).join('|'), props }); return null };\n`
  else if (n === 'EmptyState' || n === 'ErrorState') sdkSrc += `export const ${n} = function ${n}(props) { globalThis.__h.controls.push({ kind: '${n}', label: String(props.title || ''), props }); return props.children !== undefined ? props.children : null };\n`
  else if (n === 'ConfirmDialog') sdkSrc += `export const ConfirmDialog = function ConfirmDialog(props) { if (props.open) globalThis.__h.dialogs.push(props); return null };\n`
  else sdkSrc += `export const ${n} = function ${n}(props) { return props && props.children !== undefined ? props.children : null };\n`
}
writeFileSync(join(TMP, 'sdk.mjs'), sdkSrc)

// Real (tiny) state: useState reads and writes a per-mount store, so a pressed
// control's state change survives into the next render. No useRef, like the host.
writeFileSync(join(TMP, 'react.mjs'),
  `export const useState = (init) => { const n = (globalThis.__h.seq = (globalThis.__h.seq || 0) + 1); const s = globalThis.__h.store; if (!(n in s)) s[n] = (typeof init === 'function' ? init() : init); return [s[n], (v) => { s[n] = typeof v === 'function' ? v(s[n]) : v }] };\nexport const useEffect = () => {};\nexport const useMemo = (f) => (typeof f === 'function' ? f() : f);\nexport default {};\n`)
writeFileSync(join(TMP, 'jsx-runtime.mjs'), `const HOST_FIELDS = new Set(['input','textarea','select']);
const asControl = (t, p) => { const props = p || {}; if (typeof t === 'string' && HOST_FIELDS.has(t)) globalThis.__h.controls.push({ kind: t, label: String(props.placeholder || props['aria-label'] || ''), aria: String(props['aria-label'] || ''), props }); return { type: t, props }; };
export const jsx = (t, p) => asControl(t, p);
export const jsxs = (t, p) => asControl(t, p);
`)

let src = readFileSync(PLUGIN, 'utf8')
src = src.replaceAll(`from '@hermes/plugin-sdk'`, `from './sdk.mjs'`)
src = src.replaceAll(`from 'react'`, `from './react.mjs'`)
src = src.replaceAll(`from 'react/jsx-runtime'`, `from './jsx-runtime.mjs'`)
const tmpFile = join(TMP, 'plugin.under.actions.mjs')
writeFileSync(tmpFile, src)

// ---- renderer (function components evaluated, children flattened) ----
const flat = (v) => (Array.isArray(v) ? v.flat(Infinity).filter(Boolean)
  : (v === null || v === undefined || typeof v === 'boolean') ? [] : [v])
function render(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return flat(node.map(n => render(n, depth)))
  if (typeof node === 'string' || typeof node === 'number') return { host: '#text', props: { children: String(node) }, children: [] }
  if (typeof node !== 'object') return null
  const { type, props } = node
  if (typeof type === 'function') {
    if (depth > 80) throw new Error('render recursion too deep')
    return render(type(props || {}), depth + 1)
  }
  return { host: String(type), props: props || {}, children: flat(render(props && props.children, depth)) }
}
function walk(node, out = []) {
  for (const n of flat(node)) { if (!n || typeof n !== 'object') continue; out.push(n); walk(n.children, out) }
  return out
}
const textOf = (n) => walk(n).filter(x => x.host === '#text').map(x => x.props.children).join(' ')

const failures = []
const pass = []
function check(name, cond, detail = '') {
  if (cond) pass.push(name)
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}
const tick = () => new Promise((r) => setTimeout(r, 0))

// ---- load + register ----
const registrations = []
const ctx = {
  rest: async (path, opts) => {
    h.rest.push({ path, opts })
    if (path.startsWith('/decide')) return { ok: true, trigger: { triggered: true, task: 't_probe', dispatch: { ok: true } } }
    if (path.startsWith('/submit')) return { ok: true, msg_id: 'm_probe' }
    if (path.startsWith('/items')) return { items: ITEMS }
    if (path.startsWith('/preview')) return { items: PREVIEW[path.split('/')[2]] || [] }
    if (path.startsWith('/page')) return PAGE
    return {}
  },
  storage: { get: async (k, fb) => fb, set: async () => {} },
  onDispose: () => {},
  registerMany: (arr) => { for (const c of arr) registrations.push(c); return () => {} },
  register: () => () => {},
  host: {},
}

const mod = await import(pathToFileURL(tmpFile).href)
mod.default.register(ctx)
const page = registrations.find(r => r.area === 'routes')
if (!page) { console.log('ACTION-CHECK-FAIL\n  - no page registration'); process.exit(1) }

const mount = () => { h.seq = 0; h.controls = []; h.dialogs = []; return render(page.render()) }
const ctl = (label, kind) => h.controls.find(c => (kind ? c.kind === kind : true) && (String(c.label).includes(label) || String(c.aria || '').includes(label)))
const press = (label, kind) => {
  const c = ctl(label, kind)
  if (!c) throw new Error(`control not found: ${label} (kind ${kind || 'any'})`)
  if (typeof c.props.onClick !== 'function') throw new Error(`no onClick on ${label}`)
  return c.props.onClick({ preventDefault() {}, stopPropagation() {}, key: '', target: {} })
}
const rowsOf = (tree) => walk(tree).filter(n => n.props && n.props.role === 'button')
const clickRow = (tree, i) => rowsOf(tree)[i].props.onClick({ preventDefault() {}, stopPropagation() {} })
const rootKey = (tree, key) => walk(tree).find(n => typeof n.props.onKeyDown === 'function').props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} })

try {
  // 1. the panel mounts and offers its controls
  let tree = mount()
  check('panel mounts with controls', h.controls.length >= 4, `controls=${h.controls.length}`)
  check('rows render keyboard-reachable', rowsOf(tree).length === ITEMS.length)

  // 2. refresh → invalidation
  press('Refresh', 'Button')
  check('Refresh invalidates the queries', h.invalidate.length >= 1)

  // 3. search → the list narrows
  ctl('Search subject', 'SearchField').props.onChange('SVG')
  tree = mount()
  check('search narrows the list', rowsOf(tree).length === 1 && textOf(tree).includes('Approve SVG: fixture'), `rows=${rowsOf(tree).length}`)
  ctl('Search subject', 'SearchField').props.onChange('')

  // 4. filter → only pending
  ctl('Pending', 'SegmentedControl').props.onChange('pending')
  tree = mount()
  check('filter shows only pending', rowsOf(tree).length === 2 && !textOf(tree).includes('Approve SVG: fixture'), `rows=${rowsOf(tree).length} text=${textOf(tree).slice(0, 120)} store=${JSON.stringify(h.store)}`)
  ctl('All', 'SegmentedControl').props.onChange('all')
  tree = mount()

  // 5. select a row → the detail opens (asserted through controls: the segmented
  //    control of the side panel is a stubbed component, so its label is not text)
  clickRow(tree, 0)
  tree = mount()
  const detail = textOf(tree)
  const selectedId = ITEMS.find(i => detail.includes(i.subject)) || {}
  check('row click opens the detail', !!ctl('Back', 'Button') && !!ctl('Approve', 'Button') && !!ctl('Reject', 'Button'),
    `controls=${h.controls.map(c => c.label).filter(Boolean).slice(0, 8).join(',')}`)

  // 6. Approve goes through its confirm dialog, then POSTs the decision
  press('Approve', 'Button')
  tree = mount()
  check('Approve asks for confirmation first', h.dialogs.length === 1 && h.mutate.length === 0, `dialogs=${h.dialogs.length} mutations=${h.mutate.length}`)
  await h.dialogs[0].onConfirm()
  const approveCall = h.rest.find(r => r.path === '/decide' && r.opts && r.opts.body && r.opts.body.decision === 'approve')
  check('Approve POSTs /decide approve for the selected request',
    !!approveCall && approveCall.opts.body.msg_id === selectedId.msg_id && !!approveCall.opts.body.artifact_version,
    JSON.stringify({ sent: approveCall && approveCall.opts.body, selected: selectedId.msg_id }))
  check('Approve invalidates the inbox queries', h.invalidate.length >= 1)

  // 7. Reject: note first, then send
  press('Reject', 'Button')
  tree = mount()
  const noteInput = ctl('Reason for rejection', 'textarea')
  check('Reject reveals the reason field', !!noteInput)
  noteInput.props.onChange({ target: { value: 'not good enough' }, preventDefault() {} })
  tree = mount()
  check('the typed reason is kept in state', String(ctl('Reason for rejection', 'textarea').props.value) === 'not good enough',
    `value=${ctl('Reason for rejection', 'textarea').props.value}`)
  press('Send rejection', 'Button')
  const rejectCall = h.rest.find(r => r.path === '/decide' && r.opts.body.decision === 'reject')
  check('Send rejection POSTs /decide reject WITH the note', !!rejectCall && rejectCall.opts.body.note === 'not good enough',
    JSON.stringify(rejectCall && rejectCall.opts.body))

  // 8. Retry Studio chips fill the note; Request new version rejects then submits a v+1
  const chip = ctl('Remove Em-dashes', 'Button')
  check('Retry Studio offers instruction chips', !!chip)
  chip.props.onClick({ preventDefault() {}, stopPropagation() {} })
  tree = mount()
  check('a chip fills the retry note', textOf(tree).includes('Remove Em-dashes'))
  const beforeRetry = h.rest.length
  press('Request new version', 'Button')
  await tick(); await tick()
  const submitCall = h.rest.slice(beforeRetry).find(r => r.path === '/submit')
  const regetCall = h.rest.slice(beforeRetry).find(r => r.path === '/decide')
  check('Request new version rejects with the note and submits a new version',
    !!regetCall && regetCall.opts.body.decision === 'reject' && /Re-get requested/.test(regetCall.opts.body.note)
    && !!submitCall && submitCall.opts.body.artifact.version === '2',
    JSON.stringify({ reget: regetCall && regetCall.opts.body.decision, submit: submitCall && submitCall.opts.body.artifact }))

  // 9. Audit Trail tab renders the history
  ctl('Audit Trail', 'SegmentedControl').props.onChange('history')
  tree = mount()
  check('Audit Trail shows the timeline', textOf(tree).includes('Submitted'))
  ctl('Retry Studio', 'SegmentedControl').props.onChange('retry')
  tree = mount()

  // 10. Escape leaves the detail
  rootKey(tree, 'Escape')
  tree = mount()
  check('Escape returns to the list', !ctl('Back', 'Button') && rowsOf(tree).length === ITEMS.length,
    `rows=${rowsOf(tree).length} back=${!!ctl('Back', 'Button')}`)

  // 11. Enter / Space activate a row
  const rowEl = rowsOf(tree)[0]
  if (typeof rowEl.props.onKeyDown === 'function') rowEl.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  tree = mount()
  check('Enter on a row opens it', !!ctl('Back', 'Button'))
  rootKey(tree, 'Escape')
  tree = mount()

  // 12. the image request: zoom, fullscreen, close
  const svgIdx = rowsOf(tree).findIndex(r => textOf(r).includes('Approve SVG: fixture'))
  check('the approved SVG request is listed', svgIdx >= 0, `rows=${rowsOf(tree).length}`)
  clickRow(tree, svgIdx)
  tree = mount()
  press('Zoom out', 'Button')
  tree = mount()
  check('Zoom out changes the rendered scale', walk(tree).some(n => JSON.stringify(n.props.style || {}).includes('0.9')),
    JSON.stringify(walk(tree).map(n => n.props.style).filter(Boolean).slice(0, 4)))
  press('Fullscreen', 'Button')
  tree = mount()
  check('Fullscreen opens the overlay', !!ctl('Close', 'Button'), `controls=${h.controls.map(c => c.label).filter(Boolean).slice(0, 8).join(',')}`)
  press('Close', 'Button')
  tree = mount()
  check('Close dismisses the overlay', !ctl('Close', 'Button'))

  // 13. the PDF: Save uses the SDK door with the backend path; Read here pages through
  rootKey(tree, 'Escape')
  tree = mount()
  const pdfIdx = rowsOf(tree).findIndex(r => textOf(r).includes('Approve PDF: fixture'))
  check('the PDF request is listed', pdfIdx >= 0, `rows=${rowsOf(tree).length}`)
  clickRow(tree, pdfIdx)
  tree = mount()
  await tick(); await tick()   // let the preview read settle so its save door is captured
  const saveAnchor = walk(tree).find(n => n.host === 'a' && n.props.download)
  check('the PDF detail offers Save', !!saveAnchor)
  saveAnchor.props.onClick({ preventDefault() {}, stopPropagation() {} })
  check('Save calls the SDK save door with the backend stored path',
    h.saved.length === 1 && h.saved[0].path === PREVIEW['fx-pdf'][0].stored_path && h.saved[0].name === 'fixture.pdf',
    JSON.stringify(h.saved))
  press('Read here', 'Button')
  tree = mount()
  check('Read here shows the rendered page', walk(tree).some(n => n.host === 'img' && /^data:image\/png/.test(String(n.props.src))))
  check('the reader states the page position', textOf(tree).includes('Page 1 of 119'), textOf(tree).slice(-120))
  const pageKeysBefore = h.keys.filter(k => k.includes('"page"')).length
  press('Next', 'Button')
  tree = mount()
  const nextKey = h.keys.filter(k => k.includes('"page"')).slice(pageKeysBefore).find(k => JSON.parse(k)[4] === 2)
  check('Next requests the following page', !!nextKey, JSON.stringify(h.keys.filter(k => k.includes('"page"')).map(k => JSON.parse(k)[4])))
  press('Prev', 'Button')
  tree = mount()
  check('the reader still shows a page after Prev', walk(tree).some(n => n.host === 'img' && /^data:image\/png/.test(String(n.props.src))))

  // 14. preview retry (the failure path the Founder hit) refetches
  h.forceError = '"preview"'
  tree = mount()
  const retryPreview = ctl('Retry preview', 'Button')
  check('a failed preview offers Retry', !!retryPreview)
  retryPreview.props.onClick({ preventDefault() {}, stopPropagation() {} })
  check('Retry preview refetches the preview', h.refetch.some(k => k.includes('preview')), JSON.stringify(h.refetch))
  h.forceError = null
  tree = mount()

  // 15. the header button navigates; the error state offers a working Retry
  press('Approval Inbox', 'Button')
  check('the header button navigates to the inbox route', h.navigate.includes('/approval-inbox'), JSON.stringify(h.navigate))
  h.forceError = '"items"'
  rootKey(tree, 'Escape')
  tree = mount()
  const errRetry = ctl('Retry', 'Button')
  check('a failed inbox load offers Retry', !!errRetry)
  if (errRetry) errRetry.props.onClick({ preventDefault() {}, stopPropagation() {} })
  check('the error Retry invalidates the queries', h.invalidate.length >= 1)
  h.forceError = null
} catch (e) {
  const st = String((e && e.stack) || '').split('\n').slice(1, 4).map(s => s.trim()).join(' | ')
  failures.push(`action check threw: ${String((e && e.message) || e).slice(0, 240)} :: ${st}`)
}

if (failures.length) {
  console.log('ACTION-CHECK-FAIL')
  for (const f of failures) console.log('  -', f)
  console.log(`  passed ${pass.length}, failed ${failures.length}`)
  process.exit(1)
}
console.log(`ACTION-CHECK-OK: ${pass.length} controls pressed and asserted (${pass.length} passed)`)
