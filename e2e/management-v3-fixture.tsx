import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import { NavigationStateProvider } from '../src/components/shell/NavigationState'
import { SessionsPage, type SessionsPageApi } from '../src/pages/SessionsPage'
import { BackupsPage, type BackupPreview, type BackupsPageApi } from '../src/pages/BackupsPage'
import { McpPage, type McpServerView } from '../src/pages/McpPage'
import { SkillsPage, type SkillView } from '../src/pages/SkillsPage'
import { PluginsPage, type PluginView } from '../src/pages/PluginsPage'
import type { ExtensionMutation, ExtensionSnapshot, MultiProviderSessionSummary, MultiProviderSessionPage, ProviderId, XingmangApi } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') ?? 'dark'
const providers: ProviderId[] = ['codex', 'claude', 'gemini', 'grok']
declare global { interface Window { managementHarness: { actions: string[]; detailCalls: number; restoreCalls: number; mutations: ExtensionMutation[] } } }
window.managementHarness = { actions: [], detailCalls: 0, restoreCalls: 0, mutations: [] }
const record = (action: string) => { window.managementHarness.actions.push(action) }
const extensionStates = new Map<string, boolean>()
const snapshot = (provider: ProviderId): ExtensionSnapshot => ({
  provider, checkedAt: '2026-09-07T00:00:00Z', warnings: [],
  capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: provider !== 'claude', reason: provider === 'claude' ? '该工具不提供插件市场' : null } },
  items: (['mcp', 'skill', 'plugin'] as const).map((kind) => ({
    provider, kind, id: `${provider}-${kind}`, name: `${provider}-${kind}`, description: `${provider} ${kind} 本地条目`, installed: true,
    enabled: extensionStates.get(`${provider}-${kind}`) ?? true, scope: provider === 'gemini' ? 'workspace' : 'user', currentVersion: '1.0.0', latestVersion: '1.1.0',
    source: { kind: 'local', locator: `C:\\fixture\\${provider}\\${kind}`, reference: null },
    update: { state: 'update-available', reason: '存在更新', checkedAt: '2026-09-07T00:00:00Z' },
    operations: { install: provider !== 'claude', uninstall: provider !== 'claude', enable: provider !== 'claude', disable: provider !== 'claude', update: provider !== 'claude' },
  })),
})
window.xingmang = {
  async listProviderExtensions(provider: ProviderId) { record(`list:${provider}`); return snapshot(provider) },
  async mutateProviderExtension(input: ExtensionMutation) { window.managementHarness.mutations.push(input); if (input.id) extensionStates.set(input.id, input.action !== 'disable'); return snapshot(input.provider) },
} as unknown as XingmangApi

const sessions: MultiProviderSessionSummary[] = providers.map((provider) => ({
  id: `${provider}-session`, provider, nativeId: `${provider}-native`, title: `${provider} project conversation`, cwd: 'C:\\Projects\\long-project-name', model: 'gpt-5.4',
  archived: false, readonly: provider !== 'codex', createdAt: 1_777_000_000_000, updatedAt: 1_777_000_000_000, messageCount: 2, sourcePath: 'fixture.jsonl', detailAvailable: true,
}))
const capabilities = Object.fromEntries(providers.map((provider) => [provider, {
  provider, available: true, readable: true, readonly: provider !== 'codex', source: 'jsonl', reason: provider === 'codex' ? '' : '该来源仅支持读取和导出',
  operations: { list: true, detail: true, exportMarkdown: true, archive: provider === 'codex', restore: provider === 'codex' },
}])) as MultiProviderSessionPage['capabilities']
const sessionsApi: SessionsPageApi = {
  async listProviderSessions(query) {
    record(`sessions:${query.provider}:${query.search ?? ''}:${query.page}`)
    const items = sessions.filter((session) => (query.provider === 'all' || session.provider === query.provider) && (!query.search || session.title.includes(query.search)))
    return { items, total: items.length, page: query.page ?? 1, pageSize: 15, pages: 1, capabilities, stats: { total: 4, byProvider: { codex: 1, claude: 1, gemini: 1, grok: 1 } } }
  },
  async getProviderSessionDetail(id) {
    window.managementHarness.detailCalls += 1
    if (params.get('failure') === 'detail' && window.managementHarness.detailCalls === 1) throw new Error('会话文件暂时不可读')
    return { session: sessions.find((session) => session.id === id)!, messages: [{ role: 'user', text: '保留这条对话', timestamp: null }, { role: 'assistant', text: '真实组件的测试输入', timestamp: null }], messageStats: { total: 2, user: 1, assistant: 1, system: 0, other: 0, invalidLines: 0 }, messagesTruncated: false, sourceTruncated: false }
  },
  async exportProviderSession(id) { record(`export:${id}`); return { id, provider: 'codex', outputPath: 'C:\\fixture\\export.md', messages: 2, truncated: false } },
  async archiveSession(id) { record(`archive:${id}`); sessions.find((session) => session.nativeId === id)!.archived = true; return { sessionId: id, archived: true, backupPath: 'backup.db', rolloutPath: 'fixture.jsonl', operationId: 'archive-1' } },
  async restoreSession(id) { record(`restore-session:${id}`); return { sessionId: id, archived: false, backupPath: 'backup.db', rolloutPath: 'fixture.jsonl', operationId: 'restore-1' } },
}
const backup: BackupPreview = { id: 'backup-fixture-01', provider: 'codex', reason: 'manual', createdAt: '2026-09-07T00:00:00Z', fileCount: 1, existingFileCount: 1, totalSize: 128, valid: true, error: null,
  files: [{ targetRelativePath: '.codex/config.toml', backupRelativePath: 'config.toml', existed: true, size: 128, sha256: 'f'.repeat(64) }] }
const backupApi: BackupsPageApi = {
  async list() { return [backup] }, async create(provider) { record(`backup:${provider}`); return { ...backup, provider } }, async inspect(id) { record(`inspect:${id}`); return backup },
  async restore(id) { window.managementHarness.restoreCalls += 1; if (params.get('failure') === 'restore' && window.managementHarness.restoreCalls === 1) throw new Error('备份校验未通过'); record(`restore-backup:${id}`); return { preRestoreBackupId: 'before-restore-02' } },
  async delete(id) { record(`delete-backup:${id}`) },
}
const initialMcp: McpServerView[] = [{ name: 'Local MCP', enabled: true, disabledReason: null, transportType: 'http', command: null, args: [], cwd: null, url: 'https://example.com/mcp', envNames: ['MCP_TOKEN'], inheritedEnvNames: [], httpHeaderNames: [], inheritedHttpHeaderNames: [], bearerTokenEnvVar: 'MCP_TOKEN', startupTimeoutSec: 15, toolTimeoutSec: 30, authStatus: 'authenticated', origin: 'user', editable: true }]
const initialSkills: SkillView[] = [{ id: 'managed', name: 'Managed Skill', description: '可管理的工作流', path: 'C:\\fixture\\managed', scope: 'user', source: 'agents', enabled: true, managed: true }, { id: 'system', name: 'System Skill', description: '系统只读技能', path: 'C:\\fixture\\system', scope: 'system', source: 'agents', enabled: true, managed: false }]
const initialPlugins: PluginView[] = [{ pluginId: 'codex-plugin', name: 'Local Plugin', marketplaceName: 'local-market', version: '1.0.0', installed: true, enabled: true, installPolicy: 'DEFAULT', authPolicy: 'DEFAULT', sourceType: 'local', sourcePath: 'C:\\fixture\\plugin' }]

function Fixture() {
  const [view, setView] = useState(params.get('view') ?? 'sessions')
  const [skills, setSkills] = useState(initialSkills)
  const [plugins, setPlugins] = useState(initialPlugins)
  const [mcp, setMcp] = useState(initialMcp)
  const [toast, setToast] = useState('')
  return <NavigationStateProvider scope="fixture-account"><div style={{ display: 'grid', gridTemplateRows: '40px minmax(0, 1fr)', height: '100%' }}>
    <nav aria-label="验收页面">{['sessions', 'backups', 'mcp', 'skills', 'plugins'].map((id) => <button key={id} type="button" onClick={() => setView(id)}>{id}</button>)}</nav>
    <main className="main-content">
      {view === 'sessions' && <SessionsPage api={sessionsApi} notify={(notice) => setToast(notice.message)} />}
      {view === 'backups' && <BackupsPage api={backupApi} />}
      {view === 'mcp' && <McpPage servers={mcp} loading={false} onRefresh={async () => { record('mcp:refresh') }} onAdd={async (input) => { record(`mcp:add:${input.name}`) }} onRemove={async (name) => { record(`mcp:remove:${name}`); setMcp((current) => current.filter((server) => server.name !== name)) }} onLogin={async (name) => { record(`mcp:login:${name}`) }} onLogout={async (name) => { record(`mcp:logout:${name}`) }} />}
      {view === 'skills' && <SkillsPage skills={skills} loading={false} repositoryAvailable platform={platformCapabilitiesFor('win32', 'x64')} onRefresh={async () => { record('skill:refresh') }} onImport={async (input) => { record(`skill:import:${input.scope}`) }} onToggle={async (path, enabled) => { record(`skill:toggle:${path}:${enabled}`); setSkills((current) => current.map((skill) => skill.path === path ? { ...skill, enabled } : skill)) }} onUninstall={async (path) => { record(`skill:uninstall:${path}`); setSkills((current) => current.filter((skill) => skill.path !== path)) }} />}
      {view === 'plugins' && <PluginsPage plugins={plugins} marketplaces={[{ name: 'local-market', root: 'C:\\fixture\\market' }]} loading={false} onRefresh={async () => { record('plugin:refresh') }} onInstall={async (id) => { record(`plugin:install:${id}`) }} onRemove={async (id) => { record(`plugin:remove:${id}`); setPlugins((current) => current.filter((plugin) => plugin.pluginId !== id)) }} onToggle={async (id, enabled) => { record(`plugin:toggle:${id}:${enabled}`); setPlugins((current) => current.map((plugin) => plugin.pluginId === id ? { ...plugin, enabled } : plugin)) }} onAddMarketplace={async () => { record('market:add') }} onUpgradeMarketplace={async () => { record('market:update') }} onRemoveMarketplace={async () => { record('market:remove') }} />}
    </main><output data-testid="management-toast" style={{ position: 'fixed', bottom: 0 }}>{toast}</output>
  </div></NavigationStateProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
