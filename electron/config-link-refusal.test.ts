import { describe, expect, it } from 'vitest'
import { configLinkRefusalIn, configLinkRefusalMessage } from './config-link-refusal'

describe('config link refusal', () => {
  it('says where the link is, that nothing changed and what to swap it for', () => {
    expect(configLinkRefusalMessage('用户文件夹里的 .claude/settings.json', 'file'))
      .toBe('用户文件夹里的 .claude/settings.json 是个链接。为了安全，星芒不往链接里写，原来的设置没有动。把它换成普通文件后再试。')
    expect(configLinkRefusalMessage('用户文件夹里的 .codex', 'folder'))
      .toBe('用户文件夹里的 .codex 这个文件夹是个链接。为了安全，星芒不往链接里写，原来的设置没有动。把它换成普通文件夹后再试。')
  })

  it('finds the sentence again inside the wrapping a switch or a save adds', () => {
    const sentence = configLinkRefusalMessage('config.toml', 'file')
    expect(configLinkRefusalIn(`改用当前账号没有完成：${sentence}已恢复到切换前的配置。`)).toBe(sentence)
    expect(configLinkRefusalIn(sentence)).toBe(sentence)
    expect(configLinkRefusalIn('配置路径不能经过符号链接或目录联接')).toBeNull()
  })
})
