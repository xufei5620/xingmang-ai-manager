import { describe, expect, it } from 'vitest'
import { networkFailureMessages } from '../../../../electron/network-failure'
import { keySyncFailureReason, keySyncFailureText, resolveToolKeySyncFailure } from './key-sync-failure'

describe('key sync failure wording', () => {
  it('names the tool and translates raw English failures', () => {
    expect(keySyncFailureText('codex', 'fetch failed')).toBe('Codex CLI：网络连不上')
    // 写 Key 写的是配置文件，不是安装目录（已知29）。
    expect(keySyncFailureText('claude', 'EPERM: operation not permitted')).toBe('Claude Code：写不进配置文件')
    expect(keySyncFailureText('grok', 'unexpected token in JSON')).toBe('Grok CLI：密钥没有写进去，点「重新同步」再试')
  })

  it('keeps Chinese reasons but never shows the home folder path', () => {
    const text = keySyncFailureText('codex', '配置文件 C:\\Users\\alice\\.codex\\auth.json 不是单链接普通文件')
    expect(text.startsWith('Codex CLI：')).toBe(true)
    expect(text).not.toContain('alice')
    expect(keySyncFailureReason('/home/alice/.claude/settings.json 写入失败')).not.toContain('alice')
  })

  it('does not take an English failure for Chinese because its redacted path is', () => {
    // 脱敏后的占位词「本机路径」本身是汉字，以前这两句英文原样上屏（第三十批 A）。
    expect(keySyncFailureText('claude', "ENOENT: no such file or directory, open 'C:\\Users\\张三\\.claude\\settings.json'"))
      .toBe('Claude Code：密钥没有写进去，点「重新同步」再试')
    expect(keySyncFailureText('codex', "EISDIR: illegal operation on a directory, read '/Users/alice/.codex/config.toml'"))
      .toBe('Codex CLI：密钥没有写进去，点「重新同步」再试')
  })

  it('masks keys in a Chinese reason it shows as is', () => {
    const text = keySyncFailureText('grok', '写入失败，密钥 sk-abcdefghijklmnopqrstuvwxyz0123456789 不对')
    expect(text.startsWith('Grok CLI：写入失败')).toBe(true)
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('does not repeat the tool name the reason already starts with', () => {
    expect(keySyncFailureText('grok', 'Grok CLI 没有收到配置完成结果，请重新检测')).toBe('Grok CLI 没有收到配置完成结果，请重新检测')
  })

  it('lets a Codex failure that names the desktop app stand on its own', () => {
    expect(keySyncFailureText('codex', 'Codex 桌面端可能仍在运行，连接线路暂未改动；请关闭工具后重新同步'))
      .toBe('Codex 桌面端可能仍在运行，连接线路暂未改动；请关闭工具后重新同步')
    expect(keySyncFailureText('claude', 'Codex 桌面端可能仍在运行')).toBe('Claude Code：Codex 桌面端可能仍在运行')
  })

  it('turns an unavailable account group into advice the customer can act on', () => {
    expect(keySyncFailureText('claude', '分组不存在、不可用或名称重复，请确认账号可用分组'))
      .toBe('Claude Code：当前账号还不能用，需要的话请联系客服开通')
    expect(keySyncFailureText('grok', '当前账号不可使用分组「Grok-中转/订阅」'))
      .toBe('Grok CLI：当前账号还不能用，需要的话请联系客服开通')
  })
})

describe('key sync failure for one tool', () => {
  const offline = '当前网络不可用，已装好的工具照常能用；联网后会自动补写密钥。'
  const certificate = '连星芒时被网络上的设备拦下了，这次没写好密钥。已装好的工具照常能用；稍等一两分钟点「重新同步」，还不行就换个网络（比如手机热点）。'
  function result(overrides: { failed?: Array<{ provider: 'claude' | 'codex' | 'grok'; message: string }>; networkBlocked?: boolean; networkBlockedByCertificate?: boolean } = {}) {
    return { result: { failed: [], networkBlocked: false, ...overrides } }
  }

  it('says nothing before a round has finished or when the tool was written', () => {
    expect(resolveToolKeySyncFailure(null, 'claude')).toBeNull()
    expect(resolveToolKeySyncFailure({}, 'claude')).toBeNull()
    expect(resolveToolKeySyncFailure(result(), 'claude')).toBeNull()
    expect(resolveToolKeySyncFailure(result({ failed: [{ provider: 'codex', message: 'fetch failed' }] }), 'claude')).toBeNull()
  })

  it('uses the home banner sentence and offers the resync button', () => {
    expect(resolveToolKeySyncFailure(result({ failed: [{ provider: 'claude', message: 'unexpected token in JSON' }] }), 'claude'))
      .toEqual({ text: 'Claude Code：密钥没有写进去，点「重新同步」再试', retry: true })
  })

  it('names the desktop app when that is what the customer picked', () => {
    expect(resolveToolKeySyncFailure(result({ failed: [{ provider: 'codex', message: 'unexpected token in JSON' }] }), 'codex', 'codexDesktop'))
      .toEqual({ text: 'Codex 桌面端：密钥没有写进去，点「重新同步」再试', retry: true })
    // 原话点的是 Codex CLI 也算点过名，不念成「Codex 桌面端：Codex CLI ……」。
    expect(keySyncFailureText('codexDesktop', 'Codex CLI 没有收到配置完成结果，请重新检测')).toBe('Codex CLI 没有收到配置完成结果，请重新检测')
  })

  it('says the network sentences the home banner says when the network stopped it', () => {
    expect(resolveToolKeySyncFailure(result({ networkBlocked: true, failed: [{ provider: 'claude', message: networkFailureMessages.offline }] }), 'claude'))
      .toEqual({ text: offline, retry: true })
    expect(resolveToolKeySyncFailure(result({ networkBlocked: true, networkBlockedByCertificate: true, failed: [{ provider: 'claude', message: networkFailureMessages.tls }] }), 'claude'))
      .toEqual({ text: certificate, retry: true })
  })

  it('covers a round that threw before it reached any tool', () => {
    expect(resolveToolKeySyncFailure({ error: `账号 Key 初始化没有完成：${networkFailureMessages.dns}` }, 'grok')).toEqual({ text: offline, retry: true })
    expect(resolveToolKeySyncFailure({ error: `账号 Key 初始化没有完成：${networkFailureMessages.tls}` }, 'grok')).toEqual({ text: certificate, retry: true })
    expect(resolveToolKeySyncFailure({ error: '当前分组未返回可用模型' }, 'grok')).toEqual({ text: '密钥没写好：当前分组未返回可用模型', retry: true })
  })

  it('offers no resync for a tool the account has not enabled, as the home banner does', () => {
    expect(resolveToolKeySyncFailure(result({ failed: [{ provider: 'grok', message: '分组不存在、不可用或名称重复，请确认账号可用分组' }] }), 'grok'))
      .toEqual({ text: 'Grok CLI：当前账号还不能用，需要的话请联系客服开通', retry: false })
  })
})
