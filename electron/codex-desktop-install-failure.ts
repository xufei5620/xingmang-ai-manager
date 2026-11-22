// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * Codex 桌面端装不上 / 更新不了时，客户看到的那句话（第十九批 5）。
 *
 * 以前安装那一路的原话直接上屏：「镜像备用源安装包 SHA-256 与镜像清单不一致」
 *「返回的不是 MSIX 文件（Content-Type: …）」「错误码 0x8a150049」一句套三层，
 * 末尾一句「请使用微软商店完成首次安装」又没有按钮。这里把原话归成客户分得清的
 * 几种原因，每种一句大白话；原话本身照旧挂在错误上进 runtime.jsonl，「查看日志」
 * 看得到，界面不出现。
 *
 * 这个模块同时给主进程和渲染层用（渲染层靠 codexDesktopInstallFailedPrefix 认出
 * 这一类、配上「前往微软商店安装」按钮），所以和 network-failure.ts 一样不许引 Node。
 */

/** 微软商店里 Codex 桌面端的页面。main.ts 的外链白名单按全等匹配收的就是这一条（I12）。 */
export const codexDesktopStoreUrl = 'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS'

/** 安装 / 更新失败那句话的开头；渲染层 operation-error.ts 按它归到 codexDesktopInstallFailed。 */
export const codexDesktopInstallFailedPrefix = 'Codex 桌面端未能安装'

/**
 * 客户看不懂、也用不上的那些词。安装失败那句话和安装途中的进度提示里都不许出现，
 * 测试按它钉住；进度提示里捎带的原因带着这些词时整段不上屏（原话照样进日志）。
 */
export const codexDesktopTechnicalWords = /SHA|MSIX|Appx|Content-Type|Content-Length|winget|msstore|0x[0-9a-f]{4,}|schema|HTTP \d{3}|Location/i

export type CodexDesktopInstallFailureReason = 'unsupported' | 'firewallOff' | 'blocked' | 'damaged' | 'unreachable' | 'unavailable' | 'unknown'

/**
 * 这台电脑根本没有微软商店（LTSC、精简版、公司策略关掉了）时，失败句里代替
 *「微软商店安装失败」的那半句。渲染层按它认出这一类、不再给「前往微软商店安装」。
 */
export const codexDesktopNoStoreNotice = '本机没有微软商店'

/**
 * 第二路（OpenAI 官网的离线安装包）也没下成、换到国内镜像时，接在商店那半句后面的话。
 * 进度提示和失败句共用这一句，免得两处说法对不上。
 */
export const codexDesktopOfficialPackageFailedNotice = 'OpenAI 官网的离线安装包也未能下载'

/**
 * winget 的 APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE：商店那边还没有比本机更新的版本。
 * 商店没出错，只是没新版，失败句里不能说成「微软商店安装失败」。
 */
export const codexDesktopStoreNoUpdateExitCode = 0x8a15002b

export const codexDesktopInstallFailureReasons: Readonly<Record<CodexDesktopInstallFailureReason, string>> = {
  unsupported: '本机的 Windows 版本过旧，无法安装 Codex 桌面端。可先使用 Codex CLI，或将 Windows 更新至最新版本。',
  firewallOff: '本机的 Windows 防火墙服务已停用。新版 Codex 桌面端安装时需在防火墙中注册，该服务停用时 Windows 将拒绝安装，重试或通过微软商店安装均无法解决。',
  blocked: 'Windows 拒绝了本次安装，可能留有未安装完成的程序，点击「重试」将重新安装。',
  damaged: '下载的安装包不完整或已被篡改，已删除。',
  unreachable: '国内下载线路暂时无法连接。',
  unavailable: '国内下载线路暂无可安装的版本。',
  unknown: '未能确定出错的步骤，详细过程已记录到日志。',
}

/**
 * 顺序有讲究：Windows 那一步（Add-AppxPackage）的报错里常带着 MSIX、签名这些
 * 词，先认它才不会被当成「安装包坏了」叫客户反复重下；「所有国内镜像均未通过
 * 完整校验」只是外壳，里面每一路的原因才算数，所以 damaged 只认具体的校验词，
 * 不认「校验」两个字。
 */
const rules: ReadonlyArray<{ reason: Exclude<CodexDesktopInstallFailureReason, 'unknown'>; test: RegExp }> = [
  // 系统版本低于安装包要求时 Windows 报 0x80073CFD（ERROR_INSTALL_PREREQUISITE_FAILED），
  // 原话里写着要求的 OS 版本。它也在 blocked 那一族错误码里，但「重试」永远没用，
  // 所以排在 blocked 前面单独认。
  { reason: 'unsupported', test: /0x80073cfd|requires OS version|OS 版本[^。；]{0,40}(或更高|以上)/i },
  // 0x800706D9 (EPT_S_NOT_REGISTERED) inside the generic 0x80073CF6: registering the
  // package's windows.firewallRules extension needs the Windows Firewall service (MpsSvc)
  // over RPC, and it is stopped or disabled. Retrying or going through the Store hits the
  // same registration step. PowerShell wraps its error at the console width (the
  // 2026-11-06 log reads "windows.firewallRu\r\nles"), so match the code, not the word.
  { reason: 'firewallOff', test: /0x800706d9/i },
  { reason: 'blocked', test: /Add-AppxPackage|管理员安装失败|应用部署|0x80073[cd][0-9a-f]{2}|授权使用了不同的 Windows 账号|安装命令完成后仍未检测到/i },
  { reason: 'damaged', test: /SHA-256|Content-Length|Content-Type|不是 MSIX|AppxManifest|官方安装包|不匹配|字节数|下载不完整|超过声明|大小无效|安全上限|签名|身份|已损坏|元数据|发生变化|与[^。；]{0,12}清单版本[^。；]{0,24}不一致/i },
  { reason: 'unreachable', test: /HTTP \d{3}|超时|连接|连不上|本次不可用|未返回|重定向|fetch failed|network|socket|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_[A-Z_]+/i },
  { reason: 'unavailable', test: /没有可安装|没有可验证|没有可用镜像|无法获取|不支持当前处理器架构/ },
]

export function classifyCodexDesktopInstallFailure(detail: string): CodexDesktopInstallFailureReason {
  return rules.find((rule) => rule.test.test(detail))?.reason ?? 'unknown'
}

/**
 * 这几句本来就是写给客户看的，而且各有自己的下一步（清磁盘、重新授权、别重复点、
 * 换回当初装它的 Windows 账户），套上「没装上」反而把那一步盖掉，所以原样放行。
 */
export function isPlainCodexDesktopInstallMessage(message: string): boolean {
  return /磁盘|[A-Z] 盘空间不足|请勿重复操作|已取消管理员授权|未获得管理员权限|macOS|仅支持 Windows|读不到|无法读取已安装的版本|无法读取本机 Codex 桌面端的安装信息/.test(message)
}

export interface CodexDesktopInstallFailureContext {
  /** 这一次先试过微软商店、没装上。 */
  storeTried: boolean
  /** 试过商店，商店说还没有比本机更新的版本（codexDesktopStoreNoUpdateExitCode）。缺省 = 商店那边出错或没试。 */
  storeNoUpdate?: boolean
  /** 这台电脑没有微软商店，这次直接走的国内线路。缺省 = 不知道或有商店。 */
  storeUnavailable?: boolean
  /** 商店之后还试过 OpenAI 官网的离线安装包，没下成才换的国内镜像。缺省 = 没走那一路。 */
  officialTried?: boolean
  /** 本机已经装着一版，这次是更新。 */
  updating: boolean
}

export function buildCodexDesktopInstallFailureMessage(
  reason: CodexDesktopInstallFailureReason,
  context: CodexDesktopInstallFailureContext,
): string {
  // 防火墙服务停着时，商店和官网那两路怎么样都不相干：哪一路装都卡在同一步，提了反倒像是还能换一路试。
  const routes = reason !== 'firewallOff'
  const store = !routes ? ''
    : context.storeUnavailable ? `${codexDesktopNoStoreNotice}，`
      : context.storeTried ? (context.storeNoUpdate ? '微软商店暂无新版本，' : '微软商店安装失败，') : ''
  const official = routes && context.officialTried ? `${codexDesktopOfficialPackageFailedNotice}，` : ''
  // Windows 拒绝安装时旧版本可能已经被动过，不能说「照常能用」。
  const unaffected = context.updating && reason !== 'blocked' && reason !== 'firewallOff' ? '原版本仍可正常使用。' : ''
  return `${codexDesktopInstallFailedPrefix}：${store}${official}${codexDesktopInstallFailureReasons[reason]}${unaffected}`
}

export function isCodexDesktopInstallFailureMessage(message: string): boolean {
  return message.includes(`${codexDesktopInstallFailedPrefix}：`)
}

/** 没有微软商店的电脑上装不上：那颗「前往微软商店安装」按了也打不开。 */
export function isCodexDesktopNoStoreInstallFailure(message: string): boolean {
  return isCodexDesktopInstallFailureMessage(message) && message.includes(`${codexDesktopNoStoreNotice}，`)
}

/** Windows 太旧装不了：重试、去商店都没用。 */
export function isCodexDesktopUnsupportedInstallFailure(message: string): boolean {
  return isCodexDesktopInstallFailureMessage(message) && message.includes(codexDesktopInstallFailureReasons.unsupported)
}

/** Windows 防火墙服务停着装不上：重试、去商店都没用，先得把服务打开。 */
export function isCodexDesktopFirewallOffInstallFailure(message: string): boolean {
  return isCodexDesktopInstallFailureMessage(message) && message.includes(codexDesktopInstallFailureReasons.firewallOff)
}
