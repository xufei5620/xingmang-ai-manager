import path from 'node:path'
import { createServer } from 'vite'
import { spawn, spawnSync } from 'node:child_process'
import electronExecutable from 'electron'
import fs from 'node:fs/promises'

process.env.XINGMANG_RENDERER = 'v2'
const root = path.resolve(import.meta.dirname, '..')

// This script is also the documented one-command entry point used while
// iterating on the desktop window. Keep it self-contained: callers often run
// it directly after a renderer edit, which otherwise leaves Electron loading
// a stale or half-written dist-electron/canvas-preload.js from tsc --watch.
// The regular npm run dev:v2:runtime path already performs this prebuild, so
// this is intentionally idempotent and cheap compared with starting Electron
// against an inconsistent preload set.
const prebuild = path.join(root, 'scripts', 'prebuild-electron-dev.mjs')
const prebuildResult = spawnSync(process.execPath, [prebuild], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  shell: false,
})
if (prebuildResult.error) throw prebuildResult.error
if (prebuildResult.status !== 0) {
  throw new Error(`Electron 开发预编译失败（退出码 ${prebuildResult.status ?? '未知'}）`)
}
for (const file of ['platform/entry.js', 'main.js', 'preload.js', 'canvas-preload.js', 'canvas-window.js']) {
  await fs.access(path.join(root, 'dist-electron', file))
}

const review = process.argv.includes('--isolated-review')
const reviewRoot = path.join(root, 'artifacts', 'renderer-v2-local-preview')
if (review) {
  await fs.mkdir(path.join(reviewRoot, 'home'), { recursive: true })
  await fs.mkdir(path.join(reviewRoot, 'user-data'), { recursive: true })
  const preferences = path.join(reviewRoot, 'user-data', 'settings.json')
  try { await fs.access(preferences) } catch {
    await fs.writeFile(preferences, JSON.stringify({ version: 2, workspace: '', theme: 'dark', checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false }), 'utf8')
  }
}
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5175, strictPort: false } })
await server.listen()
const address = server.httpServer.address()
if (!address || typeof address === 'string') throw new Error('Vite did not provide a TCP port')
const url = `http://127.0.0.1:${address.port}`
console.log(`Renderer v2 (React 19): ${url}`)
const electron = spawn(electronExecutable, ['.', ...(review ? [`--user-data-dir=${path.join(reviewRoot, 'user-data')}`] : [])], {
  // Electron is the interactive development window; SW_HIDE can suppress its first ShowWindow call.
  cwd: root, stdio: 'inherit', windowsHide: false,
  env: { ...process.env, XINGMANG_RENDERER: 'v2', VITE_DEV_SERVER_URL: url, ...(review ? {
    HOME: path.join(reviewRoot, 'home'), USERPROFILE: path.join(reviewRoot, 'home'),
    XINGMANG_CODEX_HOME_OVERRIDE: path.join(reviewRoot, 'home', '.codex'), XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
  } : {}) },
})
function stop() { electron.kill() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
electron.once('error', async (error) => { console.error(error); await server.close(); process.exitCode = 1 })
electron.once('exit', async (code) => {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await server.close()
  process.exitCode = code ?? 0
})
