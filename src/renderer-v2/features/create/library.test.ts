import { describe, expect, it } from 'vitest'
import type { AiChatAsset, AiLibraryEntry, AiVideoClip } from '../../../../electron/ipc-contract'
import { createConversation, type ChatMessage, type Conversation } from '../chat/state'
import type { VideoStudioItem } from '../video-studio/library'
import { createVideoStudioProject, type VideoStudioShot } from '../video-studio/project'
import {
  buildLibraryOrigins, cleanLibrarySearch, libraryBadge, libraryCaption, libraryChatAsset, libraryClipMade, libraryClipSource, libraryDetailLine, libraryFilmAssetIds,
  libraryKindCount, libraryMatchedAssetIds, libraryTitle, libraryVideoClip, maxLibraryMatchedIds, maxLibrarySearchLength,
} from './library'

const now = new Date(2026, 10, 21, 15, 0).getTime()

function id(seed: string): string {
  return seed.padEnd(43, '0').slice(0, 43)
}

function image(seed: string, size?: { width: number, height: number }): AiChatAsset {
  return { assetId: id(seed), localUrl: `xingmang-asset://image/${id(seed)}`, mimeType: 'image/png', fileName: `xingmang-${id(seed)}.png`, ...size }
}

function clip(seed: string, extra: Partial<AiVideoClip> = {}): AiVideoClip {
  return { assetId: id(seed), thumbnailUrl: `xingmang-asset://thumb/v2/video/${id(seed)}`, ...extra }
}

let messageNumber = 0
function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `m${++messageNumber}`, role, content, reasoning: '', status: 'complete', createdAt: now, ...extra }
}

function conversation(conversationId: string, title: string, messages: ChatMessage[]): Conversation {
  return { ...createConversation(undefined, conversationId), title, messages }
}

function film(filmId: string, name: string, shots: Array<Partial<VideoStudioShot>>, exported?: AiVideoClip): VideoStudioItem {
  const project = createVideoStudioProject()
  return { id: filmId, name, updatedAt: now, project: { ...project, shots: shots.map((shot, index) => ({ id: `s${index}`, prompt: '', caption: '', status: 'idle', ...shot })), ...(exported ? { exported } : {}) } }
}

function entry(seed: string, mediaType: AiLibraryEntry['mediaType'], extra: Partial<AiLibraryEntry> = {}): AiLibraryEntry {
  return { assetId: id(seed), mediaType, createdAt: new Date(now - 58 * 60 * 1000).toISOString(), fileName: `xingmang-${id(seed)}.${mediaType === 'video' ? 'mp4' : 'png'}`, ...(mediaType === 'image' ? { mimeType: 'image/png' as const } : {}), ...extra }
}

describe('where a thing in the library came from', () => {
  it('ties a generated picture and a generated clip to the conversation and to the sentence that asked for them', () => {
    const origins = buildLibraryOrigins([conversation('c1', '橘猫', [
      message('user', '一只橘猫在下雨的街头'),
      message('assistant', '', { assets: [image('cat', { width: 1024, height: 1024 })] }),
      message('user', '让它动起来', { assets: [image('start')] }),
      message('assistant', '', { video: { clip: clip('walk', { width: 1280, height: 720, durationSeconds: 5 }) }, settings: { ...createConversation().settings, mode: 'video', model: 'grok-imagine-video', group: 'Grok' } }),
    ])], [])
    expect(origins.get(id('cat'))).toEqual({ from: 'chat', id: 'c1', title: '橘猫', prompt: '一只橘猫在下雨的街头', width: 1024, height: 1024 })
    expect(origins.get(id('walk'))).toMatchObject({ from: 'chat', id: 'c1', prompt: '让它动起来', imageAssetId: id('start'), made: { aspect: '16:9', model: 'grok-imagine-video', group: 'Grok', seconds: 5 } })
    // 客户自己发的那张图也在作品库里：记成在这段对话里用过。他那句话说的是拿它做什么，不当成这张图的描述。
    expect(origins.get(id('start'))).toEqual({ from: 'chat', used: true, id: 'c1', title: '橘猫', prompt: '' })
  })

  it('ties shot pictures, shot clips and the finished film to the film they belong to', () => {
    const origins = buildLibraryOrigins([], [film('f1', '橘猫回家', [
      { prompt: '雨夜街头', clip: clip('shot1', { durationSeconds: 6 }), image: { assetId: id('still1'), url: '' } },
      { prompt: '家门口' },
    ], clip('final', { durationSeconds: 15 }))])
    expect(origins.get(id('shot1'))).toMatchObject({ from: 'video', id: 'f1', title: '橘猫回家', prompt: '雨夜街头', imageAssetId: id('still1') })
    expect(origins.get(id('shot1'))).not.toHaveProperty('used')
    // 开头图分不出是给这一镜画的还是选来的：按在这条视频里用过算，描述是这一镜的那句。
    expect(origins.get(id('still1'))).toEqual({ from: 'video', used: true, id: 'f1', title: '橘猫回家', prompt: '雨夜街头' })
    expect(origins.get(id('final'))).toMatchObject({ from: 'video', id: 'f1', prompt: '', clip: { durationSeconds: 15 } })
    expect(origins.get(id('final'))).not.toHaveProperty('used')
  })

  it('credits a clip to the film that generated it, not to a film that only borrowed it', () => {
    const shared = clip('shared', { durationSeconds: 6 })
    const borrower = film('borrower', '合集', [{ prompt: '借来的那一段', clip: shared, borrowed: true }])
    const maker = film('maker', '橘猫回家', [{ prompt: '雨夜街头', clip: shared }])
    // 借用它的那条排在前面（最近动过），出处还是生成它的那条。
    expect(buildLibraryOrigins([], [borrower, maker]).get(id('shared'))).toMatchObject({ from: 'video', id: 'maker', prompt: '雨夜街头' })
    expect(buildLibraryOrigins([], [borrower, maker]).get(id('shared'))).not.toHaveProperty('used')
    // 生成它的那条删掉以后，只剩用过它的那条。
    expect(buildLibraryOrigins([], [borrower]).get(id('shared'))).toMatchObject({ from: 'video', used: true, id: 'borrower', prompt: '借来的那一段', clip: shared })
    // 对话里客户自己发过、后来又选作开头图的那张：镜头那一处排在对话前面。
    const picked = buildLibraryOrigins(
      [conversation('c1', '发过图', [message('user', '看看这张', { assets: [image('photo')] })])],
      [film('f1', '新品', [{ prompt: '口红特写', image: { assetId: id('photo'), url: '' } }])],
    )
    expect(picked.get(id('photo'))).toMatchObject({ from: 'video', used: true, id: 'f1', prompt: '口红特写' })
  })

  it('credits the place a thing was made over the places it was later used', () => {
    const made = clip('walk')
    const origins = buildLibraryOrigins(
      [
        // 在另一段对话里又发了一次那张 AI 画的图：还是算它画出来的那段。
        conversation('later', '后来', [message('user', '照这张再来', { assets: [image('cat')] })]),
        conversation('first', '最早', [message('user', '画一只猫'), message('assistant', '', { assets: [image('cat')] }), message('user', '动起来'), message('assistant', '', { video: { clip: made } })]),
      ],
      // 那段视频后来加进了一条视频：出处还是那段对话。
      [film('f1', '合集', [{ prompt: '别的话', clip: made }])],
    )
    expect(origins.get(id('cat'))).toMatchObject({ from: 'chat', id: 'first', prompt: '画一只猫' })
    expect(origins.get(id('walk'))).toMatchObject({ from: 'chat', id: 'first', prompt: '动起来' })
  })

  it('names each film\'s latest finished cut once, for the main process to count', () => {
    const cut = clip('final')
    expect(libraryFilmAssetIds([film('f1', 'a', [], cut), film('f2', 'b', []), film('f3', 'c', [], cut), film('f4', 'd', [], clip('other'))])).toEqual([id('final'), id('other')])
  })
})

describe('searching the library by what was written', () => {
  const origins = buildLibraryOrigins(
    [conversation('c1', '橘猫日常', [message('user', '一只橘猫在下雨的街头'), message('assistant', '', { assets: [image('cat')] }), message('user', 'A Sunset over the SEA'), message('assistant', '', { assets: [image('sea')] })])],
    [film('f1', '海边旅行', [{ prompt: '浪花', clip: clip('wave') }])],
  )

  it('finds things by the sentence that asked for them or by the name of the conversation or film, whatever the case', () => {
    expect(libraryMatchedAssetIds(origins, '下雨')).toEqual([id('cat')])
    expect(libraryMatchedAssetIds(origins, 'sunset')).toEqual([id('sea')])
    expect(libraryMatchedAssetIds(origins, '橘猫日常').sort()).toEqual([id('cat'), id('sea')].sort())
    expect(libraryMatchedAssetIds(origins, '海边')).toEqual([id('wave')])
    expect(libraryMatchedAssetIds(origins, '没有这个词')).toEqual([])
    expect(libraryMatchedAssetIds(origins, '   ')).toEqual([])
  })

  it('never hands the main process more than it accepts', () => {
    const many = new Map(Array.from({ length: maxLibraryMatchedIds + 50 }, (_, index) => [id(`a${index}-`), { from: 'chat' as const, id: 'c', title: 't', prompt: '同一句话' }]))
    expect(libraryMatchedAssetIds(many, '同一句')).toHaveLength(maxLibraryMatchedIds)
    expect(cleanLibrarySearch(`  ${'字'.repeat(maxLibrarySearchLength + 20)}  `)).toHaveLength(maxLibrarySearchLength)
    // 粘贴带进来的控制字符主进程见到会整句拒掉，先换成空格。
    expect(cleanLibrarySearch('橘\u0007猫\n')).toBe('橘 猫')
  })
})

describe('the words on a library tile and on the opened item', () => {
  const chatOrigin = { from: 'chat' as const, id: 'c1', title: '一只橘猫在下雨的街头，夜晚，暖色灯光，电影感，还有很长的后半句', prompt: '一只橘猫在下雨的街头' }

  it('says where it came from and when under each tile, and only when if the source is unknown', () => {
    expect(libraryCaption(entry('cat', 'image'), chatOrigin, now)).toBe('对话 · 今天 14:02')
    expect(libraryCaption(entry('wave', 'video'), { from: 'video', id: 'f1', title: '海边', prompt: '' }, now)).toBe('视频 · 今天 14:02')
    expect(libraryCaption(entry('cat', 'image'), undefined, now)).toBe('今天 14:02')
    expect(libraryCaption(entry('cat', 'image', { createdAt: 'not a time' }), undefined, now)).toBe('')
  })

  it('writes the line under the opened item from what is known, leaving out what is not', () => {
    expect(libraryDetailLine(entry('cat', 'image'), chatOrigin, { width: 1024, height: 1024 }, now)).toBe('出自对话「一只橘猫在下雨的街头，夜晚，暖色灯光，电影感，还…」 · 今天 14:02 · 1024 × 1024')
    expect(libraryDetailLine(entry('wave', 'video'), { from: 'video', id: 'f1', title: '海边旅行', prompt: '' }, null, now)).toBe('出自视频「海边旅行」 · 今天 14:02')
    expect(libraryDetailLine(entry('cat', 'image'), undefined, { width: 800 }, now)).toBe('今天 14:02')
    // 只是在那里用过的不说「出自」。
    expect(libraryDetailLine(entry('photo', 'image'), { from: 'chat', used: true, id: 'c1', title: '发过图', prompt: '' }, null, now)).toBe('用于对话「发过图」 · 今天 14:02')
    expect(libraryDetailLine(entry('still', 'image'), { from: 'video', used: true, id: 'f1', title: '新品', prompt: '口红特写' }, null, now)).toBe('用于视频「新品」 · 今天 14:02')
  })

  it('titles the opened item with the name the customer gave it, else the sentence that asked for it, else its kind', () => {
    expect(libraryTitle(entry('cat', 'image'), chatOrigin, false)).toBe('一只橘猫在下雨的街头')
    expect(libraryTitle(entry('cat', 'image', { prompt: '画布里写的那句' }), undefined, false)).toBe('画布里写的那句')
    expect(libraryTitle(entry('cat', 'image', { name: '封面图' }), undefined, false)).toBe('封面图')
    expect(libraryTitle(entry('cat', 'image', { name: '封面图', prompt: '画布里写的那句' }), chatOrigin, false)).toBe('封面图')
    expect(libraryTitle(entry('cat', 'image'), undefined, false)).toBe('图片')
    expect(libraryTitle(entry('wave', 'video'), undefined, false)).toBe('视频')
    expect(libraryTitle(entry('final', 'video'), { from: 'video', id: 'f1', title: '海边旅行', prompt: '' }, true)).toBe('海边旅行')
    expect(libraryTitle(entry('final', 'video'), undefined, true)).toBe('成片')
    expect(libraryTitle(entry('cat', 'image', { prompt: `${'很长'.repeat(40)}` }), undefined, false)).toHaveLength(61)
  })

  it('marks a video tile with its length when known, and a finished film as one', () => {
    const known = { from: 'video' as const, id: 'f1', title: 't', prompt: '', clip: clip('x', { durationSeconds: 75.2 }) }
    expect(libraryBadge(known, false)).toBe('1:15')
    expect(libraryBadge(known, true)).toBe('成片 1:15')
    expect(libraryBadge(undefined, true)).toBe('成片')
    expect(libraryBadge(undefined, false)).toBe('')
  })

  it('counts everything as pictures plus videos, since a finished film is one of the videos', () => {
    const counts = { image: 96, video: 32, film: 8 }
    expect([libraryKindCount(counts, 'all'), libraryKindCount(counts, 'image'), libraryKindCount(counts, 'video'), libraryKindCount(counts, 'clip'), libraryKindCount(counts, 'film')]).toEqual([128, 96, 32, 24, 8])
  })
})

describe('handing a library item to the chat box or to a film', () => {
  it('turns a picture into what the chat box takes, and refuses a video or a picture of unknown type', () => {
    expect(libraryChatAsset(entry('cat', 'image'), { from: 'chat', id: 'c', title: 't', prompt: '', width: 1024, height: 768 })).toEqual({ assetId: id('cat'), localUrl: `xingmang-asset://image/${id('cat')}`, mimeType: 'image/png', fileName: `xingmang-${id('cat')}.png`, width: 1024, height: 768 })
    expect(libraryChatAsset(entry('wave', 'video'))).toBeNull()
    const { mimeType: _mimeType, ...untyped } = entry('cat', 'image')
    expect(libraryChatAsset(untyped)).toBeNull()
  })

  it('prefers the size and length the main process measured, then what the page measured, and writes nothing it does not know', () => {
    const recorded = { from: 'chat' as const, id: 'c', title: 't', prompt: '动起来', clip: clip('walk', { width: 1280, height: 720, durationSeconds: 5 }), imageAssetId: id('start') }
    expect(libraryVideoClip(entry('walk', 'video'), recorded, { width: 640, height: 360, durationSeconds: 4.9 })).toEqual({ assetId: id('walk'), thumbnailUrl: `xingmang-asset://thumb/v2/video/${id('walk')}`, width: 1280, height: 720, durationSeconds: 5 })
    expect(libraryVideoClip(entry('walk', 'video'), undefined, { width: 640, height: 360, durationSeconds: 4.9 })).toMatchObject({ width: 640, height: 360, durationSeconds: 4.9 })
    expect(libraryVideoClip(entry('walk', 'video'), undefined, { width: 0, height: Number.NaN, durationSeconds: Number.POSITIVE_INFINITY })).toEqual({ assetId: id('walk'), thumbnailUrl: `xingmang-asset://thumb/v2/video/${id('walk')}` })
    expect(libraryClipSource(entry('walk', 'video'), recorded)).toMatchObject({ prompt: '动起来', imageAssetId: id('start'), clip: { assetId: id('walk') } })
    expect(libraryClipSource(entry('walk', 'video', { prompt: '画布里的话' }))).toEqual({ prompt: '画布里的话', clip: { assetId: id('walk'), thumbnailUrl: `xingmang-asset://thumb/v2/video/${id('walk')}` } })
  })

  it('starts a new film in the shape of the clip, and leaves the model for the studio to pick when it is not known', () => {
    expect(libraryClipMade(clip('tall', { width: 720, height: 1280, durationSeconds: 8.4 }))).toEqual({ aspect: '9:16', model: '', group: '', seconds: 8 })
    expect(libraryClipMade(clip('square', { width: 512, height: 512 }))).toEqual({ aspect: '1:1', model: '', group: '', seconds: 5 })
    expect(libraryClipMade(clip('unknown'))).toEqual({ aspect: '16:9', model: '', group: '', seconds: 5 })
    const made = { aspect: '9:16' as const, model: 'grok-imagine-video', group: 'Grok', seconds: 6 }
    expect(libraryClipMade(clip('walk'), { from: 'chat', id: 'c', title: 't', prompt: '', made })).toBe(made)
  })
})
