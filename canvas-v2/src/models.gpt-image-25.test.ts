import { describe, expect, it } from 'vitest'
import { v2EquivalentCapabilities } from './host-capabilities'
import { availableModelsForKind, withPreferredMediaDefaults, withResolvedMediaModels } from './library/media-groups'
import { availableImageModelPresets, defaultImageModel, imageModelPreset, imageModelPresets } from './models'

// 画布里用不了 gpt-image-2.5-flare（桌面「完善无限画布」第 1 条）：xm 的图片分组开着 gpt-image-2、2.5-flare、2.5-sunburst，
// 画布下拉只认内核型号表，只剩「GPT Image 2(推荐)」一项。下拉的字是 yoyo 11-09 回「型号改」批的那三行。
const xmImageGroup = ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']

describe('GPT Image 2.5 presets', () => {
  it('lists Flare first, then GPT Image 2, then Sunburst, with the approved labels', () => {
    expect(imageModelPresets.slice(0, 3).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare(推荐)' },
      { id: 'gpt-image-2', label: 'GPT Image 2' },
      { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
    ])
    expect(imageModelPresets.filter((preset) => preset.label.includes('推荐')).map((preset) => preset.id)).toEqual(['gpt-image-2.5-flare'])
  })

  it('offers all three models of the xm image group in that order, whatever order the account lists them in', () => {
    // 桌面的分组不声明用途，生图下拉 = 内核型号表和分组型号的交集。
    expect(availableModelsForKind('image', xmImageGroup)).toEqual(['gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-2.5-sunburst'])
    expect(availableImageModelPresets(xmImageGroup, true).map((preset) => preset.label)).toEqual(['GPT Image 2.5 Flare(推荐)', 'GPT Image 2', 'GPT Image 2.5 Sunburst'])
  })

  it('defaults a new project to Flare when the group has it, and to GPT Image 2 when it does not', () => {
    const fresh = withPreferredMediaDefaults({}, [{ name: '图片模型' }, { name: 'Gemini' }])
    expect(withResolvedMediaModels(fresh, xmImageGroup, [], []).imageModel).toBe('gpt-image-2.5-flare')
    const legacy = withPreferredMediaDefaults({}, [{ name: 'GPT-image2' }, { name: 'Gemini' }], 'solov-api')
    expect(withResolvedMediaModels(legacy, ['gpt-image-2'], [], []).imageModel).toBe('gpt-image-2')
  })

  it('keeps the model an existing project already saved', () => {
    expect(withResolvedMediaModels({ image: '图片模型', imageModel: 'gpt-image-2' }, xmImageGroup, [], []).imageModel).toBe('gpt-image-2')
  })

  it('still lays nodes out for GPT Image 2 while the account models are not known', () => {
    expect(defaultImageModel).toBe('gpt-image-2')
  })

  it('treats the 2.5 models like GPT Image 2 for sizes, quality and edits', () => {
    const base = imageModelPreset('gpt-image-2')
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      expect(imageModelPreset(id)).toMatchObject({ sizes: base.sizes, supportsSize: true, supportsQuality: true, supportsEdits: true })
    }
  })

  it('gives a host the clarity tiers it declares and the web only what its request builder implements', () => {
    // 桌面声明「其他 gpt-image-*」有 1K/2K/4K，主进程按 gpt-image-2 的规矩换算尺寸（桌面 ai-chat-protocol.ts）。
    const desktop = imageModelPreset('gpt-image-2.5-flare', v2EquivalentCapabilities)
    expect(desktop.resolutions).toEqual(['1K', '2K', '4K'])
    expect(desktop.resolutionNote).toBeUndefined()
    const web = imageModelPreset('gpt-image-2.5-flare')
    expect(web.resolutions).toEqual(['1K'])
    expect(web.resolutionNote).toContain('暂仅开放 1K')
  })

  it('keeps unlisted GPT Image 2 snapshots on the GPT Image 2 template rather than the first preset', () => {
    const snapshot = imageModelPreset('gpt-image-2-2026-04-21')
    expect(snapshot).toMatchObject({ label: 'gpt-image-2-2026-04-21', resolutions: ['1K', '2K', '4K'] })
    expect(snapshot.resolutionNote).toContain('GPT Image 2 的 4K')
  })
})
