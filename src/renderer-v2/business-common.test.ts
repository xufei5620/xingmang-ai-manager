import { describe, expect, it } from 'vitest'
import { errorMessage, overflowedPage, rawErrorMessage, snapshotErrorMessage, userFacingErrorMessage } from './business-common'

describe('rawErrorMessage', () => {
  it('strips the Electron IPC prefix that would otherwise expose channel names', () => {
    expect(rawErrorMessage(new Error("Error invoking remote method 'config:save': 保存失败")))
      .toBe('保存失败')
  })

  it('strips the error class name Electron re-serializes after the channel name', () => {
    expect(rawErrorMessage(new Error("Error invoking remote method 'config:save': Error: 保存失败")))
      .toBe('保存失败')
    expect(rawErrorMessage(new Error("Error invoking remote method 'account:balance': RealmAccountError: 读取失败")))
      .toBe('读取失败')
  })

  it('keeps a business message that happens to start with an error class name', () => {
    // The class tag is only an Electron artifact when it follows the channel
    // name. Stripping it unconditionally would cut into ordinary copy.
    expect(rawErrorMessage(new Error('Error: 这句是业务文案'))).toBe('Error: 这句是业务文案')
  })

  it('strips every layer when the prefix is nested', () => {
    const nested = new Error(
      "Error invoking remote method 'a:one': "
      + "Error invoking remote method 'b:two': "
      + "Error invoking remote method 'c:three': 真正的原因",
    )

    expect(rawErrorMessage(nested)).toBe('真正的原因')
  })

  it('reads a message off a plain object that is not an Error', () => {
    // Structured clone across IPC can deliver an error-shaped plain object.
    expect(rawErrorMessage({ message: '来自结构化克隆的错误' })).toBe('来自结构化克隆的错误')
    expect(rawErrorMessage({ message: "Error invoking remote method 'x:y': 内部原因" }))
      .toBe('内部原因')
  })

  it('returns an empty string for null and undefined so the caller keeps its own fallback', () => {
    // Deliberately different from the legacy helper, which answers 未知错误 here:
    // a Chinese string would be mistaken for a reason the server actually gave.
    expect(rawErrorMessage(null)).toBe('')
    expect(rawErrorMessage(undefined)).toBe('')
  })

  it('stringifies values that carry no message', () => {
    expect(rawErrorMessage('直接抛出的字符串')).toBe('直接抛出的字符串')
    expect(rawErrorMessage(404)).toBe('404')
  })

  it('does not mistake a quoted method name mid-sentence for the prefix', () => {
    expect(rawErrorMessage(new Error("调用 'config:save' 时出错"))).toBe("调用 'config:save' 时出错")
  })

  it('is not affected by regex lastIndex state across calls', () => {
    // The prefix pattern deliberately has no /g flag. If that ever changes,
    // .test() would advance lastIndex and every other call would miss.
    const prefixed = "Error invoking remote method 'config:save': 保存失败"
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(rawErrorMessage(new Error(prefixed))).toBe('保存失败')
    }
  })
})

describe('userFacingErrorMessage', () => {
  it('redacts the Windows config path the main process names, account name included', () => {
    // electron/config-files.ts and electron/backups.ts put the failing path in
    // the message. On Windows that path carries the account name (I13).
    const leak = new Error(
      "Error invoking remote method 'config:save': Error: "
      + '配置事务源不是单链接普通文件，已拒绝写入：C:\\Users\\张三\\.codex\\config.toml',
    )

    expect(userFacingErrorMessage(leak)).toBe('配置事务源不是单链接普通文件，已拒绝写入：本地配置文件')
    expect(userFacingErrorMessage(leak)).not.toContain('张三')
  })

  it('redacts macOS and Linux home paths', () => {
    expect(userFacingErrorMessage(new Error('备份失败：/Users/zhangsan/.codex/config.toml')))
      .toBe('备份失败：本地配置文件')
    expect(userFacingErrorMessage(new Error('备份失败：/home/zhangsan/.codex/config.toml')))
      .toBe('备份失败：本地配置文件')
  })

  it('redacts a UNC path', () => {
    expect(userFacingErrorMessage(new Error('拒绝写入：\\\\fileserver\\share\\config.toml')))
      .toBe('拒绝写入：本地配置文件')
  })

  it('keeps the sentence that follows the path intact', () => {
    expect(userFacingErrorMessage(new Error('配置路径越过 Provider 根目录，已拒绝写入：C:\\Users\\张三\\x.toml，请重新选择目录')))
      .toBe('配置路径越过 Provider 根目录，已拒绝写入：本地配置文件，请重新选择目录')
  })

  it('collapses control characters so a stack fragment cannot reshape the dialog', () => {
    expect(userFacingErrorMessage(new Error('保存失败\n\tat handler (main.js:1)')))
      .toBe('保存失败 at handler (main.js:1)')
  })

  it('caps the length so one runaway message cannot fill the surface', () => {
    expect(userFacingErrorMessage(new Error('长'.repeat(2000)))).toHaveLength(1000)
  })

  it('answers an empty string for an empty cause', () => {
    expect(userFacingErrorMessage(null)).toBe('')
    expect(userFacingErrorMessage(new Error(''))).toBe('')
  })
})

describe('errorMessage', () => {
  it('never puts a config path on screen', () => {
    const leak = new Error(
      "Error invoking remote method 'config:save': Error: "
      + '保存 Codex 配置失败：C:\\Users\\张三\\.codex\\config.toml',
    )

    expect(errorMessage(leak)).toBe('保存 Codex 配置失败：本地配置文件')
  })

  it('keeps the precise new-api wording ahead of the heuristics', () => {
    // The table added for R-S4 must still win, including when the message
    // arrives wrapped by IPC.
    expect(errorMessage(new Error("Error invoking remote method 'account:change-password': Error: original password is incorrect")))
      .toBe('原密码错误，请重新输入')
    expect(errorMessage(new Error('user has been banned'))).toBe('该账号已被封禁，请联系客服')
  })

  it('matches the table on a plain object and on a bare string too', () => {
    // The previous implementation required an Error instance, so a structured
    // clone across IPC fell straight through to the generic fallback.
    expect(errorMessage({ message: 'registration has been disabled' }))
      .toBe('当前暂未开放注册，请联系客服')
    expect(errorMessage('database error')).toBe('服务暂时不可用，请稍后重试')
  })

  it('still maps an expired session and a network timeout', () => {
    expect(errorMessage(new Error('Request failed with status 401'))).toContain('登录')
    expect(errorMessage(new Error('fetch failed: ENOTFOUND'))).toContain('网络')
  })

  it('uses the caller fallback when nothing recognizes the cause', () => {
    expect(errorMessage(new Error('EPIPE'), '更新检查没有完成')).toBe('更新检查没有完成')
    expect(errorMessage(null, '更新检查没有完成')).toBe('更新检查没有完成')
    expect(errorMessage(new Error(''), '更新检查没有完成')).toBe('更新检查没有完成')
  })

  it('keeps its own generic fallback when the caller passes none', () => {
    expect(errorMessage(new Error('EPIPE'))).toBe('操作没有成功，请重试或查看反馈日志。')
  })
})

describe('snapshotErrorMessage', () => {
  it('redacts the local path a probe failure carries into the snapshot', () => {
    // describeProbeFailure hands Error.message through untouched, so a failed
    // stat lands on screen with the Windows account name in it.
    expect(snapshotErrorMessage("ENOENT: no such file or directory, open 'C:\\Users\\yoyo\\AppData\\Roaming\\claude.json'"))
      .toBe("ENOENT: no such file or directory, open '本地配置文件")
    expect(snapshotErrorMessage('读取 /Users/yoyo/.codex/config.toml 失败')).toBe('读取 本地配置文件 失败')
  })

  it('keeps a Chinese reason that names no path', () => {
    expect(snapshotErrorMessage('Claude Desktop 本地配置无法确认，请重新检测。'))
      .toBe('Claude Desktop 本地配置无法确认，请重新检测。')
  })

  it('reports nothing rather than an empty string so callers keep their own fallback', () => {
    expect(snapshotErrorMessage(null)).toBeNull()
    expect(snapshotErrorMessage(undefined)).toBeNull()
    expect(snapshotErrorMessage('   ')).toBeNull()
  })
})

describe('overflowedPage', () => {
  it('steps back to the last real page once the current one has emptied out', () => {
    expect(overflowedPage(2, 20)).toBe(1)
    expect(overflowedPage(2, 21)).toBeNull()
    expect(overflowedPage(1, 0)).toBeNull()
    expect(overflowedPage(3, 0)).toBe(1)
    expect(overflowedPage(5, 41, 20)).toBe(3)
  })
})
