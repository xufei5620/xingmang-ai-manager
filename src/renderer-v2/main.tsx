import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RendererV2App from './App'
import './styles/tokens.css'
import './styles/components.css'
import './styles/shell.css'
import './app.css'
import './styles/contrast.css'
import { attachRuntimeReporting } from './features/app/error-report'
import { initialTheme } from './features/app/initial-theme'
import { initialWindowOs } from './features/app/window-os'
import { attachWindowIdleMarker } from './features/app/window-idle'

declare const __XINGMANG_RENDERER__: string
const root = document.getElementById('root')!
// 第一帧就按主进程拼进地址的深浅色画，不等设置回来（initial-theme.ts）。
const theme = initialTheme(location.search)
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme
// The Mac title bar has to make room for the traffic lights on the very first
// frame, long before the platform capabilities come back over IPC.
document.documentElement.dataset.os = initialWindowOs(undefined, navigator.platform)
root.dataset.renderer = __XINGMANG_RENDERER__
attachWindowIdleMarker(document, window)
const native = window.xingmang
if (native) attachRuntimeReporting(native)
createRoot(root).render(<StrictMode><RendererV2App /></StrictMode>)
