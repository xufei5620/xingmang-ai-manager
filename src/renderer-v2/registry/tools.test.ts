import { describe, expect, it } from 'vitest';
import { cliCatalog, isProviderId, providerConfigDirectoryNames, providerIds } from '../../../electron/catalog';
import { firstRunHints, guideRecommendedTool, officialAccountNames, officialAccountNotes, tools } from './tools';

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

  // A6:装完只剩一个闪烁的光标是用户流失最集中的一屏,这两条文案是引导完成步与首页
  // 建议卡唯一的内容来源。少一条不会报错,只会让那张卡悄悄消失,所以在这里钉住。
  it('gives every managed CLI a first command and a prompt to paste', () => {
    expect(Object.keys(firstRunHints).sort()).toEqual([...providerIds].sort());
    for (const provider of providerIds) {
      const hint = firstRunHints[provider];
      expect(hint.command.trim()).not.toBe('');
      expect(hint.prompt.trim()).not.toBe('');
    }
    for (const tool of tools) {
      if (tool.kind !== 'cli' || !isProviderId(tool.id)) continue;
      expect(tool.firstRun).toEqual(firstRunHints[tool.id]);
    }
  });

  // 启动命令就是主进程「打开」按钮真正执行的那条(resolveCliCommand 的 argv 始终为空),
  // 抄错一个字用户敲下去就是 command not found。
  it('keeps the first command equal to the CLI the main process launches', () => {
    for (const provider of providerIds) {
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
    expect(Object.keys(officialAccountNames).sort()).toEqual([...providerIds].sort());
  });

  // Google stopped serving personal accounts (AI Pro / Ultra included) on
  // 2026-06-18, so the option is now enterprise-only. Anyone who still reads
  // it as "sign in with your Google account" burns an afternoon on a login
  // page that will never work, then calls support.
  it('warns next to the Gemini official option that personal Google accounts are out', () => {
    expect(officialAccountNames.gemini).toContain('企业版');
    const note = officialAccountNotes.gemini ?? '';
    expect(note).toContain('个人 Google 账号');
    expect(note).toContain('2026 年 6 月');
    expect(note).toContain('企业版 Code Assist');
    expect(note).toContain('星芒账号');
  });

  it('covers every provider in the official note table and leaves the unrestricted ones empty', () => {
    expect(Object.keys(officialAccountNotes).sort()).toEqual([...providerIds].sort());
    expect(officialAccountNotes.claude).toBeNull();
    expect(officialAccountNotes.codex).toBeNull();
    for (const provider of providerIds)
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
});
