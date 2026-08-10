import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' 是宿主约束:产物经 xingmang-canvas:// 自定义协议加载,
// 绝对路径会解析失败(与 v1 画布同一约束,见主仓 canvas-protocol.ts)。
export default defineConfig({
  plugins: [react()],
  base: './',
})
