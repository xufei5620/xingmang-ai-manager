import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ProviderConfigRoots } from './codex-home'
import { removeCodexContextLimitsFromConfigs, type NativeConfigSaveResult, type NativeConfigWriteHooks } from './config-files'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

const markerContent = '{"version":1,"completed":true}\n'
const markerLabel = 'Codex 上下文限制迁移记录'

/** A stable ID, independent of app version, makes this a one-time upgrade. */
export async function runCodexContextLimitsMigration(
  managerDataDirectory: string,
  roots: ProviderConfigRoots,
  hooks: NativeConfigWriteHooks = {},
): Promise<NativeConfigSaveResult & { skipped: boolean }> {
  const resolvedRoot = path.resolve(roots.codexHome)
  const rootIdentity = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
  const rootHash = createHash('sha256').update(rootIdentity).digest('hex')
  const directory = path.join(managerDataDirectory, 'migrations')
  const markerPath = path.join(directory, `codex-context-limits-v1-${rootHash}.json`)
  const marker = readSafeUtf8FileSync(markerPath, markerLabel, 1024)
  if (marker !== null) {
    if (marker !== markerContent) throw new Error(`${markerLabel}损坏，未执行修改`)
    return { skipped: true, backups: [], files: [] }
  }

  const result = removeCodexContextLimitsFromConfigs(roots, hooks)
  // No config/no matching key also completes the check. Never create Codex
  // config files just to record migration state. Failed writes remain retryable.
  ensureSafeDataDirectory(directory, markerLabel)
  await writeAtomicSafeUtf8File(markerPath, markerContent, markerLabel)
  return { ...result, skipped: false }
}
