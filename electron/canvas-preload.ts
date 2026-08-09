import { contextBridge, ipcRenderer } from 'electron'

// This is the ONLY preload the canvas BrowserWindow ever loads (see
// canvas-window.ts). It never sees window.xingmang or any channel the main
// app owns -- window.xingmangCanvasHost below is a deliberately tiny,
// separate surface with exactly five capabilities, backed by the
// canvas-host:* channels canvas-window.ts registers. A compromised canvas
// page that walks this object can save/pick files (through a native dialog,
// never an attacker-chosen path), pop an OS notification, and open a URL
// from a fixed allowlist -- nothing that reaches window.xingmang, ipcMain
// channels the main app owns, or Node itself (sandbox:true, same as the
// main window).
//
// Sandboxed preload scripts cannot require local runtime modules (same
// constraint documented in preload.ts), so the channel names and storage key
// below are duplicated literals rather than imports from canvas-window.ts /
// canvas-ai-config.ts. Keep these in sync by hand if either changes:
//   canvas-window.ts:   canvasHost{AuthToken,SaveFile,PickFile,Notify,OpenExternal}Channel
//   canvas-ai-config.ts: canvasAiConfigStorageKey
const authTokenChannel = 'canvas-host:auth-token'
const saveFileChannel = 'canvas-host:save-file'
const pickFileChannel = 'canvas-host:pick-file'
const notifyChannel = 'canvas-host:notify'
const openExternalChannel = 'canvas-host:open-external'
const aiConfigStorageKey = 'infinite-canvas:ai_config_store'

interface CanvasAuthTokenResponse {
  token: { baseUrl: string; apiKey: string } | null
  storageValue: string | null
}

// Resolved synchronously, before this script returns control and the page's
// own (deferred `type="module"`) script gets to run. ipcRenderer.sendSync
// blocks this renderer until canvas-window.ts's main-process handler
// replies with a value it already finished computing before this window
// started loading -- there is no await here, and therefore no race between
// "seed localStorage" and "infinite-canvas reads its persisted config store"
// the way there would be with an async invoke() at this same point.
let authTokenResponse: CanvasAuthTokenResponse = { token: null, storageValue: null }
try {
  let existingRaw: string | null = null
  try {
    existingRaw = window.localStorage.getItem(aiConfigStorageKey)
  } catch {
    // Storage can legitimately be unavailable (e.g. disabled by policy);
    // treat exactly like "nothing stored yet".
  }
  authTokenResponse = ipcRenderer.sendSync(authTokenChannel, existingRaw) as CanvasAuthTokenResponse
  if (authTokenResponse.storageValue) {
    window.localStorage.setItem(aiConfigStorageKey, authTokenResponse.storageValue)
  }
} catch {
  // Never let a bridge failure block the canvas app from loading -- it has
  // its own config UI as a fallback for exactly this situation.
}

contextBridge.exposeInMainWorld('xingmangCanvasHost', {
  getAuthToken: () => Promise.resolve(authTokenResponse.token),
  saveFile: (suggestedName: string, content: string) => (
    ipcRenderer.invoke(saveFileChannel, suggestedName, content)
  ),
  pickFile: () => ipcRenderer.invoke(pickFileChannel),
  notify: (title: string, body?: string) => ipcRenderer.invoke(notifyChannel, title, body),
  openExternal: (url: string) => ipcRenderer.invoke(openExternalChannel, url),
})
