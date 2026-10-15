import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Search } from 'lucide-react';
import { Button, Card, Chips, ChoiceMenu, Input, Menu, Notice, Pill, Progress, Segment, Slider, Switch, Tabs, Toast, ToolRow, toastDurationMs } from './components';
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
  it('renders chips as a labelled group of toggle buttons with counts', () => {
    const html = renderToStaticMarkup(<Chips label="按类别筛选" testId="chips" value="b" onChange={() => undefined} options={[{ value: 'a', label: '全部', count: 3, testId: 'chip-a' }, { value: 'b', label: '入门', count: 0, leading: <i data-icon="" /> }]} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="按类别筛选"');
    expect(html).toContain('data-testid="chip-a"');
    expect(html).toContain('aria-pressed="false" data-testid="chip-a">全部<span class="xm-chip-count">3</span>');
    expect(html).toContain('<span class="xm-chip-lead" aria-hidden="true"><i data-icon=""></i></span>入门');
    expect(html).toContain('class="xm-chip has-leading" aria-pressed="true"');
    expect(html).toContain('入门<span class="xm-chip-count">0</span>');
  });
  it('keeps the Caps Lock warning out of a password field until a key reports the lock', () => {
    const html = renderToStaticMarkup(<Input testId="login-password" password aria-label="密码" />);
    expect(html).toContain('data-testid="login-password"');
    expect(html).not.toContain('大写锁定已开启');
    expect(html).not.toContain('login-password-caps');
  });
  it('marks errors and warnings with their own icon whatever icon the caller passed', () => {
    const icon = (tone: 'bad' | 'warn' | 'accent') => renderToStaticMarkup(<Notice tone={tone} icon={Search} title="标题" body="说明" />).match(/class="lucide [^"]*"/)?.[0];
    expect(icon('bad')).toBe('class="lucide lucide-circle-x"');
    expect(icon('warn')).toBe('class="lucide lucide-triangle-alert"');
    expect(icon('accent')).toBe('class="lucide lucide-search"');
  });
  it('keeps a short card note beside the title and moves a long one into the body', () => {
    const short = renderToStaticMarkup(<Card title="你的工具" meta="3 个已装"><p>行</p></Card>);
    expect(short).toContain('<h2>你的工具</h2><small title="3 个已装">3 个已装</small>');
    expect(short).not.toContain('xm-card-lead');
    const note = '用每个工具配置里真正写着的密钥和模型各测一次；装好的外部客户端也一起测。';
    const long = renderToStaticMarkup(<Card title="连接自检" meta={note}><p>行</p></Card>);
    expect(long).not.toContain('<small');
    expect(long).toContain('class="xm-card-body"><p class="xm-card-lead">' + note + '</p><p>行</p>');
  });
  it('renders status and bounded progress', () => {
    const html = renderToStaticMarkup(<><Pill tone="ok" dot>已配好</Pill><Progress testId="progress" value={160} /></>);
    expect(html).toContain('已配好');
    expect(html).toContain('width:100%');
  });
  it('puts the route first in a tool row subtitle so a long version cannot push it out of view', () => {
    const html = renderToStaticMarkup(<ToolRow tool="claude" status="ready" version="2.1.200（推荐 2.1.296）" route="线路2" model="claude-model" modelHint="说明" primaryAction={null} />);
    expect(html).toContain('>线路2 · v2.1.200（推荐 2.1.296） · claude-model</small>');
    expect(html).toContain('title="线路2 · v2.1.200（推荐 2.1.296） · claude-model\n说明"');
    expect(renderToStaticMarkup(<ToolRow tool="claude" status="ready" version="v2.1.0" model="claude-model" primaryAction={null} />)).toContain('>v2.1.0 · claude-model</small>');
  });
  it('names an overflow menu after the row it acts on', () => {
    const html = renderToStaticMarkup(<Menu label="密钥 生产 Key 的更多操作" anchor={null} items={[{ label: '撤销密钥', danger: true, onSelect: () => undefined }]} />);
    expect(html).toContain('aria-label="密钥 生产 Key 的更多操作"');
    expect(html).not.toContain('aria-label="操作"');
  });
  it('turns a button anchor into the trigger of a closed choice menu', () => {
    const html = renderToStaticMarkup(<ChoiceMenu label="分组和模型" anchor={<Button testId="picker">gpt-test</Button>} sections={[{ label: '分组', value: 'a', options: [{ value: 'a', label: 'a' }], onChange: () => undefined }]} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="picker"');
    expect(html).not.toContain('role="menu"');
  });
  it('shows an untouched slider as its placeholder while the thumb rests on the fallback', () => {
    const unset = renderToStaticMarkup(<Slider label="随机度" value="" fallback={1} min={0} max={2} step={0.1} placeholder="默认" hint="越高越有创意，越低越稳定" onChange={() => undefined} testId="temperature" />);
    expect(unset).toContain('data-unset="true"');
    expect(unset).toContain('>默认</b>');
    expect(unset).toContain('value="1"');
    expect(unset).toContain('aria-valuetext="默认"');
    expect(unset).toContain('越高越有创意，越低越稳定');
    const set = renderToStaticMarkup(<Slider label="随机度" value="0.7" fallback={1} min={0} max={2} step={0.1} placeholder="默认" onChange={() => undefined} />);
    expect(set).toContain('>0.7</b>');
    expect(set).not.toContain('data-unset');
    expect(set).not.toContain('aria-valuetext');
  });
  it('resolves icons for provider models returned by the relay', () => {
    for (const model of ['deepseek-v4-flash', 'qwen3-max', 'glm-5', 'kimi-k2', 'minimax-m2']) {
      const html = renderToStaticMarkup(<BrandIcon model={model} />);
      expect(html, model).not.toContain('circle-help');
      expect(html, model).not.toContain('其他工具');
    }
  });
});
