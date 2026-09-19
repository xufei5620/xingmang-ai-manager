import { describe, expect, it } from 'vitest'
import { classifyOperationError, presentOperationError } from './operation-error'

describe('renderer-v2 operation error classification', () => {
  it('names the npm failures a user actually hits during a CLI install', () => {
    expect(classifyOperationError('Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename')).toBe('permission')
    expect(classifyOperationError('Grok CLI 安装失败：EBUSY: resource busy or locked')).toBe('installBlocked')
    expect(classifyOperationError('Codex CLI 安装失败：npm 官方源：request to https://registry.npmjs.org failed, reason: ETIMEDOUT')).toBe('downloadTimeout')
  })

  it('keeps a relay failure apart from a download failure', () => {
    expect(classifyOperationError('模型查询超时，请检查网络后重试')).toBe('timeout')
    expect(classifyOperationError('账号接口返回 401 Unauthorized')).toBe('sessionExpired')
    expect(classifyOperationError('当前分组下无可用渠道')).toBe('keyInvalid')
  })

  it('only promises the previous version is safe when the failure came from an update', () => {
    expect(classifyOperationError('Claude Code 更新失败：SHA-512 完整性校验不一致')).toBe('updateIntegrity')
    expect(classifyOperationError('npm 镜像的完整依赖图、版本或 SHA-512 与官方源不一致')).toBe('unknown')
  })

  it('leaves a failure it cannot name untouched rather than guessing', () => {
    expect(presentOperationError('请先准备 Node.js 运行环境，再安装命令行工具。')).toBeNull()
    expect(presentOperationError('   ')).toBeNull()
  })

  it('does not repeat wording the message already carries', () => {
    expect(presentOperationError('登录已过期，工具里已写入的 Key 还能用。')).toBeNull()
  })

  it('leaves the account table\'s finished sentences alone', () => {
    // features/auth/account-errors.ts already resolved these; a second heading
    // on top of a finished sentence reads as a bug.
    for (const resolved of [
      '服务暂时不可用，请稍后重试',
      '原密码错误，请重新输入',
      '该账号已被封禁，请联系客服',
      '用户名或密码错误',
      '当前账号未设置密码，请先通过“找回密码”设置密码',
    ]) expect(presentOperationError(resolved)).toBeNull()
  })

  it('hands back only the buttons this app can honour', () => {
    const hint = presentOperationError('Codex CLI 安装失败：下载 ETIMEDOUT')
    expect(hint?.title).toBe('下载超时')
    expect(hint?.body).toBe('下载没有完成，已安装的工具不受影响。')
    expect(hint?.actions).toEqual([{ id: 'retry', label: '换官方源重试' }])
  })

  it('falls back to support when every catalog action is one this app cannot run', () => {
    // permission only offers 以管理员身份重试, and there is no elevated retry channel.
    const hint = presentOperationError('安装失败：EACCES permission denied')
    expect(hint?.title).toBe('需要管理员权限')
    expect(hint?.actions).toEqual([{ id: 'support', label: '找客服' }])
  })
})
