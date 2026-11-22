import { describe, expect, it } from 'vitest'
import { anonymousUsageFrom, dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom, worksCount, worksExportQuestion } from './data-transfer'

describe('data transfer wording', () => {
  it('names the saved file and what is in it', () => {
    expect(dataTransferExportMessage({ outputPath: 'C:\\Users\\a\\Desktop\\星芒聊天记录与设置-2026-09-25.json', conversations: 23 }))
      .toBe('已保存「星芒聊天记录与设置-2026-09-25.json」，包含 23 个对话及设置。复制到新电脑后，请在此点击「导入」。')
    expect(dataTransferExportMessage({ outputPath: '/Users/a/Desktop/x.json', conversations: 0 })).toContain('包含设置')
  })

  it('says what the import actually did', () => {
    expect(dataTransferImportMessage({ fileConversations: 23, added: 23, updated: 0, skipped: 0, signedIn: true, settingsChanged: true })).toBe('已导入 23 个对话及设置。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 0, signedIn: true, settingsChanged: false })).toBe('文件中的对话均已存在于本机。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: true })).toBe('设置已导入。文件中的 3 个对话需登录后再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 0, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: false })).toBe('文件中的设置与本机一致，无需修改。')
  })

  it('says how many conversations did not fit instead of claiming they are all here', () => {
    expect(dataTransferImportMessage({ fileConversations: 10, added: 4, updated: 0, skipped: 6, signedIn: true, settingsChanged: true }))
      .toBe('已导入 4 个对话及设置。另有 6 个未导入：本机最多保存 200 个对话，请在「创作」中删除部分不需要的记录，再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 10, added: 4, updated: 0, skipped: 6, signedIn: true, settingsChanged: false }))
      .toBe('已导入 4 个对话。另有 6 个未导入：本机最多保存 200 个对话，请在「创作」中删除部分不需要的记录，再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 3, signedIn: true, settingsChanged: true }))
      .toBe('设置已导入。本机已保存 200 个对话（已达上限），文件中的 3 个对话未导入。请在「创作」中删除部分不需要的记录，再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 2, signedIn: true, settingsChanged: false }))
      .toBe('本机已保存 200 个对话（已达上限），文件中的 2 个对话未导入。请在「创作」中删除部分不需要的记录，再次点击「导入」。')
  })

  it('says how many conversations were brought up to date by a second import', () => {
    // X-4：先导一次、旧电脑接着聊几天再导一次。
    expect(dataTransferImportMessage({ fileConversations: 5, added: 2, updated: 1, skipped: 0, signedIn: true, settingsChanged: false }))
      .toBe('已导入 2 个对话，另有 1 个对话已更新为文件中的内容。')
    expect(dataTransferImportMessage({ fileConversations: 5, added: 0, updated: 3, skipped: 0, signedIn: true, settingsChanged: false }))
      .toBe('3 个对话已更新为文件中的内容，其余已存在于本机。')
    expect(dataTransferImportMessage({ fileConversations: 5, added: 2, updated: 1, skipped: 0, signedIn: true, settingsChanged: true }))
      .toBe('已导入 2 个对话及设置，另有 1 个对话已更新为文件中的内容。')
    expect(dataTransferImportMessage({ fileConversations: 5, added: 0, updated: 3, skipped: 0, signedIn: true, settingsChanged: true }))
      .toBe('3 个对话已更新为文件中的内容，其余已存在于本机，设置已导入。')
    // 文件中的对话全都更新了，没有「其余」。
    expect(dataTransferImportMessage({ fileConversations: 2, added: 0, updated: 2, skipped: 0, signedIn: true, settingsChanged: false }))
      .toBe('2 个对话已更新为文件中的内容。')
    expect(dataTransferImportMessage({ fileConversations: 10, added: 4, updated: 1, skipped: 5, signedIn: true, settingsChanged: false }))
      .toBe('已导入 4 个对话，另有 1 个对话已更新为文件中的内容。另有 5 个未导入：本机最多保存 200 个对话，请在「创作」中删除部分不需要的记录，再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 4, added: 0, updated: 1, skipped: 3, signedIn: true, settingsChanged: false }))
      .toBe('1 个对话已更新为文件中的内容。本机已保存 200 个对话（已达上限），文件中的 3 个对话未导入。请在「创作」中删除部分不需要的记录，再次点击「导入」。')
  })

  // 「搬作品改」（yoyo 2026-11-22）批的字。
  it('names the videos and the works an export carried', () => {
    expect(dataTransferExportMessage({ outputPath: '/Users/a/Downloads/星芒聊天记录与设置-2026-11-22.json', conversations: 3, videoProjects: 2 }))
      .toBe('已保存「星芒聊天记录与设置-2026-11-22.json」，包含 3 个对话、2 条视频及设置。复制到新电脑后，请在此点击「导入」。')
    expect(dataTransferExportMessage({ outputPath: 'D:\\星芒数据导出-2026-11-22\\星芒聊天记录与设置.json', conversations: 3, videoProjects: 2, works: { folderName: '星芒数据导出-2026-11-22', count: 128 } }))
      .toBe('已保存至「星芒数据导出-2026-11-22」文件夹，包含 3 个对话、2 条视频、128 件作品及设置。请将整个文件夹复制到新电脑，在此点击「导入」并选择其中的「星芒聊天记录与设置」文件。')
    expect(dataTransferExportMessage({ outputPath: '/x.json', conversations: 0, videoProjects: 0, works: { folderName: '星芒数据导出-2026-11-22 (2)', count: 0 } }))
      .toBe('已保存至「星芒数据导出-2026-11-22 (2)」文件夹，包含设置。请将整个文件夹复制到新电脑，在此点击「导入」并选择其中的「星芒聊天记录与设置」文件。')
  })

  it('asks about the works with their count and size', () => {
    const works = { images: 96, videos: 30, audios: 2, bytes: Math.round(3.2 * 1024 ** 3) }
    expect(worksCount(works)).toBe(128)
    expect(worksExportQuestion(works)).toBe('当前账号的作品库中共有 128 件作品（图片 96 张、视频片段与成片 30 个、配乐 2 首），约 3.2 GB。')
    expect(worksExportQuestion({ images: 5, videos: 0, audios: 0, bytes: 12 * 1024 ** 2 })).toBe('当前账号的作品库中共有 5 件作品（图片 5 张），约 12 MB。')
  })

  it('says what became of the videos and works in an import', () => {
    const base = { fileConversations: 3, added: 3, updated: 0, skipped: 0, signedIn: true, settingsChanged: true }
    expect(dataTransferImportMessage({ ...base, fileVideos: 2, videosAdded: 2, works: { kind: 'done', added: 120, existing: 8, failed: 0 } }))
      .toBe('已导入 3 个对话及设置。已导入 2 条视频。已导入 120 件作品，另有 8 件已存在于本机。')
    expect(dataTransferImportMessage({ ...base, fileVideos: 5, videosAdded: 2, videosSkipped: 3 }))
      .toBe('已导入 3 个对话及设置。已导入 2 条视频。另有 3 条视频未导入：本机最多保存 200 条视频，请在「创作」中删除部分不需要的视频，再次点击「导入」。')
    expect(dataTransferImportMessage({ ...base, works: { kind: 'done', added: 0, existing: 8, failed: 0 } })).toBe('已导入 3 个对话及设置。文件中的作品均已存在于本机。')
    expect(dataTransferImportMessage({ ...base, works: { kind: 'done', added: 5, existing: 0, failed: 2 } })).toBe('已导入 3 个对话及设置。已导入 5 件作品。另有 2 件作品无法读取，未导入。')
    expect(dataTransferImportMessage({ ...base, works: { kind: 'no-space', neededBytes: Math.round(3.2 * 1024 ** 3), availableBytes: Math.round(1.1 * 1024 ** 3) } }))
      .toBe('已导入 3 个对话及设置。作品未导入：需要约 3.2 GB，本机仅剩 1.1 GB。请清理磁盘后再次点击「导入」，已导入的内容不会重复。')
    expect(dataTransferImportMessage({ ...base, works: { kind: 'missing' } }))
      .toBe('已导入 3 个对话及设置。未在文件所在位置找到「作品」文件夹，作品未导入。请将导出的整个文件夹复制到本机后再次导入。')
    expect(dataTransferImportMessage({ ...base, works: { kind: 'unreadable', count: 128 } })).toBe('已导入 3 个对话及设置。另有 128 件作品无法读取，未导入。')
  })

  it('does not call a file with only videos and works one with nothing to change', () => {
    expect(dataTransferImportMessage({ fileConversations: 0, added: 0, updated: 0, skipped: 0, signedIn: true, settingsChanged: false, fileVideos: 2, videosAdded: 2, works: { kind: 'done', added: 4, existing: 0, failed: 0 } }))
      .toBe('已导入 2 条视频。已导入 4 件作品。')
    expect(dataTransferImportMessage({ fileConversations: 0, added: 0, updated: 0, skipped: 0, signedIn: true, settingsChanged: true, fileVideos: 2, videosAdded: 2 }))
      .toBe('已导入设置。已导入 2 条视频。')
  })

  it('names the videos and works that wait for a sign-in', () => {
    expect(dataTransferImportMessage({ fileConversations: 3, fileVideos: 2, fileWorks: 128, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: false }))
      .toBe('文件中的 3 个对话、2 条视频和 128 件作品需登录后再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 0, fileVideos: 0, fileWorks: 128, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: true }))
      .toBe('设置已导入。文件中的 128 件作品需登录后再次点击「导入」。')
  })

  it('merges settings updates and drops the version marker', () => {
    expect(settingsPatchFrom({ version: 2 })).toBeNull()
    expect(settingsPatchFrom({ version: 2, theme: 'dark' }, { version: 2, closeBehavior: 'tray' })).toEqual({ theme: 'dark', closeBehavior: 'tray' })
  })

  it('switches usage stats back on only when the user chose the file in the question', () => {
    // X-3：这台关过的「匿名使用统计」，点「保留本机设置」照旧关着。
    expect(anonymousUsageFrom({ conflictingAnonymousUsage: true }, false)).toBeUndefined()
    expect(anonymousUsageFrom({ conflictingAnonymousUsage: true }, true)).toBe(true)
    expect(anonymousUsageFrom({ anonymousUsage: false }, false)).toBe(false)
    expect(anonymousUsageFrom({ anonymousUsage: false }, true)).toBe(false)
    expect(anonymousUsageFrom({}, true)).toBeUndefined()
  })
})
