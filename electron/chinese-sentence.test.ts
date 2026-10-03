import { describe, expect, it } from 'vitest'
import { isChineseSentence } from './chinese-sentence'

describe('isChineseSentence', () => {
  it('reads a sentence written in Chinese as Chinese, paths and all', () => {
    expect(isChineseSentence('保存 Codex 配置失败：C:\\Users\\张三\\.codex\\config.toml')).toBe(true)
    expect(isChineseSentence('无法确认当前安装状态：/Applications/星芒AI管理工具.app')).toBe(true)
    expect(isChineseSentence('Codex config.toml 无法解析，未执行修改（第 4 行附近）')).toBe(true)
    expect(isChineseSentence('配置文件 C:\\Users\\alice\\.codex\\auth.json 不是单链接普通文件')).toBe(true)
  })

  it('keeps a Chinese sentence whose own words carry a slash', () => {
    // 星芒的分组名带斜杠，中文句子又不带空格：以前整句被当成一条路径去掉，客户只看到兜底句（第三十批 A）。
    expect(isChineseSentence('当前账号不可使用分组「GPT-中转/订阅」')).toBe(true)
    expect(isChineseSentence('分组Gemini-中转/订阅暂时不可用')).toBe(true)
    expect(isChineseSentence('请访问https://xm.solov.cc/wallet充值')).toBe(true)
    expect(isChineseSentence('无法读取C:\\Users\\张三\\.codex\\auth.json')).toBe(true)
  })

  it('does not let a Chinese name inside a path or quotes pass an English failure off as Chinese', () => {
    expect(isChineseSentence("EPERM: operation not permitted, open 'C:\\Users\\张三\\.codex\\config.toml'")).toBe(false)
    expect(isChineseSentence('ENOENT: no such file or directory, open "/Users/张三/.claude/settings.json"')).toBe(false)
    expect(isChineseSentence('spawn C:\\Users\\张 三\\AppData\\Roaming\\npm\\codex.cmd ENOENT')).toBe(false)
    expect(isChineseSentence('EACCES: permission denied, mkdir /Applications/星芒AI管理工具.app/Contents')).toBe(false)
    expect(isChineseSentence('Code signature at URL file:///Applications/星芒AI管理工具.app/ did not pass validation')).toBe(false)
    expect(isChineseSentence('EPERM: operation not permitted, rename “C:\\Users\\张三\\x.tmp” -> “C:\\Users\\张三\\x”')).toBe(false)
  })

  it('reads text without any Chinese as not Chinese', () => {
    expect(isChineseSentence('')).toBe(false)
    expect(isChineseSentence('EPIPE')).toBe(false)
  })
})
