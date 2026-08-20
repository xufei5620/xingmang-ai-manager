import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { App } from './App'
import './theme.css'
import './styles.css'
import { applyCanvasTheme, initialCanvasTheme } from './theme/canvas-theme'

const initialTheme = initialCanvasTheme(window.location.search)
applyCanvasTheme(initialTheme)

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      {/* The provider must sit above App so descendants can use React Flow
          hooks; the instance is no longer captured from onInit. */}
      <ReactFlowProvider>
        <App initialTheme={initialTheme} />
      </ReactFlowProvider>
    </StrictMode>,
  )
}
