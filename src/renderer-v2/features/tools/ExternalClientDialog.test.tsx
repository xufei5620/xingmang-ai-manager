import { describe, expect, it } from 'vitest'
import { externalClientHint } from './ExternalClientDialog'

describe('externalClientHint', () => {
  it('tells Windows users that 星芒 places the program and only Cowork still needs the official site', () => {
    expect(externalClientHint('claudeDesktop', true)).toBe('保存后要完全退出再重新打开 Claude Desktop。从星芒点「打开」时，星芒会先替它放好聊天和 Code 要用的程序；Cowork 要用的工作区（约 1.3GB）还得这台电脑连得上 Claude 官网才下得动。')
  })

  it('keeps the old sentence where 星芒 does not place the program, and for the other clients', () => {
    expect(externalClientHint('claudeDesktop', false)).toContain('都要从 Claude 官网下载组件（最多 1.6GB）')
    expect(externalClientHint('workbuddy', true)).toBe(externalClientHint('workbuddy', false))
    expect(externalClientHint('opencode', true)).toBe('命令行版和桌面版共用这份配置。')
  })
})
