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
 * 这一类、配上「去微软商店装」按钮），所以和 network-failure.ts 一样不许引 Node。
 */

/** 微软商店里 Codex 桌面端的页面。main.ts 的外链白名单按全等匹配收的就是这一条（I12）。 */
export const codexDesktopStoreUrl = 'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS'

/** 安装 / 更新失败那句话的开头；渲染层 operation-error.ts 按它归到 codexDesktopInstallFailed。 */
export const codexDesktopInstallFailedPrefix = 'Codex 桌面端没装上'

/**
 * 客户看不懂、也用不上的那些词。安装失败那句话和安装途中的进度提示里都不许出现，
 * 测试按它钉住；进度提示里捎带的原因带着这些词时整段不上屏（原话照样进日志）。
 */
export const codexDesktopTechnicalWords = /SHA|MSIX|Appx|Content-Type|Content-Length|winget|msstore|0x[0-9a-f]{4,}|schema|HTTP \d{3}|Location/i

export type CodexDesktopInstallFailureReason = 'blocked' | 'damaged' | 'unreachable' | 'unavailable' | 'unknown'

export const codexDesktopInstallFailureReasons: Readonly<Record<CodexDesktopInstallFailureReason, string>> = {
  blocked: '这台电脑不让装（Windows 拒绝了这次安装）。可能留下了装到一半的程序，点「重试」会重新装一遍。',
  damaged: '下载下来的安装包不完整或被改过，已经删掉了。',
  unreachable: '国内下载线路这会儿连不上。',
  unavailable: '国内下载线路这会儿没有能装的版本。',
  unknown: '没查出是哪一步出了问题，经过已经记进日志。',
}

/**
 * 顺序有讲究：Windows 那一步（Add-AppxPackage）的报错里常带着 MSIX、签名这些
 * 词，先认它才不会被当成「安装包坏了」叫客户反复重下；「所有国内镜像均未通过
 * 完整校验」只是外壳，里面每一路的原因才算数，所以 damaged 只认具体的校验词，
 * 不认「校验」两个字。
 */
const rules: ReadonlyArray<{ reason: Exclude<CodexDesktopInstallFailureReason, 'unknown'>; test: RegExp }> = [
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
  return /磁盘|请勿重复操作|已取消管理员授权|未获得管理员权限|macOS|仅支持 Windows|读不到/.test(message)
}

export interface CodexDesktopInstallFailureContext {
  /** 这一次先试过微软商店、没装上。 */
  storeTried: boolean
  /** 本机已经装着一版，这次是更新。 */
  updating: boolean
}

export function buildCodexDesktopInstallFailureMessage(
  reason: CodexDesktopInstallFailureReason,
  context: CodexDesktopInstallFailureContext,
): string {
  const store = context.storeTried ? '微软商店这次没装上，' : ''
  // Windows 拒绝安装时旧版本可能已经被动过，不能说「照常能用」。
  const unaffected = context.updating && reason !== 'blocked' ? '原来那一版照常能用。' : ''
  return `${codexDesktopInstallFailedPrefix}：${store}${codexDesktopInstallFailureReasons[reason]}${unaffected}`
}

export function isCodexDesktopInstallFailureMessage(message: string): boolean {
  return message.includes(`${codexDesktopInstallFailedPrefix}：`)
}
