import { describe, expect, it } from 'vitest'
import {
  anonymousUsageFrom,
  dataTransferExportMessage,
  dataTransferImportMessage,
  settingsPatchFrom,
  standingInstructionsFrom,
  worksCount,
  worksExportNote,
  worksExportNoteFor,
  worksExportQuestion,
  worksExportTitle,
  worksExportWorthAsking,
} from './data-transfer'

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

  // 第三轮复查第 6 条：画布项目跟作品一起搬，贴给 yoyo 的字。
  it('asks about the canvas projects together with the works, and only when there is something to carry', () => {
    const works = { images: 120, videos: 8, audios: 0, bytes: Math.round(2.3 * 1024 ** 3) }
    expect(worksExportWorthAsking(works)).toBe(true)
    expect(worksExportTitle(works)).toBe('是否同时导出作品？')
    expect(worksExportNoteFor(works)).toBe(worksExportNote)
    const withProjects = { ...works, canvasProjects: 4 }
    expect(worksExportTitle(withProjects)).toBe('是否同时导出作品和画布项目？')
    expect(worksExportQuestion(withProjects)).toBe('当前账号的作品库中共有 128 件作品（图片 120 张、视频片段与成片 8 个），另有画布项目 4 个，共约 2.3 GB。')
    expect(worksExportNoteFor(withProjects))
      .toBe('选择「导出全部」时，将在所选位置新建一个文件夹，存放聊天记录、设置、作品和画布项目。作品较多时需要几分钟，导出期间请勿关闭星芒。')
    const onlyProjects = { images: 0, videos: 0, audios: 0, bytes: 35 * 1024 ** 2, canvasProjects: 4 }
    expect(worksExportWorthAsking(onlyProjects)).toBe(true)
    expect(worksExportQuestion(onlyProjects)).toBe('当前账号共有画布项目 4 个，约 35 MB。')
    // 找不到文件夹的那个也报进总数，再另说一句不会导出。
    expect(worksExportQuestion({ ...onlyProjects, canvasProjects: 3, canvasProjectsUnreachable: 1 }))
      .toBe('当前账号共有画布项目 4 个，约 35 MB。其中 1 个画布项目的文件夹当前无法访问，将不会导出；如需一并导出，请先连接其所在的磁盘。')
    // 没有作品、项目又都导不了：不问，照旧只导聊天记录和设置。
    expect(worksExportWorthAsking({ images: 0, videos: 0, audios: 0, bytes: 0, canvasProjectsUnreachable: 2 })).toBe(false)
    expect(worksExportWorthAsking({ images: 0, videos: 0, audios: 0, bytes: 0 })).toBe(false)
  })

  it('names the canvas projects an export carried', () => {
    expect(dataTransferExportMessage({ outputPath: 'D:\\星芒数据导出-2026-11-23\\星芒聊天记录与设置.json', conversations: 3, works: { folderName: '星芒数据导出-2026-11-23', count: 128, canvasProjects: 4 } }))
      .toBe('已保存至「星芒数据导出-2026-11-23」文件夹，包含 3 个对话、128 件作品、4 个画布项目及设置。请将整个文件夹复制到新电脑，在此点击「导入」并选择其中的「星芒聊天记录与设置」文件。')
  })

  it('says what became of the canvas projects after the works', () => {
    const base = { fileConversations: 3, added: 3, updated: 0, skipped: 0, signedIn: true, settingsChanged: true }
    const works = { kind: 'done' as const, added: 120, existing: 8, failed: 0 }
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'done', added: 4, existing: 0, full: 0, failed: 0 } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。已导入 4 个画布项目。')
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'done', added: 3, existing: 1, full: 0, failed: 0 } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。已导入 3 个画布项目，另有 1 个已存在于本机。')
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'done', added: 0, existing: 4, full: 0, failed: 0 } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。文件中的画布项目均已存在于本机。')
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'done', added: 2, existing: 0, full: 2, failed: 1 } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。已导入 2 个画布项目。另有 2 个画布项目未导入：本机画布项目数量已达上限，请先在画布中归档或删除部分项目，再次点击「导入」。另有 1 个画布项目未能导入，请再次点击「导入」。')
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'done', added: 0, existing: 1, full: 2, failed: 0 } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。另有 2 个画布项目未导入：本机画布项目数量已达上限，请先在画布中归档或删除部分项目，再次点击「导入」。')
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'missing' } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。未在文件所在位置找到「画布项目」文件夹，画布项目未导入。请将导出的整个文件夹复制到本机后再次导入。')
    expect(dataTransferImportMessage({ ...base, works: { kind: 'missing' }, canvasProjects: { kind: 'missing' } }))
      .toBe('已导入 3 个对话及设置。未在文件所在位置找到「作品」和「画布项目」文件夹，作品和画布项目未导入。请将导出的整个文件夹复制到本机后再次导入。')
    expect(dataTransferImportMessage({ ...base, works, canvasProjects: { kind: 'unreadable', count: 2 } }))
      .toBe('已导入 3 个对话及设置。已导入 120 件作品，另有 8 件已存在于本机。另有 2 个画布项目无法读取，未导入。')
    const noSpace = { kind: 'no-space' as const, neededBytes: Math.round(3.2 * 1024 ** 3), availableBytes: Math.round(1.1 * 1024 ** 3) }
    expect(dataTransferImportMessage({ ...base, works: noSpace, canvasProjects: { kind: 'no-space' } }))
      .toBe('已导入 3 个对话及设置。作品和画布项目未导入：需要约 3.2 GB，本机仅剩 1.1 GB。请清理磁盘后再次点击「导入」，已导入的内容不会重复。')
    // 项目导完以后盘才满的：项目照报，空间那句只说作品。
    expect(dataTransferImportMessage({ ...base, works: noSpace, canvasProjects: { kind: 'done', added: 4, existing: 0, full: 0, failed: 0 } }))
      .toBe('已导入 3 个对话及设置。作品未导入：需要约 3.2 GB，本机仅剩 1.1 GB。请清理磁盘后再次点击「导入」，已导入的内容不会重复。已导入 4 个画布项目。')
  })

  it('does not call a file with only canvas projects one with nothing to change, and names them while signed out', () => {
    expect(dataTransferImportMessage({ fileConversations: 0, added: 0, updated: 0, skipped: 0, signedIn: true, settingsChanged: false, works: { kind: 'done', added: 0, existing: 0, failed: 0 }, canvasProjects: { kind: 'done', added: 4, existing: 0, full: 0, failed: 0 } }))
      .toBe('已导入 4 个画布项目。')
    expect(dataTransferImportMessage({ fileConversations: 3, fileWorks: 128, fileCanvasProjects: 4, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: false }))
      .toBe('文件中的 3 个对话、128 件作品和 4 个画布项目需登录后再次点击「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 0, fileCanvasProjects: 4, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: true }))
      .toBe('设置已导入。文件中的 4 个画布项目需登录后再次点击「导入」。')
  })

  // 第三轮复查第 7 条贴给 yoyo 的字。
  it('says where to save the standing instructions again when a tool could not take them', () => {
    const missed = '给 AI 的长期嘱咐已导入，但部分工具未能写入，请在「设置 › 工具管理」中再次保存。'
    const base = { fileConversations: 3, added: 3, updated: 0, skipped: 0, signedIn: true, settingsChanged: true }
    expect(dataTransferImportMessage({ ...base, standingInstructionsMissed: true, fileVideos: 2, videosAdded: 2 }))
      .toBe(`已导入 3 个对话及设置。${missed}已导入 2 条视频。`)
    expect(dataTransferImportMessage({ ...base, fileConversations: 0, added: 0, standingInstructionsMissed: true })).toBe(`已导入设置。${missed}`)
    expect(dataTransferImportMessage({ ...base, signedIn: false, added: 0, standingInstructionsMissed: true }))
      .toBe(`设置已导入。${missed}文件中的 3 个对话需登录后再次点击「导入」。`)
    expect(dataTransferImportMessage(base)).toBe('已导入 3 个对话及设置。')
  })

  it('writes the standing instructions from the file only when this computer had none or the user chose the file', () => {
    expect(standingInstructionsFrom({ standingInstructions: '回答请尽量简洁。' }, false)).toBe('回答请尽量简洁。')
    expect(standingInstructionsFrom({ standingInstructions: '回答请尽量简洁。' }, true)).toBe('回答请尽量简洁。')
    expect(standingInstructionsFrom({ conflictingStandingInstructions: '回答请尽量简洁。' }, false)).toBeUndefined()
    expect(standingInstructionsFrom({ conflictingStandingInstructions: '回答请尽量简洁。' }, true)).toBe('回答请尽量简洁。')
    expect(standingInstructionsFrom({}, true)).toBeUndefined()
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
