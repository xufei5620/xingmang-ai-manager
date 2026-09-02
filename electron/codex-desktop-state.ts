import fs from 'node:fs'
import path from 'node:path'
import {
  assertNoReparseComponents,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const globalStateFileName = '.codex-global-state.json'
const maximumGlobalStateBytes = 8 * 1024 * 1024
const persistedAtomStateKey = 'electron-persisted-atom-state'
const permissionVisibilityKey = 'composer-permission-mode-visibility'

const defaultPermissionVisibility = {
  'guardian-approvals': true,
  'full-access': true,
} as const

export interface CodexDesktopGlobalStateStatus {
  path: string
  exists: boolean
  needsRepair: boolean
  error: string | null
}

export interface CodexDesktopGlobalStateRepairResult extends CodexDesktopGlobalStateStatus {
  changed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isPermissionVisibility(value: unknown): value is Record<string, boolean> {
  return isRecord(value)
    && typeof value['guardian-approvals'] === 'boolean'
    && typeof value['full-access'] === 'boolean'
}

function parseGlobalState(content: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('Codex Desktop 全局状态文件无法解析')
  }
  if (!isRecord(parsed)) throw new Error('Codex Desktop 全局状态文件格式无效')
  return parsed
}

/**
 * Normalizes the persisted composer permission visibility atom introduced by
 * newer Desktop builds. Older builds wrote a boolean here; the current UI
 * expects an object and disables its permission selector when it receives the
 * legacy value. Only this one atom is changed; all other Desktop state stays
 * intact.
 */
export function normalizeCodexDesktopGlobalStateText(
  content: string | null,
): { content: string | null; changed: boolean; needsRepair: boolean } {
  if (content === null) return { content: null, changed: false, needsRepair: false }
  const parsed = parseGlobalState(content)
  const atoms = parsed[persistedAtomStateKey]
  if (!isRecord(atoms)) return { content, changed: false, needsRepair: false }

  const current = atoms[permissionVisibilityKey]
  if (current === undefined || isPermissionVisibility(current)) {
    return { content, changed: false, needsRepair: false }
  }

  const preserved = isRecord(current)
    ? {
        'guardian-approvals': typeof current['guardian-approvals'] === 'boolean'
          ? current['guardian-approvals']
          : defaultPermissionVisibility['guardian-approvals'],
        'full-access': typeof current['full-access'] === 'boolean'
          ? current['full-access']
          : defaultPermissionVisibility['full-access'],
      }
    : defaultPermissionVisibility
  atoms[permissionVisibilityKey] = preserved
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    changed: true,
    needsRepair: true,
  }
}

export function inspectCodexDesktopGlobalState(
  codexHome: string,
): CodexDesktopGlobalStateStatus {
  const statePath = path.resolve(codexHome, globalStateFileName)
  const base = { path: statePath, exists: false, needsRepair: false, error: null }
  try {
    assertNoReparseComponents(codexHome, 'Codex Home')
    const content = readSafeUtf8FileSync(statePath, 'Codex Desktop 全局状态文件', maximumGlobalStateBytes)
    if (content === null) return base
    const normalized = normalizeCodexDesktopGlobalStateText(content)
    return { ...base, exists: true, needsRepair: normalized.needsRepair }
  } catch (error) {
    return {
      ...base,
      exists: fs.existsSync(statePath),
      error: error instanceof Error ? error.message : 'Codex Desktop 全局状态检测失败',
    }
  }
}

/** Repairs the legacy permission selector state after the Desktop is closed. */
export async function repairCodexDesktopGlobalState(
  codexHome: string,
): Promise<CodexDesktopGlobalStateRepairResult> {
  const statePath = path.resolve(codexHome, globalStateFileName)
  assertNoReparseComponents(codexHome, 'Codex Home')
  const homeStats = fs.statSync(codexHome)
  if (!homeStats.isDirectory()) throw new Error('Codex Home 不是普通目录')
  const content = readSafeUtf8FileSync(statePath, 'Codex Desktop 全局状态文件', maximumGlobalStateBytes)
  const base = { path: statePath, exists: content !== null, needsRepair: false, error: null, changed: false }
  if (content === null) return base
  const normalized = normalizeCodexDesktopGlobalStateText(content)
  if (!normalized.changed || normalized.content === null) {
    return { ...base, needsRepair: normalized.needsRepair }
  }
  ensureSafeDataDirectory(codexHome, 'Codex Home')
  await writeAtomicSafeUtf8File(statePath, normalized.content, 'Codex Desktop 全局状态文件')
  return { ...base, needsRepair: false, changed: true }
}
