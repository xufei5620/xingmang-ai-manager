// 装工具那几句结果、首页那份任务算不算这一行在装、「安装指南」落教程哪一章（#1070 第 11 步，从
// pages-maintenance.tsx 原样搬来）。检查页和扩展三页都用，pages-maintenance.tsx 照旧转出。
import {
  cliTutorialTopic,
  desktopInstallTutorialTopic,
  macDesktopTutorialTopic,
  macRuntimeTutorialTopic,
} from '../../registry/business'
import type { ActiveProviderId } from '../../../../electron/catalog'
import type { ToolJob } from './useToolbox'
import type { PlatformCapabilities } from '../../../../electron/ipc-contract'
import type { ToolInstallOutcome } from '../../business-actions'

// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：本页不再替它安装、检查或写 Key。
type Provider = ActiveProviderId

export function installResultMessage(result: ToolInstallOutcome | 'cancelled'): string | null {
  if (result === 'declined') return null
  if (result === 'cancelled') return '安装已取消'
  if (result === 'restart') return '运行环境已装好，重启电脑后再点一次「安装」'
  if (result === 'skipped') return '这个工具正在安装，等它做完就好'
  return '安装完成，工具状态已更新'
}

/**
 * 首页那边这个工具正挂着的任务算不算这一行在装：卸载也挂在工具编号下，那不是安装，
 * 这一行不能标「安装中」，只说正在卸载、按钮先灰着。
 */
export function installJobRunning(job: ToolJob | undefined): boolean {
  return job !== undefined && job.kind !== 'uninstall'
}

/**
 * 「查看安装步骤」「安装指南」落到教程哪一章。以前一律落到第一章，客户还得自己翻：
 * 桌面端在 Mac 上去「Mac 上装桌面端」、别的电脑去「Codex 桌面端怎么安装？」；命令行
 * 工具去「进阶：安装与使用命令行工具」；运行环境在 Mac 上去「Mac 上准备 Node.js 和 Python」，
 * 别的电脑也去命令行工具那一章。
 */
export function installGuideTopic(
  id: Provider | 'codexDesktop' | 'node' | 'python',
  platform: PlatformCapabilities['platform'] | undefined,
): string {
  const mac = platform === 'macos'
  if (id === 'codexDesktop') return mac ? macDesktopTutorialTopic : desktopInstallTutorialTopic
  if (id === 'node' || id === 'python') return mac ? macRuntimeTutorialTopic : cliTutorialTopic
  return cliTutorialTopic
}
