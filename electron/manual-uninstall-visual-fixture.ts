import path from 'node:path'
import type { SystemSnapshot } from './system-service'

export interface ManualUninstallVisualFixtureGate {
  environmentValue: string | undefined
  isPackaged: boolean
}

export function shouldUseManualUninstallVisualFixture(
  options: ManualUninstallVisualFixtureGate,
): boolean {
  return options.environmentValue === '1' && options.isPackaged === false
}

function fixtureHomeDirectory(homeDirectory: string): string {
  if (homeDirectory.includes('\0')) throw new Error('视觉测试用户目录不能包含 NUL')
  if (!path.posix.isAbsolute(homeDirectory)) {
    throw new Error('视觉测试用户目录必须是绝对路径')
  }
  const resolved = path.posix.resolve(homeDirectory)
  if (resolved === path.posix.parse(resolved).root) {
    throw new Error('视觉测试用户目录不能是文件系统根目录')
  }
  return resolved
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function standaloneTrashCommand(homeDirectory: string): string {
  const trashRoot = path.posix.join(homeDirectory, '.Trash')
  const standaloneRoot = path.posix.join(homeDirectory, 'Applications', 'Codex-standalone')
  const visibleLink = path.posix.join(homeDirectory, '.local', 'bin', 'codex')
  return [
    `trash_root=${shellSingleQuote(trashRoot)} && \\`,
    '  /bin/mkdir -p "$trash_root" && \\',
    `  standalone_root=${shellSingleQuote(standaloneRoot)} && \\`,
    `  visible_link=${shellSingleQuote(visibleLink)} && \\`,
    '  trash_dir=$(/usr/bin/mktemp -d "$trash_root/Codex-standalone.XXXXXX") && \\',
    '  [ -L "$visible_link" ] && \\',
    '  [ -d "$standalone_root" ] && \\',
    '  [ "$trash_root" != "$standalone_root" ] && \\',
    '  [ "$trash_dir" != "$standalone_root" ] && \\',
    '  [ "$trash_dir" != "$visible_link" ] && \\',
    '  [ "$(/usr/bin/dirname "$visible_link")" != "$standalone_root" ] && \\',
    '  /bin/mv "$visible_link" "$trash_dir/" && \\',
    '  /bin/mv "$standalone_root" "$trash_dir/"',
  ].join('\n')
}

export function withManualUninstallVisualFixture(
  snapshot: SystemSnapshot,
  homeDirectory: string,
): SystemSnapshot {
  const fixtureHome = fixtureHomeDirectory(homeDirectory)
  const standaloneDirectory = path.posix.join(
    fixtureHome,
    'Applications',
    'Codex-standalone',
  )
  const visibleCodexLink = path.posix.join(fixtureHome, '.local', 'bin', 'codex')
  const unknownGrokDirectory = path.posix.join(
    fixtureHome,
    'Library',
    'Application Support',
    'unknown-grok-installation',
  )
  const projectedStatus = (
    status: SystemSnapshot['clis']['codex'],
    options: {
      path: string
      directory: string
      reason: string
      manualCommand: string | null
    },
  ): SystemSnapshot['clis']['codex'] => ({
    ...status,
    installed: true,
    version: '0.0.0-e2e',
    path: options.path,
    installDirectory: options.directory,
    latestVersion: '0.0.0-e2e',
    updateAvailable: false,
    updateSource: 'native',
    updateCheck: 'checked',
    updateState: 'latest',
    updateCheckedAt: snapshot.checkedAt,
    updateError: null,
    uninstall: {
      available: false,
      reason: options.reason,
      manualCommand: options.manualCommand,
    },
  })

  return {
    ...snapshot,
    clis: {
      ...snapshot.clis,
      codex: projectedStatus(snapshot.clis.codex, {
        path: visibleCodexLink,
        directory: standaloneDirectory,
        reason: '已识别 OpenAI 官方 Codex standalone 安装；为保留配置和会话，请按教程将 CLI 程序移动到废纸篓',
        manualCommand: standaloneTrashCommand(fixtureHome),
      }),
      grok: projectedStatus(snapshot.clis.grok, {
        path: path.posix.join(unknownGrokDirectory, 'bin', 'grok'),
        directory: unknownGrokDirectory,
        reason: '当前安装来源或目录不支持安全自动卸载，请使用该发行版自带的卸载方式',
        manualCommand: null,
      }),
    },
  }
}
