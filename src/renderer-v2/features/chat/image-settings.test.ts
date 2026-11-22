import { afterEach, describe, expect, it } from 'vitest'
import {
  applySharedImageSettings,
  defaultImageOptions,
  fitImageOptions,
  forgetSharedImageSettings,
  parseSharedImageSettings,
  readSharedImageSettings,
  sameSharedImageSettings,
  sharedImageSettingsOf,
  subscribeSharedImageSettings,
  writeSharedImageSettings,
  type SharedImageSettings,
} from './image-settings'
import { defaultChatSettings, type ChatSettings } from './state'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

const remembered: SharedImageSettings = { model: 'gpt-image-2', group: '图片模型', size: '1536x1024', quality: 'high', imageResolution: '2K' }
const key = 'xingmang-ui-v2:image-settings:solov:7'

function imageSettings(patch: Partial<ChatSettings> = {}): ChatSettings {
  return { ...defaultChatSettings(), mode: 'image', model: 'gpt-image-2', group: '图片模型', ...patch }
}

describe('shared image settings', () => {
  afterEach(() => forgetSharedImageSettings())

  it('starts from the defaults of a new conversation', () => {
    expect(defaultImageOptions()).toEqual({ size: '1024x1024', quality: 'low', imageResolution: '1K' })
  })

  it('reads what is stored on this computer as outside data', () => {
    expect(parseSharedImageSettings(JSON.stringify(remembered))).toEqual(remembered)
    expect(parseSharedImageSettings(JSON.stringify({ ...remembered, size: 'auto', extra: 'ignored' }))).toEqual({ ...remembered, size: 'auto' })
    for (const raw of [null, '', 'not json', 'null', '[]', '"text"', JSON.stringify({ ...remembered, model: '' }), JSON.stringify({ ...remembered, group: 7 }), JSON.stringify({ ...remembered, model: 'm'.repeat(201) }),
      JSON.stringify({ ...remembered, size: '1024' }), JSON.stringify({ ...remembered, size: '1024x1024; drop' }), JSON.stringify({ ...remembered, quality: 'ultra' }), JSON.stringify({ ...remembered, imageResolution: '8K' })]) {
      expect(parseSharedImageSettings(raw), String(raw)).toBeNull()
    }
  })

  it('keeps one record per account and tells whoever is listening when it changes', () => {
    const storage = memoryStorage()
    const heard: string[] = []
    const stop = subscribeSharedImageSettings((scope) => heard.push(scope))
    expect(readSharedImageSettings('solov:7', storage)).toBeNull()
    writeSharedImageSettings('solov:7', remembered, storage)
    expect(JSON.parse(storage.values.get(key) ?? 'null')).toEqual(remembered)
    expect(readSharedImageSettings('solov:7', storage)).toEqual(remembered)
    // Another account has its own record.
    expect(readSharedImageSettings('solov:8', storage)).toBeNull()
    // Writing the same thing again neither stores nor announces.
    writeSharedImageSettings('solov:7', { ...remembered }, storage)
    writeSharedImageSettings('solov:7', { ...remembered, quality: 'low' }, storage)
    expect(heard).toEqual(['solov:7', 'solov:7'])
    stop()
    writeSharedImageSettings('solov:7', remembered, storage)
    expect(heard).toHaveLength(2)
    // A record without a model or a group is not one.
    writeSharedImageSettings('solov:9', { ...remembered, model: '' }, storage)
    expect(readSharedImageSettings('solov:9', storage)).toBeNull()
  })

  it('reads the stored record after a restart and ignores a broken one', () => {
    expect(readSharedImageSettings('solov:7', memoryStorage({ [key]: JSON.stringify(remembered) }))).toEqual(remembered)
    forgetSharedImageSettings()
    expect(readSharedImageSettings('solov:7', memoryStorage({ [key]: '{"model":' }))).toBeNull()
  })

  it('still agrees within one run when the computer refuses to store anything', () => {
    const broken = { getItem: (): string | null => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
    expect(readSharedImageSettings('solov:7', broken)).toBeNull()
    writeSharedImageSettings('solov:7', remembered, broken)
    expect(readSharedImageSettings('solov:7', broken)).toEqual(remembered)
    expect(readSharedImageSettings('solov:7', null)).toEqual(remembered)
  })

  it('compares two records field by field', () => {
    expect(sameSharedImageSettings(null, null)).toBe(true)
    expect(sameSharedImageSettings(remembered, null)).toBe(false)
    expect(sameSharedImageSettings(remembered, { ...remembered })).toBe(true)
    expect(sameSharedImageSettings(remembered, { ...remembered, group: 'default' })).toBe(false)
  })

  it('takes the record from a conversation only while it is making pictures with a size the model accepts', () => {
    expect(sharedImageSettingsOf(imageSettings({ size: '1536x1024', quality: 'high', imageResolution: '2K' }))).toEqual(remembered)
    expect(sharedImageSettingsOf(imageSettings({ mode: 'text' }))).toBeNull()
    expect(sharedImageSettingsOf(imageSettings({ model: '' }))).toBeNull()
    expect(sharedImageSettingsOf(imageSettings({ group: '' }))).toBeNull()
    // A custom size still being typed is not remembered.
    expect(sharedImageSettingsOf(imageSettings({ size: '1000x' }))).toBeNull()
    expect(sharedImageSettingsOf(imageSettings({ size: '1000x1000' }))).toBeNull()
    // Quality and resolution the model does not take are remembered as its own defaults.
    expect(sharedImageSettingsOf(imageSettings({ model: 'gpt-image-1', quality: 'high', imageResolution: '4K' }))).toMatchObject({ quality: 'high', imageResolution: '1K' })
  })

  it('moves size, quality and resolution into what the model accepts', () => {
    expect(fitImageOptions('gpt-image-2', { size: '1536x1024', quality: 'high', imageResolution: '2K' })).toEqual({ size: '1536x1024', quality: 'high', imageResolution: '2K' })
    expect(fitImageOptions('grok-imagine-image', { size: '1536x1024', quality: 'high', imageResolution: '2K' })).toEqual({ size: 'auto', quality: 'auto', imageResolution: '1K' })
    expect(fitImageOptions('gemini-3.1-flash-image', { size: '1280x720', quality: 'low', imageResolution: '4K' })).toEqual({ size: '1280x720', quality: 'auto', imageResolution: '4K' })
    // Other fields ride along untouched; an unknown model is left for the main process to refuse.
    expect(fitImageOptions('gpt-image-1', { size: '720x1280', quality: 'low', imageResolution: '1K', model: 'gpt-image-1' })).toEqual({ size: '1024x1024', quality: 'low', imageResolution: '1K', model: 'gpt-image-1' })
    const odd = { size: '5x5', quality: 'high' as const, imageResolution: '4K' as const }
    expect(fitImageOptions('', odd)).toBe(odd)
    expect(fitImageOptions('gpt-5.6-sol', odd)).toBe(odd)
  })

  it('puts the record onto a picture conversation and leaves other modes alone', () => {
    const catalog = [{ model: 'gpt-image-2', groups: ['图片模型', 'default'] }, { model: 'grok-imagine-image', groups: ['default'] }]
    const context = { groups: [{ name: 'default', recommended: true }, { name: '图片模型', recommended: false, image: true }] }
    const current = imageSettings({ model: 'grok-imagine-image', group: 'default', size: 'auto', quality: 'auto' })
    expect(applySharedImageSettings(current, remembered, catalog, context)).toEqual({ ...current, ...remembered })
    // Nothing to change: the very same object comes back, so nothing is saved or redrawn.
    const same = imageSettings({ size: '1536x1024', quality: 'high', imageResolution: '2K' })
    expect(applySharedImageSettings(same, remembered, catalog, context)).toBe(same)
    expect(applySharedImageSettings(current, null, catalog, context)).toBe(current)
    const text = imageSettings({ mode: 'text', model: 'gpt-5.6-sol', group: 'default' })
    expect(applySharedImageSettings(text, remembered, catalog, context)).toBe(text)
    // The remembered group no longer carries the model: the conversation's own group if it does, else the picture group.
    expect(applySharedImageSettings(current, { ...remembered, group: '没了的分组' }, catalog, context)).toMatchObject({ model: 'gpt-image-2', group: 'default' })
    expect(applySharedImageSettings({ ...current, group: '也没了' }, { ...remembered, group: '没了的分组' }, catalog, context)).toMatchObject({ model: 'gpt-image-2', group: '图片模型' })
    // The remembered model is not on the list right now: the conversation keeps its own, the options still follow and are fitted to it.
    expect(applySharedImageSettings(current, { ...remembered, model: 'gone-image-model' }, catalog, context)).toEqual({ ...current, size: 'auto', quality: 'auto', imageResolution: '1K' })
    expect(applySharedImageSettings(imageSettings(), { ...remembered, model: 'gone-image-model' }, catalog, context)).toMatchObject({ model: 'gpt-image-2', group: '图片模型', size: '1536x1024', quality: 'high', imageResolution: '2K' })
  })
})
