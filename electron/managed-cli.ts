import fs from 'node:fs'
import path from 'node:path'
import {
  managedCliRoot,
  managedNpmCacheRoot,
  managedNpmPrefix,
  managedProductRoot,
} from './managed-cli-paths'
import {
  assertPlainDirectory,
  createTrustedTemporaryDirectory,
  ensureTrustedDirectory,
  type ApplyWindowsAcl,
} from './trusted-temp'
import type { WindowsMachinePaths } from './windows-machine-paths'

export interface ManagedNpmLayout {
  prefix: string
  cacheRoot: string
  userConfig: string
}

export interface ManagedNpmLayoutOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  applyWindowsAcl?: ApplyWindowsAcl
  machinePaths?: WindowsMachinePaths
}

const managedNpmTransactionPrefix = 'npm-transaction-'

async function recoverInterruptedManagedNpmTransaction(
  prefix: string,
  cacheRoot: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true })
  const recoverable: Array<{ transaction: string; previousPrefix: string }> = []

  for (const entry of entries) {
    if (!entry.name.startsWith(managedNpmTransactionPrefix)) continue
    const transaction = path.join(cacheRoot, entry.name)
    assertPlainDirectory(transaction, platform)
    const previousPrefix = path.join(transaction, 'previous-prefix')
    if (!fs.existsSync(previousPrefix)) continue
    assertPlainDirectory(previousPrefix, platform)
    recoverable.push({ transaction, previousPrefix })
  }

  if (recoverable.length > 1) {
    throw new Error('检测到多个未完成的 npm 安装事务，无法安全判断应恢复的版本')
  }
  const interrupted = recoverable[0]
  if (!interrupted) return

  const displacedPrefix = path.join(interrupted.transaction, 'interrupted-prefix')
  if (fs.existsSync(displacedPrefix)) {
    throw new Error('npm 安装恢复目录已存在冲突，未修改当前安装')
  }

  const activeExists = fs.existsSync(prefix)
  if (activeExists) {
    assertPlainDirectory(prefix, platform)
    await fs.promises.rename(prefix, displacedPrefix)
  }
  try {
    await fs.promises.rename(interrupted.previousPrefix, prefix)
  } catch (error) {
    if (activeExists && fs.existsSync(displacedPrefix) && !fs.existsSync(prefix)) {
      try {
        await fs.promises.rename(displacedPrefix, prefix)
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`npm 安装恢复失败，且无法还原当前目录：${detail}`, { cause: error })
      }
    }
    throw new Error('npm 安装恢复失败，当前安装未被替换', { cause: error })
  }

  await fs.promises.rm(interrupted.transaction, { recursive: true, force: true })
}

function assertPlainSingleLinkFile(filePath: string): void {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error('托管 npm 配置不是单链接普通文件')
  }
  if (path.resolve(fs.realpathSync(filePath)) !== path.resolve(filePath)) {
    throw new Error('托管 npm 配置经过了符号链接或目录联接')
  }
}

export async function ensureManagedNpmLayout(
  options: ManagedNpmLayoutOptions = {},
): Promise<ManagedNpmLayout> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error('托管 npm 安装目录目前仅支持 Windows 和 macOS')
  }
  const env = options.env ?? process.env
  const directoryOptions = {
    platform,
    env,
    applyWindowsAcl: options.applyWindowsAcl,
    machinePaths: options.machinePaths,
  }
  const productRoot = managedProductRoot(env, platform, options.machinePaths)
  const cliRoot = managedCliRoot(env, platform, options.machinePaths)
  const prefix = managedNpmPrefix(env, platform, options.machinePaths)
  const cacheRoot = managedNpmCacheRoot(env, platform, options.machinePaths)

  for (const directory of [productRoot, cliRoot, cacheRoot]) {
    await ensureTrustedDirectory(directory, directoryOptions)
  }
  await recoverInterruptedManagedNpmTransaction(prefix, cacheRoot, platform)
  await ensureTrustedDirectory(prefix, directoryOptions)

  // npm must not consume a user-controlled .npmrc during managed maintenance.
  // Recreate this app-owned empty file after its parent has been secured.
  const userConfig = path.join(cliRoot, 'npmrc')
  if (fs.existsSync(userConfig)) {
    assertPlainSingleLinkFile(userConfig)
    await fs.promises.rm(userConfig)
  }
  const handle = await fs.promises.open(userConfig, 'wx', 0o600)
  await handle.close()
  assertPlainSingleLinkFile(userConfig)

  return { prefix, cacheRoot, userConfig }
}

export async function createManagedNpmCache(
  layout: ManagedNpmLayout,
  options: ManagedNpmLayoutOptions = {},
): Promise<string> {
  return createTrustedTemporaryDirectory('npm', {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    baseDirectory: layout.cacheRoot,
    applyWindowsAcl: options.applyWindowsAcl,
    machinePaths: options.machinePaths,
  })
}
