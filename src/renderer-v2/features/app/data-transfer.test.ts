import { describe, expect, it } from 'vitest'
import { anonymousUsageFrom, dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom } from './data-transfer'

describe('data transfer wording', () => {
  it('names the saved file and what is in it', () => {
    expect(dataTransferExportMessage({ outputPath: 'C:\\Users\\a\\Desktop\\星芒聊天记录与设置-2026-09-25.json', conversations: 23 }))
      .toBe('已存好「星芒聊天记录与设置-2026-09-25.json」，里面有23 个对话和你的设置。拷到新电脑后，在这里点「导入」。')
    expect(dataTransferExportMessage({ outputPath: '/Users/a/Desktop/x.json', conversations: 0 })).toContain('里面有你的设置')
  })

  it('says what the import actually did', () => {
    expect(dataTransferImportMessage({ fileConversations: 23, added: 23, updated: 0, skipped: 0, signedIn: true, settingsChanged: true })).toBe('导入了 23 个对话和你的设置。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 0, signedIn: true, settingsChanged: false })).toBe('文件里的对话这台电脑上都有了。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: true })).toBe('设置已导入。文件里的 3 个对话要先登录，再点一次「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 0, added: 0, updated: 0, skipped: 0, signedIn: false, settingsChanged: false })).toBe('文件里的设置和这台电脑上的一样，没有要改的。')
  })

  it('says how many conversations did not fit instead of claiming they are all here', () => {
    expect(dataTransferImportMessage({ fileConversations: 10, added: 4, updated: 0, skipped: 6, signedIn: true, settingsChanged: true }))
      .toBe('导入了 4 个对话和你的设置。还有 6 个没导进来：这台电脑最多存 200 个对话，在「聊天」里删掉一些不要的，再点一次「导入」就能补上。')
    expect(dataTransferImportMessage({ fileConversations: 10, added: 4, updated: 0, skipped: 6, signedIn: true, settingsChanged: false }))
      .toBe('导入了 4 个对话。还有 6 个没导进来：这台电脑最多存 200 个对话，在「聊天」里删掉一些不要的，再点一次「导入」就能补上。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 3, signedIn: true, settingsChanged: true }))
      .toBe('设置已导入。这台电脑已经存满 200 个对话，文件里的 3 个对话没导进来。在「聊天」里删掉一些不要的，再点一次「导入」就能补上。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, updated: 0, skipped: 2, signedIn: true, settingsChanged: false }))
      .toBe('这台电脑已经存满 200 个对话，文件里的 2 个对话没导进来。在「聊天」里删掉一些不要的，再点一次「导入」就能补上。')
  })

  it('says how many conversations were brought up to date by a second import', () => {
    // X-4：先导一次、旧电脑接着聊几天再导一次。
    expect(dataTransferImportMessage({ fileConversations: 5, added: 2, updated: 1, skipped: 0, signedIn: true, settingsChanged: false }))
      .toBe('导入了 2 个对话，另有 1 个对话更新成了文件里的内容。')
    expect(dataTransferImportMessage({ fileConversations: 5, added: 0, updated: 3, skipped: 0, signedIn: true, settingsChanged: false }))
      .toBe('有 3 个对话更新成了文件里的内容，其余这台电脑上都有了。')
    expect(dataTransferImportMessage({ fileConversations: 5, added: 2, updated: 1, skipped: 0, signedIn: true, settingsChanged: true }))
      .toBe('导入了 2 个对话和你的设置，另有 1 个对话更新成了文件里的内容。')
    expect(dataTransferImportMessage({ fileConversations: 5, added: 0, updated: 3, skipped: 0, signedIn: true, settingsChanged: true }))
      .toBe('有 3 个对话更新成了文件里的内容，其余这台电脑上都有了，设置已导入。')
    // 文件里的对话全都更新了，没有「其余」。
    expect(dataTransferImportMessage({ fileConversations: 2, added: 0, updated: 2, skipped: 0, signedIn: true, settingsChanged: false }))
      .toBe('有 2 个对话更新成了文件里的内容。')
    expect(dataTransferImportMessage({ fileConversations: 10, added: 4, updated: 1, skipped: 5, signedIn: true, settingsChanged: false }))
      .toBe('导入了 4 个对话，另有 1 个对话更新成了文件里的内容。还有 5 个没导进来：这台电脑最多存 200 个对话，在「聊天」里删掉一些不要的，再点一次「导入」就能补上。')
    expect(dataTransferImportMessage({ fileConversations: 4, added: 0, updated: 1, skipped: 3, signedIn: true, settingsChanged: false }))
      .toBe('有 1 个对话更新成了文件里的内容。这台电脑已经存满 200 个对话，文件里的 3 个对话没导进来。在「聊天」里删掉一些不要的，再点一次「导入」就能补上。')
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
