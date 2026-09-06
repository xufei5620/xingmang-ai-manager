import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { filterComboboxOptions } from './Combobox'
import { DateRange, validateDateRange } from './DateRange'
import { Segment, Tabs } from './Selection'
import { floatingPosition } from './Floating'

describe('shared interactive controls', () => {
  it('finds labels, identifiers and keywords without mutating the option set', () => {
    const options = [{ value: 'model-1', label: 'Alpha', keywords: '推理' }, { value: 'model-2', label: 'Beta', disabled: true }]
    expect(filterComboboxOptions(options, '推理')).toEqual([options[0]])
    expect(filterComboboxOptions(options, 'MODEL-2')).toEqual([options[1]])
    expect(options).toHaveLength(2)
  })
  it('rejects invalid calendar dates and reversed ranges while allowing partial filters', () => {
    expect(validateDateRange({ start: '2026-02-30', end: '' })).toBe('请输入有效日期')
    expect(validateDateRange({ start: '2026-09-07T11:00', end: '2026-09-07T10:00' })).toBe('开始时间不能晚于结束时间')
    expect(validateDateRange({ start: '', end: '2026-09-07' })).toBeUndefined()
  })
  it('keeps caller date limits when a prefilled selection falls outside the permitted range', () => {
    const value = { start: '2026-09-01', end: '2026-09-20' }
    expect(validateDateRange(value, { min: '2026-09-03', max: '2026-09-10' })).toBe('日期超出允许范围')
    const markup = renderToStaticMarkup(<DateRange label="日期" value={value} onChange={() => undefined} min="2026-09-03" max="2026-09-10" />)
    expect(markup.match(/min="2026-09-03"/g)).toHaveLength(2)
    expect(markup.match(/max="2026-09-10"/g)).toHaveLength(2)
    expect(markup).toContain('value="2026-09-20"')
    expect(markup).toContain('aria-invalid="true"')
  })
  it('retains a keyboard entry when a selected tab or segment is no longer available', () => {
    const items = [{ value: 'missing', label: '不可用', disabled: true, content: '旧内容' }, { value: 'available', label: '可用', content: '新内容' }]
    for (const value of ['missing', 'unknown']) {
      const tabs = renderToStaticMarkup(<Tabs label="页签" items={items} value={value} onChange={() => undefined} />)
      expect(tabs).toMatch(/tabindex="0"[^>]*>可用/)
      const segment = renderToStaticMarkup(<Segment label="筛选" options={items} value={value} onChange={() => undefined} />)
      expect(segment).toMatch(/tabindex="0"[^>]*>可用/)
    }
  })
  it('flips and bounds a popup next to the lower right edge', () => {
    const result = floatingPosition({ left: 850, top: 520, width: 80, height: 32 }, { width: 300, height: 200 }, { width: 960, height: 560 })
    expect(result.side).toBe('top')
    expect(result.left).toBeGreaterThanOrEqual(8)
    expect(result.left + 300).toBeLessThanOrEqual(952)
    expect(result.top + 200).toBeLessThan(520)
  })
})
