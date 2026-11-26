import { describe, expect, it } from 'vitest'
import { externalClientHint } from './ExternalClientDialog'

describe('externalClientHint', () => {
  it('tells Windows and Mac users that 星芒 places both the program and the Cowork workspace', () => {
    expect(externalClientHint('claudeDesktop', true)).toBe('保存后请完全退出并重新打开 Claude Desktop。从星芒点击「打开」时，星芒会预先准备聊天和 Code 所需程序，并在后台自动下载 Cowork 所需工作区（约 1.3GB），均无需连接 Claude 官网。')
  })

  it('keeps the old sentence where 星芒 does not place the program, and for the other clients', () => {
    expect(externalClientHint('claudeDesktop', false)).toContain('需从 Claude 官网下载组件（最大 1.6GB）')
    expect(externalClientHint('workbuddy', true)).toBe(externalClientHint('workbuddy', false))
    expect(externalClientHint('opencode', true)).toBe('命令行版与桌面版共用此配置。')
  })
})
