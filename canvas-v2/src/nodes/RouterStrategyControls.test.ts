import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RouterStrategyControls, type RouterStrategyControlsProps } from './RouterStrategyControls'

function fixture(settings?: Record<string, unknown>, disabled = false) {
  const onChange = vi.fn(), props: RouterStrategyControlsProps = { settings, disabled, onChange }
  const element = RouterStrategyControls(props)
  const select = element.props.children.find((child: unknown) => isValidElement(child) && child.type === 'select')
  if (!isValidElement<{ onChange(event: { target: { value: string } }): void; disabled?: boolean }>(select)) throw new Error('Missing actual router strategy select')
  return { onChange, html: renderToStaticMarkup(element), choose(value: string) { select.props.onChange({ target: { value } }) } }
}

describe('explicit router strategy controls', () => {
  it.each([undefined, { strategy: 'first-available' }, { strategy: 'all' }])('shows actual legacy all behavior without writing new settings for %j', (settings) => {
    const before = structuredClone(settings), f = fixture(settings)
    expect(f.html).toContain('旧配置实际保留全部输入'); expect(f.html).toContain('value="legacy-all" disabled="" selected=""')
    expect(f.html).toContain('请明确选择后启用新策略'); expect(f.html).toContain('上游仍按原运行范围执行，可能产生费用')
    expect(f.onChange).not.toHaveBeenCalled(); expect(settings).toEqual(before)
  })
  it.each(['first-available', 'all'])('writes the versioned %s strategy only after the actual selection event', (strategy) => {
    const f = fixture({ strategy: 'first-available' }); f.choose(strategy)
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith({ routerStrategy: { version: 1, strategy } })
  })
  it('repairs an unrecognized historical selector only on an explicit supported choice', () => {
    const settings = { strategy: 'future-legacy', title: '保留的名称' }, f = fixture(settings)
    expect(f.html).toContain('旧策略字段无法核对'); expect(f.onChange).not.toHaveBeenCalled()
    f.choose('all'); expect(f.onChange).toHaveBeenCalledExactlyOnceWith({ routerStrategy: { version: 1, strategy: 'all' }, strategy: 'all' })
    expect(settings).toEqual({ strategy: 'future-legacy', title: '保留的名称' })
    const marked = fixture({ ...settings, routerStrategy: { version: 1, strategy: 'first-available' } })
    expect(marked.html).toContain('旧策略字段无法核对'); marked.choose('all')
    expect(marked.onChange).toHaveBeenCalledExactlyOnceWith({ routerStrategy: { version: 1, strategy: 'all' }, strategy: 'all' })
  })
  it('describes each media choice and saved edge order without promising upstream failover', () => {
    const f = fixture({ routerStrategy: { version: 1, strategy: 'first-available' } })
    expect(f.html).toContain('按保存的连线顺序'); expect(f.html).toContain('首段非空文本'); expect(f.html).toContain('图像、视频、音频各取首个素材'); expect(f.html).toContain('不提供失败容错')
    expect(fixture({ routerStrategy: { version: 1, strategy: 'all' } }).html).toContain('归一化后的全部文本及媒体输入')
  })
  it.each([null, undefined, { version: 2, strategy: 'all' }, { version: 1, strategy: 'unknown' }, { version: 1, strategy: 'all', future: true }])('keeps invalid versioned settings %j visible and blocks forged changes', (routerStrategy) => {
    const settings = { routerStrategy }, before = structuredClone(settings), f = fixture(settings)
    expect(f.html).toContain('策略无法核对，原值保留'); expect(f.html).toContain('role="alert"'); expect(f.html).toMatch(/aria-label="路由策略"[^>]*disabled=""/)
    f.choose('all'); expect(f.onChange).not.toHaveBeenCalled(); expect(settings).toEqual(before)
  })
  it('rejects forged changes when disabled or when the requested choice is unknown', () => {
    const blocked = fixture({ routerStrategy: { version: 1, strategy: 'all' } }, true); blocked.choose('first-available')
    const active = fixture(); active.choose('unknown'); active.choose('legacy-all')
    expect(blocked.onChange).not.toHaveBeenCalled(); expect(active.onChange).not.toHaveBeenCalled()
  })
})
