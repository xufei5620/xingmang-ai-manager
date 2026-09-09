import path from 'node:path'

/** The storage realms currently understood by the account layer. */
export type RealmDataRealm = 'xm-account' | 'api-account'

export interface RealmDataRoots {
  readonly realmId: RealmDataRealm
  /** Root used by stores that persist account-owned data. */
  readonly rootDirectory: string
  readonly chatKeysFile: string
  readonly managedCliKeysFile: string
  readonly canvasProjectsDirectory: string
  readonly canvasRuntimeDirectory: string
  readonly canvasVideoTasksDirectory: string
  readonly assetThumbnailsDirectory: string
  /** Resolve the generated-media root. xm keeps the pre-existing output root. */
  assetOutputDirectory(legacyRoot: string): string
  accountDirectory(userId: number): string
}

function requireRealm(value: unknown): RealmDataRealm {
  if (value !== 'xm-account' && value !== 'api-account') {
    throw new Error('账号数据域无效')
  }
  return value
}

function requireUserId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('账号标识无效')
  return value
}

/**
 * Resolve all account-owned roots from one stable application data directory.
 * xm-account deliberately keeps the historical paths for in-place upgrades;
 * api-account is always placed below a fixed realm directory, so equal user
 * IDs can never address the same files across realms.
 */
export function resolveRealmDataRoots(managerDataDirectory: string, realmInput: unknown): RealmDataRoots {
  if (typeof managerDataDirectory !== 'string' || !managerDataDirectory.trim() || managerDataDirectory.includes('\0')) {
    throw new Error('应用数据目录无效')
  }
  const managerRoot = path.resolve(managerDataDirectory)
  const realmId = requireRealm(realmInput)
  const rootDirectory = realmId === 'xm-account'
    ? managerRoot
    : path.join(managerRoot, 'realms', 'api-account')
  const accountDirectory = (userId: number): string => path.join(rootDirectory, `user-${requireUserId(userId)}`)
  const assetOutputDirectory = (legacyRoot: string): string => {
    if (typeof legacyRoot !== 'string' || !legacyRoot.trim() || legacyRoot.includes('\0')) throw new Error('资产输出目录无效')
    const base = path.resolve(legacyRoot)
    return realmId === 'xm-account' ? base : path.join(base, 'realms', 'api-account')
  }
  return Object.freeze({
    realmId,
    rootDirectory,
    chatKeysFile: path.join(rootDirectory, 'chat-group-keys.dat'),
    managedCliKeysFile: path.join(rootDirectory, 'managed-cli-keys.dat'),
    canvasProjectsDirectory: path.join(rootDirectory, 'canvas-projects'),
    canvasRuntimeDirectory: path.join(rootDirectory, 'canvas-runtime'),
    canvasVideoTasksDirectory: path.join(rootDirectory, 'canvas-video-tasks'),
    assetThumbnailsDirectory: path.join(rootDirectory, 'asset-thumbnails'),
    assetOutputDirectory,
    accountDirectory,
  })
}

export function resolveRealmDataRoot(managerDataDirectory: string, realmInput: unknown): string {
  return resolveRealmDataRoots(managerDataDirectory, realmInput).rootDirectory
}
