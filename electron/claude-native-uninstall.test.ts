import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClaudeNativeLayout,
  buildClaudeRetainedFiles,
  buildClaudeRetainedVersionFilesCommand,
  buildClaudeRetainedVersionFilesReason,
  isClaudeVersionFileName,
  uninstallVerifiedClaudeNativeInstallation,
} from './claude-native-uninstall'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'
import { captureUninstallLeftovers, removeUninstallLeftovers } from './uninstall-leftovers'

const temporaryDirectories: string[] = []
const posixHost = process.platform !== 'win32'

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryHome(): string {
  // realpath: macOS hands out /var/... temp paths that resolve through /private.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-native-')))
  temporaryDirectories.push(directory)
  return directory
}

function exists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

interface OfficialLayout {
  home: string
  bin: string
  command: string
  data: string
  versions: string
  current: string
  older: string
  settings: string
  globalConfig: string
}

/** Reproduces what `curl -fsSL https://claude.ai/install.sh | bash` leaves on disk. */
function officialLayout(options: { linkTarget?: (layout: OfficialLayout) => string } = {}): OfficialLayout {
  const home = temporaryHome()
  const layout: OfficialLayout = {
    home,
    bin: path.join(home, '.local', 'bin'),
    command: path.join(home, '.local', 'bin', 'claude'),
    data: path.join(home, '.local', 'share', 'claude'),
    versions: path.join(home, '.local', 'share', 'claude', 'versions'),
    current: path.join(home, '.local', 'share', 'claude', 'versions', '2.1.3'),
    older: path.join(home, '.local', 'share', 'claude', 'versions', '2.0.9'),
    settings: path.join(home, '.claude', 'settings.json'),
    globalConfig: path.join(home, '.claude.json'),
  }
  fs.mkdirSync(layout.bin, { recursive: true })
  fs.mkdirSync(layout.versions, { recursive: true })
  fs.mkdirSync(path.dirname(layout.settings), { recursive: true })
  fs.writeFileSync(layout.current, 'claude 2.1.3', { mode: 0o755 })
  fs.writeFileSync(layout.older, 'claude 2.0.9', { mode: 0o755 })
  fs.writeFileSync(layout.settings, '{"env":{}}')
  fs.writeFileSync(layout.globalConfig, '{"projects":{}}')
  fs.symlinkSync(options.linkTarget ? options.linkTarget(layout) : layout.current, layout.command)
  return layout
}

function expectConfigKept(layout: OfficialLayout): void {
  expect(fs.readFileSync(layout.settings, 'utf8')).toBe('{"env":{}}')
  expect(fs.readFileSync(layout.globalConfig, 'utf8')).toBe('{"projects":{}}')
}

describe('Claude Code native uninstall', () => {
  it.runIf(posixHost).each(['linux', 'darwin'] as const)(
    'removes the official absolute link and every Claude version file on %s',
    async (platform) => {
      const layout = officialLayout()

      const result = await uninstallVerifiedClaudeNativeInstallation({
        homeDirectory: layout.home,
        installDirectory: layout.bin,
        platform,
      })

      expect(exists(layout.command)).toBe(false)
      expect(result.removedVersionFiles.sort()).toEqual([layout.older, layout.current].sort())
      expect(result.retainedVersionFiles).toEqual([])
      expect(exists(layout.versions)).toBe(false)
      expect(exists(layout.data)).toBe(false)
      expect(exists(layout.bin)).toBe(true)
      expectConfigKept(layout)
      if (platform === 'darwin') {
        // Node has no inode-bound unlink on macOS, so the renamed link stays.
        expect(result.retainedQuarantineFiles).toHaveLength(1)
        expect(path.dirname(result.retainedQuarantineFiles[0])).toBe(layout.bin)
        expect(path.basename(result.retainedQuarantineFiles[0])).toMatch(/^\.claude-[0-9a-f-]{36}\.removing$/)
      } else {
        expect(result.retainedQuarantineFiles).toEqual([])
        expect(fs.readdirSync(layout.bin)).toEqual([])
      }
    },
  )

  it.runIf(posixHost)('accepts a relative link into the versions directory', async () => {
    const layout = officialLayout({ linkTarget: () => path.join('..', 'share', 'claude', 'versions', '2.1.3') })

    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: layout.home,
      installDirectory: layout.bin,
      platform: 'linux',
    })

    expect(exists(layout.command)).toBe(false)
    expect(result.removedVersionFiles).toContain(layout.current)
    expect(exists(layout.data)).toBe(false)
    expectConfigKept(layout)
  })

  it.runIf(posixHost).each(['linux', 'darwin'] as const)(
    'refuses a link that points outside ~/.local/share/claude/versions on %s',
    async (platform) => {
      const layout = officialLayout({
        linkTarget: (value) => {
          const foreign = path.join(value.home, 'opt', 'claude-2.1.3')
          fs.mkdirSync(path.dirname(foreign), { recursive: true })
          fs.writeFileSync(foreign, 'someone else', { mode: 0o755 })
          return foreign
        },
      })

      await expect(uninstallVerifiedClaudeNativeInstallation({
        homeDirectory: layout.home,
        installDirectory: layout.bin,
        platform,
      })).rejects.toThrow(/官方安装目录/)

      expect(fs.lstatSync(layout.command).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(path.join(layout.home, 'opt', 'claude-2.1.3'), 'utf8')).toBe('someone else')
      expect(exists(layout.current)).toBe(true)
      expect(exists(layout.older)).toBe(true)
      expectConfigKept(layout)
    },
  )

  it.runIf(posixHost)('refuses a version entry that is itself a link escaping the versions directory', async () => {
    const layout = officialLayout()
    const victim = path.join(layout.home, 'Documents', 'report.txt')
    fs.mkdirSync(path.dirname(victim), { recursive: true })
    fs.writeFileSync(victim, 'keep me')
    fs.rmSync(layout.current)
    fs.symlinkSync(victim, layout.current)

    await expect(uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: layout.home,
      installDirectory: layout.bin,
      platform: 'darwin',
    })).rejects.toThrow(/官方安装目录/)

    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me')
    expect(fs.lstatSync(layout.command).isSymbolicLink()).toBe(true)
    expect(exists(layout.older)).toBe(true)
  })

  it.runIf(posixHost)('refuses when the versions directory is redirected through a link', async () => {
    const home = temporaryHome()
    const bin = path.join(home, '.local', 'bin')
    const elsewhere = path.join(home, 'elsewhere')
    const data = path.join(home, '.local', 'share', 'claude')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(elsewhere, '2.1.3'), 'claude', { mode: 0o755 })
    fs.writeFileSync(path.join(elsewhere, '1.0.0'), 'unrelated')
    fs.symlinkSync(elsewhere, path.join(data, 'versions'))
    fs.symlinkSync(path.join(data, 'versions', '2.1.3'), path.join(bin, 'claude'))

    await expect(uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: home,
      installDirectory: bin,
      platform: 'darwin',
    })).rejects.toThrow(/被链接替换/)

    expect(fs.lstatSync(path.join(bin, 'claude')).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(elsewhere).sort()).toEqual(['1.0.0', '2.1.3'])
  })

  it.runIf(posixHost)('refuses a hard-linked link target without renaming anything', async () => {
    const layout = officialLayout()
    const alias = path.join(layout.home, 'alias')
    fs.linkSync(layout.current, alias)

    await expect(uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: layout.home,
      installDirectory: layout.bin,
      platform: 'linux',
    })).rejects.toThrow(/单链接普通文件/)

    expect(fs.lstatSync(layout.command).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(alias, 'utf8')).toBe('claude 2.1.3')
  })

  it.runIf(posixHost)('keeps unrelated entries and reports version files it would not delete', async () => {
    const layout = officialLayout()
    const notes = path.join(layout.versions, 'notes.txt')
    const staging = path.join(layout.versions, '2.2.0-staging')
    const hardLinkedVersion = path.join(layout.versions, '1.9.0')
    fs.writeFileSync(notes, 'mine')
    fs.mkdirSync(staging)
    fs.writeFileSync(hardLinkedVersion, 'old')
    fs.linkSync(hardLinkedVersion, path.join(layout.home, 'backup-of-1.9.0'))

    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: layout.home,
      installDirectory: layout.bin,
      platform: 'linux',
    })

    expect(exists(layout.command)).toBe(false)
    expect(result.removedVersionFiles.sort()).toEqual([layout.older, layout.current].sort())
    expect(result.retainedVersionFiles).toEqual([hardLinkedVersion])
    expect(fs.readFileSync(notes, 'utf8')).toBe('mine')
    expect(fs.statSync(staging).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(layout.home, 'backup-of-1.9.0'), 'utf8')).toBe('old')
    expectConfigKept(layout)
  })

  it.runIf(posixHost)('removes a plain-file command and cleans versions when no link is involved', async () => {
    const layout = officialLayout()
    fs.rmSync(layout.command)
    fs.writeFileSync(layout.command, 'claude', { mode: 0o755 })

    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: layout.home,
      installDirectory: layout.bin,
      platform: 'darwin',
    })

    expect(exists(layout.command)).toBe(false)
    expect(result.retainedQuarantineFiles).toEqual([])
    expect(exists(layout.data)).toBe(false)
    expectConfigKept(layout)
  })

  it.runIf(posixHost)('uninstalls the command when the versions directory is already gone', async () => {
    const home = temporaryHome()
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'claude'), 'claude', { mode: 0o755 })

    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: home,
      installDirectory: bin,
      platform: 'linux',
    })

    expect(exists(path.join(bin, 'claude'))).toBe(false)
    expect(result).toEqual({ removedVersionFiles: [], retainedVersionFiles: [], retainedQuarantineFiles: [] })
  })

  it.runIf(process.platform === 'win32')('removes claude.exe and the Windows version files', async () => {
    const home = temporaryHome()
    const bin = path.join(home, '.local', 'bin')
    const versions = path.join(home, '.local', 'share', 'claude', 'versions')
    const settings = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(versions, { recursive: true })
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(path.join(bin, 'claude.exe'), 'claude')
    fs.writeFileSync(path.join(versions, '2.1.3'), 'claude')
    fs.writeFileSync(path.join(versions, '2.0.9.exe'), 'claude')
    fs.writeFileSync(settings, '{}')

    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: home,
      installDirectory: bin,
      platform: 'win32',
    })

    expect(exists(path.join(bin, 'claude.exe'))).toBe(false)
    expect(result.removedVersionFiles).toHaveLength(2)
    expect(exists(path.join(home, '.local', 'share', 'claude'))).toBe(false)
    expect(fs.readFileSync(settings, 'utf8')).toBe('{}')
  })

  it.runIf(process.platform === 'win32')('reports the claude.exe an open Claude Code still runs from, and deletes it once closed', async () => {
    const home = temporaryHome()
    const bin = path.join(home, '.local', 'bin')
    const versions = path.join(home, '.local', 'share', 'claude', 'versions')
    const command = path.join(bin, 'claude.exe')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(versions, { recursive: true })
    fs.writeFileSync(path.join(versions, '2.1.3'), 'claude')
    // A real program started from claude.exe, as when the user left Claude Code
    // open: Windows lets the uninstall rename the image but not delete it.
    fs.copyFileSync(process.execPath, command)
    const running = spawn(command, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const ended = new Promise<void>((resolve) => {
      running.once('exit', () => resolve())
      running.once('error', () => resolve())
    })
    try {
      await new Promise<void>((resolve, reject) => {
        running.once('spawn', resolve)
        running.once('error', reject)
      })

      const result = await uninstallVerifiedClaudeNativeInstallation({
        homeDirectory: home,
        installDirectory: bin,
        platform: 'win32',
      })

      expect(exists(command)).toBe(false)
      expect(result.removedVersionFiles).toEqual([path.join(versions, '2.1.3')])
      expect(result.retainedVersionFiles).toEqual([])
      expect(result.retainedQuarantineFiles).toHaveLength(1)
      const [renamed] = result.retainedQuarantineFiles
      // Compared by name only: the uninstall reports the directory's native
      // realpath, which expands the runner's 8.3 short temp path.
      expect(path.basename(renamed)).toMatch(/^\.claude\.exe-.+\.removing$/)
      expect(fs.readdirSync(bin)).toEqual([path.basename(renamed)])
      expect(exists(renamed)).toBe(true)

      const options = { platform: 'win32' as const, ownerUid: undefined }
      const leftovers = captureUninstallLeftovers(result.retainedQuarantineFiles, options)
      expect(leftovers.map((leftover) => leftover.kind)).toEqual(['pinned'])
      const whileOpen = await removeUninstallLeftovers(leftovers, options)
      expect(whileOpen.removed).toBe(0)
      expect(whileOpen.kept.map((entry) => entry.reason)).toEqual(['delete-failed'])
      expect(exists(renamed)).toBe(true)

      running.kill()
      await ended
      const afterClose = await removeUninstallLeftovers(whileOpen.kept.map((entry) => entry.leftover), options)
      expect(afterClose).toEqual({ removed: 1, reused: 0, kept: [] })
      expect(exists(renamed)).toBe(false)
    } finally {
      running.kill()
      await ended
    }
  })

  it('recognizes only installer-produced version names', () => {
    expect(isClaudeVersionFileName('2.1.3', 'darwin')).toBe(true)
    expect(isClaudeVersionFileName('2.1.3-beta.1', 'linux')).toBe(true)
    expect(isClaudeVersionFileName('2.1.3.exe', 'darwin')).toBe(false)
    expect(isClaudeVersionFileName('2.1.3.exe', 'win32')).toBe(true)
    expect(isClaudeVersionFileName('.2.1.3-0f0e0d0c-0000-4000-8000-000000000000.removing', 'darwin')).toBe(false)
    expect(isClaudeVersionFileName('..', 'linux')).toBe(false)
    expect(isClaudeVersionFileName('notes.txt', 'win32')).toBe(false)
  })

  it('builds the layout under ~/.local only, never ~/.claude', () => {
    const layout = buildClaudeNativeLayout(path.join(path.sep, 'home', 'tester'), 'darwin')
    expect(layout.commandPath).toBe(path.join(path.sep, 'home', 'tester', '.local', 'bin', 'claude'))
    expect(layout.versionsDirectory).toBe(path.join(path.sep, 'home', 'tester', '.local', 'share', 'claude', 'versions'))
    expect(buildClaudeNativeLayout(path.join(path.sep, 'home', 'tester'), 'win32').commandName).toBe('claude.exe')
  })

  it('quotes retained paths for the shell the user will paste into', () => {
    expect(buildClaudeRetainedVersionFilesCommand([], 'darwin')).toBeNull()
    expect(buildClaudeRetainedVersionFilesCommand(["/Users/o'neil/.local/share/claude/versions/1.9.0"], 'darwin'))
      .toBe(`rm -f '/Users/o'"'"'neil/.local/share/claude/versions/1.9.0'`)
    expect(buildClaudeRetainedVersionFilesCommand(["C:\\Users\\o'neil\\.local\\share\\claude\\versions\\1.9.0"], 'win32'))
      .toBe(`Remove-Item -LiteralPath 'C:\\Users\\o''neil\\.local\\share\\claude\\versions\\1.9.0' -Force`)
  })

  it('reports the renamed command entry on Windows only, where it means Claude Code is still open', () => {
    const result = {
      removedVersionFiles: [],
      retainedVersionFiles: ['/home/a/.local/share/claude/versions/2.1.3'],
      retainedQuarantineFiles: ['/home/a/.local/bin/.claude-0f0e0d0c-0000-4000-8000-000000000000.removing'],
    }
    expect(buildClaudeRetainedFiles(result, 'win32')).toEqual({
      commandFiles: result.retainedQuarantineFiles,
      versionFiles: result.retainedVersionFiles,
    })
    for (const platform of ['darwin', 'linux'] as const) {
      expect(buildClaudeRetainedFiles(result, platform)).toEqual({
        commandFiles: [],
        versionFiles: result.retainedVersionFiles,
      })
    }
  })

  it('asks the user to close Claude Code first when the renamed claude.exe could not be deleted', () => {
    const renamed = 'C:\\Users\\a\\.local\\bin\\.claude.exe-0f0e0d0c-0000-4000-8000-000000000000.removing'
    const version = 'C:\\Users\\a\\.local\\share\\claude\\versions\\2.1.3'
    expect(buildClaudeRetainedVersionFilesReason([], 'win32', [renamed])).toBe(
      'Claude Code 已卸载，但还有 1 个程序文件没能删掉，多半是 Claude Code 还开着。先关掉所有 Claude Code 窗口，再清理这些文件；你的 Claude Code 设置和会话记录不受影响。',
    )
    const both = buildClaudeRetainedVersionFilesReason([version], 'win32', [renamed])
    expect(both).toContain('还有 2 个程序文件没能删掉')
    expect(both).not.toContain('.removing')
    expect(buildClaudeRetainedVersionFilesCommand([renamed, version], 'win32')).toBe(
      `Remove-Item -LiteralPath '${renamed}' -Force; Remove-Item -LiteralPath '${version}' -Force`,
    )
  })

  it('explains retained version files without touching settings', () => {
    expect(buildClaudeRetainedVersionFilesReason([], 'darwin')).toBeNull()
    const reason = buildClaudeRetainedVersionFilesReason(['/Users/a/.local/share/claude/versions/1.9.0'], 'darwin')
    expect(reason).toContain('Claude Code 已卸载')
    expect(reason).toContain('1.9.0')
    expect(reason).toContain('设置和会话记录不受影响')
  })
})

describe('verified native CLI uninstall with absolute link targets', () => {
  it.runIf(posixHost)('still rejects an absolute link target unless the plan opts in', async () => {
    const layout = officialLayout()
    const link = fs.lstatSync(layout.command, { bigint: true })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: layout.bin,
      expectedDirectory: layout.bin,
      fileNames: ['claude'],
      label: 'Claude Code',
      platform: 'linux',
      removeDirectoryWhenEmpty: false,
      expectedSymbolicLinks: { claude: layout.current },
      expectedSymbolicLinkIdentities: {
        claude: {
          dev: link.dev,
          ino: link.ino,
          mode: link.mode,
          uid: link.uid,
          gid: link.gid,
          nlink: link.nlink,
          size: link.size,
          ctimeNs: link.ctimeNs,
          birthtimeNs: link.birthtimeNs,
        },
      },
    })).rejects.toThrow(/卸载计划无效/)

    expect(fs.lstatSync(layout.command).isSymbolicLink()).toBe(true)
  })

  it.runIf(posixHost)('refuses the absolute opt-in without a resolved-target root to pin it', async () => {
    const layout = officialLayout()

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: layout.bin,
      expectedDirectory: layout.bin,
      fileNames: ['claude'],
      label: 'Claude Code',
      platform: 'linux',
      removeDirectoryWhenEmpty: false,
      allowAbsoluteSymbolicLinkTargets: true,
    })).rejects.toThrow(/缺少完整目标身份/)

    expect(fs.lstatSync(layout.command).isSymbolicLink()).toBe(true)
  })
})
