import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, Input, Menu, Pill, Progress, Segment, Switch, Tabs, Toast, toastDurationMs } from './components';
import { BrandIcon } from './brand';

describe('renderer-v2 component contract', () => {
  it('keeps short toasts at 2.4s and gives longer ones more time up to 10s', () => {
    expect(toastDurationMs('已复制')).toBe(2400);
    expect(toastDurationMs('一二三四五六七八九十一二')).toBe(2400);
    expect(toastDurationMs('一二三四五六七八九十一二三')).toBe(2600);
    expect(toastDurationMs('已切回官方账号，原来的配置已备份。', 'ok')).toBe(2400 + 5 * 200);
    expect(toastDurationMs('字'.repeat(200))).toBe(10000);
  });
  it('keeps warning and error toasts until they are closed', () => {
    expect(toastDurationMs('已复制', 'warn')).toBeNull();
    expect(toastDurationMs('已复制', 'bad')).toBeNull();
    const closable = renderToStaticMarkup(<Toast text="模型没换成" tone="warn" onDismiss={() => undefined} />);
    expect(closable).toContain('role="status"');
    expect(closable).toContain('aria-label="关闭"');
    expect(renderToStaticMarkup(<Toast text="已复制" tone="ok" />)).not.toContain('<button');
  });
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
  it('keeps the Caps Lock warning out of a password field until a key reports the lock', () => {
    const html = renderToStaticMarkup(<Input testId="login-password" password aria-label="密码" />);
    expect(html).toContain('data-testid="login-password"');
    expect(html).not.toContain('大写锁定已开启');
    expect(html).not.toContain('login-password-caps');
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
