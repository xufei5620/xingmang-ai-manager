import os from 'node:os'
import path from 'node:path'
import { providerConfigDirectoryNames, type ProviderId } from './catalog'

export interface ProviderConfigRoots {
  userHome: string
  codexHome: string
}

export type IgnoredCodexHomeReason = 'relative' | 'nul'

export interface IgnoredCodexHome {
  /** The raw environment value. Log it only after home-directory redaction (I13). */
  value: string
  reason: IgnoredCodexHomeReason
}

export interface CodexHomeContext extends ProviderConfigRoots {
  codexEnv: NodeJS.ProcessEnv
  /** 用户环境里的 CODEX_HOME 写得不对、已按没设处理时才有。 */
  ignoredCodexHome?: IgnoredCodexHome
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

interface CodexHomeVariable {
  codexHome?: string
  ignored?: IgnoredCodexHome
}

/**
 * CODEX_HOME comes from the user's machine, not from us: Codex tutorials tell
 * people to `setx CODEX_HOME %USERPROFILE%\.codex`, which can store the
 * literal text, and `~/.codex` or `.codex` are just as easy to type. Throwing
 * here used to abort startup, so one bad variable locked the user out of the
 * very screen that could fix it. An unusable value is treated as unset and
 * reported instead; the value we inject into codexEnv then replaces it for
 * every Codex process we launch.
 *
 * Only this user-owned variable is forgiven. The development override below
 * stays strict, and no other path check is relaxed.
 */
function inspectCodexHomeVariable(value: string | undefined): CodexHomeVariable {
  if (value === undefined || value.trim() === '') return {}
  const selected = value.trim()
  if (selected.includes('\0')) return { ignored: { value: selected, reason: 'nul' } }
  if (!path.isAbsolute(selected)) return { ignored: { value: selected, reason: 'relative' } }
  return { codexHome: path.resolve(selected) }
}

export function resolveCodexHomeContext(options: ResolveCodexHomeContextOptions): CodexHomeContext {
  const env = options.env ?? process.env
  const userHome = path.resolve(options.userHome ?? os.homedir())
  const override = options.isPackaged
    ? undefined
    : selectedAbsolutePath(env.XINGMANG_CODEX_HOME_OVERRIDE, 'XINGMANG_CODEX_HOME_OVERRIDE')
  const variable: CodexHomeVariable = override ? {} : inspectCodexHomeVariable(env.CODEX_HOME)
  const codexHome = override ?? variable.codexHome ?? path.join(userHome, providerConfigDirectoryNames.codex)
  return {
    userHome,
    codexHome,
    codexEnv: { ...env, CODEX_HOME: codexHome },
    ...(variable.ignored ? { ignoredCodexHome: variable.ignored } : {}),
  }
}

export function defaultProviderConfigRoots(
  userHome = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfigRoots {
  const resolvedUserHome = path.resolve(userHome)
  const codexHome = inspectCodexHomeVariable(env.CODEX_HOME).codexHome
    ?? path.join(resolvedUserHome, providerConfigDirectoryNames.codex)
  return { userHome: resolvedUserHome, codexHome }
}

export function providerConfigRoot(provider: ProviderId, roots: ProviderConfigRoots): string {
  return provider === 'codex' ? roots.codexHome : path.join(roots.userHome, providerConfigDirectoryNames[provider])
}
