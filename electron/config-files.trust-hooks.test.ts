import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  claudeRootConfigTrustsFolder,
  codexConfigTrustsFolder,
  geminiTrustedFoldersTrustFolder,
  claudeConsoleKeySnapshotName,
  restoreManagedCliHooks,
  rewriteManagedCliHooks,
  codexConfigSnapshotPaths,
  ensureGeminiContextFilenamesInSettingsText,
  ensureGeminiProjectContextFiles,
  inspectManagedCliHookTargets,
  inspectOfficialLogin,
  inspectProviderConfig,
  inspectRetiredGeminiIntegrations,
  inspectHomeFolderTrust,
  moveClaudeConsoleKeyAside,
  moveClaudeConsoleKeyAsideTexts,
  providerConfigPaths,
  removeManagedCliHooks,
  inspectManagedCliHookParts,
  removeRetiredGeminiIntegrations,
  restoreClaudeConsoleKey,
  restoreClaudeConsoleKeyTexts,
  saveProviderConfig,
  switchProviderToOfficialAccount,
  trustClaudeWorkspace,
  trustClaudeWorkspaceInRootConfigText,
  trustGeminiWorkspaceInTrustedFoldersText,
  trustManagedWorkspace,
} from './config-files'
import { providerBaseUrls } from './catalog'
import type { CliHookInvocation } from './cli-hooks'
import {
  asRecord,
  cliHook,
  type GrokConfigShape,
  providerRoots,
  removeTemporaryHomes,
  statusLineCommand,
  temporaryHome,
  testModels,
} from './config-files.test-support'

afterEach(() => {
  vi.restoreAllMocks()
  removeTemporaryHomes()
})

describe('workspace trust for the directory the user picked', () => {
  // 字段形态见 config-files.ts 的长注释：2026-09-21 用空 HOME 走完
  // Claude Code 2.1.277 与 Gemini CLI 0.60.0 的首启向导后 diff 出来的。
  it('accepts the Claude trust dialog and the first-run wizard for that workspace', () => {
    const result = trustClaudeWorkspaceInRootConfigText(null, 'D:\\Work')
    expect(result.changed).toBe(true)
    const parsed = JSON.parse(result.content) as Record<string, unknown>
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(asRecord(asRecord(parsed.projects)?.['D:\\Work'])?.hasTrustDialogAccepted).toBe(true)
  })

  it('keeps every other Claude project entry and answer untouched', () => {
    const existing = JSON.stringify({
      hasCompletedOnboarding: false,
      numStartups: 7,
      projects: {
        'D:\\Other': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
        'D:\\Work': { hasTrustDialogAccepted: false, mcpServers: { local: {} } },
      },
    })
    const result = trustClaudeWorkspaceInRootConfigText(existing, 'd:/work')
    expect(result.changed).toBe(false)
    const parsed = JSON.parse(result.content) as Record<string, unknown>
    // 用户自己答过「不信任」，本软件不替他翻案；向导的 false 同理。
    expect(parsed.hasCompletedOnboarding).toBe(false)
    expect(parsed.numStartups).toBe(7)
    const projects = asRecord(parsed.projects)
    expect(asRecord(projects?.['D:\\Work'])?.hasTrustDialogAccepted).toBe(false)
    expect(asRecord(projects?.['D:\\Work'])?.mcpServers).toEqual({ local: {} })
    expect(asRecord(projects?.['D:\\Other'])?.allowedTools).toEqual(['Bash'])
  })

  it('reuses the Claude project key that already names this workspace', () => {
    const existing = JSON.stringify({ projects: { 'D:\\Work': { allowedTools: [] } } })
    const result = trustClaudeWorkspaceInRootConfigText(existing, 'D:/Work/')
    const projects = asRecord((JSON.parse(result.content) as Record<string, unknown>).projects)
    expect(Object.keys(projects ?? {})).toEqual(['D:\\Work'])
    expect(asRecord(projects?.['D:\\Work'])?.hasTrustDialogAccepted).toBe(true)
  })

  // D4：文件夹自带 Claude Code 的项目设置时，信任那一问留给 Claude Code 自己。
  it('skips only the first-run wizard when the folder trust is left to Claude Code', () => {
    const fresh = trustClaudeWorkspaceInRootConfigText(null, 'D:\\Download\\repo', { leaveFolderTrustToCli: true })
    expect(fresh.changed).toBe(true)
    // 连空的项目条目都不建，Claude Code 打开时照常问信任。
    expect(JSON.parse(fresh.content)).toEqual({ hasCompletedOnboarding: true })

    const existing = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        'D:\\Download\\repo': { allowedTools: ['Bash'] },
        'D:\\Work': { hasTrustDialogAccepted: true },
      },
    })
    const kept = trustClaudeWorkspaceInRootConfigText(existing, 'D:\\Download\\repo', { leaveFolderTrustToCli: true })
    expect(kept.changed).toBe(false)
    expect(JSON.parse(kept.content)).toEqual(JSON.parse(existing))
  })

  it('still refuses a damaged Claude project record when the folder trust is left to Claude Code', () => {
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects": ["D:\\\\Work"]}', 'D:\\Work', { leaveFolderTrustToCli: true }))
      .toThrow('项目记录已损坏')
  })

  it('trusts an unknown Gemini folder and leaves an existing answer alone', () => {
    const fresh = trustGeminiWorkspaceInTrustedFoldersText('{}', '/home/tester/work')
    expect(fresh.changed).toBe(true)
    expect(JSON.parse(fresh.content)).toEqual({ '/home/tester/work': 'TRUST_FOLDER' })

    const declined = JSON.stringify({ '/home/tester/work': 'DO_NOT_TRUST', '/home/tester/other': 'TRUST_PARENT' })
    const kept = trustGeminiWorkspaceInTrustedFoldersText(declined, '/home/tester/work/')
    expect(kept.changed).toBe(false)
    expect(JSON.parse(kept.content)).toEqual({
      '/home/tester/work': 'DO_NOT_TRUST',
      '/home/tester/other': 'TRUST_PARENT',
    })
  })

  // Gemini 0.62.0 在 macOS 上把键全转小写再写进去，读回来时同一文件夹的两条后一条算数。
  it('finds the lower-case key Gemini writes on macOS and Windows instead of appending a second one', () => {
    const declined = JSON.stringify({ '/users/alex/projects/app': 'DO_NOT_TRUST' })
    const mac = trustGeminiWorkspaceInTrustedFoldersText(declined, '/Users/alex/Projects/App', 'darwin')
    expect(mac.changed).toBe(false)
    expect(JSON.parse(mac.content)).toEqual({ '/users/alex/projects/app': 'DO_NOT_TRUST' })

    const windows = JSON.stringify({ 'c:/users/peaker/app': 'DO_NOT_TRUST' })
    expect(trustGeminiWorkspaceInTrustedFoldersText(windows, 'C:\\Users\\peaker\\app', 'win32').changed).toBe(false)

    // Linux 上 Gemini 分大小写，这是另一个文件夹。
    const linux = trustGeminiWorkspaceInTrustedFoldersText(declined, '/Users/alex/Projects/App', 'linux')
    expect(linux.changed).toBe(true)
    expect(JSON.parse(linux.content)).toEqual({
      '/users/alex/projects/app': 'DO_NOT_TRUST',
      '/Users/alex/Projects/App': 'TRUST_FOLDER',
    })
  })

  it('keeps comments in Gemini trust and context files it adds entries to', () => {
    const trust = trustGeminiWorkspaceInTrustedFoldersText('{\n  // 家里的项目\n  "/home/tester/other": "TRUST_FOLDER"\n}\n', '/home/tester/work')
    expect(trust.changed).toBe(true)
    expect(trust.content).toContain('// 家里的项目')
    expect(trust.content).toContain('"/home/tester/work": "TRUST_FOLDER"')

    const context = ensureGeminiContextFilenamesInSettingsText('{\n  // 我的主题\n  "ui": { "theme": "GitHub" }\n}\n')
    expect(context.changed).toBe(true)
    expect(context.content).toContain('// 我的主题')
    expect(context.content).toContain('"AGENTS.md"')

    const unchanged = '{\n  // 已经配好\n  "context": { "fileName": ["GEMINI.md", "AGENTS.md"] }\n}\n'
    expect(ensureGeminiContextFilenamesInSettingsText(unchanged)).toEqual({ content: unchanged, changed: false })
  })

  it('refuses to guess at a damaged trust file instead of overwriting it', () => {
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects":', 'D:\\Work'))
      .toThrow('无法解析为 JSON')
    expect(() => trustGeminiWorkspaceInTrustedFoldersText('["a"]', '/home/tester/work'))
      .toThrow('不是有效的 JSON 对象')
    // 解析器原文会带上出错位置附近的片段，~/.claude.json 里有会话历史（I13）。
    expect(() => trustClaudeWorkspaceInRootConfigText('{"apiKey": "sk-secret-value"', 'D:\\Work'))
      .not.toThrow(/sk-secret-value/)
  })

  it('leaves a Claude project record it cannot read the shape of entirely alone', () => {
    // 换成空对象就跳过了弹窗，代价是用户的项目记录没了，这笔买卖不做。
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects": ["D:\\\\Work"]}', 'D:\\Work'))
      .toThrow('项目记录已损坏')
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects": {"D:\\\\Work": "trusted"}}', 'D:\\Work'))
      .toThrow('项目记录已损坏')
  })

  it('writes the Claude trust transaction with a recoverable backup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = path.join(home, '.claude.json')
    fs.writeFileSync(configPath, JSON.stringify({ numStartups: 3 }), 'utf8')

    const result = trustManagedWorkspace('claude', roots, path.join(home, 'project'))
    expect(result.changed).toBe(true)
    expect(result.backups).toHaveLength(1)
    expect(fs.existsSync(result.backups[0])).toBe(true)
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(written.numStartups).toBe(3)
    expect(written.hasCompletedOnboarding).toBe(true)
    expect(asRecord(asRecord(written.projects)?.[path.join(home, 'project')])?.hasTrustDialogAccepted).toBe(true)

    // 第二次打开同一个目录不再改文件，所以也不会再堆一份备份。
    const again = trustClaudeWorkspace(roots, path.join(home, 'project'))
    expect(again.changed).toBe(false)
    expect(again.backups).toEqual([])
  })

  it('writes no Claude folder trust to disk when it is left to Claude Code', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = path.join(home, '.claude.json')
    fs.writeFileSync(configPath, JSON.stringify({ numStartups: 3 }), 'utf8')

    const result = trustManagedWorkspace('claude', roots, path.join(home, 'project'), { leaveFolderTrustToCli: true })
    expect(result.changed).toBe(true)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ numStartups: 3, hasCompletedOnboarding: true })

    // 向导已经跳过、信任又不替他写，就没有要改的了，不再堆备份。
    expect(trustManagedWorkspace('claude', roots, path.join(home, 'project'), { leaveFolderTrustToCli: true }))
      .toEqual({ backups: [], files: [], changed: false })
  })

  it('creates the Gemini trust file when the CLI has never written one', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const workspace = path.join(home, 'project')

    const result = trustManagedWorkspace('gemini', roots, workspace)
    expect(result.changed).toBe(true)
    expect(result.backups).toEqual([])
    const trustedFolders = path.join(home, '.gemini', 'trustedFolders.json')
    expect(JSON.parse(fs.readFileSync(trustedFolders, 'utf8'))).toEqual({ [workspace]: 'TRUST_FOLDER' })
  })

  it('reports a damaged trust file instead of blocking the launch path', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":', 'utf8')

    expect(() => trustManagedWorkspace('claude', roots, path.join(home, 'project')))
      .toThrow('未执行修改')
    // 原文件一字未动，等着 CLI 自己去修。
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{"projects":')
  })

  it('has nothing to write for the providers without a launch-time trust file', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      expect(trustManagedWorkspace(provider, roots, path.join(home, 'project')))
        .toEqual({ backups: [], files: [], changed: false })
    }
    expect(fs.readdirSync(home)).toEqual([])
  })
})

describe('telling which tools trust the whole home folder', () => {
  it('reads a Claude trust answer for the home folder under either slash style', () => {
    const trusted = JSON.stringify({ projects: { 'C:/Users/peaker': { hasTrustDialogAccepted: true } } })
    expect(claudeRootConfigTrustsFolder(trusted, 'C:\\Users\\peaker')).toBe(true)
    expect(claudeRootConfigTrustsFolder(trusted, 'C:\\Users\\peaker\\project')).toBe(false)
    // 只有答过「信任」才算；答过「不信任」、只是记着别的设置的都不算。
    const other = JSON.stringify({ projects: { 'C:\\Users\\peaker': { hasTrustDialogAccepted: false }, 'C:\\Users\\peaker\\app': { hasTrustDialogAccepted: true } } })
    expect(claudeRootConfigTrustsFolder(other, 'C:\\Users\\peaker')).toBe(false)
    expect(claudeRootConfigTrustsFolder(JSON.stringify({ projects: { '/home/me': { allowedTools: [] } } }), '/home/me')).toBe(false)
  })

  it('reads a Codex trust level for the home folder, including its verbatim Windows form', () => {
    expect(codexConfigTrustsFolder('[projects."/Users/alex"]\ntrust_level = "trusted"\n', '/Users/alex/')).toBe(true)
    expect(codexConfigTrustsFolder('[projects."\\\\\\\\?\\\\C:\\\\Users\\\\peaker"]\ntrust_level = "trusted"\n', 'C:\\Users\\peaker')).toBe(true)
    expect(codexConfigTrustsFolder('[projects."/Users/alex"]\ntrust_level = "untrusted"\n', '/Users/alex')).toBe(false)
    expect(codexConfigTrustsFolder('[projects."/Users/alex/app"]\ntrust_level = "trusted"\n', '/Users/alex')).toBe(false)
  })

  it('reads a Gemini trusted home folder, also through a project directly under it that trusts its parent', () => {
    expect(geminiTrustedFoldersTrustFolder('{\n  // 自己加的\n  "/home/me": "TRUST_FOLDER"\n}\n', '/home/me')).toBe(true)
    expect(geminiTrustedFoldersTrustFolder(JSON.stringify({ 'C:\\Users\\peaker\\app': 'TRUST_PARENT' }), 'C:\\Users\\peaker')).toBe(true)
    expect(geminiTrustedFoldersTrustFolder(JSON.stringify({ '/home/me/work/app': 'TRUST_PARENT' }), '/home/me')).toBe(false)
    expect(geminiTrustedFoldersTrustFolder(JSON.stringify({ '/home/me': 'DO_NOT_TRUST', '/home/me/app': 'TRUST_FOLDER' }), '/home/me')).toBe(false)
  })

  it('treats a file it cannot read as no answer instead of an error', () => {
    expect(claudeRootConfigTrustsFolder('{"projects":', '/home/me')).toBe(false)
    expect(claudeRootConfigTrustsFolder(null, '/home/me')).toBe(false)
    expect(codexConfigTrustsFolder('[projects', '/home/me')).toBe(false)
    expect(geminiTrustedFoldersTrustFolder('["/home/me"]', '/home/me')).toBe(false)
  })

  it('lists the tools that remember trusting the home folder on disk, in a fixed order', () => {
    // macOS 的临时目录经过 /var → /private/var 这条符号链接，安全读法会拒读。
    const home = fs.realpathSync.native(temporaryHome())
    const roots = providerRoots(home)
    expect(inspectHomeFolderTrust(roots)).toEqual([])
    fs.mkdirSync(path.join(home, '.gemini'))
    fs.writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [home]: 'TRUST_FOLDER' }), 'utf8')
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true } } }), 'utf8')
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[projects', 'utf8')
    expect(inspectHomeFolderTrust(roots)).toEqual(['claude', 'gemini'])
    // 只读：哪个文件都没被改动。
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe('[projects')
  })
})

describe('teaching Gemini CLI to read the shared AGENTS.md', () => {
  it('adds both context files when settings.json has none', () => {
    const result = ensureGeminiContextFilenamesInSettingsText('{}')
    expect(result.changed).toBe(true)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    expect(context?.fileName).toEqual(['GEMINI.md', 'AGENTS.md'])
  })

  it('appends only what is missing and keeps the user list and order', () => {
    const existing = JSON.stringify({ context: { fileName: ['docs/RULES.md', 'GEMINI.md'] } })
    const result = ensureGeminiContextFilenamesInSettingsText(existing)
    expect(result.changed).toBe(true)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    // GEMINI.md 已在，不重复；用户自己的条目原样保留，AGENTS.md 补在末尾。
    expect(context?.fileName).toEqual(['docs/RULES.md', 'GEMINI.md', 'AGENTS.md'])
  })

  it('upgrades a single string value to a list without losing it', () => {
    const result = ensureGeminiContextFilenamesInSettingsText(JSON.stringify({ context: { fileName: 'GEMINI.md' } }))
    expect(result.changed).toBe(true)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    expect(context?.fileName).toEqual(['GEMINI.md', 'AGENTS.md'])
  })

  it('does nothing when both context files are already listed', () => {
    const existing = JSON.stringify({ context: { fileName: ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'] } })
    const result = ensureGeminiContextFilenamesInSettingsText(existing)
    expect(result.changed).toBe(false)
  })

  it('leaves an unreadable context.fileName shape untouched', () => {
    const result = ensureGeminiContextFilenamesInSettingsText(JSON.stringify({ context: { fileName: { a: 1 } } }))
    expect(result.changed).toBe(false)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    expect(context?.fileName).toEqual({ a: 1 })
  })

  it('writes the settings.json transaction only once and keeps other settings', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const settingsPath = path.join(home, '.gemini', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'Dark', security: { auth: { selectedType: 'gemini-api-key' } } }), 'utf8')

    const result = ensureGeminiProjectContextFiles(roots)
    expect(result.changed).toBe(true)
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(written.theme).toBe('Dark')
    expect(asRecord(asRecord(written.security)?.auth)?.selectedType).toBe('gemini-api-key')
    expect(asRecord(written.context)?.fileName).toEqual(['GEMINI.md', 'AGENTS.md'])

    const again = ensureGeminiProjectContextFiles(roots)
    expect(again.changed).toBe(false)
    expect(again.backups).toEqual([])
  })
})

describe('moving competing official credentials aside during an account switch', () => {
  it('moves the Console key out of ~/.claude.json and keeps every other field', () => {
    const next = moveClaudeConsoleKeyAsideTexts(JSON.stringify({ primaryApiKey: 'sk-ant-api03-console', projects: { '/work': { hasTrustDialogAccepted: true } } }))
    expect(JSON.parse(next.rootConfig!)).toEqual({ projects: { '/work': { hasTrustDialogAccepted: true } } })
    expect(JSON.parse(next.snapshot!)).toEqual({ primaryApiKey: 'sk-ant-api03-console' })
  })

  it('leaves both files alone when there is no Console key', () => {
    expect(moveClaudeConsoleKeyAsideTexts(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))).toEqual({ rootConfig: null, snapshot: null })
    expect(moveClaudeConsoleKeyAsideTexts(null)).toEqual({ rootConfig: null, snapshot: null })
  })

  it('puts the key back and empties the snapshot, but never overwrites a newer login', () => {
    const snapshot = JSON.stringify({ primaryApiKey: 'sk-ant-api03-console' })
    const restored = restoreClaudeConsoleKeyTexts(JSON.stringify({ numStartups: 3 }), snapshot)
    expect(JSON.parse(restored.rootConfig!)).toEqual({ numStartups: 3, primaryApiKey: 'sk-ant-api03-console' })
    expect(restored.snapshot).toBe('')
    expect(restoreClaudeConsoleKeyTexts(JSON.stringify({ primaryApiKey: 'sk-ant-newer' }), snapshot)).toEqual({ rootConfig: null, snapshot: '' })
    expect(restoreClaudeConsoleKeyTexts(JSON.stringify({}), null)).toEqual({ rootConfig: null, snapshot: null })
  })

  it('round-trips the Console key through the snapshot file on disk', () => {
    const home = temporaryHome()
    const rootConfig = path.join(home, '.claude.json')
    const snapshot = path.join(home, '.claude', claudeConsoleKeySnapshotName)
    fs.writeFileSync(rootConfig, JSON.stringify({ primaryApiKey: 'sk-ant-api03-console', hasCompletedOnboarding: true }))

    expect(moveClaudeConsoleKeyAside(providerRoots(home))).toBe(true)
    expect(JSON.parse(fs.readFileSync(rootConfig, 'utf8'))).toEqual({ hasCompletedOnboarding: true })
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toEqual({ primaryApiKey: 'sk-ant-api03-console' })
    expect(moveClaudeConsoleKeyAside(providerRoots(home))).toBe(false)

    expect(restoreClaudeConsoleKey(providerRoots(home))).toBe(true)
    expect(JSON.parse(fs.readFileSync(rootConfig, 'utf8'))).toEqual({ hasCompletedOnboarding: true, primaryApiKey: 'sk-ant-api03-console' })
    expect(fs.readFileSync(snapshot, 'utf8')).toBe('')
    expect(restoreClaudeConsoleKey(providerRoots(home))).toBe(false)
  })

  it('does not create files when nothing needs to move', () => {
    const home = temporaryHome()
    expect(moveClaudeConsoleKeyAside(providerRoots(home))).toBe(false)
    expect(restoreClaudeConsoleKey(providerRoots(home))).toBe(false)
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.claude', claudeConsoleKeySnapshotName))).toBe(false)
  })

  it('pins the relay profile to file-based Codex credentials and keeps the official choice in its snapshot', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'cli_auth_credentials_store = "keyring"\nmodel = "gpt-5.5"\n')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).cli_auth_credentials_store).toBe('file')

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).cli_auth_credentials_store).toBe('keyring')
  })

  it('lifts a forced ChatGPT login for the relay key and gives the official profile its restriction back', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexConfigSnapshotPaths(roots)
    fs.mkdirSync(path.dirname(snapshots.active), { recursive: true })
    fs.writeFileSync(snapshots.active, 'forced_login_method = "chatgpt"\nmodel = "gpt-5.5"\n')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    for (const file of [snapshots.active, snapshots.relay]) {
      expect(TOML.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('forced_login_method')
    }
    expect(TOML.parse(fs.readFileSync(snapshots.chatgpt, 'utf8')).forced_login_method).toBe('chatgpt')

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(snapshots.active, 'utf8')).forced_login_method).toBe('chatgpt')

    // Back on the relay the stored relay profile is reused; the restriction stays lifted there too.
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(snapshots.active, 'utf8'))).not.toHaveProperty('forced_login_method')
  })

  it('lifts a forced ChatGPT login left in a relay profile and keeps a forced API key login', () => {
    function savedLoginMethod(existing: string): unknown {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, existing)
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
      return TOML.parse(fs.readFileSync(configPath, 'utf8')).forced_login_method
    }

    const relayTable = `model_provider = "XingmangAI"\n\n[model_providers.XingmangAI]\nname = "OpenAI"\nbase_url = "${providerBaseUrls.codex}"\nwire_api = "responses"\nrequires_openai_auth = true\n`
    expect(savedLoginMethod(`forced_login_method = "chatgpt"\n${relayTable}`)).toBeUndefined()
    // "api" is what the relay key is, so Codex keeps it signed in.
    expect(savedLoginMethod('forced_login_method = "api"\n')).toBe('api')
  })

  it('switches a half-switched Codex (ChatGPT login over the relay config.toml) fully back to official', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    // What Codex's own "Sign in with ChatGPT" leaves behind.
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).actualBaseUrl).toBe(providerBaseUrls.codex)

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(config.model_provider).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toMatchObject({ auth_mode: 'chatgpt', tokens: { access_token: 'token' } })
  })

  it('reads a Codex auth file without auth_mode the way Codex does: the key wins', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-relay', tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).codexAuthMode).toBe('apikey')
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-relay', tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).codexAuthMode).toBe('chatgpt')
  })
})

describe('telling whether an official login already exists on this computer', () => {
  it('recognises a Claude login from the account record or the credentials file', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(inspectOfficialLogin('claude', roots)).toBe(false)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))
    expect(inspectOfficialLogin('claude', roots)).toBe(true)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    expect(inspectOfficialLogin('claude', roots)).toBe(false)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}')
    expect(inspectOfficialLogin('claude', roots)).toBe(true)
  })

  it('recognises a ChatGPT login and admits it cannot see the OS credential store', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-relay' }))
    expect(inspectOfficialLogin('codex', roots)).toBe(false)
    fs.writeFileSync(configPath, 'cli_auth_credentials_store = "auto"\n')
    expect(inspectOfficialLogin('codex', roots)).toBeNull()
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectOfficialLogin('codex', roots)).toBe(true)
  })

  it('recognises a Google login from the cached OAuth credentials', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(inspectOfficialLogin('gemini', roots)).toBe(false)
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{"refresh_token":"x"}')
    expect(inspectOfficialLogin('gemini', roots)).toBe(true)
    expect(inspectOfficialLogin('grok', roots)).toBe(false)
  })
})

describe('hooks and status line pointing at an old location', () => {
  const moved: CliHookInvocation = { ...cliHook, scriptPath: '/new/place/bundled-catalog/cli-hooks/xingmang-hook.cjs' }
  const movedStatusLine = '"/managed/node/bin/node" "/new/place/bundled-catalog/cli-status-line/xingmang-statusline.cjs"'
  const oldTargets = { nodeExecutable: cliHook.nodeExecutable, scriptPath: cliHook.scriptPath }

  function writeAll(roots: ReturnType<typeof providerRoots>): void {
    for (const provider of ['claude', 'gemini', 'codex'] as const) {
      saveProviderConfig(provider, 'sk-relay', testModels[provider], 'reset', roots, {}, providerBaseUrls, provider === 'claude' ? statusLineCommand : undefined, undefined, cliHook)
    }
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls, undefined, undefined, { ...cliHook, platform: 'linux' })
  }

  it('reads back where our hooks, status line and notify point', () => {
    const roots = providerRoots(temporaryHome())
    expect(inspectManagedCliHookTargets('claude', roots)).toEqual([])
    writeAll(roots)
    const claude = inspectManagedCliHookTargets('claude', roots)
    expect(claude).toHaveLength(6)
    expect(claude.slice(0, 5)).toEqual(Array(5).fill(oldTargets))
    expect(claude[5]).toEqual({ nodeExecutable: '/managed/node/bin/node', scriptPath: '/opt/app/resources/bundled-catalog/cli-status-line/xingmang-statusline.cjs' })
    expect(inspectManagedCliHookTargets('gemini', roots)).toEqual(Array(4).fill({ ...oldTargets, form: 'posix' }))
    expect(inspectManagedCliHookTargets('codex', roots)).toEqual([oldTargets])
    expect(inspectManagedCliHookTargets('grok', roots)).toEqual(Array(6).fill({ ...oldTargets, form: 'posix' }))
  })

  it('rewrites only our entries to the new location and keeps keys, models and user hooks', () => {
    const roots = providerRoots(temporaryHome())
    writeAll(roots)
    const [claudePath] = providerConfigPaths('claude', roots)
    const withUserHook = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as { hooks: Record<string, unknown[]> }
    const own = { hooks: [{ type: 'command', command: 'say done' }] }
    withUserHook.hooks.Stop.unshift(own)
    fs.writeFileSync(claudePath, `${JSON.stringify(withUserHook, null, 2)}\n`, 'utf8')

    const result = rewriteManagedCliHooks('claude', roots, { cliHook: moved, claudeStatusLineCommand: movedStatusLine })
    expect(result.files).toEqual([claudePath])
    expect(result.backups).toHaveLength(1)
    const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as { env: Record<string, string>, model: string, statusLine: { command: string }, hooks: Record<string, unknown[]> }
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-relay')
    expect(claude.model).toBe(testModels.claude)
    expect(claude.statusLine.command).toBe(movedStatusLine)
    expect(claude.hooks.Stop[0]).toEqual(own)
    expect(inspectManagedCliHookTargets('claude', roots).slice(0, 5)).toEqual(Array(5).fill({ nodeExecutable: moved.nodeExecutable, scriptPath: moved.scriptPath }))

    for (const provider of ['gemini', 'codex', 'grok'] as const) {
      rewriteManagedCliHooks(provider, roots, { cliHook: provider === 'grok' ? { ...moved, platform: 'linux' } : moved })
      expect(new Set(inspectManagedCliHookTargets(provider, roots).map((target) => target.scriptPath))).toEqual(new Set([moved.scriptPath]))
    }
    expect(inspectProviderConfig('codex', roots).apiKey).toBe('sk-relay')
    expect(inspectProviderConfig('gemini', roots).apiKey).toBe('sk-relay')
    expect(inspectProviderConfig('grok', roots).apiKey).toBe('sk-relay')
  })

  it('takes our entries back when this computer cannot write them any more', () => {
    const roots = providerRoots(temporaryHome())
    writeAll(roots)
    rewriteManagedCliHooks('claude', roots, {})
    const claude = JSON.parse(fs.readFileSync(providerConfigPaths('claude', roots)[0], 'utf8')) as Record<string, unknown>
    expect('hooks' in claude).toBe(false)
    expect('statusLine' in claude).toBe(false)
    expect(inspectManagedCliHookTargets('claude', roots)).toEqual([])
  })

  it('does not add hooks to a config that never had ours and leaves a user status line alone', () => {
    const roots = providerRoots(temporaryHome())
    const [claudePath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    const user = { statusLine: { type: 'command', command: '~/.claude/line.sh' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }
    fs.writeFileSync(claudePath, `${JSON.stringify(user, null, 2)}\n`, 'utf8')
    const before = fs.readFileSync(claudePath, 'utf8')
    expect(rewriteManagedCliHooks('claude', roots, { cliHook: moved, claudeStatusLineCommand: movedStatusLine })).toEqual({ backups: [], files: [] })
    expect(removeManagedCliHooks('claude', roots)).toEqual({ backups: [], files: [] })
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(before)
    for (const provider of ['gemini', 'codex', 'grok'] as const) {
      expect(removeManagedCliHooks(provider, roots)).toEqual({ backups: [], files: [] })
    }
  })

  it('adds the Grok hooks to a config saved without them only when asked, and keeps the key', () => {
    const roots = providerRoots(temporaryHome())
    const [configPath] = providerConfigPaths('grok', roots)
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    const before = fs.readFileSync(configPath, 'utf8')
    const posixHook = { ...moved, platform: 'linux' as const }

    expect(rewriteManagedCliHooks('grok', roots, { cliHook: posixHook })).toEqual({ backups: [], files: [] })
    expect(rewriteManagedCliHooks('grok', roots, { addIfMissing: true })).toEqual({ backups: [], files: [] })
    expect(rewriteManagedCliHooks('grok', roots, { cliHook: { ...moved, platform: 'win32', grokWindowsShell: 'cmd' }, addIfMissing: true }))
      .toEqual({ backups: [], files: [] })
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)

    const result = rewriteManagedCliHooks('grok', roots, { cliHook: posixHook, addIfMissing: true })
    expect(result.backups).toHaveLength(1)
    expect(inspectManagedCliHookTargets('grok', roots)).toHaveLength(6)
    expect(inspectProviderConfig('grok', roots).apiKey).toBe('sk-relay')

    const powerShell = { ...moved, platform: 'win32' as const, grokWindowsShell: 'powershell' as const }
    rewriteManagedCliHooks('grok', roots, { cliHook: powerShell, addIfMissing: true })
    const rewritten = TOML.parse(fs.readFileSync(configPath, 'utf8')) as unknown as GrokConfigShape
    expect(rewritten.hooks.Stop).toHaveLength(1)
    expect(rewritten.hooks.Stop[0].hooks[0].command.startsWith('& ')).toBe(true)
  })

  it('removes our hooks, status line and notify on uninstall but keeps the keys and user settings', () => {
    const roots = providerRoots(temporaryHome())
    writeAll(roots)
    for (const provider of ['claude', 'gemini', 'codex', 'grok'] as const) removeManagedCliHooks(provider, roots)
    for (const provider of ['claude', 'gemini', 'codex', 'grok'] as const) {
      expect(inspectManagedCliHookTargets(provider, roots)).toEqual([])
      expect(inspectProviderConfig(provider, roots).apiKey).toBe('sk-relay')
    }
    const grok = TOML.parse(fs.readFileSync(providerConfigPaths('grok', roots)[0], 'utf8')) as unknown as GrokConfigShape
    expect(grok.compat).toEqual({ claude: { hooks: false } })
  })

  it('tells our hooks and our Claude Code status line apart', () => {
    const roots = providerRoots(temporaryHome())
    for (const provider of ['claude', 'gemini', 'codex', 'grok'] as const) expect(inspectManagedCliHookParts(provider, roots)).toEqual([])
    writeAll(roots)
    expect(inspectManagedCliHookParts('claude', roots)).toEqual(['hooks', 'statusLine'])
    for (const provider of ['gemini', 'codex', 'grok'] as const) expect(inspectManagedCliHookParts(provider, roots)).toEqual(['hooks'])
    rewriteManagedCliHooks('claude', roots, { cliHook: moved })
    expect(inspectManagedCliHookParts('claude', roots)).toEqual(['hooks'])
  })

  it('puts back what the uninstaller took, at the new location, and keeps keys and models', () => {
    const roots = providerRoots(temporaryHome())
    writeAll(roots)
    for (const provider of ['claude', 'gemini', 'codex', 'grok'] as const) removeManagedCliHooks(provider, roots)
    const restore = { parts: ['hooks', 'statusLine'] as const, cliHook: moved, claudeStatusLineCommand: movedStatusLine }

    const result = restoreManagedCliHooks('claude', roots, restore)
    expect(result.backups).toHaveLength(1)
    const claude = JSON.parse(fs.readFileSync(providerConfigPaths('claude', roots)[0], 'utf8')) as { env: Record<string, string>, model: string, statusLine: { command: string } }
    expect(claude.statusLine.command).toBe(movedStatusLine)
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-relay')
    expect(claude.model).toBe(testModels.claude)
    expect(inspectManagedCliHookTargets('claude', roots).slice(0, 5)).toEqual(Array(5).fill({ nodeExecutable: moved.nodeExecutable, scriptPath: moved.scriptPath }))

    restoreManagedCliHooks('codex', roots, { parts: ['hooks'], cliHook: moved })
    expect(inspectManagedCliHookTargets('codex', roots)).toEqual([{ nodeExecutable: moved.nodeExecutable, scriptPath: moved.scriptPath }])
    restoreManagedCliHooks('grok', roots, { parts: ['hooks'], cliHook: { ...moved, platform: 'linux' } })
    expect(inspectManagedCliHookTargets('grok', roots)).toHaveLength(6)
    for (const provider of ['claude', 'codex', 'grok'] as const) expect(inspectProviderConfig(provider, roots).apiKey).toBe('sk-relay')

    // Gemini CLI is retired: nothing is put back there.
    expect(restoreManagedCliHooks('gemini', roots, { parts: ['hooks'], cliHook: moved })).toEqual({ backups: [], files: [] })
    expect(inspectManagedCliHookParts('gemini', roots)).toEqual([])
  })

  it('puts back only the parts it is told to and never pushes out the customer\'s own status line or notify', () => {
    const roots = providerRoots(temporaryHome())
    writeAll(roots)
    for (const provider of ['claude', 'codex'] as const) removeManagedCliHooks(provider, roots)

    restoreManagedCliHooks('claude', roots, { parts: ['hooks'], cliHook: moved, claudeStatusLineCommand: movedStatusLine })
    expect(inspectManagedCliHookParts('claude', roots)).toEqual(['hooks'])

    const [claudePath] = providerConfigPaths('claude', roots)
    const settings = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as Record<string, unknown>
    settings.statusLine = { type: 'command', command: '~/.claude/line.sh' }
    fs.writeFileSync(claudePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    const claudeBefore = fs.readFileSync(claudePath, 'utf8')
    expect(restoreManagedCliHooks('claude', roots, { parts: ['hooks', 'statusLine'], cliHook: moved, claudeStatusLineCommand: movedStatusLine }))
      .toEqual({ backups: [], files: [] })
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(claudeBefore)

    const [codexPath] = providerConfigPaths('codex', roots)
    fs.writeFileSync(codexPath, `notify = ["say", "done"]\n${fs.readFileSync(codexPath, 'utf8')}`, 'utf8')
    const codexBefore = fs.readFileSync(codexPath, 'utf8')
    expect(restoreManagedCliHooks('codex', roots, { parts: ['hooks'], cliHook: moved })).toEqual({ backups: [], files: [] })
    expect(fs.readFileSync(codexPath, 'utf8')).toBe(codexBefore)
  })

  it('leaves entries that are already there alone, even ones pointing at an old location', () => {
    const roots = providerRoots(temporaryHome())
    writeAll(roots)
    const [claudePath] = providerConfigPaths('claude', roots)
    const before = fs.readFileSync(claudePath, 'utf8')
    expect(restoreManagedCliHooks('claude', roots, { parts: ['hooks', 'statusLine'], cliHook: moved, claudeStatusLineCommand: movedStatusLine }))
      .toEqual({ backups: [], files: [] })
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(before)
    for (const provider of ['codex', 'grok'] as const) {
      expect(restoreManagedCliHooks(provider, roots, { parts: ['hooks'], cliHook: { ...moved, platform: 'linux' } })).toEqual({ backups: [], files: [] })
    }
  })

  it('writes nothing when this computer cannot write the hooks, or the config is gone', () => {
    const roots = providerRoots(temporaryHome())
    expect(restoreManagedCliHooks('claude', roots, { parts: ['hooks', 'statusLine'], cliHook: moved, claudeStatusLineCommand: movedStatusLine }))
      .toEqual({ backups: [], files: [] })
    writeAll(roots)
    for (const provider of ['claude', 'codex', 'grok'] as const) removeManagedCliHooks(provider, roots)
    const read = () => (['claude', 'codex', 'grok'] as const).map((provider) => fs.readFileSync(providerConfigPaths(provider, roots)[0], 'utf8'))
    const files = read()
    expect(restoreManagedCliHooks('claude', roots, { parts: ['hooks', 'statusLine'] })).toEqual({ backups: [], files: [] })
    expect(restoreManagedCliHooks('codex', roots, { parts: ['hooks'] })).toEqual({ backups: [], files: [] })
    expect(restoreManagedCliHooks('grok', roots, { parts: ['hooks'], cliHook: { ...moved, platform: 'win32', grokWindowsShell: 'cmd' } }))
      .toEqual({ backups: [], files: [] })
    expect(read()).toEqual(files)
  })
})

describe('taking back what Xingmang wrote into the retired Gemini CLI', () => {
  const ourImageServer = {
    command: '/managed/node/bin/node',
    args: ['/home/me/.agents/skills/星芒AI/scripts/mcp-server.mjs'],
    env: { XINGMANG_IMAGE_CONFIG_PATH: '/home/me/.agents/skills/星芒AI/config.json' },
    trust: true,
  }
  const userServer = { command: 'npx', args: ['-y', 'user-mcp'] }
  const userHook = { matcher: '*', hooks: [{ type: 'command', command: 'say done', name: 'user-notify' }] }

  function writeGemini(roots: ReturnType<typeof providerRoots>, servers: Record<string, unknown>): string {
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown[]>, mcpServers?: unknown }
    settings.hooks.AfterAgent.unshift(userHook)
    settings.mcpServers = servers
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    return settingsPath
  }

  it('removes only our hooks and image tool and keeps the key, address, model and what the user added', () => {
    const roots = providerRoots(temporaryHome())
    const settingsPath = writeGemini(roots, { 'xingmang-image': ourImageServer, 'user-server': userServer })
    const before = inspectProviderConfig('gemini', roots)
    expect(inspectRetiredGeminiIntegrations(roots)).toEqual({ hooks: true, imageMcp: true })

    const removed = removeRetiredGeminiIntegrations(roots)
    expect(removed).toMatchObject({ hooks: true, imageMcp: true, result: { files: [settingsPath] } })
    expect(removed.result.backups).toHaveLength(1)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown[]>, mcpServers: Record<string, unknown> }
    expect(settings.mcpServers).toEqual({ 'user-server': userServer })
    expect(settings.hooks).toEqual({ AfterAgent: [userHook] })
    expect(inspectManagedCliHookTargets('gemini', roots)).toEqual([])
    const after = inspectProviderConfig('gemini', roots)
    expect(after.apiKey).toBe('sk-relay')
    expect(after.baseUrl).toBe(before.baseUrl)
    expect(after.model).toBe(before.model)
    expect(after.matchesRelay).toBe(true)

    // Every startup asks again; once there is nothing left nothing is written.
    const text = fs.readFileSync(settingsPath, 'utf8')
    expect(inspectRetiredGeminiIntegrations(roots)).toEqual({ hooks: false, imageMcp: false })
    expect(removeRetiredGeminiIntegrations(roots)).toEqual({ hooks: false, imageMcp: false, result: { backups: [], files: [] } })
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(text)
  })

  it('drops an emptied mcpServers section and leaves a same-name server the user set up alone', () => {
    const roots = providerRoots(temporaryHome())
    const settingsPath = writeGemini(roots, { 'xingmang-image': ourImageServer })
    removeRetiredGeminiIntegrations(roots)
    expect('mcpServers' in (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)).toBe(false)

    const other = providerRoots(temporaryHome())
    const userImage = { command: 'node', args: ['/home/me/my-image-server.mjs'] }
    const otherPath = writeGemini(other, { 'xingmang-image': userImage })
    expect(inspectRetiredGeminiIntegrations(other)).toEqual({ hooks: true, imageMcp: false })
    expect(removeRetiredGeminiIntegrations(other)).toMatchObject({ hooks: true, imageMcp: false })
    expect((JSON.parse(fs.readFileSync(otherPath, 'utf8')) as { mcpServers: unknown }).mcpServers).toEqual({ 'xingmang-image': userImage })
  })

  it('creates nothing when Gemini CLI was never set up', () => {
    const roots = providerRoots(temporaryHome())
    expect(inspectRetiredGeminiIntegrations(roots)).toEqual({ hooks: false, imageMcp: false })
    expect(removeRetiredGeminiIntegrations(roots)).toEqual({ hooks: false, imageMcp: false, result: { backups: [], files: [] } })
    expect(fs.existsSync(path.join(roots.userHome, '.gemini'))).toBe(false)
  })

  it('leaves a settings.json it cannot read untouched', () => {
    const roots = providerRoots(temporaryHome())
    const [settingsPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ "hooks": ', 'utf8')
    expect(() => inspectRetiredGeminiIntegrations(roots)).toThrow()
    expect(() => removeRetiredGeminiIntegrations(roots)).toThrow()
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ "hooks": ')
    expect(fs.readdirSync(path.dirname(settingsPath))).toEqual(['settings.json'])
  })
})
