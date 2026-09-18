import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sameLocalPathIdentity } from './path-identity'

const directoryPrefix = 'xingmang-acceleration-electron-'
const argumentPrefix = '--user-data-dir='

function verifiedDirectory(directory: string): string {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  if (!path.isAbsolute(directory)
    || !sameLocalPathIdentity(path.dirname(directory), temporaryRoot)
    || !/^xingmang-acceleration-electron-[A-Za-z0-9]{6}$/.test(path.basename(directory))) {
    throw new Error('加速辅助进程数据目录无效。')
  }
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || !sameLocalPathIdentity(fs.realpathSync(directory), directory)) {
    throw new Error('加速辅助进程数据目录无效。')
  }
  return directory
}

/** Each Electron main process must have its own Local State / OSCrypt key. */
export function createAccelerationElectronProfile(): { directory: string; argument: string; cleanup(): void } {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), directoryPrefix))
  verifiedDirectory(directory)
  const identity = fs.lstatSync(directory, { bigint: true })
  let cleaned = false
  return {
    directory,
    argument: `${argumentPrefix}${directory}`,
    cleanup() {
      if (cleaned) return
      try {
        verifiedDirectory(directory)
        const current = fs.lstatSync(directory, { bigint: true })
        if (current.dev !== identity.dev || current.ino !== identity.ino) return
        // Only after the owning Electron process exits; disconnect can leave it
        // alive while retrying proxy recovery. Never sweep other worker dirs.
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
        cleaned = true
      } catch { /* A parent crash or locked profile can leave harmless temporary state. */ }
    },
  }
}

/** Runs synchronously before loading any desktop or worker service modules. */
export function isolateAccelerationElectronProfile(
  app: { setPath(name: 'userData' | 'sessionData', directory: string): void },
  argv: readonly string[],
): void {
  const arguments_ = argv.filter((argument) => argument.startsWith(argumentPrefix))
  if (arguments_.length !== 1) throw new Error('加速辅助进程缺少独立数据目录。')
  const directory = verifiedDirectory(arguments_[0].slice(argumentPrefix.length))
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
}
