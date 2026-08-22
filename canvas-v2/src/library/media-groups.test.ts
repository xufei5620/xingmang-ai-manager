import { describe, expect, it } from 'vitest'
import {
  availableTextModels,
  defaultCanvasMediaPreferences,
  mediaGroupsEqual,
  mediaGroupsSignature,
  pickAvailableModel,
  preferredMediaGroups,
  preferredModelForNodeType,
  withPreferredMediaDefaults,
  withResolvedMediaModels,
} from './media-groups'

describe('media group defaults', () => {
  it('treats model changes as a real configuration change without re-preparing groups', () => {
    expect(mediaGroupsSignature({ image: '生图分组', video: 'grok', imageModel: 'a' }))
      .toBe(mediaGroupsSignature({ image: '生图分组', video: 'grok', imageModel: 'b' }))
    expect(mediaGroupsEqual(
      { image: '生图分组', imageModel: 'gpt-image-2' },
      { image: '生图分组', imageModel: 'gemini-3.1-flash-image' },
    )).toBe(false)
  })

  it('keeps a preferred model when the group still offers it', () => {
    expect(pickAvailableModel('gpt-image-2', ['gemini-3.1-flash-image', 'gpt-image-2'])).toBe('gpt-image-2')
    expect(pickAvailableModel('gone', ['gpt-image-2'])).toBe('gpt-image-2')
    expect(pickAvailableModel(undefined, [])).toBeUndefined()
  })

  it('lists chat models by excluding known image and video presets', () => {
    expect(availableTextModels(['gpt-image-2', 'grok-imagine-video', 'gpt-5.4'])).toEqual(['gpt-5.4'])
    expect(availableTextModels(['gpt-image-2'])).toEqual(['gpt-image-2'])
  })

  it('fills new image and video nodes from the configured defaults', () => {
    const groups = { imageModel: 'gpt-image-2', videoModel: 'minimax-h3-mini', textModel: 'gpt-5.4' }
    expect(preferredModelForNodeType('image-generate', groups)).toBe('gpt-image-2')
    expect(preferredModelForNodeType('video-generate', groups)).toBe('minimax-h3-mini')
    expect(preferredModelForNodeType('prompt', groups)).toBeUndefined()
    expect(preferredModelForNodeType('drama-parse', groups)).toBe('gpt-5.4')
  })

  it('defaults to the production image, video, and Gemini groups', () => {
    expect(preferredMediaGroups([
      { name: '图片模型-中转/订阅' },
      { name: '视频模型-中转/订阅' },
      { name: 'Gemini-中转/订阅' },
      { name: 'openai' },
      { name: '生图分组' },
      { name: 'grok' },
      { name: '视频分组' },
      { name: '对话分组' },
      { name: 'Gemini' },
    ])).toEqual({
      image: '图片模型-中转/订阅',
      video: '视频模型-中转/订阅',
      text: 'Gemini-中转/订阅',
      imageModel: defaultCanvasMediaPreferences.imageModel,
      videoModel: defaultCanvasMediaPreferences.videoModel,
      textModel: defaultCanvasMediaPreferences.textModel,
    })
  })

  it('falls back to nearby groups when the preferred names are missing', () => {
    expect(preferredMediaGroups([
      { name: '生图分组' },
      { name: 'grok' },
      { name: '对话分组' },
    ])).toMatchObject({ image: '生图分组', video: 'grok', text: '对话分组' })
  })

  it('does not pretend an image group is a text group', () => {
    expect(preferredMediaGroups([
      { name: '生图分组' },
      { name: '视频分组' },
    ]).text).toBeUndefined()
  })

  it('fills missing text defaults without overwriting an existing project selection', () => {
    expect(withPreferredMediaDefaults(
      { image: '生图分组', video: '视频分组' },
      [{ name: '生图分组' }, { name: '视频分组' }, { name: 'Gemini' }],
    )).toEqual({
      image: '生图分组',
      video: '视频分组',
      text: 'Gemini',
      imageModel: defaultCanvasMediaPreferences.imageModel,
      videoModel: defaultCanvasMediaPreferences.videoModel,
      textModel: defaultCanvasMediaPreferences.textModel,
    })
    expect(withPreferredMediaDefaults(
      { image: 'openai', video: 'grok', text: '对话分组', videoModel: 'grok-imagine-video' },
      [{ name: 'openai' }, { name: 'grok' }, { name: '对话分组' }, { name: 'Gemini' }],
    )).toMatchObject({
      image: 'openai',
      video: 'grok',
      text: '对话分组',
      videoModel: 'grok-imagine-video',
    })
  })

  it('migrates historical default groups when the production names changed', () => {
    expect(withPreferredMediaDefaults(
      { image: '生图分组', video: '视频分组', text: 'Gemini' },
      [
        { name: '图片模型-中转/订阅' },
        { name: '视频模型-中转/订阅' },
        { name: 'Gemini-中转/订阅' },
      ],
    )).toMatchObject({
      image: '图片模型-中转/订阅',
      video: '视频模型-中转/订阅',
      text: 'Gemini-中转/订阅',
    })
  })

  it('repairs a stale default model after the group changes', () => {
    expect(withResolvedMediaModels(
      { image: '生图分组', imageModel: 'gone' },
      ['gpt-image-2'],
      [],
      [],
    )).toEqual({ image: '生图分组', imageModel: 'gpt-image-2' })
  })
})
