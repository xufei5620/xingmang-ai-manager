import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

function reportRendererError(message: string, stack?: string, context?: string): void {
  void window.xingmang.reportRendererError({ message, stack, context }).catch(() => undefined)
}

window.addEventListener('error', (event) => {
  reportRendererError(
    event.message || 'Renderer error',
    event.error instanceof Error ? event.error.stack : undefined,
    event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : 'window.error',
  )
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
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
