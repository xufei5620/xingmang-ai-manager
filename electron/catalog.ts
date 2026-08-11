export const providerIds = ['claude', 'codex', 'grok', 'gemini'] as const

export type ProviderId = (typeof providerIds)[number]

export interface CliDefinition {
  id: ProviderId
  name: string
  company: string
  command: string
  packageName: string
  versionArgs: string[]
}

export const cliCatalog: Record<ProviderId, CliDefinition> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    company: 'Anthropic',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
    versionArgs: ['--version'],
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    company: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
    versionArgs: ['--version'],
  },
  grok: {
    id: 'grok',
    name: 'Grok CLI',
    company: 'xAI',
    command: 'grok',
    packageName: '@xai-official/grok',
    versionArgs: ['--version'],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    company: 'Google',
    command: 'gemini',
    packageName: '@google/gemini-cli',
    versionArgs: ['--version'],
  },
}

export interface ManagedCliKeyProfile {
  group: string
  keyName: string
}

// The account-side token group each local CLI must use. Kept beside
// providerIds so the main-process provisioning code and renderer UI cannot
// drift onto different group names or provider coverage.
export const managedCliKeyProfiles: Record<ProviderId, ManagedCliKeyProfile> = {
  claude: { group: 'Claude-MAX(不限制客户端)-5m', keyName: 'xingmang-desktop-claude' },
  codex: { group: 'codex-pro', keyName: 'xingmang-desktop-codex' },
  grok: { group: 'grok', keyName: 'xingmang-desktop-grok' },
  gemini: { group: 'Gemini', keyName: 'xingmang-desktop-gemini' },
}

// 老板拍板(2026-08-10):中转与账号后端统一到 new-api 生产实例
// xm.solov.cc——CLI 的 AI 请求和注册/登录/Key 签发从此同域。原
// api.solov.cc 不再出现在任何写入 CLI 的配置里;老用户配置里的旧域会被
// matchesRelay 判为不匹配,走登录→重新写 Key 的迁移路径。路径形状不变
// (grok 仍带 /v1 后缀,其余裸域)。
export const providerBaseUrls: Record<ProviderId, string> = {
  claude: 'https://xm.solov.cc',
  codex: 'https://xm.solov.cc',
  grok: 'https://xm.solov.cc/v1',
  gemini: 'https://xm.solov.cc',
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && providerIds.includes(value as ProviderId)
}
