import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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
      <App initialTheme={initialTheme} />
    </StrictMode>,
  )
}
