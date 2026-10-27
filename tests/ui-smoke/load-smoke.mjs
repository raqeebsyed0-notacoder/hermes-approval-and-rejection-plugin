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
const PROVEN_SDK = ['ErrorState','GlyphSpinner','host','Input','PALETTE_AREA','ROUTES_AREA','ScrollArea','SearchField','SegmentedControl','Separator','SIDEBAR_NAV_AREA','Switch','atom','queryClient','useMutation','useQuery','useValue']
const sdkStub = `export const ${PROVEN_SDK.join(', ')} = globalThis.__sdkVals.${'__ALL__'};`
// Simpler: build explicit stub file with each name defined.
let sdkSrc = ''
for (const n of PROVEN_SDK) {
  if (['PALETTE_AREA','ROUTES_AREA','SIDEBAR_NAV_AREA'].includes(n)) sdkSrc += `export const ${n} = '${n}';\n`
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
  console.log('NAV:', JSON.stringify(registrations.filter(r => r.area === 'SIDEBAR_NAV_AREA')))
} catch (e) {
  console.log('LOAD-OR-REGISTER-THREW:', String(e && e.message || e).slice(0, 500))
  process.exit(1)
}
