import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, Input, Menu, Pill, Progress, Segment, Switch, Tabs } from './components';
import { BrandIcon } from './brand';

describe('renderer-v2 component contract', () => {
  it('透传 testId 并支持语义按钮状态', () => {
    const html = renderToStaticMarkup(<Button testId="button-save" variant="primary">保存</Button>);
    expect(html).toContain('data-testid="button-save"');
    expect(html).toContain('xm-btn-primary');
  });
  it('supports controlled fields and keyboard-friendly controls', () => {
    const html = renderToStaticMarkup(<><Input testId="input-name" aria-label="名称" /><Switch testId="switch" checked={false} onChange={() => undefined} label="通知" /><Segment testId="segment" options={[{ value: 'a', label: 'A' }]} value="a" onChange={() => undefined} /><Tabs testId="tabs" items={[{ value: 'a', label: 'A' }]} value="a" onChange={() => undefined} /></>);
    expect(html).toContain('data-testid="input-name"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('role="tablist"');
  });
  it('renders status and bounded progress', () => {
    const html = renderToStaticMarkup(<><Pill tone="ok" dot>已配好</Pill><Progress testId="progress" value={160} /></>);
    expect(html).toContain('已配好');
    expect(html).toContain('width:100%');
  });
  it('names an overflow menu after the row it acts on', () => {
    const html = renderToStaticMarkup(<Menu label="密钥 生产 Key 的更多操作" anchor={null} items={[{ label: '撤销密钥', danger: true, onSelect: () => undefined }]} />);
    expect(html).toContain('aria-label="密钥 生产 Key 的更多操作"');
    expect(html).not.toContain('aria-label="操作"');
  });
  it('resolves icons for provider models returned by the relay', () => {
    for (const model of ['deepseek-v4-flash', 'qwen3-max', 'glm-5', 'kimi-k2', 'minimax-m2']) {
      const html = renderToStaticMarkup(<BrandIcon model={model} />);
      expect(html, model).not.toContain('circle-help');
      expect(html, model).not.toContain('其他工具');
    }
  });
});
