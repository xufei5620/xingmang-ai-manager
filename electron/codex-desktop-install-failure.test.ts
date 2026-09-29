import { describe, expect, it } from 'vitest'
import {
  buildCodexDesktopInstallFailureMessage,
  classifyCodexDesktopInstallFailure,
  codexDesktopInstallFailedPrefix,
  codexDesktopInstallFailureReasons,
  codexDesktopTechnicalWords,
  isCodexDesktopInstallFailureMessage,
  type CodexDesktopInstallFailureReason,
} from './codex-desktop-install-failure'
import { CodexDesktopInstallFailure, describeCodexDesktopPrimaryMirrorSkip, toCodexDesktopInstallFailure } from './codex-desktop-service'

// 每一类都用 codex-desktop-service.ts / codex-desktop-appx.ts 真会抛出的原话。
const samples: Record<CodexDesktopInstallFailureReason, string[]> = {
  blocked: [
    'Add-AppxPackage 安装失败：部署失败，HRESULT: 0x80073CF3，程序包无法进行更新、相关性或冲突验证。',
    'Codex 桌面端管理员安装失败（退出码 1），请检查 Windows 应用部署事件日志后重试。',
    '授权使用了不同的 Windows 账号，已停止安装以免注册到其他用户。请由当前 Windows 账号的管理员会话完成安装。',
    '安装命令完成后仍未检测到 Codex Desktop',
  ],
  damaged: [
    '所有国内镜像均未通过完整校验：国内镜像（26.924.2738.0）：镜像备用源安装包 SHA-256 与镜像清单不一致，文件可能已损坏；镜像备用源（26.924.2738.0）：镜像备用源返回的不是 MSIX 文件（Content-Type: text/html）',
    '所有国内镜像均未通过完整校验：国内镜像（26.924.2738.0）：国内镜像返回的 Content-Length 与镜像清单不一致：应为 1024 字节，实际 512 字节',
    '所有国内镜像均未通过完整校验：国内镜像（26.924.2738.0）：官方安装包缺少 Appx 签名',
    '所有国内镜像均未通过完整校验：国内镜像（26.924.2738.0）：安装包版本 26.1.0.0 与国内镜像清单版本 26.924.2738.0 不一致',
    '授权期间 Codex 安装包发生变化，已停止安装，请重新下载。',
  ],
  unreachable: [
    '所有国内镜像均未通过完整校验：国内镜像（26.924.2738.0）：国内镜像连接或下载超时；镜像备用源（26.924.2738.0）：镜像备用源返回 HTTP 503',
    '当前版本和上一版本均无法获取（当前版本：国内镜像返回 HTTP 502；上一版本：连接被拒绝），请使用微软商店完成首次安装',
    '国内镜像清单读取失败：fetch failed',
  ],
  unavailable: [
    '国内镜像暂时没有可安装的 Codex Desktop 版本',
    '当前镜像暂时不可用，上一版本也无法获取（没有可验证的上一版本清单），请使用微软商店完成首次安装',
    'Codex Desktop 更新源不支持当前处理器架构 ia32',
  ],
  unknown: [
    '无法比较已安装版本 26.1.0.0 与镜像版本 26.924.2738.0',
    'Codex Desktop 下载地址格式无效',
  ],
}

describe('Codex Desktop install failure wording', () => {
  it('sorts each raw failure into the reason a customer can act on', () => {
    for (const [reason, messages] of Object.entries(samples)) {
      for (const message of messages) expect([message, classifyCodexDesktopInstallFailure(message)]).toEqual([message, reason])
    }
  })

  it('never shows a customer the technical words the raw failure is full of', () => {
    for (const reason of Object.keys(codexDesktopInstallFailureReasons) as CodexDesktopInstallFailureReason[]) {
      for (const storeTried of [true, false]) {
        for (const updating of [true, false]) {
          const message = buildCodexDesktopInstallFailureMessage(reason, { storeTried, updating })
          expect(message.startsWith(`${codexDesktopInstallFailedPrefix}：`)).toBe(true)
          expect(isCodexDesktopInstallFailureMessage(message)).toBe(true)
          expect(message).not.toMatch(codexDesktopTechnicalWords)
          expect(message).not.toMatch(/SHA|MSIX|Appx|Content-Type|winget|msstore|Codex Desktop|错误码|镜像清单/i)
        }
      }
    }
  })

  it('only promises the old version still works when Windows did not touch it', () => {
    expect(buildCodexDesktopInstallFailureMessage('damaged', { storeTried: false, updating: true })).toContain('原来那一版照常能用')
    expect(buildCodexDesktopInstallFailureMessage('damaged', { storeTried: false, updating: false })).not.toContain('原来那一版')
    expect(buildCodexDesktopInstallFailureMessage('blocked', { storeTried: false, updating: true })).not.toContain('原来那一版')
    expect(buildCodexDesktopInstallFailureMessage('blocked', { storeTried: false, updating: false })).toContain('装到一半')
  })

  it('keeps the raw failure, the store exit code and the cause for the runtime log', () => {
    const raw = new Error(samples.damaged[0])
    const failure = toCodexDesktopInstallFailure(raw, { storeFailure: '商店那边没说原因', storeExitCode: '0x8a150049', updating: false })
    expect(failure).toBeInstanceOf(CodexDesktopInstallFailure)
    expect(failure.message).toBe('Codex 桌面端没装上：微软商店这次没装上，下载下来的安装包不完整或被改过，已经删掉了。')
    expect(failure.cause).toBe(raw)
    // ipc.ts 记失败时 runtime-log 的 sanitizeValue 只会带上 Error 的「自有、可枚举」字段。
    expect(Object.keys(failure)).toEqual(expect.arrayContaining(['detail', 'reason', 'storeExitCode']))
    const logged = failure as CodexDesktopInstallFailure
    expect(logged.detail).toBe(`微软商店这次没装上（商店那边没说原因），国内镜像也没装上：${samples.damaged[0]}`)
    expect(logged.storeExitCode).toBe('0x8a150049')
  })

  it('lets sentences already written for customers through untouched', () => {
    for (const plain of [
      'Codex 桌面端安装失败：安装目录所在磁盘空间不足，只剩 300 MB，至少需要 1.0 GB，请先清理磁盘再试',
      '已取消管理员授权，Codex 桌面端安装未开始。重新点击安装即可再次授权。',
      '读不到这台电脑上 Codex 桌面端的安装信息，请换成当初装它的那个 Windows 账户登录，再打开星芒重试。',
      'Codex 桌面端正在安装或更新，请勿重复操作',
    ]) {
      const original = new Error(plain)
      expect(toCodexDesktopInstallFailure(original, { storeFailure: null, storeExitCode: null, updating: false })).toBe(original)
    }
  })

  it('keeps technical detail out of the fallback download notice', () => {
    const fallback = { label: '镜像备用源', url: 'https://codexapp-r2.agentsmirror.com/latest/win-x64' }
    expect(describeCodexDesktopPrimaryMirrorSkip(fallback, ['国内镜像：返回 HTTP 503'])).toBe('国内镜像本次不可用')
    expect(describeCodexDesktopPrimaryMirrorSkip(fallback, ['国内镜像：schema、产品 ID、包身份、版本、架构、文件大小或 SHA-256 校验失败'])).toBe('国内镜像本次不可用')
    expect(describeCodexDesktopPrimaryMirrorSkip(fallback, ['国内镜像：查询超时'])).toBe('国内镜像本次不可用（查询超时）')
  })
})
