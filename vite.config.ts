import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'

const legacyRequire = createRequire(new URL('./tooling/legacy-renderer/package.json', import.meta.url))
const requestedRenderer = process.env.XINGMANG_RENDERER?.trim()
if (requestedRenderer && requestedRenderer !== 'v2' && requestedRenderer !== 'legacy') {
  throw new Error(`Unsupported XINGMANG_RENDERER value: ${requestedRenderer}`)
}
const renderer = requestedRenderer === 'legacy' ? 'legacy' : 'v2'

export default defineConfig({
  plugins: [react(), {
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
      if (renderer !== 'v2') return
      this.emitFile({ type: 'asset', fileName: 'renderer-v2.flag', source: 'v3.1.1\n' })
      const sourceRoot = new URL('./src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
      const sourcePath = decodeURIComponent(sourceRoot).replaceAll('\\', '/')
      const forbidden = [...this.getModuleIds()].map((id) => id.replaceAll('\\', '/'))
        .filter((id) => id.startsWith(sourcePath) && !id.startsWith(`${sourcePath}renderer-v2/`))
      if (forbidden.length) throw new Error(`Renderer v2 imports legacy UI: ${forbidden.join(', ')}`)
    },
  }],
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
  },
})
