import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// base './' 是宿主约束:产物经 xingmang-canvas:// 自定义协议加载,
// 绝对路径会解析失败(与 v1 画布同一约束,见主仓 canvas-protocol.ts)。
export default defineConfig({
  plugins: [react(), {
    name: 'xingmang-canvas-v2-tokens',
    enforce: 'pre',
    resolveId(source) {
      if (process.env.XINGMANG_RENDERER === 'v2' && source === '../../src/styles/ui-tokens.css') {
        return fileURLToPath(new URL('../src/renderer-v2/styles/tokens.css', import.meta.url))
      }
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
  resolve: {
    dedupe: ['react', 'react-dom', '@xyflow/react'],
  },
})
