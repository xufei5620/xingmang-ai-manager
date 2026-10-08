import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SupportIdentity, buildLastFailureLine, buildSupportBundle, buildSupportIdentityLine, linuxSystemDetail } from './SupportIdentity'

describe('SupportIdentity', () => {
  it('lists account name, id, version and system for a signed-in user', () => {
    expect(buildSupportIdentityLine({ signedIn: true, account: { userId: 10086, username: '张三' }, version: '0.2.10', os: 'win' }))
      .toBe('账号 张三（ID 10086） · 星芒AI管理工具 0.2.10 · Windows')
    expect(buildSupportIdentityLine({ signedIn: true, account: { userId: 7, username: 'peaker' }, version: '0.2.11', os: 'mac' }))
      .toBe('账号 peaker（ID 7） · 星芒AI管理工具 0.2.11 · macOS')
  })

  it('adds the Linux distribution and chip so support does not have to ask again', () => {
    const systemDetail = linuxSystemDetail('Ubuntu 24.04.1 LTS', 'arm64')
    expect(systemDetail).toBe('Ubuntu 24.04.1 LTS · ARM 芯片')
    expect(buildSupportIdentityLine({ signedIn: true, account: { userId: 7, username: 'peaker' }, version: '0.2.14', os: 'linux', systemDetail }))
      .toBe('账号 peaker（ID 7） · 星芒AI管理工具 0.2.14 · Linux（Ubuntu 24.04.1 LTS · ARM 芯片）')
    expect(buildSupportBundle({ signedIn: false, account: null, version: '0.2.14', os: 'linux', systemDetail: linuxSystemDetail(undefined, 'x64') },
      { at: new Date(2026, 9, 2, 9, 5), message: '安装没有完成' }).split('\n')[2]).toBe('版本 0.2.14 · Linux（64 位）')
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: '0.2.14', os: 'linux' })).toBe('未登录 · 星芒AI管理工具 0.2.14 · Linux')
    expect(linuxSystemDetail(undefined, undefined)).toBeUndefined()
  })

  it('keeps the Windows and macOS label unchanged even if a system detail is passed', () => {
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: '0.2.14', os: 'win', systemDetail: 'x' })).toBe('未登录 · 星芒AI管理工具 0.2.14 · Windows')
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: '0.2.14', os: 'mac', systemDetail: 'x' })).toBe('未登录 · 星芒AI管理工具 0.2.14 · macOS')
  })

  it('says not signed in when there is no account', () => {
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: '0.2.10', os: 'win' }))
      .toBe('未登录 · 星芒AI管理工具 0.2.10 · Windows')
    expect(buildSupportIdentityLine({ signedIn: false, account: { userId: 1, username: 'stale' }, version: '0.2.10', os: 'mac' }))
      .toBe('未登录 · 星芒AI管理工具 0.2.10 · macOS')
  })

  it('omits the id instead of inventing one when the account has no usable numeric id', () => {
    for (const userId of [0, Number.NaN, -3, 1.5]) {
      expect(buildSupportIdentityLine({ signedIn: true, account: { userId, username: 'legacy' }, version: '0.2.10', os: 'win' }))
        .toBe('账号 legacy · 星芒AI管理工具 0.2.10 · Windows')
    }
  })

  it('drops the version when it is not known yet', () => {
    expect(buildSupportIdentityLine({ signedIn: false, account: null, version: undefined, os: 'win' })).toBe('未登录 · 星芒AI管理工具 · Windows')
  })

  it('never includes an email or site name', () => {
    const line = buildSupportIdentityLine({ signedIn: true, account: { userId: 5, username: 'a' }, version: '1.0.0', os: 'win' })
    expect(line).not.toMatch(/@|solov|xm\./)
  })

  it('renders the line with a copy button', () => {
    const markup = renderToStaticMarkup(<SupportIdentity line="未登录 · 星芒AI管理工具 0.2.10 · Windows" onCopy={() => undefined} />)
    expect(markup).toContain('找客服时把这行一起发过去：')
    expect(markup).toContain('data-testid="support-identity-line"')
    expect(markup).toContain('未登录 · 星芒AI管理工具 0.2.10 · Windows')
    expect(markup).toContain('复制')
  })

  it('bundles who, which version, when, what and why into one copy', () => {
    const at = new Date(2026, 8, 29, 14, 37)
    const text = buildSupportBundle({ signedIn: true, account: { userId: 7, username: 'peaker' }, version: '0.2.11', os: 'win' },
      { at, action: '打开 Codex 桌面端', message: '打开 Codex 桌面端没有完成', reason: '工具正在运行', detail: 'EBUSY: resource busy' })
    expect(text.split('\n')).toEqual([
      '星芒AI管理工具 · 给客服的信息',
      '账号 peaker（ID 7）',
      '版本 0.2.11 · Windows',
      '时间 2026-09-29 14:37',
      '做什么：打开 Codex 桌面端',
      '原因：工具正在运行',
      '原话：EBUSY: resource busy',
    ])
  })

  it('keeps a backend sentence as the outcome and says when the cause was not recognised', () => {
    const at = new Date(2026, 0, 2, 3, 4)
    const text = buildSupportBundle({ signedIn: false, account: null, version: undefined, os: 'mac' },
      { at, action: '保存', message: '配置文件写入失败：磁盘只读' })
    expect(text).toContain('未登录\n版本 未知 · macOS\n时间 2026-01-02 03:04')
    expect(text).toContain('结果：配置文件写入失败：磁盘只读')
    expect(text).not.toContain('原因：')
    expect(buildSupportBundle({ signedIn: false, account: null, version: '1', os: 'win' }, { at, message: '操作没有完成', detail: 'spawn ENOSYS' }))
      .toContain('原因：没认出是哪一类问题，原话在下面\n原话：spawn ENOSYS')
  })

  it('masks keys that slipped into the original', () => {
    const text = buildSupportBundle({ signedIn: false, account: null, version: '1', os: 'win' },
      { at: new Date(), message: '操作没有完成', detail: 'failed api_key=abc123 Bearer sk-abcdefghijk' })
    expect(text).not.toMatch(/abc123|sk-abcdefghijk/)
    expect(text).toContain('[REDACTED]')
  })

  it('writes the last failure line for the help dialog and renders it under the identity', () => {
    const at = new Date(2026, 8, 29, 14, 37)
    expect(buildLastFailureLine({ at, action: '打开 Codex 桌面端', message: '打开 Codex 桌面端没有完成', reason: '工具正在运行' }))
      .toBe('最近一次出错：14:37 打开 Codex 桌面端：工具正在运行')
    expect(buildLastFailureLine({ at, action: '保存', message: '保存没有完成', detail: 'spawn ENOSYS' }))
      .toBe('最近一次出错：14:37 保存：spawn ENOSYS')
    expect(buildLastFailureLine({ at, message: '操作没有完成' })).toBe('最近一次出错：14:37 操作没有完成')
    const markup = renderToStaticMarkup(<SupportIdentity line="未登录" lastFailure="最近一次出错：14:37 保存" onCopy={() => undefined} />)
    expect(markup).toContain('support-last-failure')
    expect(renderToStaticMarkup(<SupportIdentity line="未登录" onCopy={() => undefined} />)).not.toContain('support-last-failure')
  })
})
