import os from 'node:os'
import path from 'node:path'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

const PRODUCT_DIRECTORY = 'XingMangAI'
const CLI_DIRECTORY = 'Cli'
const NPM_PREFIX_DIRECTORY = 'npm'
const NPM_CACHE_DIRECTORY = 'npm-cache'
const NATIVE_DIRECTORY = 'native'
const RUNTIME_DIRECTORY = 'Runtime'
const NODE_RUNTIME_DIRECTORY = 'node'

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

function requireProgramData(
  _env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const programData = platform === 'win32'
    ? (machinePaths ?? resolveWindowsMachinePaths()).programData
    : null
  if (!programData || (platform === 'win32' && !path.win32.isAbsolute(programData))) {
    throw new Error('未找到可信的 Windows ProgramData 目录')
  }
  return programData
}

export function managedProductRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  if (platform === 'darwin') {
    const homeDirectory = env.HOME?.trim() || os.homedir()
    if (!homeDirectory || homeDirectory.includes('\0') || !path.posix.isAbsolute(homeDirectory)) {
      throw new Error('未找到有效的 macOS 用户目录')
    }
    return path.posix.join(homeDirectory, 'Library', 'Application Support', PRODUCT_DIRECTORY)
  }
  if (platform !== 'win32') return path.posix.join('/var', 'lib', 'xingmang-ai')
  return path.win32.join(requireProgramData(env, platform, machinePaths), PRODUCT_DIRECTORY)
}

export function managedCliRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const root = managedProductRoot(env, platform, machinePaths)
  return pathApi(platform).join(root, CLI_DIRECTORY)
}

export function managedNpmPrefix(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const root = managedCliRoot(env, platform, machinePaths)
  return pathApi(platform).join(root, NPM_PREFIX_DIRECTORY)
}

export function managedNpmCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const root = managedCliRoot(env, platform, machinePaths)
  return pathApi(platform).join(root, NPM_CACHE_DIRECTORY)
}

export function managedNpmBinDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const prefix = managedNpmPrefix(env, platform, machinePaths)
  return platform === 'win32' ? prefix : path.posix.join(prefix, 'bin')
}

export function managedNativeRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const root = managedCliRoot(env, platform, machinePaths)
  return pathApi(platform).join(root, NATIVE_DIRECTORY)
}

/**
 * macOS 上缺 Node.js 时由本软件下载官方压缩包放在这里（第十六批 2），和四个工具
 * 同在产品目录下、同属当前用户，不装进系统目录，也就不用输开机密码。Windows 仍由
 * 机器级 MSI 安装，不用这个目录。
 */
export function managedNodeRuntimeRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  const root = managedProductRoot(env, platform, machinePaths)
  return pathApi(platform).join(root, RUNTIME_DIRECTORY, NODE_RUNTIME_DIRECTORY)
}

export function managedNodeRuntimeBinDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  return pathApi(platform).join(managedNodeRuntimeRoot(env, platform, machinePaths), 'bin')
}

export function managedNativeProviderRoot(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) throw new Error('托管 CLI Provider 格式错误')
  const root = managedNativeRoot(env, platform, machinePaths)
  return pathApi(platform).join(root, provider)
}
