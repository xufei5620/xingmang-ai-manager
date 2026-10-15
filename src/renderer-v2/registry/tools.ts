import { cliCatalog, providerConfigDirectoryNames, type ActiveProviderId } from '../../../electron/catalog';
import type { ExternalToolId } from '../../../electron/ipc-contract';

export type ToolFirstRun = { command: string; prompt: string };
export type ToolDef = { id: ActiveProviderId | 'codexDesktop'; name: string; vendor: string; brandIcon: string; kind: 'cli' | 'desktop'; install: { type: 'npm'; pkg: string } | { type: 'installer'; win?: 'managed' | 'store'; mac?: 'managed' | 'external'; linux?: 'unavailable' }; requires: Array<'node' | 'python'>; configPath: Record<'win' | 'mac' | 'linux', string>; sources: Array<'account' | 'official' | 'manual'>; models?: string[] | { endpoint: string }; shortcutIndex: number; firstRun?: ToolFirstRun; hidden?: (os: 'win' | 'mac' | 'linux') => boolean };

// npm 包名与配置目录名都从主进程的单一真相源派生,而不是在这里再抄一份:
// 抄过的字段会漂移——`keyWrite` 就漂过(grok 标成 'env',实际写的是
// config.toml),而且抄的那份没有任何消费者能发现它错了(审查总表 R-S11)。
function npmInstall(provider: ActiveProviderId): { type: 'npm'; pkg: string } {
  return { type: 'npm', pkg: cliCatalog[provider].packageName };
}

// 界面上展示给用户的配置位置。真正解析落点的是主进程的 providerConfigRoot,
// 它读的是同一张 providerConfigDirectoryNames。
function configPathsFor(provider: ActiveProviderId): Record<'win' | 'mac' | 'linux', string> {
  const directory = providerConfigDirectoryNames[provider];
  return { win: `%USERPROFILE%\\${directory}`, mac: `~/${directory}`, linux: `~/${directory}` };
}

// 「官方账号」这一来源在界面上的中文名。写成 Record<ActiveProviderId, …> 而不是
// 三元链:加一个 CLI 时漏掉它是编译错(TS2741),不是在界面上静默显示别家
// 的账号名。没有官方登录通道的工具取 null,它的 sources 里也不含 'official'。
// 已下线的 CLI(Gemini,yoyo 2026-10-14)不在这几张表里:界面不再显示它。
export const officialAccountNames: Record<ActiveProviderId, string | null> = {
  claude: 'Claude 账号',
  codex: 'ChatGPT 账号',
  grok: 'Grok 账号',
};

// 官方来源选项旁边的一句补充,给官方登录有门槛、用户点下去之前就得知道的工具
// ——否则他们会在官方登录页上反复失败,最后来找客服。同样写成
// Record<ActiveProviderId, …>:加一个 CLI 时漏掉它是编译错,没有这类限制的工具取 null
// (眼下在用的几家都没有)。
export const officialAccountNotes: Record<ActiveProviderId, string | null> = {
  claude: null,
  codex: null,
  grok: null,
};

// 装好之后在终端里敲的第一条命令,外加一句可以直接粘进去的中文提示词(功能清单 A6)。
// 每个 CLI 装完都只剩一个闪烁的光标,这两行是用户能不能走完第一分钟的全部依据。
// 写成 Record<ActiveProviderId, …> 而不是逐条挂在 tools 上:加一个 CLI 时漏掉它是编译错
// (TS2741),而不是界面上少一张卡片——少一张卡片没有任何东西会报错。
// 命令就是各 CLI 官方的裸命令,与主进程「打开」按钮真正启动的那条一致
// (resolveCliCommand 的 argv 始终为空),用户自己开终端敲的和点按钮得到的是同一个东西。
// Codex 桌面端是图形界面,没有要敲的命令,所以这张表只覆盖命令行工具。
export const firstRunHints: Record<ActiveProviderId, ToolFirstRun> = {
  claude: { command: 'claude', prompt: '用中文介绍一下这个项目是做什么的,再指出最值得先读的三个文件。' },
  codex: { command: 'codex', prompt: '用中文说明把这个项目跑起来需要哪些步骤,越具体越好。' },
  grok: { command: 'grok', prompt: '用中文讲讲这个项目的主要功能,并给我一条改进建议。' },
};

// 新手引导第一步默认选中、标「推荐」的那一个（第十一批候选 1，协调者拍板）。
// Codex 桌面端是几种开始方式里唯一不用准备运行环境、不用开终端的，也是教程主线；
// Windows 与 Mac 用同一个，两边都在首页点「安装」。页面里不写这个字面量（T2）。
export const guideRecommendedTool: ToolDef['id'] = 'codexDesktop';

// Linux 上没有桌面端（ui-spec/04-pages.md：Linux 走 Codex CLI 或直接聊天）。推荐 Codex CLI，
// 和 Linux 版教程第一章同一条路；Node.js 由星芒自己准备，新手一路「下一步」照样走得完。
export function guideRecommendedToolFor(os: 'win' | 'mac' | 'linux'): ToolDef['id'] {
  return os === 'linux' ? 'codex' : guideRecommendedTool;
}

export const tools: ToolDef[] = [
  { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', brandIcon: 'Claude', kind: 'cli', install: npmInstall('claude'), requires: ['node'], configPath: configPathsFor('claude'), sources: ['account', 'official', 'manual'], shortcutIndex: 1, firstRun: firstRunHints.claude },
  { id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', brandIcon: 'OpenAI', kind: 'cli', install: npmInstall('codex'), requires: ['node'], configPath: configPathsFor('codex'), sources: ['account', 'official', 'manual'], shortcutIndex: 2, firstRun: firstRunHints.codex },
  { id: 'codexDesktop', name: 'Codex 桌面端', vendor: 'OpenAI', brandIcon: 'OpenAI', kind: 'desktop', install: { type: 'installer', win: 'managed', mac: 'managed', linux: 'unavailable' }, requires: [], configPath: configPathsFor('codex'), sources: ['account', 'official', 'manual'], shortcutIndex: 3, hidden: os => os === 'linux' },
  { id: 'grok', name: 'Grok CLI', vendor: 'xAI', brandIcon: 'Grok', kind: 'cli', install: npmInstall('grok'), requires: ['node'], configPath: configPathsFor('grok'), sources: ['account', 'official', 'manual'], shortcutIndex: 4, firstRun: firstRunHints.grok },
];

// Ctrl / Command + 数字打开的那几个:按展示顺序数这台电脑上看得到的工具。快捷键本身和
// 设置里「快捷键」那一行都读它,免得写着 1–5、实际只有前几个数字按得动。
export function shortcutTools(os: 'win' | 'mac' | 'linux'): ToolDef[] {
  return tools.filter(tool => !tool.hidden?.(os));
}

// 卡片第二行「{厂商} · 命令行工具」那半句（v4 首页）。外接客户端的 kind 记在 registry/clients.ts。
export const toolKindLabels: Record<ToolDef['kind'], string> = { cli: '命令行工具', desktop: '桌面应用' };

// v4 首页的工具卡片按厂商排，命令行工具和外接的桌面客户端排在一张网格里（方案批 04）。
// 次序只在这里定义，页面不写字面量（T2）；registry/tools.test.ts 钉住它不漏不重。
export type HomeToolId = ToolDef['id'] | ExternalToolId;
export const homeToolOrder: ReadonlyArray<HomeToolId> = ['claude', 'claudeDesktop', 'codex', 'codexDesktop', 'grok', 'opencode', 'workbuddy'];

// 没装时卡片中间那一句介绍。写成 Record：加一个工具时漏掉它是编译错，不是卡片上空一行。
export const homeToolBlurbs: Record<HomeToolId, string> = {
  claude: '命令行编程助手',
  claudeDesktop: '可以接当前账号使用',
  codex: '命令行编程助手',
  codexDesktop: '和 Codex CLI 共用配置',
  grok: '在终端里读项目、改代码',
  opencode: '开源，命令行版和桌面版共用配置',
  workbuddy: '办公助手，可以接当前账号的模型',
};
