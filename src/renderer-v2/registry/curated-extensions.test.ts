import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { providerIds } from '../../../electron/catalog';
import {
  curatedCommandText,
  curatedExtensions,
  curatedItemsFor,
  curatedNeedsInput,
  curatedNetworkLabels,
  curatedRiskLabels,
  curatedRisks,
  curatedRuntimeLabels,
  parseCuratedExtensions,
} from './curated-extensions';

const raw: unknown = JSON.parse(
  readFileSync(new URL('../../../bundled-catalog/curated-extensions.json', import.meta.url), 'utf8'),
);
const rawItems = ((raw as { items: unknown[] }).items ?? []) as Array<Record<string, unknown>>;

describe('curated extension catalog', () => {
  // 解析层会丢掉不合格的条目，好让一次手误变成「少一项」而不是白屏。代价是清单写错时
  // 界面上没有任何提示，所以这条断言是它唯一的报警器：随包清单必须一条不落地通过校验。
  it('accepts every entry the bundled catalog ships', () => {
    expect(curatedExtensions).toHaveLength(rawItems.length);
    expect(curatedExtensions.map(item => item.id)).toEqual(rawItems.map(item => item.id));
  });

  it('gives every entry a unique id', () => {
    expect(new Set(curatedExtensions.map(item => item.id)).size).toBe(curatedExtensions.length);
  });

  it('only names CLIs this application actually manages', () => {
    for (const item of curatedExtensions) {
      expect(item.providers.length).toBeGreaterThan(0);
      for (const provider of item.providers) expect(providerIds).toContain(provider);
    }
  });

  // 精选安装走的是主进程那条 `mcp add ... -- command args` 的 argv，`--` 之后的参数不会被
  // 当成 CLI 自己的开关。但清单是随包数据，写进去一个 `--trust` 就是在替用户降低信任门槛，
  // 所以在源头上禁掉，Gemini 的 --trust 尤其不许出现。
  it('never carries CLI switches that change trust or scope', () => {
    for (const item of curatedExtensions) {
      if (item.install.type !== 'stdio') continue;
      for (const argument of item.install.args) {
        expect(argument).not.toMatch(/^--(?:trust|scope|include-tools|exclude-tools)/);
      }
    }
  });

  // 上游 MCP 服务器每周都在发版，`@latest` 意味着用户某天早上打开工具就换了一份新代码。
  it('pins every npm package to an exact version', () => {
    for (const item of curatedExtensions) {
      if (item.install.type !== 'stdio') continue;
      expect(item.install.command).toBe('npx');
      const specifier = item.install.args.find(argument => !argument.startsWith('-'));
      expect(specifier).toBeTruthy();
      expect(specifier).not.toContain('@latest');
      // 作用域包是 @scope/name@version，所以版本号那个 @ 一定不在第 0 位。
      expect(specifier?.slice(1)).toContain('@');
      expect(item.pinnedVersion).toBe(specifier?.slice(1).split('@')[1]);
    }
  });

  it('only reaches remote servers over https', () => {
    for (const item of curatedExtensions) {
      if (item.install.type === 'http') expect(item.install.url.startsWith('https://')).toBe(true);
      expect(item.homepage.startsWith('https://')).toBe(true);
    }
  });

  it('keeps risk labels inside the vocabulary the page can render', () => {
    for (const item of curatedExtensions) {
      for (const risk of item.risks) {
        expect(curatedRisks).toContain(risk);
        expect(curatedRiskLabels[risk].label).toBeTruthy();
      }
      expect(curatedRuntimeLabels[item.runtime]).toBeTruthy();
      expect(curatedNetworkLabels).toHaveProperty(item.network);
      expect(item.riskNote.length).toBeGreaterThan(8);
    }
  });

  // 占位符没有对应的 inputs 就是「表单里留了一项谁也不知道该填什么」，反过来多出一条
  // inputs 则是一句永远不会被满足的提示。两边必须一一对上。
  it('pairs every placeholder with an input the form explains', () => {
    for (const item of curatedExtensions) {
      const values = item.install.type === 'stdio'
        ? [...item.install.args, ...Object.values(item.install.env)]
        : [item.install.url];
      const placeholders = new Set(
        values.flatMap(value => [...value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map(match => match[1])),
      );
      expect([...placeholders].sort()).toEqual(item.inputs.map(input => input.key).sort());
      expect(curatedNeedsInput(item)).toBe(placeholders.size > 0);
    }
  });

  // I3：随包数据经由渲染层进配置文件，任何看着像密钥的东西都不该在这条路上出现。
  it('carries no credentials', () => {
    expect(JSON.stringify(raw)).not.toMatch(/sk-|Bearer |api[_-]?key["']?\s*[:=]/i);
  });

  // 双站点对用户无感：面向用户的文案里不出现站点名与内部代号。
  it('keeps site names and internal code names out of the copy', () => {
    for (const item of curatedExtensions) {
      const copy = `${item.name} ${item.summary} ${item.riskNote} ${item.note ?? ''}`;
      expect(copy).not.toMatch(/solov|new-api|sub2api|relay|星芒美元/i);
    }
  });

  it('filters by page and by the tool the user is looking at', () => {
    for (const provider of providerIds) {
      for (const item of curatedItemsFor('mcp', provider)) {
        expect(item.kind).toBe('mcp');
        expect(item.providers).toContain(provider);
      }
    }
    expect(curatedItemsFor('mcp', 'claude').map(item => item.id)).toContain('files');
    // 第一步只做外接工具页，技能与插件还没有精选，两页应当什么也不渲染。
    expect(curatedItemsFor('skill', 'claude')).toEqual([]);
    expect(curatedItemsFor('plugin', 'claude')).toEqual([]);
  });

  it('shows the exact command that will be written into the tool configuration', () => {
    const files = curatedExtensions.find(item => item.id === 'files');
    expect(curatedCommandText(files!)).toBe(
      'npx -y @modelcontextprotocol/server-filesystem@2026.8.31 {{directory}}',
    );
    const memory = curatedExtensions.find(item => item.id === 'memory');
    // 环境变量也要出现在确认框里，否则用户看不见记忆文件会被写到哪。
    expect(curatedCommandText(memory!)).toContain('MEMORY_FILE_PATH={{directory}}/ai-memory.jsonl');
    const github = curatedExtensions.find(item => item.id === 'github');
    expect(curatedCommandText(github!)).toBe('https://api.githubcopilot.com/mcp/');
  });

  it('drops entries it cannot fully validate instead of rendering half of one', () => {
    const valid = rawItems[0];
    expect(parseCuratedExtensions({ items: [valid] })).toHaveLength(1);
    expect(parseCuratedExtensions({ items: [{ ...valid, providers: ['nope'] }] })).toEqual([]);
    expect(parseCuratedExtensions({ items: [{ ...valid, risks: ['made-up'] }] })).toEqual([]);
    expect(parseCuratedExtensions({ items: [{ ...valid, runtime: 'perl' }] })).toEqual([]);
    expect(parseCuratedExtensions({ items: [{ ...valid, install: { type: 'http', url: 'http://x.test/' } }] })).toEqual([]);
    expect(parseCuratedExtensions({ items: [{ ...valid, requiresAccount: 'yes' }] })).toEqual([]);
    expect(parseCuratedExtensions({ items: [{ ...valid, summary: '  ' }] })).toEqual([]);
    expect(parseCuratedExtensions({ items: 'nope' })).toEqual([]);
    expect(parseCuratedExtensions(null)).toEqual([]);
  });
});
