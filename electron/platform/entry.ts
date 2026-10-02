import { accelerationEntryMode } from '../acceleration-worker-entry'
import { linuxLaunchRefusal, linuxLaunchRefusalNotice, type LinuxLaunchRefusal } from '../linux-launch-guard'
import { uninstallCleanupEntryMode } from '../uninstall-cleanup-entry'

/**
 * Says why once, then quits without loading the desktop: no single-instance lock, no
 * settings, no logs. Everything Chromium and its helpers would still write is pointed at
 * a fresh private directory first, because under `sudo -E` HOME still names the
 * customer's home and the profile, the GPU shader cache and the font cache would
 * otherwise leave root-owned files in it, the very damage the refusal exists to prevent.
 */
function refuseLinuxLaunch(refusal: LinuxLaunchRefusal): void {
  const { app, dialog } = require('electron') as typeof import('electron')
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  const notice = linuxLaunchRefusalNotice(refusal)
  // A terminal launch (where sudo was typed) shows this even if no dialog can open.
  process.stderr.on('error', () => undefined)
  try { process.stderr.write(`${notice.title}。${notice.message}\n`) } catch { /* no live diagnostic pipe */ }
  // The error box needs no GPU, and without one no shader cache is written at all.
  app.disableHardwareAcceleration()
  let scratch: string | null = null
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-refused-'))
    // Child processes read these when they start, which is after this line.
    for (const key of ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[key] = scratch
    app.setPath('userData', scratch)
    app.setPath('sessionData', scratch)
  } catch {
    // Quitting is still the answer; the dialog below is the only thing that needs a profile.
  }
  void app.whenReady()
    .then(() => dialog.showErrorBox(notice.title, notice.message))
    .catch(() => undefined)
    .finally(() => {
      if (scratch) {
        try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* temporary directory */ }
      }
      app.exit(1)
    })
}

// Checked before every other mode: no helper started by a normal launch is ever root,
// and nothing this process could go on to do is something root should do here.
const launchRefusal = linuxLaunchRefusal({
  platform: process.platform,
  effectiveUid: process.geteuid?.(),
  env: process.env,
})
// This branch must run before importing desktop modules: helpers do not own
// windows, renderer IPC, the single-instance lock, or the normal quit handlers.
const cleanupMode = uninstallCleanupEntryMode(process.argv, process.platform)
const mode = accelerationEntryMode(process.argv, typeof process.send === 'function' && process.connected, process.platform)
if (launchRefusal) {
  refuseLinuxLaunch(launchRefusal)
} else if (cleanupMode === 'cleanup') {
  // The uninstaller waits on this process and deletes the files right after,
  // so it never takes the single-instance lock or opens the desktop.
  const { app } = require('electron') as typeof import('electron')
  const { startUninstallCleanup } = require('../uninstall-cleanup') as typeof import('../uninstall-cleanup')
  // The uninstaller attaches no stderr; the CI smoke does, and reads why.
  process.stderr.on('error', () => undefined)
  startUninstallCleanup(app, (code) => process.exit(code), (line) => {
    try { process.stderr.write(`${line}\n`) } catch { /* no live diagnostic pipe */ }
  })
} else if (cleanupMode === 'invalid') {
  process.exit(1)
} else if (mode === 'worker') {
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
