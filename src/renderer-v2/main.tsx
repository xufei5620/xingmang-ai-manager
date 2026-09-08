import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RendererV2App from './App'
import './styles/tokens.css'
import './styles/components.css'
import './styles/shell.css'
import './app.css'
import { attachRuntimeReporting } from './features/app/error-report'

declare const __XINGMANG_RENDERER__: string
const root = document.getElementById('root')!
// Keep the first paint aligned with the product default. The persisted app
// setting (including an explicit dark/system preference) is applied during
// bootstrap immediately afterwards.
const initialTheme = 'light'
document.documentElement.dataset.theme = initialTheme
document.documentElement.dataset.skin = 'mist'
document.documentElement.style.colorScheme = initialTheme
root.dataset.renderer = __XINGMANG_RENDERER__
if (window.xingmang) {
  attachRuntimeReporting(window.xingmang)
  // RuntimeApp installs the full close report after its bootstrap effects run.
  // Answer native close requests during the splash/reload gap so Electron
  // never waits for the 15-second query timeout while no user-editable state
  // exists yet. Once RuntimeApp marks itself ready, this listener deliberately
  // yields to its richer task/dirty-state report.
  window.xingmang.onWindowCloseRequest(({ requestId }) => {
    if (document.documentElement.dataset.rendererReady === 'true') return
    void window.xingmang.replyWindowClose(requestId, {
      blockingTask: false,
      unsavedChanges: false,
    }).catch(() => undefined)
  })
}
createRoot(root).render(<StrictMode><RendererV2App /></StrictMode>)
