import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Proven surface = exactly what hermes-newswire (working, same Desktop) imports.
const PROVEN = ['ErrorState','GlyphSpinner','host','Input','PALETTE_AREA','ROUTES_AREA','ScrollArea','SearchField','SegmentedControl','Separator','SIDEBAR_NAV_AREA','Switch','atom','queryClient','useMutation','useQuery','useValue']
const src = readFileSync(join(__dirname, '..', '..', 'desktop', 'plugin.js'), 'utf8')
const needed = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@hermes\/plugin-sdk'/g)].flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean))
console.log('NEEDS:', JSON.stringify(needed))
const missing = needed.filter(n => !PROVEN.includes(n))
console.log('MISSING-FROM-PROVEN-SURFACE:', JSON.stringify(missing))
