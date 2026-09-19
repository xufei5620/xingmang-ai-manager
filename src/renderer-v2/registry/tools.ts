import { cliCatalog, providerConfigDirectoryNames, type ProviderId } from '../../../electron/catalog';

export type ToolDef = { id: ProviderId | 'codexDesktop'; name: string; vendor: string; brandIcon: string; kind: 'cli' | 'desktop'; install: { type: 'npm'; pkg: string } | { type: 'installer'; win?: 'managed' | 'store'; mac?: 'external'; linux?: 'unavailable' }; requires: Array<'node' | 'python'>; configPath: Record<'win' | 'mac' | 'linux', string>; sources: Array<'account' | 'official' | 'manual'>; models?: string[] | { endpoint: string }; shortcutIndex: number; hidden?: (os: 'win' | 'mac' | 'linux') => boolean };

// npm 包名与配置目录名都从主进程的单一真相源派生,而不是在这里再抄一份:
// 抄过的字段会漂移——`keyWrite` 就漂过(grok 标成 'env',实际写的是
// config.toml),而且抄的那份没有任何消费者能发现它错了(审查总表 R-S11)。
function npmInstall(provider: ProviderId): { type: 'npm'; pkg: string } {
  return { type: 'npm', pkg: cliCatalog[provider].packageName };
}

// 界面上展示给用户的配置位置。真正解析落点的是主进程的 providerConfigRoot,
// 它读的是同一张 providerConfigDirectoryNames。
function configPathsFor(provider: ProviderId): Record<'win' | 'mac' | 'linux', string> {
  const directory = providerConfigDirectoryNames[provider];
  return { win: `%USERPROFILE%\\${directory}`, mac: `~/${directory}`, linux: `~/${directory}` };
}

// 「官方账号」这一来源在界面上的中文名。写成 Record<ProviderId, …> 而不是
// 三元链:加第五个 CLI 时漏掉它是编译错(TS2741),不是在界面上静默显示别家
// 的账号名。没有官方登录通道的工具取 null,它的 sources 里也不含 'official'。
export const officialAccountNames: Record<ProviderId, string | null> = {
  claude: 'Claude 账号',
  codex: 'ChatGPT 账号',
  gemini: 'Google 账号',
  grok: null,
};

export const tools: ToolDef[] = [
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', brandIcon: 'Claude', kind: 'cli', install: npmInstall('claude'), requires: ['node'], configPath: configPathsFor('claude'), sources: ['account', 'official', 'manual'], shortcutIndex: 1 },
  { id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', brandIcon: 'OpenAI', kind: 'cli', install: npmInstall('codex'), requires: ['node'], configPath: configPathsFor('codex'), sources: ['account', 'official', 'manual'], shortcutIndex: 2 },
  { id: 'codexDesktop', name: 'Codex 桌面端', vendor: 'OpenAI', brandIcon: 'OpenAI', kind: 'desktop', install: { type: 'installer', win: 'managed', mac: 'external', linux: 'unavailable' }, requires: [], configPath: configPathsFor('codex'), sources: ['account', 'official', 'manual'], shortcutIndex: 3, hidden: os => os === 'linux' },
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', brandIcon: 'Gemini', kind: 'cli', install: npmInstall('gemini'), requires: ['node', 'python'], configPath: configPathsFor('gemini'), sources: ['account', 'official', 'manual'], shortcutIndex: 4 },
  { id: 'grok', name: 'Grok CLI', vendor: 'xAI', brandIcon: 'Grok', kind: 'cli', install: npmInstall('grok'), requires: ['node'], configPath: configPathsFor('grok'), sources: ['account', 'manual'], shortcutIndex: 5 },
];
