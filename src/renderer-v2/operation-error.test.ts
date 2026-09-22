import { describe, expect, it } from 'vitest'
import { classifyOperationError, operationFallbackActions, presentOperationError, type OperationErrorKey } from './operation-error'
import { errors } from './registry/errors'

/**
 * 目录里的 16 条都要有交代：要么给出一句真的会到达渲染层的后端原话，要么写明
 * 为什么这条不可能从失败消息里认出来。这张表就是「还有几类是死代码」的答案。
 */
const catalogCoverage: Record<OperationErrorKey, { sample: string } | { unreachable: string }> = {
  sessionExpired: { sample: '账号接口返回 401 Unauthorized' },
  keyInvalid: { sample: '当前分组下无可用渠道' },
  noBalance: { sample: '账号余额或 API Key 额度不足，请充值后重试' },
  tooManyRequests: { sample: '星芒服务返回 429 Too Many Requests' },
  server: { sample: '星芒服务返回 502 Bad Gateway' },
  timeout: { sample: '模型查询超时，请检查网络后重试' },
  // 更新替换正在跑的 CLI 时文件被锁，主进程（cli-process-probe.ts）把话说清楚；
  // npm 自己吐的 EBUSY 原文也走这条。
  toolRunning: { sample: 'Claude Code 更新失败：文件被占用，检测到 Claude Code 正在运行（2 个进程），请关掉它的窗口再试。' },
  installBlocked: { sample: 'Grok CLI 安装失败：安装文件已被隔离，请检查杀毒软件的隔离记录' },
  downloadTimeout: { sample: 'Codex CLI 安装失败：npm 官方源：request to registry 失败，reason: ETIMEDOUT' },
  permission: { sample: 'Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename' },
  updateIntegrity: { sample: 'Claude Code 更新失败：SHA-512 完整性校验不一致' },
  backupIntegrity: { sample: '备份文件已损坏或被篡改' },
  unsafeStorage: { sample: '当前系统没有可用的密钥环，安全存储只能以明文保存，已拒绝写入托管 API Key。' },
  // 支付的两个终态不走这条路：pages-account.tsx 的 paymentTerminalPresentation
  // 已经按回跳结果给出更具体的说法，再用目录文案盖一层只会更含糊。
  paymentClosed: { unreachable: 'paymentTerminalPresentation 直接给终态文案' },
  paymentTimeout: { unreachable: 'paymentTerminalPresentation 直接给终态文案' },
  // 托盘在 Windows 与 macOS 上一直存在，没有对应的失败消息可认。
  noTray: { unreachable: '受支持的两个平台都有托盘' },
  unknown: { unreachable: '兜底格，由 operationFallbackActions 负责' },
}

describe('renderer-v2 operation error classification', () => {
  it('names the npm failures a user actually hits during a CLI install', () => {
    expect(classifyOperationError('Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename')).toBe('permission')
    expect(classifyOperationError('Grok CLI 安装失败：EBUSY: resource busy or locked')).toBe('toolRunning')
    expect(classifyOperationError('Codex CLI 安装失败：npm 官方源：request to https://registry.npmjs.org failed, reason: ETIMEDOUT')).toBe('downloadTimeout')
  })

  it('sends a locked file to the running tool, not to the antivirus settings', () => {
    // 候选 5：更新/回滚要替换正在运行的 CLI 的文件，Windows 上那是文件锁。
    // 以前这几句都落在 installBlocked，标题是「安装被杀毒软件拦住了」。
    for (const locked of [
      'Claude Code 安装失败：npm 官方源：EBUSY: resource busy or locked, rename',
      'Claude Code 更新失败：文件被占用，检测到 Claude Code 正在运行（2 个进程），请关掉它的窗口再试。',
      'Codex CLI 更新失败：文件被占用，Codex CLI 可能正在运行，请关掉正在使用它的窗口再试。',
      '会话操作失败，会话文件正被其他程序占用；请关闭占用它的程序（如杀毒或备份软件）后重启本工具',
    ]) expect([locked, classifyOperationError(locked)]).toEqual([locked, 'toolRunning'])
    const hint = presentOperationError('Claude Code 更新失败：文件被占用，检测到 Claude Code 正在运行（2 个进程），请关掉它的窗口再试。')
    expect(hint?.title).toBe('工具正在运行')
    expect(hint?.actions).toEqual([{ id: 'retry', label: '重试' }, { id: 'log', label: '查看日志' }])
  })

  it('still names a real antivirus quarantine', () => {
    expect(classifyOperationError('Grok CLI 安装失败：安装文件已被隔离，请检查杀毒软件的隔离记录')).toBe('installBlocked')
    expect(classifyOperationError('Windows Defender 拦住了安装包')).toBe('installBlocked')
  })

  it('leaves a bare EPERM as a permission failure, since the raw text cannot tell the two apart', () => {
    // 主进程只有数到这个工具的进程才会写「文件被占用」（cli-process-probe.ts 的
    // describeOccupiedUpdateFailure）。没有那句话时不许替用户猜。
    expect(classifyOperationError('Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename')).toBe('permission')
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

  it('sends a permission failure to the directory and the log, never to an elevated retry', () => {
    // A2 余项：这一类以前只有「以管理员身份重试」这一颗按钮，没有提权通道
    // 接得住它，于是整条落回「找客服」。现在两颗按钮都是这个应用真做得到的事。
    const hint = presentOperationError('安装失败：EACCES permission denied')
    expect(hint?.title).toBe('写不进安装目录')
    expect(hint?.actions).toEqual([{ id: 'copyPath', label: '复制路径' }, { id: 'log', label: '查看日志' }])
  })

  it('keeps 以管理员身份重试 out of the catalog and out of the honoured labels', () => {
    // 本程序按普通权限运行（0.1.12 起），提权重试等于换一套安装事务。目录里
    // 不该再出现它，表里也不该认它——这条钉住的是那个决定，不是当下的文案。
    expect(JSON.stringify(errors)).not.toContain('以管理员身份重试')
    expect(presentOperationError('安装失败：EACCES permission denied')?.actions
      .some((action) => action.label.includes('管理员'))).toBe(false)
  })

  it('offers 复制路径 on the antivirus block, where the catalog has asked for it all along', () => {
    const hint = presentOperationError('Grok CLI 安装失败：安装文件已被隔离，请检查杀毒软件的隔离记录')
    expect(hint?.actions).toEqual([{ id: 'copyPath', label: '复制路径' }, { id: 'retry', label: '重试' }])
  })

  it('accounts for every catalog entry, either with a real message or a reason it cannot be reached', () => {
    expect(Object.keys(catalogCoverage).sort()).toEqual(Object.keys(errors).sort())
    for (const [key, coverage] of Object.entries(catalogCoverage)) {
      if ('sample' in coverage) expect([key, classifyOperationError(coverage.sample)]).toEqual([key, key])
      else expect(coverage.unreachable.length).toBeGreaterThan(0)
    }
  })

  it('names the restore failure with the wording backups.ts actually throws', () => {
    const hint = presentOperationError('恢复备份失败：备份文件已损坏或被篡改')
    expect(hint?.title).toBe('备份文件校验失败')
    expect(hint?.body).toBe('未做任何改动。')
  })

  it('tells the user this machine has no keyring rather than blaming permissions', () => {
    const hint = presentOperationError('当前系统没有可用的密钥环，安全存储只能以明文保存，已拒绝写入已保存的账号。请先启用系统凭据服务后重试。')
    expect(hint?.key).toBe('unsafeStorage')
    expect(hint?.title).toBe('这台电脑无法安全保存密码')
  })

  it('never reassures when the backend says the rollback failed too', () => {
    // system-service.ts 的 ManagedNpmRollbackError。套上「当前版本不受影响」
    // 正好是反的：旧版本已经没了。
    expect(presentOperationError('托管 npm 更新失败，且旧版本回滚失败：SHA-512 完整性校验不一致')).toBeNull()
    expect(presentOperationError('托管 npm 更新失败，且旧版本回滚失败：EPERM: operation not permitted')).toBeNull()
    // 「恢复备份失败」不是撤回没做成，照常归类。
    expect(presentOperationError('恢复备份失败：备份文件已损坏或被篡改')).not.toBeNull()
  })

  it('keeps an exit for a failure it cannot name', () => {
    expect(operationFallbackActions()).toEqual([
      { id: 'retry', label: '重试' },
      { id: 'log', label: '查看日志' },
      { id: 'support', label: '找客服' },
    ])
  })
})
