import os from 'node:os'
import path from 'node:path'
import type { ProviderId } from './catalog'

export interface ProviderConfigRoots {
  userHome: string
  codexHome: string
}

export interface CodexHomeContext extends ProviderConfigRoots {
  codexEnv: NodeJS.ProcessEnv
}

export interface ResolveCodexHomeContextOptions {
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
  userHome?: string
}

function selectedAbsolutePath(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const selected = value.trim()
  if (selected.includes('\0')) throw new Error(`${label} 不能包含 NUL`)
  if (!path.isAbsolute(selected)) throw new Error(`${label} 必须是绝对路径`)
  return path.resolve(selected)
}

export function resolveCodexHomeContext(options: ResolveCodexHomeContextOptions): CodexHomeContext {
  const env = options.env ?? process.env
  const userHome = path.resolve(options.userHome ?? os.homedir())
  const selected = options.isPackaged
    ? selectedAbsolutePath(env.CODEX_HOME, 'CODEX_HOME')
    : selectedAbsolutePath(env.XINGMANG_CODEX_HOME_OVERRIDE, 'XINGMANG_CODEX_HOME_OVERRIDE')
      ?? selectedAbsolutePath(env.CODEX_HOME, 'CODEX_HOME')
  const codexHome = selected ?? path.join(userHome, '.codex')
  return { userHome, codexHome, codexEnv: { ...env, CODEX_HOME: codexHome } }
}

export function defaultProviderConfigRoots(
  userHome = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfigRoots {
  const resolvedUserHome = path.resolve(userHome)
  const codexHome = selectedAbsolutePath(env.CODEX_HOME, 'CODEX_HOME')
    ?? path.join(resolvedUserHome, '.codex')
  return { userHome: resolvedUserHome, codexHome }
}

export function providerConfigRoot(provider: ProviderId, roots: ProviderConfigRoots): string {
  return provider === 'codex' ? roots.codexHome : path.join(roots.userHome, `.${provider}`)
}
