import chatGptIconUrl from '../assets/brands/chatgpt.svg'
import claudeCodeIconUrl from '../assets/brands/claude-code.svg'
import geminiCliIconUrl from '../assets/brands/gemini-cli.svg'
import grokIconUrl from '../assets/brands/grok.svg'
import { platformPresentation } from './platform-presentation'
import type { PlatformCapabilities, ProviderId } from './types'

export type ConfigTabId = ProviderId | 'codexDesktop'

export interface ProviderMeta {
  name: string
  company: string
  command: string
  packageName: string
  color: string
  tint: string
  icon: string
}

export const providers: Record<ProviderId, ProviderMeta> = {
  claude: {
    name: 'Claude Code',
    company: 'Anthropic',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
    color: 'var(--provider-claude)',
    tint: 'var(--provider-claude-soft)',
    icon: claudeCodeIconUrl,
  },
  codex: {
    name: 'Codex CLI',
    company: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
    color: 'var(--provider-codex)',
    tint: 'var(--provider-codex-soft)',
    icon: chatGptIconUrl,
  },
  grok: {
    name: 'Grok CLI',
    company: 'xAI',
    command: 'grok',
    packageName: '@xai-official/grok',
    color: 'var(--provider-grok)',
    tint: 'var(--provider-grok-soft)',
    icon: grokIconUrl,
  },
  gemini: {
    name: 'Gemini CLI',
    company: 'Google',
    command: 'gemini',
    packageName: '@google/gemini-cli',
    color: 'var(--provider-gemini)',
    tint: 'var(--provider-gemini-soft)',
    icon: geminiCliIconUrl,
  },
}

export const codexDesktopMeta: ProviderMeta = {
  name: 'Codex 桌面端',
  company: 'OpenAI · Windows',
  command: 'Codex App',
  packageName: '',
  color: 'var(--provider-codex)',
  tint: 'var(--provider-codex-soft)',
  icon: chatGptIconUrl,
}

export function configProvider(tab: ConfigTabId): ProviderId {
  return tab === 'codexDesktop' ? 'codex' : tab
}

export function configTabMeta(tab: ConfigTabId, platform: PlatformCapabilities): ProviderMeta {
  return tab === 'codexDesktop'
    ? { ...codexDesktopMeta, company: platformPresentation(platform).codexDesktopCompany }
    : providers[tab]
}
