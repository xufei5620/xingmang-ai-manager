import type { ActiveProviderId } from '../../../electron/catalog';

/**
 * 外接工具、技能、插件三页和精选页共用的字：这一类叫什么、各家官方怎么叫、已装的按什么范围分组。
 * 范围分组只用主进程列表里带回来的 scope 归类，「随插件安装」「沿用 Claude Code」这类主进程认不出的来源不放。
 */
export type ExtensionKindId = 'mcp' | 'skill' | 'plugin';

export const extensionKindLabels: Record<ExtensionKindId, string> = { mcp: '外接工具', skill: '技能', plugin: '插件' };

/** 页签下面那条「{工具名} 官方叫「…」」：客户对着官方文档找的时候对得上。 */
export const extensionOfficialTerms: Record<ExtensionKindId, Record<ActiveProviderId, string>> = {
  mcp: { claude: 'MCP 服务器', codex: 'MCP 服务器', grok: 'MCP' },
  skill: { claude: '技能（Skills）', codex: '技能（Skills）', grok: '技能（Skills）' },
  plugin: { claude: '插件（Plugins）', codex: '插件（Plugins）', grok: '插件（Plugins）' },
};

/**
 * 已装列表的一组。scope 是这一组收哪一层：all = 这个工具只有一层，全都放这一组；builtin 是 Codex 自带、
 * 只读的技能。主进程带回来的层不在这张表里的（比如 Grok 项目里的技能），页面另起一组、标题用详情里那套范围叫法。
 */
export interface ExtensionScopeGroup {
  scope: 'all' | 'user' | 'project' | 'local' | 'builtin';
  title: string;
  description: string;
}

const claudeLayers: readonly ExtensionScopeGroup[] = [
  { scope: 'user', title: '用户', description: '你的所有项目都能用' },
  { scope: 'project', title: '项目', description: '随项目共享给协作者' },
  { scope: 'local', title: '本地', description: '只在当前项目、只给你自己' },
];

export const extensionScopeGroups: Record<ExtensionKindId, Record<ActiveProviderId, readonly ExtensionScopeGroup[]>> = {
  mcp: {
    claude: claudeLayers,
    codex: [{ scope: 'all', title: '全局', description: '所有项目共用' }],
    // Grok 的连接分 ~/.grok/config.toml 和项目里的 .grok/config.toml 两层，列表带回各自的 scope（#1092）。
    grok: [
      { scope: 'user', title: '用户', description: '所有项目都能用' },
      { scope: 'project', title: '项目', description: '只在这个项目里用' },
    ],
  },
  skill: {
    claude: [
      { scope: 'user', title: '个人', description: '所有项目都能用' },
      { scope: 'project', title: '项目', description: '随项目共享给协作者' },
    ],
    codex: [
      { scope: 'user', title: '用户', description: '所有项目都能用' },
      { scope: 'project', title: '项目', description: '只在这个项目里用' },
      { scope: 'builtin', title: '系统内置', description: 'Codex 自带，随版本更新' },
    ],
    grok: [{ scope: 'user', title: '用户', description: '所有项目都能用' }],
  },
  plugin: {
    claude: claudeLayers,
    codex: [{ scope: 'all', title: '已安装', description: '所有项目都能用' }],
    // Grok 的插件命令没有范围参数，装、卸、启停都在 ~/.grok 里，只有这一层（1.0.52、1.0.62 实测，#1092）。
    grok: [{ scope: 'all', title: '用户', description: '所有项目都能用' }],
  },
};

/** 插件页下面那块官方目录的标题；Grok CLI 没有插件市场，不在这张表里。 */
export const pluginCatalogTitles: Partial<Record<ActiveProviderId, string>> = {
  claude: 'Anthropic 官方市场',
  codex: 'OpenAI 插件目录',
};
