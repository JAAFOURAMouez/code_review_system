// Dev server: esbuild watch + static serve on http://localhost:5173
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.dev')
const port = Number(process.env.PORT ?? 5173)

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'index.html'), 'utf8'))
cpSync(join(root, 'public'), out, { recursive: true })

const ctx = await esbuild.context({
  entryPoints: [join(root, 'src/main.tsx')],
  bundle: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  // Honour NODE_PATH (the JS API ignores the env var) so globally installed deps resolve too.
  nodePaths: (process.env.NODE_PATH ?? '').split(':').filter(Boolean),
  outdir: join(out, 'assets'),
  entryNames: 'app',
  define: {
    'process.env.NODE_ENV': '"development"',
    __HORIZON_API_URL__: JSON.stringify(process.env.HORIZON_API_URL ?? ''),
  },
  logLevel: 'info',
})
await ctx.watch()
const { host, port: boundPort } = await ctx.serve({ servedir: out, port, host: '127.0.0.1' })
console.log(`Horizon AI dev server: http://${host}:${boundPort}`)
