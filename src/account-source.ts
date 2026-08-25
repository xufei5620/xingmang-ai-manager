import type { ProviderConfigSummary, ProviderId } from './types'

// 账号来源(星芒中转 / 用户自己的官方订阅)在渲染层的表达。
//
// 判定规则与主进程 config-files.ts 的 providerAccountMode 是**有意重复**的
// 一份:electron/ 不 import src/,src/ 也不能 import 主进程模块(I6),而这
// 三行分类逻辑不值得为它开一条 IPC 往返。两边同时改动的风险由各自的单测
// 兜住(本文件的测试 + config-files.test.ts 的 classifies the account mode)。

export type ProviderAccountSource = 'relay' | 'official' | 'unknown'
export type AccountSourceSwitchTarget = 'official' | 'relay'
export type AccountSourceSwitchAction = 'switch-official' | 'switch-relay' | 'noop' | 'blocked'

/** 配置弹窗里的来源切换：unknown 不能一键改，当前源再点一次是空操作。 */
export function accountSourceSwitchAction(
  source: ProviderAccountSource,
  target: AccountSourceSwitchTarget,
  options?: { codexAuthMode?: 'apikey' | 'chatgpt' | null },
): AccountSourceSwitchAction {
  if (source === 'unknown') return 'blocked'
  if (source === target) {
    // 星芒地址已写入但 Codex 仍按 ChatGPT 登录：再点一次中转把 auth_mode 修好。
    if (target === 'relay' && options?.codexAuthMode === 'chatgpt') return 'switch-relay'
    return 'noop'
  }
  return target === 'official' ? 'switch-official' : 'switch-relay'
}

/** 界面显示星芒中转，但 Codex 实际还在用 ChatGPT token。 */
export function codexRelayStillUsesChatGptAuth(
  summary: Pick<ProviderConfigSummary, 'hasApiKey' | 'matchesRelay' | 'codexAuthMode'> | null | undefined,
): boolean {
  return providerAccountSource(summary) === 'relay' && summary?.codexAuthMode === 'chatgpt'
}

/** 只依赖 ProviderConfigSummary 已有的两个字段,不需要额外 IPC 读取。 */
export function providerAccountSource(
  summary: Pick<ProviderConfigSummary, 'hasApiKey' | 'matchesRelay'> | null | undefined,
): ProviderAccountSource {
  if (!summary) return 'official'
  if (summary.matchesRelay) return 'relay'
  if (!summary.hasApiKey) return 'official'
  return 'unknown'
}

/**
 * 该 CLI 的官方订阅叫什么。返回 null = 这个 CLI 没有可切回的官方登录
 * (Grok/xAI CLI 只有 API Key 一种认证方式),UI 据此整块隐藏。
 */
export function officialAccountLabel(provider: ProviderId): string | null {
  switch (provider) {
    case 'codex':
      return 'ChatGPT 账号'
    case 'claude':
      return 'Claude 账号'
    case 'gemini':
      return 'Google 账号'
    case 'grok':
      return null
  }
}

/** 切换后用户需要自己做的那一步(各 CLI 的登录入口不同)。 */
export function officialAccountLoginHint(provider: ProviderId): string {
  switch (provider) {
    case 'codex':
      return '切换后在 Codex 里用 ChatGPT 账号登录即可（若此前登录过则无需重登）'
    case 'claude':
      return '切换后运行 claude 并按提示用 Claude 账号登录（若此前登录过则无需重登）'
    case 'gemini':
      return '切换后运行 gemini 并按提示用 Google 账号登录（若此前登录过则无需重登）'
    case 'grok':
      return ''
  }
}

export function providerAccountSourceLabel(source: ProviderAccountSource, provider: ProviderId): string {
  switch (source) {
    case 'relay':
      return '星芒中转'
    case 'official':
      return officialAccountLabel(provider) ?? '未配置'
    case 'unknown':
      return '自定义（第三方地址）'
  }
}

/**
 * 星芒中转和官方订阅都能启动；自定义第三方地址不行。
 * Grok 没有官方登录，没配星芒 Key 时也拦下。
 */
export function canLaunchManagedProvider(
  summary: Pick<ProviderConfigSummary, 'hasApiKey' | 'matchesRelay'> | null | undefined,
  provider: ProviderId,
): boolean {
  const source = providerAccountSource(summary)
  if (source === 'relay') return true
  return source === 'official' && officialAccountLabel(provider) !== null
}

export function managedProviderLaunchBlockedMessage(provider: ProviderId): string {
  switch (provider) {
    case 'codex':
      return 'Codex 当前用的是自定义接口，请先切到星芒中转或 ChatGPT 账号'
    case 'claude':
      return 'Claude 当前用的是自定义接口，请先切到星芒中转或 Claude 账号'
    case 'gemini':
      return 'Gemini 当前用的是自定义接口，请先切到星芒中转或 Google 账号'
    case 'grok':
      return 'Grok CLI 尚未配置星芒 AI，请先完成配置'
  }
}

export function codexDesktopLaunchDialogCopy(source: ProviderAccountSource): {
  title: string
  subtitle: string
  openHint: string
  restartHint: string
} {
  const subtitle = source === 'official'
    ? '当前账号来源是 ChatGPT。没改配置直接打开即可；刚切换或保存过请重启。'
    : source === 'relay'
      ? '当前账号来源是星芒中转。没改配置直接打开即可；刚保存过请重启。'
      : '没改配置直接打开即可；刚保存过请重启。'
  return {
    title: 'Codex 已在运行',
    subtitle,
    openHint: '唤起已打开的窗口，不退出当前进程',
    restartHint: '退出后再启动，星芒中转和 ChatGPT 账号都会重新读取',
  }
}

/** ChatGPT 额度刷新只对 Codex 官方订阅开放，缺配置或星芒 Key 都不出按钮。 */
export function canRefreshOfficialChatGptUsage(
  summary: Pick<ProviderConfigSummary, 'exists' | 'hasApiKey' | 'matchesRelay'> | null | undefined,
): boolean {
  return providerConfigReadiness(summary) === 'official'
}

export const officialChatGptUsageRefreshMs = 60 * 60 * 1000

export function providerConfigReadiness(
  summary: Pick<ProviderConfigSummary, 'exists' | 'hasApiKey' | 'matchesRelay'> | null | undefined,
): 'missing' | 'relay' | 'official' | 'unknown' {
  if (!summary?.exists) return 'missing'
  if (summary.hasApiKey && summary.matchesRelay) return 'relay'
  if (!summary.hasApiKey) return 'official'
  return 'unknown'
}

export function providerConfigReadinessLabel(
  summary: Pick<ProviderConfigSummary, 'exists' | 'hasApiKey' | 'matchesRelay'> | null | undefined,
  provider: ProviderId,
  wording: 'dialog' | 'dashboard' | 'desktop' = 'dialog',
): string {
  const readiness = providerConfigReadiness(summary)
  const official = officialAccountLabel(provider)
  if (readiness === 'missing') {
    return wording === 'desktop' ? '共用配置文件未创建' : wording === 'dashboard' ? '配置文件未创建' : '尚未创建配置'
  }
  if (readiness === 'relay') {
    return wording === 'desktop' ? '与 Codex CLI 共用星芒配置' : '星芒 AI 已配置'
  }
  if (readiness === 'official') {
    return wording === 'desktop'
      ? `共用 ${official ?? '官方账号'}已登录`
      : `${official ?? '官方账号'}已登录`
  }
  return wording === 'desktop' ? '共用配置需要重新配置' : '需要重新配置'
}
