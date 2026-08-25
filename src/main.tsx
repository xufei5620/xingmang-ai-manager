import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { rendererErrorDeduper, reportRendererError } from './renderer-error-report'

// 纯浏览器（v0 预览、vite dev 直开）里没有 Electron preload，window.xingmang
// 缺失会让首个 IPC 调用直接抛错、整棵树白屏。仅开发构建注入假桥，
// import.meta.env.DEV 为常量折叠条件，生产包里整块被摇掉。
if (import.meta.env.DEV) {
  const { installDevBrowserBridge } = await import('./dev-browser-bridge')
  installDevBrowserBridge()
}

window.addEventListener('error', (event) => {
  // React's dev build can also route this exact error through
  // ErrorBoundary.componentDidCatch (see renderer-error-report.ts); the
  // shared deduper keeps that from logging the same crash twice.
  if (!rendererErrorDeduper.claim(event.error ?? event.message)) return
  reportRendererError(
    event.message || 'Renderer error',
    event.error instanceof Error ? event.error.stack : undefined,
    event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : 'window.error',
  )
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (!rendererErrorDeduper.claim(reason)) return
  reportRendererError(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
    'unhandledrejection',
  )
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
