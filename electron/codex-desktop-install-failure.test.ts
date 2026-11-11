import { describe, expect, it } from 'vitest'
import {
  buildCodexDesktopInstallFailureMessage,
  classifyCodexDesktopInstallFailure,
  codexDesktopInstallFailedPrefix,
  codexDesktopInstallFailureReasons,
  codexDesktopTechnicalWords,
  isCodexDesktopFirewallOffInstallFailure,
  isCodexDesktopInstallFailureMessage,
  isCodexDesktopNoStoreInstallFailure,
  isCodexDesktopUnsupportedInstallFailure,
  type CodexDesktopInstallFailureReason,
} from './codex-desktop-install-failure'
import {
  CodexDesktopInstallFailure,
  codexDesktopPackageProbeError,
  describeCodexDesktopPrimaryMirrorSkip,
  toCodexDesktopInstallFailure,
} from './codex-desktop-service'

// 2026-11-06 客户日志里 codex-desktop-appx.ts 抛出的原话（只把用户名换掉）。PowerShell 按控制台
// 宽度折行，「windows.firewallRules」被折成了两半。
const firewallOffRaw = [
  'Add-AppxPackage 安装失败：Add-AppxPackage : 部署失败，原因是 HRESULT: 0x80073CF6, 无法注册包。\r\n',
  'AppxManifest.xml(38,6): 错误 0x800706D9: 无法注册 OpenAI.Codex_26.1103.3517.0_x64__2p2nqsd0c76g0 程序包，因为在注册 windows.firewallRu\r\n',
  'les 扩展时遇到以下错误: 终结点映射器中没有更多的终结点可用。\r\n',
  '。请重试，如果问题仍然存在，请联系程序包发布者。\r\n',
  "+ ... e = 'Stop'; Add-AppxPackage -Path 'C:\\Users\\someone\\AppData\\Local\\Temp\\x ...\r\n",
  '    + FullyQualifiedErrorId : DeploymentError,Microsoft.Windows.Appx.PackageManager.Commands.AddAppxPackageCommand',
].join('')

// 每一类都用 codex-desktop-service.ts / codex-desktop-appx.ts 真会抛出的原话。
const samples: Record<CodexDesktopInstallFailureReason, string[]> = {
  // 推测的原话：安装包要求的系统版本比这台电脑高时 Windows 的报法（真机待核）。
  unsupported: [
    'Add-AppxPackage 安装失败：部署失败，HRESULT: 0x80073CFD，无法满足安装的先决条件。Windows cannot install package OpenAI.Codex because this package is not compatible with the device. The package requires OS version 10.0.19041.0 or higher on the Windows.Desktop device family.',
    'Add-AppxPackage 安装失败：部署失败，原因是 HRESULT: 0x80073CFD，此程序包要求 Windows.Desktop 设备系列上的 OS 版本 10.0.19041.0 或更高版本。',
  ],
  firewallOff: [
    firewallOffRaw,
    // 英文系统上同一个错误的说法。
    'Add-AppxPackage 安装失败：Deployment failed with HRESULT: 0x80073CF6, Package could not be registered. error 0x800706D9: While processing the request, the system failed to register the windows.firewallRules extension due to the following error: There are no more endpoints available from the endpoint mapper.',
  ],
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
      for (const [storeTried, storeUnavailable] of [[true, false], [false, false], [false, true]]) {
        for (const [updating, officialTried] of [[true, false], [false, false], [true, true], [false, true]]) {
          const message = buildCodexDesktopInstallFailureMessage(reason, { storeTried, storeUnavailable, officialTried, updating })
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
    expect(buildCodexDesktopInstallFailureMessage('firewallOff', { storeTried: true, updating: true })).not.toContain('原来那一版')
  })

  it('blames the stopped Windows Firewall service, not the store, when the firewall rules cannot be registered', () => {
    // 2026-11-06 那一次：桶过期跳过、商店没新版、官网的包下好核过，交给 Windows 时卡在登记防火墙规则。
    const raw = new Error(firewallOffRaw)
    const failure = toCodexDesktopInstallFailure(raw, {
      storeFailure: '商店里暂时还没有更新的版本', storeExitCode: '0x8a15002b', updating: true, officialPackage: true,
      bucketFailure: '存储桶清单超过 24 小时没和官方核对过（上次是 2026-11-04T14:30:12.285Z），桶里的可能不是最新版',
    })
    expect(failure.message).toBe(`Codex 桌面端没装上：${codexDesktopInstallFailureReasons.firewallOff}`)
    expect(isCodexDesktopFirewallOffInstallFailure(failure.message)).toBe(true)
    expect(failure.message).not.toMatch(/微软商店这次没装上|微软商店里还没有新版|官网|不让装（/)
    expect(failure).toMatchObject({ reason: 'firewallOff', storeExitCode: '0x8a15002b' })
    // 日志里那句原话照旧带着三路各自的经过。
    expect((failure as CodexDesktopInstallFailure).detail).toBe(
      `存储桶这一路没走通（存储桶清单超过 24 小时没和官方核对过（上次是 2026-11-04T14:30:12.285Z），桶里的可能不是最新版），微软商店这次没装上（商店里暂时还没有更新的版本），OpenAI 官网的离线安装包也没装上：${firewallOffRaw}`,
    )
    // 这台电脑没有商店、或者是首次安装，说法也一样。
    for (const context of [{ storeTried: false, storeUnavailable: true, updating: false }, { storeTried: false, updating: false, officialTried: true }]) {
      expect(buildCodexDesktopInstallFailureMessage('firewallOff', context)).toBe(failure.message)
    }
    // 别的 Windows 拒装照旧是 blocked。
    expect(isCodexDesktopFirewallOffInstallFailure(buildCodexDesktopInstallFailureMessage('blocked', { storeTried: true, updating: false }))).toBe(false)
  })

  it('says the store has nothing newer yet rather than that it failed', () => {
    const raw = new Error(samples.unreachable[0])
    const failure = toCodexDesktopInstallFailure(raw, {
      storeFailure: '商店里暂时还没有更新的版本', storeExitCode: '0x8a15002b', updating: true,
    })
    expect(failure.message).toBe('Codex 桌面端没装上：微软商店里还没有新版，国内下载线路这会儿连不上。原来那一版照常能用。')
    // 商店真出了错（别的退出码、超时）照旧说没装上。
    for (const storeExitCode of ['0x8a150049', null]) {
      expect(toCodexDesktopInstallFailure(raw, { storeFailure: '商店那边没说原因', storeExitCode, updating: true }).message)
        .toBe('Codex 桌面端没装上：微软商店这次没装上，国内下载线路这会儿连不上。原来那一版照常能用。')
    }
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

  it('keeps what PowerShell failed with when the check before an update gets no answer', () => {
    // 10-28 点更新报错时日志里的那条命令：以前只记得下它的前 240 个字。
    const processError = Object.assign(
      new Error("Command failed: C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -Command $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Import-Module -Name 'Microsoft.PowerShell.Utility', 'Appx' -ErrorAction SilentlyContinue\n"),
      { code: null, killed: true, signal: 'SIGTERM', stderr: '' },
    )
    const summary = 'Codex desktop package probe: PowerShell gave no answer within 8 s and was stopped'
    const failure = toCodexDesktopInstallFailure(
      codexDesktopPackageProbeError(summary, { cause: processError }),
      { storeFailure: null, storeExitCode: null, updating: false },
    )

    // 客户看到的那句没变，变的只是日志里能看出是哪一步、为什么。
    expect(failure.message).toBe(buildCodexDesktopInstallFailureMessage('unknown', { storeTried: false, updating: false }))
    expect(failure).toMatchObject({ reason: 'unknown', detail: summary })
    expect((failure.cause as Error).cause).toBe(processError)
  })

  it('passes the package check sentence for another Windows account through without a cause', () => {
    const sentence = '读不到这台电脑上 Codex 桌面端的安装信息，请换成当初装它的那个 Windows 账户登录，再打开星芒重试。'
    const error = codexDesktopPackageProbeError(sentence, {})
    expect(error.cause).toBeUndefined()
    expect(toCodexDesktopInstallFailure(error, { storeFailure: null, storeExitCode: null, updating: true })).toBe(error)
  })

  it('says the store is missing rather than that it failed when this computer has none', () => {
    const failure = toCodexDesktopInstallFailure(new Error(samples.unreachable[0]), {
      storeFailure: null, storeExitCode: null, updating: false, storeUnavailable: true,
    })
    expect(failure.message).toBe('Codex 桌面端没装上：这台电脑没有微软商店，国内下载线路这会儿连不上。')
    expect(isCodexDesktopNoStoreInstallFailure(failure.message)).toBe(true)
    expect((failure as CodexDesktopInstallFailure).detail).toBe(`这台电脑没有微软商店，国内镜像也没装上：${samples.unreachable[0]}`)
    const withStore = buildCodexDesktopInstallFailureMessage('unreachable', { storeTried: true, updating: false })
    expect(isCodexDesktopNoStoreInstallFailure(withStore)).toBe(false)
  })

  it('names the failed official package between the store and the reason', () => {
    const raw = new Error(samples.unreachable[0])
    const failure = toCodexDesktopInstallFailure(raw, {
      storeFailure: '连不上微软商店', storeExitCode: null, updating: false, officialFailure: 'OpenAI 官网连接或下载超时',
    })
    expect(failure.message).toBe('Codex 桌面端没装上：微软商店这次没装上，OpenAI 官网的离线安装包也没下成，国内下载线路这会儿连不上。')
    expect((failure as CodexDesktopInstallFailure).detail).toBe(
      `微软商店这次没装上（连不上微软商店），OpenAI 官网的离线安装包也没下成（OpenAI 官网连接或下载超时），国内镜像也没装上：${samples.unreachable[0]}`,
    )

    const noStore = toCodexDesktopInstallFailure(raw, {
      storeFailure: null, storeExitCode: null, updating: true, storeUnavailable: true, officialFailure: 'OpenAI 官网返回 HTTP 403',
    })
    expect(noStore.message).toBe('Codex 桌面端没装上：这台电脑没有微软商店，OpenAI 官网的离线安装包也没下成，国内下载线路这会儿连不上。原来那一版照常能用。')
    expect(isCodexDesktopNoStoreInstallFailure(noStore.message)).toBe(true)
  })

  it('blames Windows, not the download, when the official package downloaded but would not install', () => {
    const raw = new Error(samples.blocked[0])
    const failure = toCodexDesktopInstallFailure(raw, {
      storeFailure: '商店那边没说原因', storeExitCode: '0x8a150049', updating: false, officialPackage: true,
    })
    expect(failure.message).toBe(`Codex 桌面端没装上：微软商店这次没装上，${codexDesktopInstallFailureReasons.blocked}`)
    expect((failure as CodexDesktopInstallFailure).detail)
      .toBe(`微软商店这次没装上（商店那边没说原因），OpenAI 官网的离线安装包也没装上：${samples.blocked[0]}`)
  })

  it('keeps a bucket route that did not work out of the customer sentence and puts it first in the log', () => {
    const raw = new Error(samples.unreachable[0])
    const failure = toCodexDesktopInstallFailure(raw, {
      storeFailure: '连不上微软商店', storeExitCode: null, updating: false, bucketFailure: '存储桶清单返回 HTTP 404',
    })
    expect(failure.message).toBe('Codex 桌面端没装上：微软商店这次没装上，国内下载线路这会儿连不上。')
    expect(failure.message).not.toContain('存储桶')
    expect((failure as CodexDesktopInstallFailure).detail).toBe(
      `存储桶这一路没走通（存储桶清单返回 HTTP 404），微软商店这次没装上（连不上微软商店），国内镜像也没装上：${samples.unreachable[0]}`,
    )
  })

  it('names the bucket package in the log when the build from an old index downloaded but would not install', () => {
    const raw = new Error(samples.blocked[0])
    const failure = toCodexDesktopInstallFailure(raw, {
      storeFailure: '商店那边没说原因', storeExitCode: '0x8a150049', updating: false,
      officialFailure: 'OpenAI 官网连接或下载超时', bucketFailure: '存储桶清单超过 24 小时没和官方核对过', bucketStale: true, bucketPackage: true,
    })
    // The customer sentence is the one the mirror would have got; the route only shows in the log.
    expect(failure.message).toBe(toCodexDesktopInstallFailure(raw, {
      storeFailure: '商店那边没说原因', storeExitCode: '0x8a150049', updating: false, officialFailure: 'OpenAI 官网连接或下载超时',
    }).message)
    expect(failure.message).not.toContain('存储桶')
    expect((failure as CodexDesktopInstallFailure).detail).toBe(
      `存储桶这一路没走通（存储桶清单超过 24 小时没和官方核对过），微软商店这次没装上（商店那边没说原因），OpenAI 官网的离线安装包也没下成（OpenAI 官网连接或下载超时），存储桶里的离线安装包也没装上：${samples.blocked[0]}`,
    )
  })

  it('tells a too-old Windows apart from a Windows that refused the install', () => {
    const message = buildCodexDesktopInstallFailureMessage('unsupported', { storeTried: true, updating: false })
    expect(message).toBe('Codex 桌面端没装上：微软商店这次没装上，这台电脑的 Windows 版本太旧，装不了 Codex 桌面端。可以先用 Codex CLI，或者把 Windows 更新到最新。')
    expect(isCodexDesktopUnsupportedInstallFailure(message)).toBe(true)
    expect(isCodexDesktopUnsupportedInstallFailure(buildCodexDesktopInstallFailureMessage('blocked', { storeTried: true, updating: false }))).toBe(false)
    // 其它 0x80073Cxx 仍然是「Windows 拒绝了这次安装」。
    expect(classifyCodexDesktopInstallFailure('Add-AppxPackage 安装失败：HRESULT: 0x80073CF3')).toBe('blocked')
  })

  it('lets sentences already written for customers through untouched', () => {
    for (const plain of [
      'Codex 桌面端安装失败：C 盘空间不足，只剩 300 MB，至少需要 1.0 GB，请先清理 C 盘再试',
      'Codex 桌面端安装失败：磁盘空间不足，只剩 300 MB，至少需要 1.0 GB，请先清理磁盘再试',
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
