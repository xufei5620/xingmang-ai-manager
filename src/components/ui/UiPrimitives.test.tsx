import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Download } from 'lucide-react'
import { Button, IconButton } from './Button'
import { Input, Password } from './Fields'
import { Checkbox, Switch } from './Choices'
import { Progress } from './Feedback'
import { adjacentOption, resolveUiSkin } from './types'

describe('UI foundation behavior contracts', () => {
  it('keeps the action name and prevents duplicate submits while loading', () => {
    const markup = renderToStaticMarkup(<Button loading icon={Download}>下载更新</Button>)
    expect(markup).toContain('下载更新')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('type="button"')
  })

  it('supports a balance-aware primary action without making the balance itself a credential or result source', () => {
    const markup = renderToStaticMarkup(<Button variant="balance" balanceTone="bad">充值</Button>)
    expect(markup).toContain('data-variant="balance"')
    expect(markup).toContain('data-balance-tone="bad"')
    expect(markup).toContain('>充值<')
  })

  it('gives icon actions an independent accessible name', () => {
    const markup = renderToStaticMarkup(<IconButton icon={Download} label="下载更新" />)
    expect(markup).toContain('aria-label="下载更新"')
    expect(markup).not.toContain('title="下载更新"')
  })

  it('associates labels, persistent hints and correctable errors without dropping caller descriptions', () => {
    const markup = renderToStaticMarkup(<Input id="account-name" label="账号名称" hint="保存在当前设备" error="请填写名称" aria-describedby="form-context" value="" readOnly />)
    expect(markup).toContain('for="account-name"')
    expect(markup).toContain('aria-describedby="form-context account-name-hint account-name-error"')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('id="account-name-error"')
    expect(markup).toContain('value=""')
  })

  it('masks credentials on the first render', () => {
    const markup = renderToStaticMarkup(<Password label="API Key" value="demo-only" readOnly />)
    expect(markup).toContain('type="password"')
    expect(markup).toContain('aria-pressed="false"')
  })

  it('exposes mixed selections and busy switches to assistive technology', () => {
    expect(renderToStaticMarkup(<Checkbox label="选择全部" indeterminate />)).toContain('aria-checked="mixed"')
    const markup = renderToStaticMarkup(<Switch label="通知" checked busy onChange={vi.fn()} />)
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('disabled=""')
  })

  it('does not fabricate a percentage for unknown or invalid progress', () => {
    const unknown = renderToStaticMarkup(<Progress label="检查环境" />)
    const invalid = renderToStaticMarkup(<Progress label="检查环境" value={Number.NaN} />)
    expect(unknown).not.toContain('value=')
    expect(invalid).not.toContain('value=')
    expect(renderToStaticMarkup(<Progress label="下载" value={150} />)).toContain('value="100"')
    expect(renderToStaticMarkup(<Progress label="下载" value={-10} />)).toContain('value="0"')
  })

  it('uses the two brand defaults while preserving explicit skin preference', () => {
    expect(resolveUiSkin('light')).toBe('dawn')
    expect(resolveUiSkin('dark')).toBe('obsidian')
    expect(resolveUiSkin('dark', 'auto')).toBe('obsidian')
    expect(resolveUiSkin('light', 'mist')).toBe('mist')
  })

  it('skips unavailable tabs, wraps and respects vertical navigation', () => {
    const options = [{ value: 'one', label: '一' }, { value: 'two', label: '二', disabled: true }, { value: 'three', label: '三' }]
    expect(adjacentOption(options, 'one', 'ArrowRight')).toBe('three')
    expect(adjacentOption(options, 'three', 'ArrowRight')).toBe('one')
    expect(adjacentOption(options, 'one', 'ArrowLeft')).toBe('three')
    expect(adjacentOption(options, 'three', 'Home')).toBe('one')
    expect(adjacentOption(options, 'one', 'End')).toBe('three')
    expect(adjacentOption(options, 'one', 'ArrowDown', 'vertical')).toBe('three')
    expect(adjacentOption(options, 'one', 'ArrowRight', 'vertical')).toBeNull()
    expect(adjacentOption(options.map((option) => ({ ...option, disabled: true })), 'one', 'Home')).toBeNull()
  })
})
