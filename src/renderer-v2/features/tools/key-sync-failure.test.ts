import { describe, expect, it } from 'vitest'
import { keySyncFailureReason, keySyncFailureText } from './key-sync-failure'

describe('key sync failure wording', () => {
  it('names the tool and translates raw English failures', () => {
    expect(keySyncFailureText('codex', 'fetch failed')).toBe('Codex CLI：连不上星芒服务器')
    expect(keySyncFailureText('claude', 'EPERM: operation not permitted')).toBe('Claude Code：写不进安装目录')
    expect(keySyncFailureText('gemini', 'unexpected token in JSON')).toBe('Gemini CLI：Key 没有写进去，点「重新同步」再试')
  })

  it('keeps Chinese reasons but never shows the home folder path', () => {
    const text = keySyncFailureText('codex', '配置文件 C:\\Users\\alice\\.codex\\auth.json 不是单链接普通文件')
    expect(text.startsWith('Codex CLI：')).toBe(true)
    expect(text).not.toContain('alice')
    expect(keySyncFailureReason('/home/alice/.claude/settings.json 写入失败')).not.toContain('alice')
  })

  it('does not repeat the tool name the reason already starts with', () => {
    expect(keySyncFailureText('grok', 'Grok CLI 没有收到配置完成结果，请重新检测')).toBe('Grok CLI 没有收到配置完成结果，请重新检测')
  })

  it('turns an unavailable account group into advice the customer can act on', () => {
    expect(keySyncFailureText('claude', '分组不存在、不可用或名称重复，请确认账号可用分组'))
      .toBe('Claude Code：当前账号还不能用，需要的话请联系客服开通')
    expect(keySyncFailureText('gemini', '当前账号不可使用分组「Gemini-中转/订阅」'))
      .toBe('Gemini CLI：当前账号还不能用，需要的话请联系客服开通')
  })
})
