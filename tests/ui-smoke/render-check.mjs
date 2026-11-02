/**
 * Render check — the panel is actually rendered with fixture data and the host
 * contract is asserted against the result, instead of the reviewer finding the
 * faults one at a time on his own screen.
 *
 * What it proves, from the rendered tree (not from reading the source):
 *   1. No rendered URL is relative. The Desktop renders absolute http(s): or
 *      data: only; a relative path renders nothing and just warns — that is what
 *      made the PDF reader and its Open button dead clicks.
 *   2. A PDF request offers a real save (an anchor with `download`) and never a
 *      bare reader that can paint nothing.
 *   3. Every request row is a keyboard-reachable button, one per item.
 *   4. Every format the inbox knows is labelled in the row meta.
 *   5. No useRef / window.open anywhere: the host's react shim exports
 *      useState/useEffect/useMemo and a plugin cannot open a window.
 *
 * The react stub deliberately omits useRef, so this file fails the same way the
 * real host does if one is imported.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// RENDER_CHECK_PLUGIN lets a regression proof point this at a mutated copy; normal
// runs read the repo file.
const PLUGIN = process.env.RENDER_CHECK_PLUGIN || join(__dirname, '..', '..', 'desktop', 'plugin.js')
const TMP = join(__dirname, '.tmp-render')
mkdirSync(TMP, { recursive: true })

const PROVEN_SDK = ['Badge','Button','ConfirmDialog','EmptyState','ErrorState','GlyphSpinner','host','Input','PALETTE_AREA','ROUTES_AREA','ScrollArea','SearchField','SegmentedControl','SIDEBAR_NAV_AREA','queryClient','useMutation','useQuery']
const AREAS = { PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar.nav' }

const ITEMS = [
  { msg_id: 'fx-pdf', ts: '2026-11-01 10:00:00 +0300', type: 'pdf', owner: 'code', work_id: 't_1', subject: 'Approve PDF: fixture', status: 'pending', artifact: { name: 'fixture.pdf', version: '1' }, attachments: [{ name: 'fixture.pdf', kind: 'pdf', content_type: 'application/pdf' }], decision: null },
  { msg_id: 'fx-svg', ts: '2026-11-01 10:01:00 +0300', type: 'svg', owner: 'default', work_id: 't_1', subject: 'Approve SVG: fixture', status: 'approved', artifact: { name: 'logo.svg', version: '2' }, attachments: [{ name: 'logo.svg', kind: 'image', content_type: 'image/svg+xml' }], decision: { decision: 'approve', ts: '2026-11-01 10:05:00 +0300', note: '' } },
  { msg_id: 'fx-md', ts: '2026-11-01 10:02:00 +0300', type: 'md', owner: 'default', work_id: 't_1', subject: 'Approve Markdown: fixture', status: 'pending', artifact: { name: 'doc.md', version: '1' }, attachments: [], decision: null },
]
const PREVIEW = {
  'fx-pdf': [{ name: 'fixture.pdf', content_type: 'application/pdf', kind: 'pdf', size: 2327209, data_url: 'data:application/pdf;base64,JVBERi0xLjQK', thumb_url: 'data:image/png;base64,iVBORw0KGgo=', pages: 119 }],
  'fx-svg': [{ name: 'logo.svg', content_type: 'image/svg+xml', kind: 'image', size: 7060, data_url: 'data:image/svg+xml;base64,PHN2Zy8+', thumb_url: null, pages: 0 }],
  'fx-md': [],
}

let sdkSrc = ''
for (const n of PROVEN_SDK) {
  if (n in AREAS) sdkSrc += `export const ${n} = '${AREAS[n]}';\n`
  else if (n === 'host') sdkSrc += `export const host = { notify: () => {}, navigate: () => {}, state: {} };\n`
  else if (n === 'queryClient') sdkSrc += `export const queryClient = { invalidateQueries: () => {} };\n`
  else if (n === 'useQuery') sdkSrc += `export const useQuery = (opts) => { const k = JSON.stringify(opts && opts.queryKey || []); const d = k.includes('preview') ? globalThis.__preview[opts.queryKey[2]] || [] : globalThis.__items; return { data: d, isLoading: false, isPending: false, isError: false, error: null, refetch: () => {} } };\n`
  else if (n === 'useMutation') sdkSrc += `export const useMutation = () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });\n`
  else sdkSrc += `export const ${n} = function ${n}(props) { return props && props.children !== undefined ? props.children : null };\n`
}
writeFileSync(join(TMP, 'sdk.mjs'), sdkSrc)
// Mirror the host surface exactly: no useRef.
writeFileSync(join(TMP, 'react.mjs'), `export const useState = (i) => { const n = (globalThis.__stateSeq = (globalThis.__stateSeq || 0) + 1); const ov = globalThis.__stateOverride || {}; return [Object.prototype.hasOwnProperty.call(ov, n) ? ov[n] : i, () => {}]; };\nexport const useEffect = () => {};\nexport const useMemo = (f) => (typeof f === 'function' ? f() : f);\nexport default {};\n`)
writeFileSync(join(TMP, 'jsx-runtime.mjs'), `export const jsx = (t, p) => ({ type: t, props: p || {} });\nexport const jsxs = (t, p) => ({ type: t, props: p || {} });\n`)

globalThis.__items = ITEMS
globalThis.__preview = PREVIEW

let src = readFileSync(PLUGIN, 'utf8')
src = src.replaceAll(`from '@hermes/plugin-sdk'`, `from './sdk.mjs'`)
src = src.replaceAll(`from 'react'`, `from './react.mjs'`)
src = src.replaceAll(`from 'react/jsx-runtime'`, `from './jsx-runtime.mjs'`)
const tmpFile = join(TMP, 'plugin.under.render.mjs')
writeFileSync(tmpFile, src)

// ---- tiny renderer: evaluate function components, FLATTEN every children list, keep
//      host elements. Flattening matters: a component that renders an array as its
//      children (Badge -> [dot, word]) nests an array otherwise, and the walker then
//      cannot see the word that the device does render.
const flat = (v) => (Array.isArray(v) ? v.flat(Infinity).filter(Boolean)
  : (v === null || v === undefined || typeof v === 'boolean') ? [] : [v])
function render(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return flat(node.map(n => render(n, depth)))
  if (typeof node === 'string' || typeof node === 'number') return { host: '#text', props: { children: String(node) }, children: [] }
  if (typeof node !== 'object') return null
  const { type, props } = node
  if (typeof type === 'function') {
    if (depth > 80) throw new Error('render recursion too deep (possible loop)')
    return render(type(props || {}), depth + 1)
  }
  return { host: String(type), props: props || {}, children: flat(render(props && props.children, depth)) }
}
function walk(node, out = []) {
  for (const n of flat(node)) {
    if (!n || typeof n !== 'object') continue
    out.push(n)
    walk(n.children, out)
  }
  return out
}
const textOf = (n) => walk(n).filter(x => x.host === '#text').map(x => x.props.children).join(' ')

const failures = []
const registrations = []
const ctx = {
  rest: async () => ({ items: ITEMS }),
  storage: { get: async (k, fb) => fb, set: async () => {} },
  onDispose: () => {},
  registerMany: (arr) => { for (const c of arr) registrations.push(c); return () => {} },
  register: () => () => {},
  host: {},
}

try {
  const mod = await import(pathToFileURL(tmpFile).href)
  mod.default.register(ctx)
  const page = registrations.find(r => r.area === 'routes')
  if (!page || typeof page.render !== 'function') throw new Error('no page render registration')
  const tree = render(page.render())

  // 1. no relative URL rendered anywhere
  const urlProps = ['src', 'href', 'data', 'poster']
  const badUrls = walk(tree).flatMap(n => urlProps
    .filter(p => typeof (n.props || {})[p] === 'string' && n.props[p] && !/^(data:|https?:|blob:)/.test(n.props[p]))
    .map(p => `${p}=${String(n.props[p]).slice(0, 60)}`))
  if (badUrls.length) failures.push(`relative URLs rendered (desktop renders absolute http(s):/data: only): ${JSON.stringify(badUrls)}`)

  // 2. every request row: keyboard-reachable, titled, format-labelled, statused
  const rows = walk(tree).filter(n => n.props && n.props.role === 'button')
  if (rows.length !== ITEMS.length) failures.push(`rows=${rows.length} expected ${ITEMS.length} keyboard-reachable rows`)
  if (rows.some(r => r.props.tabIndex === undefined)) failures.push('a row is missing tabIndex')
  const body = textOf(tree)
  for (const want of ['PDF', 'SVG', 'MD']) if (!body.includes(want)) failures.push(`format label missing from the rendered rows: ${want}`)
  for (const want of ['Needs decision', 'Decided']) if (!body.includes(want)) failures.push(`group header missing: ${want}`)
  for (const want of ['pending', 'approved']) if (!body.includes(want)) failures.push(`status word missing from the rendered rows: ${want}`)
  for (const want of ['Approve PDF: fixture', 'Approve SVG: fixture', 'default', 'code']) if (!body.includes(want)) failures.push(`row content missing: ${want}`)

  // 3. the request detail, mounted directly (a selection cannot be driven through the
  //    stubbed state, so the component is exercised with props)
  const t = mod.default.__test
  const el = (type, props) => ({ type, props: props || {} })
  if (!t) failures.push('no __test hook exported — the detail cannot be exercised')
  else {
    // collapsed: the always-visible affordance must be a real save bound to the bytes
    const mount = (type, props, override) => { globalThis.__stateSeq = 0; globalThis.__stateOverride = override || {}; return render(el(type, props)) }
    const pv = mount(t.PreviewBlock, { msgId: 'fx-pdf', hasFiles: true, onFullscreen: () => {} })
    const dl = walk(pv).filter(n => n.host === 'a' && n.props.download)
    if (!dl.length) failures.push('the PDF detail offers no download anchor')
    const dlUrls = dl.map(a => String(a.props.href))
    if (dlUrls.some(u => !/^(data:|https?:)/.test(u))) failures.push(`the PDF download is not a data:/http(s): URL: ${JSON.stringify(dlUrls.map(u => u.slice(0, 30)))}`)
    const label = textOf(pv)
    if (!/PDF document/i.test(label)) failures.push('the PDF block carries no format-specific approval text')
    if (!/119/.test(label)) failures.push('the PDF block does not state the page count')
    if (!/fixture\.pdf/.test(label)) failures.push('the PDF block does not name the file')
    // expanded (state 1 is the block's own `expanded`): the reader must be the bytes
    const pvOpen = mount(t.PreviewBlock, { msgId: 'fx-pdf', hasFiles: true, onFullscreen: () => {} }, { 1: 'fixture.pdf' })
    const obj = walk(pvOpen).filter(n => n.host === 'object')
    if (!obj.length) failures.push('the expanded PDF detail has no reader object')
    if (obj.some(o => !/^(data:|https?:)/.test(String(o.props.data)))) failures.push('the PDF reader is bound to a relative URL')
    const img = walk(mount(t.PreviewBlock, { msgId: 'fx-svg', hasFiles: true, onFullscreen: () => {} })).filter(n => n.host === 'img')
    if (!img.length) failures.push('the SVG detail renders no image at all')
    if (img.some(i => !/^data:/.test(String(i.props.src)))) failures.push('an image in the detail is not a data: URL')
  }

  // 4. source-level contract
  const raw = readFileSync(PLUGIN, 'utf8')
  if (/window\.open\(/.test(raw)) failures.push('window.open( is present — a plugin cannot open a window')
  if (/useRef/.test(raw.replace(/^.*useRef[^\n]*not available[^\n]*$/m, ''))) failures.push('useRef referenced — the host react shim does not export it')
} catch (e) {
  const st = String((e && e.stack) || '').split('\n').slice(1, 4).map(s => s.trim()).join(' | ')
  failures.push(`render threw: ${String((e && e.message) || e).slice(0, 300)} :: ${st}`)
}

if (failures.length) {
  console.log('RENDER-CHECK-FAIL')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('RENDER-CHECK-OK: rows, formats, statuses, group headers, URL schemes, the PDF save and reader all verified on the rendered tree')
