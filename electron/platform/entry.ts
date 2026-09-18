import { accelerationEntryMode } from '../acceleration-worker-entry'

// This branch must run before importing desktop modules: helpers do not own
// windows, renderer IPC, the single-instance lock, or the normal quit handlers.
const mode = accelerationEntryMode(process.argv, typeof process.send === 'function' && process.connected, process.platform)
if (mode === 'worker') {
  const { app } = require('electron') as typeof import('electron')
  const { isolateAccelerationElectronProfile } = require('../acceleration-electron-profile') as typeof import('../acceleration-electron-profile')
  // The launch switch isolates Chromium before JavaScript starts; these paths
  // also keep Electron's app-name default from selecting the desktop profile.
  isolateAccelerationElectronProfile(app, process.argv)
  if (process.platform === 'darwin') {
    // Packaged workers run this app's Electron executable, so macOS otherwise
    // gives the background process its own Dock item. Set the policy before
    // loading worker code; the desktop process keeps its normal activation.
    app.setActivationPolicy('prohibited')
  }
  require('../acceleration-development-worker')
} else if (mode === 'invalid-worker') {
  // A helper switch without the parent IPC channel never opens the desktop.
  // Diagnostic stdout may already be closed when a parent launcher has exited.
  process.stderr.on('error', () => undefined)
  try { process.stderr.write('加速辅助进程启动无效。\n', () => undefined) } catch { /* no live diagnostic pipe */ }
  process.exit(1)
} else {
  require('./desktop-entry')
}
