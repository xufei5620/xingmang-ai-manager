import type { CodexSetupStatus } from './types'
import { minimumSupportedNodeVersion } from '../electron/versions'

export function nodeRuntimeSupported(runtime: CodexSetupStatus['runtime']): boolean {
  const node = runtime.node
  return Boolean(node.installed)
    && node.tooOld !== true
    && node.versionStatus !== 'unknown'
}

export function codexRuntimeSetupMessage(runtime: CodexSetupStatus['runtime']): string | null {
  const nodeInstalled = runtime.node.installed
  const npmInstalled = runtime.npm.installed

  if (!nodeInstalled && !npmInstalled) {
    return '未检测到 Node.js 和 npm。请按安装教程启用 npm package manager 和 Add to PATH。'
  }
  if (!nodeInstalled) {
    return '未检测到 Node.js。请安装 Node.js LTS，并确认 Add to PATH 已启用。'
  }
  if (!npmInstalled) {
    return '已检测到 Node.js，但未检测到 npm。请修复 Node.js 安装，并确认 npm package manager 和 Add to PATH 已启用。'
  }
  if (runtime.node.tooOld || runtime.node.versionStatus === 'too-old') {
    return `Node.js 版本过低（当前 ${runtime.node.version ?? '未知'}），请升级到 v${minimumSupportedNodeVersion.major}.x 或更高版本。`
  }
  if (runtime.node.versionStatus === 'unknown') {
    return '已检测到 Node.js，但版本无法识别。请升级到 Node.js LTS，并确认 Add to PATH 已启用。'
  }
  return null
}
