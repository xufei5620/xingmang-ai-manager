import { cliCatalog, providerConfigDirectoryNames, type ProviderId } from '../../../electron/catalog';

export type ToolFirstRun = { command: string; prompt: string };
export type ToolDef = { id: ProviderId | 'codexDesktop'; name: string; vendor: string; brandIcon: string; kind: 'cli' | 'desktop'; install: { type: 'npm'; pkg: string } | { type: 'installer'; win?: 'managed' | 'store'; mac?: 'external'; linux?: 'unavailable' }; requires: Array<'node' | 'python'>; configPath: Record<'win' | 'mac' | 'linux', string>; sources: Array<'account' | 'official' | 'manual'>; models?: string[] | { endpoint: string }; shortcutIndex: number; firstRun?: ToolFirstRun; hidden?: (os: 'win' | 'mac' | 'linux') => boolean };

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
  gemini: 'Google 企业版账号',
  grok: 'Grok 账号',
};

// 官方来源选项旁边的一句补充。Google 自 2026-06-18 起不再让个人 Google 账号
// (含 AI Pro / Ultra 订阅)登录 Gemini CLI,只剩企业版 Code Assist 与 API Key
// 两条路(google-gemini/gemini-cli discussion #27274)。选项本身留着给企业客户,
// 但个人用户必须在点下去之前就看到这句——否则他们会在 Google 登录页上反复失败,
// 最后来找客服。同样写成 Record<ProviderId, …>:加第五个 CLI 时漏掉它是编译错,
// 没有这类限制的工具取 null。
export const officialAccountNotes: Record<ProviderId, string | null> = {
  claude: null,
  codex: null,
  gemini: '个人 Google 账号（含 AI Pro / Ultra 订阅）自 2026 年 6 月起不能用于 Gemini CLI，只有企业版 Code Assist 账号可用。个人用户请用星芒账号或自己填写密钥。',
  grok: null,
};

// 装好之后在终端里敲的第一条命令,外加一句可以直接粘进去的中文提示词(功能清单 A6)。
// 四个 CLI 装完都只剩一个闪烁的光标,这两行是用户能不能走完第一分钟的全部依据。
// 写成 Record<ProviderId, …> 而不是逐条挂在 tools 上:加第五个 CLI 时漏掉它是编译错
// (TS2741),而不是界面上少一张卡片——少一张卡片没有任何东西会报错。
// 命令就是各 CLI 官方的裸命令,与主进程「打开」按钮真正启动的那条一致
// (resolveCliCommand 的 argv 始终为空),用户自己开终端敲的和点按钮得到的是同一个东西。
// Codex 桌面端是图形界面,没有要敲的命令,所以这张表只覆盖四个 CLI。
export const firstRunHints: Record<ProviderId, ToolFirstRun> = {
  claude: { command: 'claude', prompt: '用中文介绍一下这个项目是做什么的,再指出最值得先读的三个文件。' },
  codex: { command: 'codex', prompt: '用中文说明把这个项目跑起来需要哪些步骤,越具体越好。' },
  gemini: { command: 'gemini', prompt: '用中文总结这个文件夹里的代码,再列出你觉得可以改进的地方。' },
  grok: { command: 'grok', prompt: '用中文讲讲这个项目的主要功能,并给我一条改进建议。' },
};

// 新手引导第一步默认选中、标「推荐」的那一个（第十一批候选 1，协调者拍板）。
// Codex 桌面端是六个里唯一不用准备运行环境、不用开终端的，也是教程主线；
// Windows 与 Mac 用同一个，Mac 上它走「安装指南」。页面里不写这个字面量（T2）。
export const guideRecommendedTool: ToolDef['id'] = 'codexDesktop';

export const tools: ToolDef[] = [
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', brandIcon: 'Claude', kind: 'cli', install: npmInstall('claude'), requires: ['node'], configPath: configPathsFor('claude'), sources: ['account', 'official', 'manual'], shortcutIndex: 1, firstRun: firstRunHints.claude },
  { id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', brandIcon: 'OpenAI', kind: 'cli', install: npmInstall('codex'), requires: ['node'], configPath: configPathsFor('codex'), sources: ['account', 'official', 'manual'], shortcutIndex: 2, firstRun: firstRunHints.codex },
  { id: 'codexDesktop', name: 'Codex 桌面端', vendor: 'OpenAI', brandIcon: 'OpenAI', kind: 'desktop', install: { type: 'installer', win: 'managed', mac: 'external', linux: 'unavailable' }, requires: [], configPath: configPathsFor('codex'), sources: ['account', 'official', 'manual'], shortcutIndex: 3, hidden: os => os === 'linux' },
  { id: 'gemini', name: 'Gemini CLI', vendor: 'Google', brandIcon: 'Gemini', kind: 'cli', install: npmInstall('gemini'), requires: ['node', 'python'], configPath: configPathsFor('gemini'), sources: ['account', 'official', 'manual'], shortcutIndex: 4, firstRun: firstRunHints.gemini },
  { id: 'grok', name: 'Grok CLI', vendor: 'xAI', brandIcon: 'Grok', kind: 'cli', install: npmInstall('grok'), requires: ['node'], configPath: configPathsFor('grok'), sources: ['account', 'official', 'manual'], shortcutIndex: 5, firstRun: firstRunHints.grok },
];
