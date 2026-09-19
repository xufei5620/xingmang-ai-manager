import { createRoot } from 'react-dom/client'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import {
  MaintenancePage,
  type MaintenanceCliStatus,
  type MaintenancePageApi,
  type MaintenanceSnapshot,
} from '../src/pages/MaintenancePage'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

document.documentElement.dataset.theme = 'dark'
document.documentElement.dataset.skin = 'obsidian'
document.body.style.margin = '0'

const cli: MaintenanceCliStatus = {
  installed: true,
  version: '0.1.0',
  path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\tool.cmd',
  installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
  latestVersion: '0.2.0',
  updateAvailable: true,
  updateState: 'available',
  updateCheck: 'checked',
  uninstall: { available: false, reason: null, manualCommand: 'npm uninstall -g tool' },
}

const snapshot: MaintenanceSnapshot = {
  checkedAt: '2026-09-07T00:00:00.000Z',
  runtime: {
    node: { installed: true, version: '24.19.0', path: 'C:\\Program Files\\nodejs\\node.exe', installDirectory: 'C:\\Program Files\\nodejs', versionStatus: 'supported' },
    npm: { installed: true, version: '11.17.0', path: 'C:\\Program Files\\nodejs\\npm.cmd', installDirectory: 'C:\\Program Files\\nodejs' },
  },
  clis: { claude: cli, codex: cli, gemini: cli, grok: cli },
  codexDesktop: { installed: true, version: '26.727.51351', appVersion: '26.727.51351', path: 'C:\\Program Files\\Codex', installDirectory: 'C:\\Program Files\\Codex', updateCheck: 'skipped', updateState: 'unknown', running: false },
}

// 这个夹具只用来量真实组件的排版,任何一次点击都不该发生;真发生了就让它
// 抛出来,而不是悄悄把测试带进一条没人断言的分支。
function unexpected(): never {
  throw new Error('maintenance layout fixture: unexpected action')
}

const api: MaintenancePageApi = {
  scan: async () => snapshot,
  installNodeRuntime: unexpected,
  restartWindows: unexpected,
  maintainCli: unexpected,
  uninstallCli: unexpected,
  checkCli: unexpected,
  installCodexDesktop: unexpected,
  uninstallCodexDesktop: unexpected,
  checkCodexDesktop: unexpected,
  openCodexDesktopStore: unexpected,
  launchCodexDesktop: unexpected,
}

createRoot(document.getElementById('root')!).render(
  <MaintenancePage api={api} platform={platformCapabilitiesFor('win32', 'x64')} />,
)
