import type { ProviderConfigSummary, ProviderId } from './types'

// 账号来源(星芒中转 / 用户自己的官方订阅)在渲染层的表达。
//
// 判定规则与主进程 config-files.ts 的 providerAccountMode 是**有意重复**的
// 一份:electron/ 不 import src/,src/ 也不能 import 主进程模块(I6),而这
// 三行分类逻辑不值得为它开一条 IPC 往返。两边同时改动的风险由各自的单测
// 兜住(本文件的测试 + config-files.test.ts 的 classifies the account mode)。

export type ProviderAccountSource = 'relay' | 'official' | 'unknown'

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
