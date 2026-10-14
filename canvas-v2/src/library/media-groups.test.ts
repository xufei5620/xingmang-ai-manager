import { describe, expect, it } from 'vitest'
import {
  availableTextModels,
  defaultCanvasMediaPreferences,
  sub2ApiCanvasMediaPreferences,
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

  it('uses the existing NewAPI defaults on the legacy site', () => {
    expect(preferredMediaGroups([
      { name: 'GPT-image2' },
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

  it('selects exact Sub2API defaults and never initializes a video group', () => {
    const groups = [{ name: 'GPT-image2' }, { name: 'Gemini' }, { name: '视频模型-中转/订阅' }]
    expect(preferredMediaGroups(groups, 'solov-api')).toEqual({ image: 'GPT-image2', text: 'Gemini', imageModel: 'gpt-image-2', textModel: 'gemini-3.7-flash', videoModel: '' })
    expect(sub2ApiCanvasMediaPreferences.video).toBe('')
    expect(preferredMediaGroups([{ name: '其他组' }], 'solov-api').image).toBeUndefined()
  })

  it('falls back to nearby groups when the preferred names are missing', () => {
    expect(preferredMediaGroups([
      { name: '生图分组' },
      { name: 'grok' },
      { name: '对话分组' },
    ])).toMatchObject({ image: '生图分组', text: '对话分组' })
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
      text: 'Gemini-中转/订阅',
    })
  })

  // xm 站 2026-10 改名后的分组，老名字删掉以后站上剩下的就是这些。
  const renamedGroups = [
    { name: 'default' },
    { name: 'Claude-MAX' },
    { name: 'Claude-ANTI' },
    { name: 'Claude AWS-B' },
    { name: 'Claude-KIRO(高缓)' },
    { name: 'GPT' },
    { name: 'GPT-官方API直连' },
    { name: 'Grok' },
    { name: 'Grok-官方API直连' },
    { name: 'Gemini' },
    { name: '图片模型' },
    { name: '视频模型' },
  ]

  it('recognizes the renamed image and video groups once the old names are gone', () => {
    expect(preferredMediaGroups(renamedGroups)).toMatchObject({
      image: '图片模型',
      video: '视频模型',
      text: 'Gemini',
    })
  })

  it('keeps the old group names first while both names exist', () => {
    expect(preferredMediaGroups([
      ...renamedGroups,
      { name: '图片模型-中转/订阅' },
      { name: '视频模型-中转/订阅' },
      { name: 'Gemini-中转/订阅' },
    ])).toMatchObject({
      image: '图片模型-中转/订阅',
      video: '视频模型-中转/订阅',
      text: 'Gemini-中转/订阅',
    })
  })

  it('moves a project saved with the old names to the renamed groups', () => {
    expect(withPreferredMediaDefaults(
      { image: '图片模型-中转/订阅', video: '视频模型-中转/订阅', text: 'Gemini-中转/订阅' },
      renamedGroups,
    )).toMatchObject({
      image: '图片模型',
      video: '视频模型',
      text: 'Gemini',
    })
  })

  it('recognizes an image or video group by name only when exactly one group carries the word', () => {
    expect(preferredMediaGroups([{ name: 'Gemini' }, { name: '星芒图片' }, { name: '星芒视频' }]))
      .toMatchObject({ image: '星芒图片', video: '星芒视频' })
    expect(preferredMediaGroups([{ name: 'Gemini' }, { name: '视频-A' }, { name: '视频-B' }]).video)
      .toBeUndefined()
  })

  it('never prepares a Grok group for video nodes', () => {
    const withoutVideo = renamedGroups.filter((group) => group.name !== '视频模型')
    expect(preferredMediaGroups(withoutVideo).video).toBeUndefined()
    expect(preferredMediaGroups([{ name: 'grok' }, { name: 'Gemini' }]).video).toBeUndefined()
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
