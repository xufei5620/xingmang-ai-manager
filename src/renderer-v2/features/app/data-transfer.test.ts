import { describe, expect, it } from 'vitest'
import { anonymousUsageFrom, dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom } from './data-transfer'

describe('data transfer wording', () => {
  it('names the saved file and what is in it', () => {
    expect(dataTransferExportMessage({ outputPath: 'C:\\Users\\a\\Desktop\\星芒聊天记录与设置-2026-09-25.json', conversations: 23 }))
      .toBe('已保存「星芒聊天记录与设置-2026-09-25.json」，包含23 个对话及设置。复制到新电脑后，请在此点击「导入」。')
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

  it('merges settings updates and drops the version marker', () => {
    expect(settingsPatchFrom({ version: 2 })).toBeNull()
    expect(settingsPatchFrom({ version: 2, theme: 'dark' }, { version: 2, closeBehavior: 'tray' })).toEqual({ theme: 'dark', closeBehavior: 'tray' })
  })

  it('switches usage stats back on only when the user chose the file in the question', () => {
    // X-3：这台关过的「匿名使用统计」，点「保留这台电脑的」照旧关着。
    expect(anonymousUsageFrom({ conflictingAnonymousUsage: true }, false)).toBeUndefined()
    expect(anonymousUsageFrom({ conflictingAnonymousUsage: true }, true)).toBe(true)
    expect(anonymousUsageFrom({ anonymousUsage: false }, false)).toBe(false)
    expect(anonymousUsageFrom({ anonymousUsage: false }, true)).toBe(false)
    expect(anonymousUsageFrom({}, true)).toBeUndefined()
  })
})
