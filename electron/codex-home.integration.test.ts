import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfigBackupStore } from './backups'
import { CodexExtensionService } from './codex-extensions'
import { resolveCodexHomeContext } from './codex-home'
import { CodexSessionsService } from './codex-sessions'
import { inspectProviderConfig } from './config-files'
import { createDiagnosticsExport, runDiagnostics } from './diagnostics'
import { rootedMainServiceOptions } from './main-service-options'
import { ProviderExtensionService } from './provider-extensions'

const cleanup: string[] = []

/** Encode a path the way it appears inside a JSON document. */
function jsonFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function createCodexSessionDatabase(
  databasePath: string,
  values: { id: string; rolloutPath: string },
): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  fs.mkdirSync(path.dirname(values.rolloutPath), { recursive: true })
  fs.writeFileSync(values.rolloutPath, `${JSON.stringify({
    type: 'session_meta', payload: { id: values.id, cwd: '/workspace' },
  })}\n`, 'utf8')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        updated_at_ms INTEGER
      )
    `)
    database.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, title, cwd, model_provider,
        model, tokens_used, archived, archived_at, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values.id, values.rolloutPath, 1_721_779_900, 1_721_780_000,
      'Custom session', '/workspace', 'openai', 'gpt-5.6-sol', 10, 0, null,
      1_721_780_000_000,
    )
  } finally {
    database.close()
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('routes every Codex-owned surface to one custom root and leaves all sentinels in place', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-home-integration-'))
  cleanup.push(root)
  const userHome = path.join(root, 'home')
  const codexHome = path.join(root, 'custom-codex')
  const workspace = path.join(root, 'workspace')
  const userData = path.join(root, 'manager-data')
  fs.mkdirSync(userHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })

  const sentinels = [
    path.join(userHome, '.claude', 'sentinel'),
    path.join(userHome, '.gemini', 'sentinel'),
    path.join(userHome, '.grok', 'sentinel'),
    path.join(userHome, '.agents', 'sentinel'),
    path.join(workspace, '.codex', 'sentinel'),
    path.join(workspace, '.agents', 'sentinel'),
  ]
  for (const sentinel of sentinels) {
    fs.mkdirSync(path.dirname(sentinel), { recursive: true })
    fs.writeFileSync(sentinel, 'do-not-move', 'utf8')
  }
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "OpenAI"',
    'model = "gpt-5.6-sol"',
    '[model_providers.OpenAI]',
    'name = "OpenAI"',
    'base_url = "https://xm.solov.cc"',
    '[mcp_servers.custom]',
    'command = "node"',
    '[plugins."sample@curated"]',
    'enabled = true',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-integration"}\n', 'utf8')
  fs.mkdirSync(path.join(codexHome, 'skills', 'custom-skill'), { recursive: true })
  fs.writeFileSync(
    path.join(codexHome, 'skills', 'custom-skill', 'SKILL.md'),
    '---\nname: Custom Skill\n---\n',
    'utf8',
  )
  fs.writeFileSync(path.join(codexHome, '.env'), 'OPENAI_API_KEY=sk-integration\n', 'utf8')
  createCodexSessionDatabase(path.join(codexHome, 'state_5.sqlite'), {
    id: 'custom-session',
    rolloutPath: path.join(codexHome, 'sessions', 'custom.jsonl'),
  })

  const context = resolveCodexHomeContext({
    isPackaged: false,
    userHome,
    env: { HOME: userHome, CODEX_HOME: codexHome },
  })
  const options = rootedMainServiceOptions(context)
  const config = inspectProviderConfig('codex', options.system.providerRoots)
  const sessions = new CodexSessionsService({
    ...options.sessions,
    managerDataDirectory: path.join(userData, 'sessions'),
  })
  const extensions = new CodexExtensionService({
    ...options.codexExtensions,
    repositoryRoot: workspace,
    invoke: async (argv) => {
      if (argv[0] === 'mcp') {
        return JSON.stringify([{
          name: 'custom',
          enabled: true,
          disabled_reason: null,
          transport: {
            type: 'stdio', command: 'node', args: [], env: {}, env_vars: [], cwd: null,
          },
          startup_timeout_sec: 30,
          tool_timeout_sec: null,
          auth_status: 'unsupported',
        }])
      }
      if (argv[0] === 'plugin' && argv[1] === 'list') {
        return JSON.stringify({
          installed: [{
            pluginId: 'sample@curated',
            name: 'sample',
            marketplaceName: 'curated',
            version: '1.0.0',
            installed: true,
            enabled: true,
            source: { source: 'local', path: path.join(codexHome, 'plugins', 'sample') },
            installPolicy: 'AVAILABLE',
            authPolicy: 'ON_USE',
          }],
          available: [],
        })
      }
      return '{"marketplaces":[]}'
    },
  })
  const providerExtensions = new ProviderExtensionService({
    ...options.providerExtensions,
    repositoryRoot: workspace,
    invoke: async () => '[]',
    inspectSource: async (input) => ({
      currentVersion: input.currentVersion,
      latestVersion: input.currentVersion,
    }),
  })
  const backups = new ConfigBackupStore({ userDataDirectory: userData, ...options.backups })
  const diagnostics = await runDiagnostics({
    app: { name: 'integration', version: '1.0.0', packaged: false },
    ...options.diagnostics,
    platform: 'darwin',
    arch: 'arm64',
    release: '23.0.0',
    inspectTool: async () => ({ installed: false, version: null, path: null }),
    inspectPowerShell: async () => ({ installed: false, version: null, path: null }),
    inspectAdministrator: async () => false,
    inspectCodexDesktop: async () => ({ installed: false, version: null, path: null }),
    inspectProvider: (provider, roots) => inspectProviderConfig(provider, roots),
    clashConfigPaths: [],
    inspectProxyVariables: async () => [],
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
  })

  expect(config.hasApiKey).toBe(true)
  expect(sessions.list().items.map((item) => item.id)).toContain('custom-session')
  expect(extensions.listSkills().map((item) => item.name)).toContain('Custom Skill')
  expect((await extensions.listMcpServers()).map((item) => item.name)).toContain('custom')
  expect((await extensions.listPlugins()).plugins.map((item) => item.pluginId)).toContain('sample@curated')
  const providerExtensionsSnapshot = await providerExtensions.list('codex')
  expect(providerExtensionsSnapshot.provider).toBe('codex')
  expect(providerExtensionsSnapshot.items).toContainEqual(expect.objectContaining({
    kind: 'skill', name: 'Custom Skill',
  }))
  const backup = backups.create('codex')
  expect(backup).toMatchObject({ valid: true, existingFileCount: 2 })
  expect(diagnostics.items.find((item) => item.code === 'CODEX_DOTENV')?.state).toBe('warn')
  diagnostics.items[0].details = { customCodexPath: path.join(codexHome, 'logs', 'probe.txt') }
  const diagnosticsExport = createDiagnosticsExport(diagnostics, options.diagnosticExport)
  // The export is JSON, so Windows separators appear escaped. Compare against the
  // encoded fragment; on POSIX this is the plain path.
  expect(diagnosticsExport).toContain(jsonFragment(path.join('[CODEX_HOME]', 'logs', 'probe.txt')))
  expect(diagnosticsExport).not.toContain(jsonFragment(codexHome))
  expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
  for (const sentinel of sentinels) {
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do-not-move')
  }
})
