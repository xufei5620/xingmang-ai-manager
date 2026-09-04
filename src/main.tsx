import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DevelopmentPreview } from './components/DevelopmentPreview'
import './styles.css'
import { rendererErrorDeduper, reportRendererError } from './renderer-error-report'

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

const hasElectronBridge = typeof window !== 'undefined' && typeof window.xingmang !== 'undefined'
const root = ReactDOM.createRoot(document.getElementById('root')!)

root.render(
  <React.StrictMode>
    {import.meta.env.DEV && !hasElectronBridge ? <DevelopmentPreview /> : <App />}
  </React.StrictMode>,
)
