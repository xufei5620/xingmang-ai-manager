import { describe, expect, it } from 'vitest';
import { activeProviderIds, cliCatalog, isActiveProviderId, isProviderId, isRetiredProviderId, providerConfigDirectoryNames, retiredProviderIds } from '../../../electron/catalog';
import { clientConnections } from './clients';
import { firstRunHints, guideRecommendedTool, guideRecommendedToolFor, homeToolBlurbs, homeToolOrder, officialAccountNames, officialAccountNotes, shortcutTools, toolKindLabels, tools } from './tools';

describe('renderer-v2 tool registry', () => {
  it('only carries ids the main process knows, plus the Codex desktop entry', () => {
    for (const tool of tools) {
      expect(isProviderId(tool.id) || tool.id === 'codexDesktop').toBe(true);
    }
    expect(new Set(tools.map(tool => tool.id)).size).toBe(tools.length);
  });

  // Gemini CLI 下线（yoyo 2026-10-14）：界面上哪儿都不能再出现它，也不能再替它安装、打开、写配置。
  // 每个页面都从这张表取工具，表里没有它，页面就画不出它。
  it('carries no retired provider in the registry or its per-provider tables', () => {
    expect(retiredProviderIds.length).toBeGreaterThan(0);
    for (const tool of tools) expect(isRetiredProviderId(tool.id)).toBe(false);
    for (const table of [officialAccountNames, officialAccountNotes, firstRunHints])
      for (const retired of retiredProviderIds) expect(Object.keys(table)).not.toContain(retired);
    const names = tools.map(tool => tool.name).join('\n');
    for (const retired of retiredProviderIds) expect(names).not.toContain(cliCatalog[retired].name);
  });

  // v3.1.1 起 renderer-v2 只有这一套展示顺序（legacy 树另有概览序与管理序两套，已冻结）。
  // 数组次序就是用户看到的次序，没有第二处定义，所以顺序只能在这里被改动。
  it('keeps one display order for every v2 surface', () => {
    expect(tools.map(tool => tool.id)).toEqual(['claude', 'codex', 'codexDesktop', 'grok']);
    expect(tools.map(tool => tool.shortcutIndex)).toEqual(tools.map((_, index) => index + 1));
  });

  it('exposes exactly one CLI entry per active catalog provider', () => {
    const cliIds = tools.filter(tool => tool.kind === 'cli').map(tool => tool.id);
    expect([...cliIds].sort()).toEqual([...activeProviderIds].sort());
  });

  // 设置里「快捷键」写的数字和真能打开的个数要一致：Linux 上没有桌面端，少一个。
  it('numbers the launch shortcuts over the tools this computer can show', () => {
    expect(shortcutTools('win').map(tool => tool.id)).toEqual(['claude', 'codex', 'codexDesktop', 'grok']);
    expect(shortcutTools('mac').map(tool => tool.id)).toEqual(['claude', 'codex', 'codexDesktop', 'grok']);
    expect(shortcutTools('linux').map(tool => tool.id)).toEqual(['claude', 'codex', 'grok']);
  });

  it('derives npm package names from the CLI catalog', () => {
    for (const tool of tools) {
      if (!isActiveProviderId(tool.id) || tool.install.type !== 'npm') continue;
      expect(tool.install.pkg).toBe(cliCatalog[tool.id].packageName);
    }
  });

  it('derives every displayed config path from the shared directory table', () => {
    for (const tool of tools) {
      const provider = tool.id === 'codexDesktop' ? 'codex' : tool.id;
      const directory = providerConfigDirectoryNames[provider];
      expect(tool.configPath).toEqual({ win: `%USERPROFILE%\\${directory}`, mac: `~/${directory}`, linux: `~/${directory}` });
    }
  });

  // A6:装完只剩一个闪烁的光标是用户流失最集中的一屏,这两条文案是引导完成步与首页
  // 建议卡唯一的内容来源。少一条不会报错,只会让那张卡悄悄消失,所以在这里钉住。
  it('gives every managed CLI a first command and a prompt to paste', () => {
    expect(Object.keys(firstRunHints).sort()).toEqual([...activeProviderIds].sort());
    for (const provider of activeProviderIds) {
      const hint = firstRunHints[provider];
      expect(hint.command.trim()).not.toBe('');
      expect(hint.prompt.trim()).not.toBe('');
    }
    for (const tool of tools) {
      if (tool.kind !== 'cli' || !isActiveProviderId(tool.id)) continue;
      expect(tool.firstRun).toEqual(firstRunHints[tool.id]);
    }
  });

  // 启动命令就是主进程「打开」按钮真正执行的那条(resolveCliCommand 的 argv 始终为空),
  // 抄错一个字用户敲下去就是 command not found。
  it('keeps the first command equal to the CLI the main process launches', () => {
    for (const provider of activeProviderIds) {
      expect(firstRunHints[provider].command).toBe(cliCatalog[provider].command);
    }
  });

  it('leaves the Codex desktop entry without a command, because it has no terminal', () => {
    expect(tools.find(tool => tool.id === 'codexDesktop')?.firstRun).toBeUndefined();
  });

  it('names an official account for every tool that offers that source', () => {
    for (const tool of tools) {
      const provider = tool.id === 'codexDesktop' ? 'codex' : tool.id;
      if (tool.sources.includes('official')) expect(officialAccountNames[provider]).toBeTruthy();
    }
    expect(Object.keys(officialAccountNames).sort()).toEqual([...activeProviderIds].sort());
  });

  it('covers every provider in the official note table and leaves the unrestricted ones empty', () => {
    expect(Object.keys(officialAccountNotes).sort()).toEqual([...activeProviderIds].sort());
    expect(officialAccountNotes.claude).toBeNull();
    expect(officialAccountNotes.codex).toBeNull();
    for (const provider of activeProviderIds)
      if (!tools.some(tool => (tool.id === 'codexDesktop' ? 'codex' : tool.id) === provider && tool.sources.includes('official')))
        expect(officialAccountNotes[provider]).toBeNull();
  });

  // 引导第一步默认选中它：必须在 Windows 与 Mac 上都看得到，而且不需要先准备
  // 运行环境，否则「一路下一步」会在第二步卡住。
  it('recommends a guide default that needs no runtime and shows on Windows and Mac', () => {
    const recommended = tools.find(tool => tool.id === guideRecommendedTool);
    expect(recommended?.requires).toEqual([]);
    expect(recommended?.hidden?.('win') ?? false).toBe(false);
    expect(recommended?.hidden?.('mac') ?? false).toBe(false);
  });

  // Linux 上看不到桌面端，改推荐 Codex CLI：它要的 Node.js 由星芒自己准备，一路下一步照样走得完。
  it('recommends Codex CLI on Linux and keeps the desktop app everywhere else', () => {
    expect(guideRecommendedToolFor('win')).toBe(guideRecommendedTool);
    expect(guideRecommendedToolFor('mac')).toBe(guideRecommendedTool);
    expect(guideRecommendedToolFor('linux')).toBe('codex');
    const linux = tools.find(tool => tool.id === guideRecommendedToolFor('linux'));
    expect(linux?.hidden?.('linux') ?? false).toBe(false);
    expect(linux?.requires).toEqual(['node']);
  });

  // v4 首页的卡片次序（批 04）：每个命令行工具、桌面端和外接客户端各一张，按厂商排，不漏不重。
  it('puts every tool and desktop client on the home page exactly once, grouped by vendor', () => {
    const everything = [...tools.map(tool => tool.id), ...clientConnections.map(client => client.id)];
    expect([...homeToolOrder].sort()).toEqual([...everything].sort());
    expect(new Set(homeToolOrder).size).toBe(homeToolOrder.length);
    expect(homeToolOrder).toEqual(['claude', 'claudeDesktop', 'codex', 'codexDesktop', 'grok', 'opencode', 'workbuddy']);
    const vendors = homeToolOrder.map(id => (tools.find(tool => tool.id === id) ?? clientConnections.find(client => client.id === id))?.vendor);
    // 同一家的挨在一起：厂商一换就不会再回来。
    expect(vendors.filter((vendor, index) => vendors.indexOf(vendor) !== index && vendors[index - 1] !== vendor)).toEqual([]);
  });

  it('gives every home card a one-line introduction and a kind label', () => {
    for (const id of homeToolOrder) expect(homeToolBlurbs[id].length, id).toBeGreaterThan(0);
    for (const definition of [...tools, ...clientConnections]) expect(toolKindLabels[definition.kind], definition.id).toMatch(/命令行工具|桌面应用/);
  });
});
