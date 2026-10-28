import { describe, expect, it } from 'vitest'
import { inspectImageResolutionSelection } from './image-resolution-selection'

describe('image resolution selection', () => {
  it('preserves an unsupported saved selection when switching models', () => {
    const selected = { model: 'gpt-image-2', size: '1280x720', imageResolution: '4K' } as const
    expect(inspectImageResolutionSelection(selected)).toMatchObject({ value: '4K', supported: true })
    const changed = inspectImageResolutionSelection({ ...selected, model: 'gemini-3.1-flash-image' })
    expect(changed).toMatchObject({ value: '4K', supported: false })
    expect(changed.message).toContain('保留的 4K 当前不可用')
    expect(changed.choices.find((choice) => choice.value === '1K')?.supported).toBe(true)
    expect(selected.imageResolution).toBe('4K')
  })

  it('disables pixel-limited 4K for square output without altering the selected value', () => {
    const selection = inspectImageResolutionSelection({ model: 'gpt-image-2', size: '1024x1024', imageResolution: '4K' })
    expect(selection).toMatchObject({ value: '4K', supported: false })
    expect(selection.choices.find((choice) => choice.value === '4K')).toMatchObject({ supported: false, reason: expect.stringContaining('8,294,400') })
    expect(selection.choices.filter((choice) => choice.supported).map((choice) => choice.value)).toEqual(['1K', '2K'])
  })

  it('enables the saved 4K again after choosing a supported wide ratio', () => {
    const selection = inspectImageResolutionSelection({ model: 'gpt-image-2', size: '1280x720', imageResolution: '4K' })
    expect(selection).toMatchObject({ value: '4K', supported: true, message: null })
    expect(selection.choices.find((choice) => choice.value === '4K')).toMatchObject({ supported: true, effectiveSize: '3840x2160' })
  })

  it('uses the legacy default only when no resolution has been saved', () => {
    expect(inspectImageResolutionSelection({ model: 'gpt-image-2' })).toMatchObject({ value: '1K', supported: true })
    expect(inspectImageResolutionSelection({ model: '' })).toMatchObject({ value: '1K', supported: false })
  })

  it('preserves an unsupported ratio after switching to a fixed-size model', () => {
    const selection = inspectImageResolutionSelection({ model: 'gpt-image-1', size: '1280x720', imageResolution: '1K' })
    expect(selection).toMatchObject({ value: '1K', supported: false })
    expect(selection.effectiveSize).toBeUndefined()
    expect(selection.message).toContain('GPT Image 1 仅支持')
    expect(inspectImageResolutionSelection({ model: 'gpt-image-1', size: '1024x1024' })).toMatchObject({ value: '1K', supported: true, effectiveSize: '1024x1024' })
  })

  it.each(['grok-imagine-image', 'jimeng_high_aes_general_v21_L'])('does not promise pixels for provider-sized model %s', (model) => {
    const selection = inspectImageResolutionSelection({ model, size: '1280x720', imageResolution: '1K' })
    expect(selection).toMatchObject({ value: '1K', supported: true, providerSized: true })
    expect(selection.effectiveSize).toBeUndefined()
    expect(selection.choices[0].effectiveSize).toBeUndefined()
    expect(selection.message).toContain('由服务决定输出尺寸')
    const highResolution = inspectImageResolutionSelection({ model, size: '1280x720', imageResolution: '4K' })
    expect(highResolution).toMatchObject({ value: '4K', supported: false, providerSized: true })
    expect(highResolution.message).toContain('保留的 4K 当前不可用')
  })
})
