import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(__dirname, '..', '..', 'desktop', 'plugin.js')
const TMP = join(__dirname, '.tmp-load')
mkdirSync(TMP, { recursive: true })

// Minimal DOM for ensureStyles()
const headChildren = []
globalThis.document = {
  head: { appendChild: (el) => { headChildren.push(el) } },
  createElement: () => ({ }),
  getElementById: () => null,
}

// SDK stub: ONLY the proven newswire surface. Anything else -> explosive Proxy
// so a missing export throws exactly like a real Desktop would.
const PROVEN_SDK = ['Badge','Button','ConfirmDialog','Dialog','DialogContent','DialogDescription','DialogFooter','DialogHeader','DialogTitle','EmptyState','ErrorState','GlyphSpinner','host','Input','PALETTE_AREA','ROUTES_AREA','ScrollArea','SearchField','SegmentedControl','Separator','SIDEBAR_NAV_AREA','Switch','atom','queryClient','useMutation','useQuery','useValue']
// Real area values from apps/desktop/src (routes.ts, command-palette/contrib.ts):
// a quoted 'SIDEBAR_NAV_AREA' string does NOT match 'sidebar.nav' and registers
// into a dead bucket with zero errors. The stub must use real values.
const REAL_AREA_VALUES = { PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar.nav' }
const sdkStub = `export const ${PROVEN_SDK.join(', ')} = globalThis.__sdkVals.${'__ALL__'};`
// Simpler: build explicit stub file with each name defined.
let sdkSrc = ''
for (const n of PROVEN_SDK) {
  if (n in REAL_AREA_VALUES) sdkSrc += `export const ${n} = '${REAL_AREA_VALUES[n]}';\n`
  else if (n === 'host') sdkSrc += `export const host = { notify: () => {}, state: {} };\n`
  else if (n === 'atom') sdkSrc += `export const atom = (v) => ({ get: () => v });\n`
  else if (n === 'queryClient') sdkSrc += `export const queryClient = { invalidateQueries: () => {} };\n`
  else sdkSrc += `export const ${n} = function ${n}() { return { __stub: '${n}' } };\n`
}
writeFileSync(join(TMP, 'sdk.mjs'), sdkSrc)
writeFileSync(join(TMP, 'react.mjs'), `export const useState = (i) => [i, () => {}];\nexport const useEffect = () => {};\nexport default {};\n`)
writeFileSync(join(TMP, 'jsx-runtime.mjs'), `export const jsx = (t, p) => ({ type: t, props: p });\nexport const jsxs = (t, p) => ({ type: t, props: p });\n`)

let src = readFileSync(PLUGIN, 'utf8')
src = src.replaceAll(`from '@hermes/plugin-sdk'`, `from './sdk.mjs'`)
src = src.replaceAll(`from 'react'`, `from './react.mjs'`)
src = src.replaceAll(`from 'react/jsx-runtime'`, `from './jsx-runtime.mjs'`)
const tmpFile = join(TMP, 'plugin.under.test.mjs')
writeFileSync(tmpFile, src)

const registrations = []
const ctx = {
  rest: async () => ({ items: [] }),
  storage: { get: async (k, fb) => fb, set: async () => {} },
  onDispose: () => {},
  register: (c) => { registrations.push({ via: 'register', ...c }); return () => {} },
  registerMany: (arr) => { for (const c of arr) registrations.push({ via: 'registerMany', area: c.area, id: c.id, path: c.data && c.data.path, label: c.data && c.data.label }) ; return () => {} },
  host: {},
}
try {
  const mod = await import(pathToFileURL(tmpFile).href)
  if (typeof mod.default?.register !== 'function') { console.log('LOAD-FAIL: no register fn'); process.exit(2) }
  mod.default.register(ctx)
  console.log('REGISTER-OK areas:', JSON.stringify(registrations.map(r => r.area)))
  console.log('NAV:', JSON.stringify(registrations.filter(r => r.area === 'sidebar.nav')))
  const areas = registrations.map(r => r.area)
  const dead = areas.filter(a => ['ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'PALETTE_AREA'].includes(a))
  if (dead.length) { console.log('DEAD-AREA-FAIL: quoted area names never match the registry:', JSON.stringify(dead)); process.exit(3) }
  for (const want of Object.values(REAL_AREA_VALUES)) {
    if (want === 'palette') continue
    if (!areas.includes(want)) { console.log('MISSING-AREA-FAIL:', want); process.exit(4) }
  }
} catch (e) {
  console.log('LOAD-OR-REGISTER-THREW:', String(e && e.message || e).slice(0, 500))
  process.exit(1)
}
