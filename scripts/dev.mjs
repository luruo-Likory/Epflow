import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function buildMain() {
  await build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: 'linked',
    external: ['electron'],
    logLevel: 'warning',
    absWorkingDir: root,
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@main': path.join(root, 'src/main')
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js')
  })
  await build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: 'linked',
    external: ['electron'],
    logLevel: 'warning',
    absWorkingDir: root,
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.js')
  })
}

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') })
await server.listen()
const url = `http://127.0.0.1:${server.config.server.port}`

await buildMain()

const child = spawn(electronPath, [path.join(root, 'dist/main/index.js')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, ELECTRON_ENABLE_LOGGING: '1' }
})

child.on('close', async () => {
  await server.close()
  process.exit(0)
})
