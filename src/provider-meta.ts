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
    color: '#b35b34',
    tint: '#fff5ef',
    icon: claudeCodeIconUrl,
  },
  codex: {
    name: 'Codex CLI',
    company: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
    color: '#087b68',
    tint: '#edfaf7',
    icon: chatGptIconUrl,
  },
  grok: {
    name: 'Grok CLI',
    company: 'xAI',
    command: 'grok',
    packageName: '@xai-official/grok',
    color: '#323640',
    tint: '#f2f3f5',
    icon: grokIconUrl,
  },
  gemini: {
    name: 'Gemini CLI',
    company: 'Google',
    command: 'gemini',
    packageName: '@google/gemini-cli',
    color: '#5969c7',
    tint: '#f1f3ff',
    icon: geminiCliIconUrl,
  },
}

export const codexDesktopMeta: ProviderMeta = {
  name: 'Codex 桌面端',
  company: 'OpenAI · Windows',
  command: 'Codex App',
  packageName: '',
  color: '#087b68',
  tint: '#edfaf7',
  icon: chatGptIconUrl,
}

export const dashboardProviderIds: ProviderId[] = ['codex', 'claude', 'grok', 'gemini']

export function configProvider(tab: ConfigTabId): ProviderId {
  return tab === 'codexDesktop' ? 'codex' : tab
}

export function configTabMeta(tab: ConfigTabId, platform: PlatformCapabilities): ProviderMeta {
  return tab === 'codexDesktop'
    ? { ...codexDesktopMeta, company: platformPresentation(platform).codexDesktopCompany }
    : providers[tab]
}
