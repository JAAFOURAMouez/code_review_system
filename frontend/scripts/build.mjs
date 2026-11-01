// Production build: bundles src/main.tsx with esbuild into dist/.
// esbuild is loaded through createRequire so NODE_PATH-based global installs
// also work (ESM imports ignore NODE_PATH).
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const result = await esbuild.build({
  entryPoints: [join(root, 'src/main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  // Honour NODE_PATH (the JS API ignores the env var) so globally installed deps resolve too.
  nodePaths: (process.env.NODE_PATH ?? '').split(':').filter(Boolean),
  outdir: join(dist, 'assets'),
  entryNames: 'app',
  loader: { '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
    // Set HORIZON_API_URL at build time when the backend is on another origin (e.g. Netlify + Render).
    __HORIZON_API_URL__: JSON.stringify(process.env.HORIZON_API_URL ?? ''),
  },
  metafile: true,
  logLevel: 'info',
})

writeFileSync(join(dist, 'index.html'), readFileSync(join(root, 'index.html'), 'utf8'))
cpSync(join(root, 'public'), dist, { recursive: true })

const kb = Object.values(result.metafile.outputs)
  .map((o) => o.bytes)
  .reduce((a, b) => a + b, 0)
console.log(`Built dist/ (${(kb / 1024).toFixed(0)} KB of assets)`)
