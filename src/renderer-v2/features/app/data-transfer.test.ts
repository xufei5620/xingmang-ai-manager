import { describe, expect, it } from 'vitest'
import { dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom } from './data-transfer'

describe('data transfer wording', () => {
  it('names the saved file and what is in it', () => {
    expect(dataTransferExportMessage({ outputPath: 'C:\\Users\\a\\Desktop\\星芒聊天记录与设置-2026-09-25.json', conversations: 23 }))
      .toBe('已存好「星芒聊天记录与设置-2026-09-25.json」，里面有23 个对话和你的设置。拷到新电脑后，在这里点「导入」。')
    expect(dataTransferExportMessage({ outputPath: '/Users/a/Desktop/x.json', conversations: 0 })).toContain('里面有你的设置')
  })

  it('says what the import actually did', () => {
    expect(dataTransferImportMessage({ fileConversations: 23, added: 23, signedIn: true, settingsChanged: true })).toBe('导入了 23 个对话和你的设置。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, signedIn: true, settingsChanged: false })).toBe('文件里的对话这台电脑上都有了。')
    expect(dataTransferImportMessage({ fileConversations: 3, added: 0, signedIn: false, settingsChanged: true })).toBe('设置已导入。文件里的 3 个对话要先登录，再点一次「导入」。')
    expect(dataTransferImportMessage({ fileConversations: 0, added: 0, signedIn: false, settingsChanged: false })).toBe('文件里的设置和这台电脑上的一样，没有要改的。')
  })

  it('merges settings updates and drops the version marker', () => {
    expect(settingsPatchFrom({ version: 2 })).toBeNull()
    expect(settingsPatchFrom({ version: 2, theme: 'dark' }, { version: 2, closeBehavior: 'tray' })).toEqual({ theme: 'dark', closeBehavior: 'tray' })
  })
})
