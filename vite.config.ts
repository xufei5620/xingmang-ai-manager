import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createThirdPartyCollector } from './scripts/third-party-collector.mjs'

const legacyRequire = createRequire(new URL('./tooling/legacy-renderer/package.json', import.meta.url))
const requestedRenderer = process.env.XINGMANG_RENDERER?.trim()
if (requestedRenderer && requestedRenderer !== 'v2' && requestedRenderer !== 'legacy') {
  throw new Error(`Unsupported XINGMANG_RENDERER value: ${requestedRenderer}`)
}
const renderer = requestedRenderer === 'legacy' ? 'legacy' : 'v2'
// 随包第三方许可清单要知道界面实际打进了哪些库，后台线程（视频拼片）那一半也要（D97，
// scripts/third-party-notices.cjs）。只记名单，不往 dist/ 里写任何东西。
const thirdParty = createThirdPartyCollector({
  bundle: 'renderer',
  projectRoot: fileURLToPath(new URL('.', import.meta.url)),
  expectedOutDir: 'dist',
  renderer,
})

export default defineConfig({
  plugins: [react(), thirdParty.plugin, {
    name: 'xingmang-renderer-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return renderer === 'v2'
          ? html.replace('/src/main.tsx', '/src/renderer-v2/main.tsx')
          : html
      },
    },
    generateBundle() {
      // Only what Rollup kept is visible here, and only during `vite build` --
      // scripts/verify-renderer-boundary.test.cjs scans the sources instead and
      // covers the type-only, dev-server and legacy-renderer cases this misses.
      if (renderer !== 'v2') return
      this.emitFile({ type: 'asset', fileName: 'renderer-v2.flag', source: 'v3.1.1\n' })
      const sourceRoot = new URL('./src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
      const sourcePath = decodeURIComponent(sourceRoot).replaceAll('\\', '/')
      const forbidden = [...this.getModuleIds()].map((id) => id.replaceAll('\\', '/'))
        .filter((id) => id.startsWith(sourcePath) && !id.startsWith(`${sourcePath}renderer-v2/`))
      if (forbidden.length) throw new Error(`Renderer v2 imports legacy UI: ${forbidden.join(', ')}`)
    },
  }],
  worker: { plugins: () => [thirdParty.workerPlugin()] },
  define: { __XINGMANG_RENDERER__: JSON.stringify(renderer) },
  base: './',
  resolve: {
    alias: renderer === 'v2' ? [] : [
      { find: /^react$/, replacement: legacyRequire.resolve('react') },
      { find: /^react\/jsx-runtime$/, replacement: legacyRequire.resolve('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: legacyRequire.resolve('react/jsx-dev-runtime') },
      { find: /^react-dom$/, replacement: legacyRequire.resolve('react-dom') },
      { find: /^react-dom\/client$/, replacement: legacyRequire.resolve('react-dom/client') },
      { find: /^react-dom\/server$/, replacement: legacyRequire.resolve('react-dom/server') },
      { find: /^react-dom\/server\.browser$/, replacement: legacyRequire.resolve('react-dom/server.browser') },
      { find: /^react-dom\/server\.node$/, replacement: legacyRequire.resolve('react-dom/server.node') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Maps for Sentry only (G06): 'hidden' writes them without a reference in
    // the code, and scripts/stash-renderer-sourcemaps.cjs moves them out of dist/
    // before anything can package them.
    sourcemap: 'hidden',
  },
})
