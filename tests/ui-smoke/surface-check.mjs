import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Proven surface = exactly what hermes-newswire (working, same Desktop) imports.
const PROVEN = ['Badge','Button','ConfirmDialog','Dialog','DialogContent','DialogDescription','DialogFooter','DialogHeader','DialogTitle','EmptyState','ErrorState','GlyphSpinner','host','Input','PALETTE_AREA','ROUTES_AREA','ScrollArea','SearchField','SegmentedControl','Separator','SIDEBAR_NAV_AREA','Switch','atom','queryClient','useMutation','useQuery','useValue']
const src = readFileSync(join(__dirname, '..', '..', 'desktop', 'plugin.js'), 'utf8')
const needed = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@hermes\/plugin-sdk'/g)].flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean))
console.log('NEEDS:', JSON.stringify(needed))
const missing = needed.filter(n => !PROVEN.includes(n))
console.log('MISSING-FROM-PROVEN-SURFACE:', JSON.stringify(missing))
// Area keys are exact strings ('routes', 'sidebar.nav', 'palette'): a quoted
// 'SIDEBAR_NAV_AREA' registers into a dead bucket nobody reads, with no error.
const quotedAreas = [...src.matchAll(/area\s*:\s*'(ROUTES_AREA|SIDEBAR_NAV_AREA|PALETTE_AREA)'/g)].map(m => m[1])
console.log('QUOTED-AREA-FAIL:', JSON.stringify(quotedAreas))
// rest() takes a body OBJECT (newswire pattern); a JSON.stringify body gets
// double-wrapped and the backend 422s. Static guard against that envelope bug.
const stringifiedBodies = [...src.matchAll(/body\s*:\s*JSON\.stringify\(/g)].length
console.log('STRINGIFY-BODY:', JSON.stringify(stringifiedBodies))
if (missing.length || quotedAreas.length || stringifiedBodies) process.exit(1)
