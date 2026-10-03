import { describe, expect, it } from 'vitest'
import { isChineseSentence } from './chinese-sentence'

describe('isChineseSentence', () => {
  it('reads a sentence written in Chinese as Chinese, paths and all', () => {
    expect(isChineseSentence('保存 Codex 配置失败：C:\\Users\\张三\\.codex\\config.toml')).toBe(true)
    expect(isChineseSentence('无法确认当前安装状态：/Applications/星芒AI管理工具.app')).toBe(true)
    expect(isChineseSentence('Codex config.toml 无法解析，未执行修改（第 4 行附近）')).toBe(true)
  })

  it('does not let a Chinese name inside a path or quotes pass an English failure off as Chinese', () => {
    expect(isChineseSentence("EPERM: operation not permitted, open 'C:\\Users\\张三\\.codex\\config.toml'")).toBe(false)
    expect(isChineseSentence('ENOENT: no such file or directory, open "/Users/张三/.claude/settings.json"')).toBe(false)
    expect(isChineseSentence('spawn C:\\Users\\张 三\\AppData\\Roaming\\npm\\codex.cmd ENOENT')).toBe(false)
    expect(isChineseSentence('EACCES: permission denied, mkdir /Applications/星芒AI管理工具.app/Contents')).toBe(false)
  })

  it('reads text without any Chinese as not Chinese', () => {
    expect(isChineseSentence('')).toBe(false)
    expect(isChineseSentence('EPIPE')).toBe(false)
  })
})
