import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { tools } from '../registry/tools';
import { statuses } from '../registry/status';

describe('renderer-v2 specification provenance', () => {
  it('imports the authoritative tokens and preserves every skin variable rule', () => {
    const local = readFileSync(resolve('src/renderer-v2/styles/tokens.css'), 'utf8');
    const source = postcss.parse(readFileSync(resolve('ui-spec/work/modules/99-skin.css'), 'utf8'));
    expect(local).toContain('@import "../../../ui-spec/tokens.css"');
    source.each(node => {
      if (node.type === 'rule' && node.nodes.length && node.nodes.every(child => child.type === 'decl' && child.prop.startsWith('--'))) {
        expect(local).toContain(node.toString());
      }
    });
  });
  it('keeps component colors semantic without responsive breakpoints', () => {
    const css = readFileSync(resolve('src/renderer-v2/styles/components.css'), 'utf8');
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|@media|@container/i);
  });
  it('keeps the tool catalog consistent with supported installation and shared Codex configuration', () => {
    const codex = tools.find(tool => tool.id === 'codex')!;
    const desktop = tools.find(tool => tool.id === 'codexDesktop')!;
    const grok = tools.find(tool => tool.id === 'grok')!;
    expect(desktop.configPath).toEqual(codex.configPath);
    expect(desktop.keyWrite).toBe('toml');
    expect(grok.install).toEqual({ type: 'npm', pkg: '@xai-official/grok' });
    expect(tools.every(tool => tool.models === undefined)).toBe(true);
    expect(statuses.order.timeout).toEqual(['已超时', 'neutral']);
  });
});
