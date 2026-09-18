import type { CodexDesktopLocaleStatus, PlatformCapabilities } from '../../../../electron/ipc-contract'

export type ChineseRuntimeChoice = 'enabled' | 'disabled'

/**
 * The half of the question that costs nothing to evaluate, so an ordinary
 * Codex launch does not pay for a locale probe once the answer is stored.
 * The injection only exists on Windows; every other platform relies on the
 * persisted localeOverride alone and has no port to ask about.
 */
export function chineseRuntimePatchAnswerMissing(
  platform: PlatformCapabilities | null,
  storedChoice: ChineseRuntimeChoice | undefined,
): boolean {
  return platform?.platform === 'windows' && storedChoice === undefined
}

/**
 * Whether opening Codex Desktop should first ask about the Chinese runtime
 * patch. That patch is the only reason Codex is ever started with a local
 * debugging port, so an unanswered question means "do not open the port" --
 * but a user upgrading from a build where Chinese was always on would then
 * silently lose it, so they are asked exactly once and the answer is stored.
 */
export function shouldAskForChineseRuntimePatch(input: {
  platform: PlatformCapabilities | null
  storedChoice: ChineseRuntimeChoice | undefined
  locale: CodexDesktopLocaleStatus | null
}): boolean {
  if (!chineseRuntimePatchAnswerMissing(input.platform, input.storedChoice)) return false
  const locale = input.locale
  // A package without the official Chinese resources cannot be patched at all,
  // and a failed probe may succeed after the next update. Neither is an answer,
  // so neither is recorded: the question simply waits for a later launch.
  return Boolean(locale && !locale.error && locale.installed && locale.chineseResources.available)
}
