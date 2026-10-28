import { describe, expect, it } from 'vitest'
import { availableModelsForKind, availableTextModels, groupsForCapability, preferredMediaGroups, withPreferredMediaDefaults, withResolvedMediaModels } from './media-groups'
import { imageModelPresets, videoModelPresets } from '../models'

describe('provider purpose and model defaults', () => {
  it('prefers recognized image and text models in a shared provider catalog', () => {
    const models = ['gpt-4o-mini', 'gpt-image-1']
    expect(withResolvedMediaModels({ image: 'source', text: 'source' }, models, [], models)).toEqual({ image: 'source', text: 'source', imageModel: 'gpt-image-1', textModel: 'gpt-4o-mini' })
    expect(availableModelsForKind('image', models, ['image', 'text'])).toEqual(['gpt-image-1'])
  })

  it.each([
    { kind: 'image' as const, expected: ['gpt-image-1', 'unknown-relay-alias'] },
    { kind: 'video' as const, expected: ['grok-imagine-video', 'unknown-relay-alias'] },
    { kind: 'text' as const, expected: ['gpt-4o-mini', 'unknown-relay-alias', 'whisper-1'] },
  ])('filters known wrong-purpose entries from explicitly multi-purpose $kind catalogs', ({ kind, expected }) => {
    const models = ['gpt-4o-mini', 'gpt-image-1', 'grok-imagine-video', 'unknown-relay-alias', 'whisper-1', 'gpt-image-1', 'unknown-relay-alias']
    const original = [...models]
    expect(availableModelsForKind(kind, models, ['image', 'video', 'text'])).toEqual(expected)
    expect(availableModelsForKind(kind, models, [kind])).toEqual(expected)
    expect(availableModelsForKind(kind, models, [])).toEqual([])
    expect(models).toEqual(original)
  })

  it('retains preset inference without an explicit purpose and rejects a purpose absent from the source', () => {
    const models = ['gpt-4o-mini', 'gpt-image-1', 'grok-imagine-video', 'unknown-relay-alias']
    expect(availableModelsForKind('image', models)).toEqual(['gpt-image-1'])
    expect(availableModelsForKind('video', models)).toEqual(['grok-imagine-video'])
    expect(availableModelsForKind('text', models)).toEqual(['gpt-4o-mini', 'unknown-relay-alias'])
    expect(availableModelsForKind('image', models, ['video', 'text'])).toEqual([])
    expect(availableModelsForKind('video', models, ['image', 'text'])).toEqual([])
    expect(availableModelsForKind('text', models, ['image', 'video'])).toEqual([])
  })

  it('retains custom models only for explicitly declared purposes', () => {
    const models = ['custom-drawing', 'gpt-image-1']
    expect(availableModelsForKind('image', models, ['image'])).toEqual(models)
    expect(availableModelsForKind('text', models, ['image'])).toEqual([])
    expect(availableModelsForKind('image', models)).toEqual(['gpt-image-1'])
  })

  it('filters known media from text-purpose mixed catalogs while preserving custom chat aliases', () => {
    const media = [...imageModelPresets, ...videoModelPresets].map(model => model.id)
    const custom = ['custom-chat', 'provider/my-text-model', 'image-reasoning-chat', 'gpt-4o-mini']
    const models = [...media, 'relay/GPT-IMAGE-2', 'openai/gpt-image-1.5', 'xai/grok-imagine-image-2.0', 'minimax-h3-unknown-tier', ...custom, 'custom-chat']
    expect(availableTextModels(models)).toEqual(custom)
    expect(availableModelsForKind('text', models, ['text'])).toEqual(custom)
    expect(availableModelsForKind('text', models, ['image', 'text', 'video'])).toEqual(custom)
    expect(availableModelsForKind('text', models)).toEqual(custom)
  })

  it('does not resurrect a non-text model when the entire catalog has known media capabilities', () => {
    const models = ['gpt-image-1', 'gpt-image-2', 'grok-imagine-video', 'minimax-h3-base']
    expect(availableTextModels(models)).toEqual([])
    expect(availableModelsForKind('text', models, ['text'])).toEqual([])
    expect(withResolvedMediaModels({ text: 'mixed-source' }, [], [], models)).toEqual({ text: 'mixed-source' })
    // A persisted choice remains visible as unavailable; never silently select a
    // different model or rewrite a user's project after a catalog refresh.
    expect(withResolvedMediaModels({ text: 'mixed-source', textModel: 'gpt-image-1' }, [], [], models)).toEqual({ text: 'mixed-source', textModel: 'gpt-image-1' })
  })

  it('preserves an explicit available model choice and uses custom-only catalogs', () => {
    expect(withResolvedMediaModels({ imageModel: 'custom-drawing' }, ['custom-drawing', 'gpt-image-1'], [], ['custom-chat']).imageModel).toBe('custom-drawing')
    expect(withResolvedMediaModels({}, ['custom-drawing'], [], ['custom-chat'])).toEqual({ imageModel: 'custom-drawing', textModel: 'custom-chat' })
  })

  it('prefers a recognized text model before an unclassified model', () => {
    expect(withResolvedMediaModels({}, [], [], ['custom-unknown', 'gpt-image-1', 'gpt-4o-mini']).textModel).toBe('gpt-4o-mini')
  })

  it('does not fabricate models or select sources with incompatible purposes', () => {
    const groups = [{ name: 'image-source', purposes: ['image'] as const }, { name: 'chat-source', purposes: ['text'] as const }]
    expect(preferredMediaGroups(groups)).toEqual({ image: 'image-source', text: 'chat-source' })
    expect(groupsForCapability(groups, 'video')).toEqual([])
    expect(withResolvedMediaModels({}, [], [], [])).toEqual({})
  })

  it('retains a saved model after it is withdrawn rather than switching generation', () => {
    const saved = { image: 'source', imageModel: 'gpt-image-1', textModel: 'retired-chat' }
    expect(withResolvedMediaModels(saved, ['gpt-image-2'], [], ['gpt-4o-mini'])).toEqual(saved)
    expect(withResolvedMediaModels(saved, [], [], [])).toEqual(saved)
  })

  it('retains explicit sources when disabled, missing or their declared purpose changes', () => {
    const saved = { image: '生图分组', video: 'removed-source', text: 'changed-purpose', imageModel: 'saved-image' }
    const groups = [{ name: 'new-image', purposes: ['image'] as const }, { name: 'changed-purpose', purposes: ['video'] as const }]
    expect(withPreferredMediaDefaults(saved, groups)).toEqual(saved)
  })

  it('swaps a renamed default group only once a group list without purposes has been read', () => {
    const saved = { image: '生图分组', video: '视频分组', text: 'Gemini' }
    expect(withPreferredMediaDefaults(saved, [])).toEqual(saved)
    expect(withPreferredMediaDefaults(saved, [{ name: '图片模型' }, { name: '视频模型' }, { name: 'Gemini-3' }])).toEqual({ image: '图片模型', video: '视频模型', text: 'Gemini-3' })
    expect(withPreferredMediaDefaults(saved, [{ name: '生图分组' }, { name: '视频模型' }])).toMatchObject({ image: '生图分组', video: '视频模型' })
  })

  it('fills only empty fields and resolves defaults from the actual prepared catalog', () => {
    const groups = [{ name: 'source', purposes: ['image', 'text'] as const }]
    const filled = withPreferredMediaDefaults({ imageModel: '' }, groups)
    expect(filled).toEqual({ image: 'source', text: 'source' })
    expect(withResolvedMediaModels(filled, ['gpt-4o-mini', 'gpt-image-1'], [], ['gpt-4o-mini'])).toEqual({ image: 'source', text: 'source', imageModel: 'gpt-image-1', textModel: 'gpt-4o-mini' })
  })
})
