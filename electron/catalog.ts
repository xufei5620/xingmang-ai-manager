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

export const providerBaseUrls: Record<ProviderId, string> = {
  claude: 'https://api.solov.cc',
  codex: 'https://api.solov.cc',
  grok: 'https://api.solov.cc/v1',
  gemini: 'https://api.solov.cc',
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && providerIds.includes(value as ProviderId)
}
