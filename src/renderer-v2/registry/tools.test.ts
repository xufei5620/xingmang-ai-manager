import { describe, expect, it } from 'vitest';
import { cliCatalog, isProviderId, providerConfigDirectoryNames, providerIds } from '../../../electron/catalog';
import { officialAccountNames, tools } from './tools';

describe('renderer-v2 tool registry', () => {
  it('only carries ids the main process knows, plus the Codex desktop entry', () => {
    for (const tool of tools) {
      expect(isProviderId(tool.id) || tool.id === 'codexDesktop').toBe(true);
    }
    expect(new Set(tools.map(tool => tool.id)).size).toBe(tools.length);
  });

  // v3.1.1 起 renderer-v2 只有这一套展示顺序（legacy 树另有概览序与管理序两套，已冻结）。
  // 数组次序就是用户看到的次序，没有第二处定义，所以顺序只能在这里被改动。
  it('keeps one display order for every v2 surface', () => {
    expect(tools.map(tool => tool.id)).toEqual(['claude', 'codex', 'codexDesktop', 'gemini', 'grok']);
    expect(tools.map(tool => tool.shortcutIndex)).toEqual(tools.map((_, index) => index + 1));
  });

  it('exposes exactly one CLI entry per catalog provider', () => {
    const cliIds = tools.filter(tool => tool.kind === 'cli').map(tool => tool.id);
    expect([...cliIds].sort()).toEqual([...providerIds].sort());
  });

  it('derives npm package names from the CLI catalog', () => {
    for (const tool of tools) {
      if (!isProviderId(tool.id) || tool.install.type !== 'npm') continue;
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

  it('names an official account for every tool that offers that source', () => {
    for (const tool of tools) {
      const provider = tool.id === 'codexDesktop' ? 'codex' : tool.id;
      if (tool.sources.includes('official')) expect(officialAccountNames[provider]).toBeTruthy();
    }
    expect(Object.keys(officialAccountNames).sort()).toEqual([...providerIds].sort());
  });
});
