import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ancestorDirectories,
  claudeManagedSettingsDirectory,
  claudeSettingsOverrideKeys,
  codexProjectOverrideKeys,
  describeOverride,
  displayOverrideFile,
  geminiSettingsOverrideKeys,
  inspectWorkspaceConfigOverrides,
  launchOverrideNotice,
  summarizeWorkspaceOverrides,
  type CurrentProviderAccount,
  type WorkspaceConfigOverride,
  type WorkspaceOverrideContext,
} from './workspace-config-overrides'

const relayAccount: CurrentProviderAccount = {
  baseUrl: 'https://relay.example',
  apiKey: 'sk-current',
  authType: 'gemini-api-key',
  codexAuthMode: 'apikey',
}

describe('claudeSettingsOverrideKeys', () => {
  it('flags an endpoint or token that differs from the current account as blocking', () => {
    const text = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example', ANTHROPIC_AUTH_TOKEN: 'sk-other' } })
    expect(claudeSettingsOverrideKeys(text, relayAccount)).toEqual([
      { key: 'ANTHROPIC_BASE_URL', severity: 'blocking' },
      { key: 'ANTHROPIC_AUTH_TOKEN', severity: 'blocking' },
    ])
  })

  it('ignores a copy of the current account, including a trailing slash or different case', () => {
    const text = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'HTTPS://relay.example/', ANTHROPIC_AUTH_TOKEN: 'sk-current' } })
    expect(claudeSettingsOverrideKeys(text, relayAccount)).toEqual([])
  })

  it('treats an extra api key or key helper as possible, since both only add a header', () => {
    const text = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-extra' }, apiKeyHelper: 'echo key' })
    expect(claudeSettingsOverrideKeys(text, relayAccount)).toEqual([
      { key: 'ANTHROPIC_API_KEY', severity: 'possible' },
      { key: 'apiKeyHelper', severity: 'possible' },
    ])
  })

  it('flags cloud platform switches only when they are turned on', () => {
    expect(claudeSettingsOverrideKeys(JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), relayAccount))
      .toEqual([{ key: 'CLAUDE_CODE_USE_BEDROCK', severity: 'blocking' }])
    expect(claudeSettingsOverrideKeys(JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: 'false', CLAUDE_CODE_USE_BEDROCK: '0' } }), relayAccount))
      .toEqual([])
  })

  it('reports nothing for unrelated settings or broken JSON', () => {
    expect(claudeSettingsOverrideKeys(JSON.stringify({ permissions: { allow: ['Bash'] }, model: 'opus' }), relayAccount)).toEqual([])
    expect(claudeSettingsOverrideKeys('{ not json', relayAccount)).toEqual([])
    expect(claudeSettingsOverrideKeys('\uFEFF{"env":{"ANTHROPIC_BASE_URL":"https://other.example"}}', relayAccount))
      .toEqual([{ key: 'ANTHROPIC_BASE_URL', severity: 'blocking' }])
  })
})

describe('codexProjectOverrideKeys', () => {
  it('flags the two keys that make Codex drop an api-key login', () => {
    const text = 'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "keyring"\n'
    expect(codexProjectOverrideKeys(text, relayAccount)).toEqual([
      { key: 'forced_login_method', severity: 'blocking' },
      { key: 'cli_auth_credentials_store', severity: 'blocking' },
    ])
  })

  it('ignores endpoint keys that Codex itself refuses in project config', () => {
    const text = 'model_provider = "other"\nopenai_base_url = "https://other.example"\n[model_providers.other]\nbase_url = "https://other.example"\n'
    expect(codexProjectOverrideKeys(text, relayAccount)).toEqual([])
  })

  it('stays quiet for a ChatGPT login, where requiring ChatGPT is exactly right', () => {
    const text = 'forced_login_method = "chatgpt"\n'
    expect(codexProjectOverrideKeys(text, { ...relayAccount, codexAuthMode: 'chatgpt' })).toEqual([])
    expect(codexProjectOverrideKeys(text, { ...relayAccount, apiKey: '' })).toEqual([])
    expect(codexProjectOverrideKeys('forced_login_method = "api"\n', relayAccount)).toEqual([])
  })

  it('reports nothing for broken TOML', () => {
    expect(codexProjectOverrideKeys('forced_login_method = ', relayAccount)).toEqual([])
  })
})

describe('geminiSettingsOverrideKeys', () => {
  it('flags a project that switches Gemini to another login method', () => {
    expect(geminiSettingsOverrideKeys(JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }), relayAccount))
      .toEqual([{ key: 'security.auth.selectedType', severity: 'blocking' }])
    expect(geminiSettingsOverrideKeys(JSON.stringify({ selectedAuthType: 'vertex-ai' }), relayAccount))
      .toEqual([{ key: 'selectedAuthType', severity: 'blocking' }])
  })

  it('ignores the same login method and unrelated settings', () => {
    expect(geminiSettingsOverrideKeys(JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }), relayAccount)).toEqual([])
    expect(geminiSettingsOverrideKeys(JSON.stringify({ ui: { theme: 'dark' } }), relayAccount)).toEqual([])
  })
})

describe('path helpers', () => {
  it('knows where Claude Code looks for managed settings on each platform', () => {
    expect(claudeManagedSettingsDirectory('win32')).toBe('C:\\Program Files\\ClaudeCode')
    expect(claudeManagedSettingsDirectory('darwin')).toBe('/Library/Application Support/ClaudeCode')
    expect(claudeManagedSettingsDirectory('linux')).toBe('/etc/claude-code')
  })

  it('walks from a directory up to the drive root', () => {
    expect(ancestorDirectories('C:\\work\\app', 'win32')).toEqual(['C:\\work\\app', 'C:\\work', 'C:\\'])
    expect(ancestorDirectories('/Users/alex/app', 'darwin')).toEqual(['/Users/alex/app', '/Users/alex', '/Users', '/'])
  })

  it('shows project files relative to the folder and hides the home directory', () => {
    expect(displayOverrideFile('C:\\work\\app\\.claude\\settings.local.json', 'C:\\work\\app', 'C:\\Users\\peaker', 'win32'))
      .toBe('.claude/settings.local.json')
    expect(displayOverrideFile('/Users/alex/.env', '/Users/alex/work/app', '/Users/alex', 'darwin')).toBe('~/.env')
    expect(displayOverrideFile('C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\work\\app', 'C:\\Users\\peaker', 'win32'))
      .toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json')
  })
})

describe('inspectWorkspaceConfigOverrides', () => {
  let root: string
  let home: string
  let workspace: string
  let managed: string
  let context: WorkspaceOverrideContext

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-overrides-')))
    home = path.join(root, 'home')
    workspace = path.join(home, 'work', 'app')
    managed = path.join(root, 'managed')
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', '.env'), 'GEMINI_API_KEY=sk-current\n')
    context = {
      platform: process.platform,
      home,
      codexHome: path.join(home, '.codex'),
      current: relayAccount,
      claudeManagedDirectory: managed,
    }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  it('finds nothing in a clean project folder', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) {
      expect(inspectWorkspaceConfigOverrides(provider, workspace, context)).toEqual([])
    }
  })

  it('reports Claude project settings with key names only, never values', () => {
    write(path.join(workspace, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example' } }))
    write(path.join(workspace, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-secret' }))
    const found = inspectWorkspaceConfigOverrides('claude', workspace, context)
    expect(found).toEqual([
      { provider: 'claude', scope: 'project', file: path.join(workspace, '.claude', 'settings.json'), keys: ['apiKeyHelper'], severity: 'possible' },
      { provider: 'claude', scope: 'project', file: path.join(workspace, '.claude', 'settings.local.json'), keys: ['ANTHROPIC_BASE_URL'], severity: 'blocking' },
    ])
    expect(JSON.stringify(found)).not.toContain('other.example')
    expect(JSON.stringify(found)).not.toContain('sk-secret')
  })

  it('does not look for Claude project settings in parent folders', () => {
    write(path.join(home, 'work', '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example' } }))
    expect(inspectWorkspaceConfigOverrides('claude', workspace, context)).toEqual([])
  })

  it('treats the home folder settings.json as the user file this app writes', () => {
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example' } }))
    expect(inspectWorkspaceConfigOverrides('claude', home, context)).toEqual([])
  })

  it('reports managed settings and drop-ins for Claude', () => {
    write(path.join(managed, 'managed-settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-company' } }))
    write(path.join(managed, 'managed-settings.d', '10-proxy.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example' } }))
    write(path.join(managed, 'managed-settings.d', 'readme.txt'), 'not settings')
    expect(inspectWorkspaceConfigOverrides('claude', workspace, context).map((entry) => [entry.scope, path.basename(entry.file), entry.keys]))
      .toEqual([
        ['managed', 'managed-settings.json', ['ANTHROPIC_AUTH_TOKEN']],
        ['managed', '10-proxy.json', ['ANTHROPIC_BASE_URL']],
      ])
  })

  it.runIf(process.platform !== 'win32')('reports a symlinked settings file as unreadable instead of following it', () => {
    const target = path.join(root, 'elsewhere.json')
    write(target, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.example' } }))
    fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true })
    fs.symlinkSync(target, path.join(workspace, '.claude', 'settings.local.json'))
    expect(inspectWorkspaceConfigOverrides('claude', workspace, context)).toEqual([
      { provider: 'claude', scope: 'project', file: path.join(workspace, '.claude', 'settings.local.json'), keys: [], severity: 'possible', unreadable: true },
    ])
  })

  it('reads Codex project config up to the git root, and only the workspace without git', () => {
    write(path.join(home, 'work', '.codex', 'config.toml'), 'forced_login_method = "chatgpt"\n')
    expect(inspectWorkspaceConfigOverrides('codex', workspace, context)).toEqual([])
    fs.mkdirSync(path.join(home, 'work', '.git'))
    expect(inspectWorkspaceConfigOverrides('codex', workspace, context)).toEqual([
      { provider: 'codex', scope: 'project', file: path.join(home, 'work', '.codex', 'config.toml'), keys: ['forced_login_method'], severity: 'blocking' },
    ])
  })

  it('never reports the Codex user config as a project file', () => {
    write(path.join(home, '.codex', 'config.toml'), 'forced_login_method = "chatgpt"\n')
    fs.mkdirSync(path.join(home, '.git'))
    expect(inspectWorkspaceConfigOverrides('codex', workspace, context)).toEqual([])
  })

  it('reports the first Gemini .env above the workspace as affecting only a self-opened terminal', () => {
    write(path.join(home, 'work', '.env'), 'OTHER=1\n')
    expect(inspectWorkspaceConfigOverrides('gemini', workspace, context)).toEqual([
      { provider: 'gemini', scope: 'project', file: path.join(home, 'work', '.env'), keys: [], severity: 'blocking', launchUnaffected: true },
    ])
    write(path.join(workspace, '.gemini', '.env'), 'GEMINI_API_KEY=sk-project\n')
    expect(inspectWorkspaceConfigOverrides('gemini', workspace, context).map((entry) => entry.file))
      .toEqual([path.join(workspace, '.gemini', '.env')])
  })

  it('stops at the user Gemini .env this app writes', () => {
    write(path.join(root, '.env'), 'OTHER=1\n')
    expect(inspectWorkspaceConfigOverrides('gemini', workspace, context)).toEqual([])
  })

  it('reports a Gemini project login switch that survives the injected environment', () => {
    write(path.join(workspace, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'vertex-ai' } } }))
    expect(inspectWorkspaceConfigOverrides('gemini', workspace, context)).toEqual([
      { provider: 'gemini', scope: 'project', file: path.join(workspace, '.gemini', 'settings.json'), keys: ['security.auth.selectedType'], severity: 'blocking' },
    ])
  })

  it('never inspects Grok, whose project config cannot change the endpoint or key', () => {
    write(path.join(workspace, '.grok', 'config.toml'), '[models]\ndefault = "x"\n')
    write(path.join(workspace, '.env'), 'XAI_API_KEY=x\n')
    expect(inspectWorkspaceConfigOverrides('grok', workspace, context)).toEqual([])
  })

  it('ignores a relative or empty workspace', () => {
    expect(inspectWorkspaceConfigOverrides('claude', 'app', context)).toEqual([])
    expect(inspectWorkspaceConfigOverrides('claude', '', context)).toEqual([])
  })
})

const projectBlocking: WorkspaceConfigOverride = {
  provider: 'claude',
  scope: 'project',
  file: 'C:\\work\\app\\.claude\\settings.local.json',
  keys: ['ANTHROPIC_BASE_URL'],
  severity: 'blocking',
}
const managedPossible: WorkspaceConfigOverride = {
  provider: 'claude',
  scope: 'managed',
  file: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
  keys: ['apiKeyHelper'],
  severity: 'possible',
}
const geminiEnv: WorkspaceConfigOverride = {
  provider: 'gemini',
  scope: 'project',
  file: 'C:\\work\\.env',
  keys: [],
  severity: 'blocking',
  launchUnaffected: true,
}

describe('launchOverrideNotice', () => {
  it('says nothing when nothing affects this launch', () => {
    expect(launchOverrideNotice('Gemini CLI', [])).toBeNull()
    expect(launchOverrideNotice('Gemini CLI', [geminiEnv])).toBeNull()
  })

  it('explains a project override in plain words without file names', () => {
    const notice = launchOverrideNotice('Claude Code', [projectBlocking])
    expect(notice).toBe('这个项目文件夹里有自己的设置，会让 Claude Code 不用当前账号，余额和用量会对不上。不是你有意这样设的话，换一个文件夹打开就好。')
    expect(notice).not.toMatch(/settings|\.env|json|ANTHROPIC/i)
  })

  it('points managed settings at the administrator and softens a possible override', () => {
    expect(launchOverrideNotice('Claude Code', [managedPossible, projectBlocking]))
      .toBe('这台电脑上有统一下发的设置（一般是公司的电脑管理员配的），可能会让 Claude Code 不用当前账号，本软件改不了它，需要找管理员处理。')
    expect(launchOverrideNotice('Claude Code', [{ ...projectBlocking, severity: 'possible' }]))
      .toContain('可能会让 Claude Code 不用当前账号')
  })
})

describe('summarizeWorkspaceOverrides', () => {
  const options = {
    toolName: (provider: string) => ({ claude: 'Claude Code', gemini: 'Gemini CLI' } as Record<string, string>)[provider] ?? provider,
    describe: (override: WorkspaceConfigOverride) => describeOverride(override, 'C:\\work\\app', 'C:\\Users\\peaker', 'win32'),
    workspaceChecked: true,
  }

  it('passes when nothing overrides the account', () => {
    expect(summarizeWorkspaceOverrides([], options)).toEqual({
      state: 'pass',
      summary: '项目文件夹里没有会盖过当前账号的设置',
      details: { count: 0 },
    })
    expect(summarizeWorkspaceOverrides([], { ...options, workspaceChecked: false }).summary).toContain('还没从本软件打开过项目文件夹')
  })

  it('fails when a launch from this app would not use the current account', () => {
    const result = summarizeWorkspaceOverrides([projectBlocking], options)
    expect(result.state).toBe('fail')
    expect(result.summary).toContain('会让 Claude Code 不用当前账号')
    expect(result.details).toEqual({ count: 1, file1: 'Claude Code · .claude/settings.local.json：ANTHROPIC_BASE_URL' })
  })

  it('only warns for possible overrides and for settings a self-opened terminal would pick up', () => {
    const result = summarizeWorkspaceOverrides([managedPossible, geminiEnv], options)
    expect(result.state).toBe('warn')
    expect(result.summary).toBe('这台电脑上有统一下发的设置，可能会让 Claude Code 不用当前账号，需要找电脑管理员处理；'
      + '在最近打开的项目文件夹里自己开终端运行 Gemini CLI 时不会用当前账号，从本软件打开不受影响')
    expect(result.details.file2).toBe('Gemini CLI · C:\\work\\.env')
  })

  it('marks unreadable files so support knows they were not checked', () => {
    const unreadable = { ...projectBlocking, keys: [], severity: 'possible' as const, unreadable: true }
    expect(summarizeWorkspaceOverrides([unreadable], options).details.file1)
      .toBe('Claude Code · .claude/settings.local.json（读不了，没法确认）')
  })
})
