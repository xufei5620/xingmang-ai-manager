import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RendererV2App from './App'
import './styles/tokens.css'
import './styles/components.css'
import './styles/shell.css'
import './app.css'
import './styles/contrast.css'
import { attachRuntimeReporting } from './features/app/error-report'
import { initialWindowOs } from './features/app/window-os'

declare const __XINGMANG_RENDERER__: string
const root = document.getElementById('root')!
// Keep the first paint aligned with the product default. The persisted app
// setting (including an explicit dark/system preference) is applied during
// bootstrap immediately afterwards.
const initialTheme = 'light'
document.documentElement.dataset.theme = initialTheme
document.documentElement.dataset.skin = 'mist'
document.documentElement.style.colorScheme = initialTheme
// The Mac title bar has to make room for the traffic lights on the very first
// frame, long before the platform capabilities come back over IPC.
document.documentElement.dataset.os = initialWindowOs(undefined, navigator.platform)
root.dataset.renderer = __XINGMANG_RENDERER__
const native = window.xingmang
if (native) {
  attachRuntimeReporting(native)
  // RuntimeApp installs the full close report after its bootstrap effects run.
  // Answer native close requests during the splash/reload gap so Electron
  // never waits for the 15-second query timeout while no user-editable state
  // exists yet. Once RuntimeApp marks itself ready, this listener deliberately
  // yields to its richer task/dirty-state report.
  native.onWindowCloseRequest(({ requestId }) => {
    if (document.documentElement.dataset.rendererReady === 'true') return
    void native.replyWindowClose(requestId, {
      blockingTask: false,
      unsavedChanges: false,
    }).catch(() => undefined)
  })
}
createRoot(root).render(<StrictMode><RendererV2App /></StrictMode>)
