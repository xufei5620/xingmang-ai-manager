import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const rendererTokens = fileURLToPath(new URL('../src/renderer-v2/styles/tokens.css', import.meta.url))

// base './' 是宿主约束:产物经 xingmang-canvas:// 自定义协议加载,
// 绝对路径会解析失败(与 v1 画布同一约束,见主仓 canvas-protocol.ts)。
export default defineConfig({
  plugins: [react(), {
    name: 'xingmang-canvas-v2-tokens',
    enforce: 'pre',
    resolveId(source, importer) {
      if (process.env.XINGMANG_RENDERER !== 'v2') return
      // 内核（xingmang-canvas）的入口引的是它自带的那份配色；桌面上换成 UI v4 的，画布才跟主窗口同色。
      // 只换入口这一处，内核别的文件照原样引用。
      if (source === '../shared/ui-tokens.css' && importer?.replaceAll('\\', '/').endsWith('/canvas-v2/src/main.tsx')) return rendererTokens
    },
    generateBundle() {
      if (process.env.XINGMANG_RENDERER !== 'v2') return
      const legacyRoot = fileURLToPath(new URL('../src/', import.meta.url)).replaceAll('\\', '/')
      const modules = [...this.getModuleIds()].map((id) => id.replaceAll('\\', '/'))
      const forbidden = modules.filter((id) => id.startsWith(legacyRoot) && !id.startsWith(legacyRoot + 'renderer-v2/'))
      if (forbidden.length) throw new Error(`Canvas v2 imports legacy UI: ${forbidden.join(', ')}`)
    },
  }],
  base: './',
  // 内核只用它藏起只属于别的宿主的入口，不承担安全判断（内核 host-kind.ts）；没定义时内核也按桌面处理，这里写明。
  define: { __XINGMANG_CANVAS_HOST__: JSON.stringify('desktop') },
  build: {
    // Vite 默认往入口里塞一段 modulepreload 兼容代码，它用 fetch 预取 <link> 指的模块。
    // 画布只跑在 Electron 自带的 Chromium 里，原生就支持 modulepreload，这段代码永远不会走到；
    // 留着它，产物出网门禁（verify-canvas-network-boundary）就得给一处不属于画布的 fetch 开口子。
    modulePreload: { polyfill: false },
  },
  resolve: {
    dedupe: ['react', 'react-dom', '@xyflow/react'],
  },
})
