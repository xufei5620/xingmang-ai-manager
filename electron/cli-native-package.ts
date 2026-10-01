import fs from 'node:fs'
import path from 'node:path'
import { readBoundedUtf8File } from './bounded-file'

// npm silently drops an optional dependency whose download fails, and still
// exits 0. Claude Code and Codex ship their real executable only in such a
// per-platform optional package, so a flaky proxy during install leaves a
// package whose version reads fine but cannot start at all (10-1 客户 Mac：
// 两步都只「added 1 package」，启动报 Could not find native binary package)。
const maximumManifestBytes = 1024 * 1024
const scopedPackageName = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/

/**
 * The optional dependencies that carry the executable for this platform. Any
 * architecture counts: an x64 Node under Rosetta, or on Windows on Arm,
 * installs the x64 package, and the launcher accepts whichever npm picked.
 */
export function cliNativePackageCandidates(
  manifest: unknown,
  packageName: string,
  platform: NodeJS.Platform,
): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const optional = (manifest as Record<string, unknown>).optionalDependencies
  if (!optional || typeof optional !== 'object' || Array.isArray(optional)) return []
  const prefix = `${packageName}-${platform}-`
  return Object.keys(optional).filter((name) => name.startsWith(prefix) && scopedPackageName.test(name))
}

async function hasPackageManifest(directory: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(path.join(directory, 'package.json'))).isFile()
  } catch {
    return false
  }
}

/**
 * 返回缺失的原生包名；不需要原生包或已经装上时返回 null。
 *
 * npm 把可选依赖装在包自己的 node_modules 下，也可能提升到同一个全局根，两处都认。
 * 读不到 package.json 时同样返回 null：包本身不在，由调用方的版本校验去报。
 */
export async function findMissingCliNativePackage(
  packageRoot: string,
  packageName: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readBoundedUtf8File(
      path.join(packageRoot, 'package.json'),
      maximumManifestBytes,
      `${packageName} package.json`,
    ))
  } catch {
    return null
  }
  const candidates = cliNativePackageCandidates(manifest, packageName, platform)
  if (candidates.length === 0) return null
  const nodeModulesRoot = path.resolve(packageRoot, ...packageName.split('/').map(() => '..'))
  for (const candidate of candidates) {
    const segments = candidate.split('/')
    if (await hasPackageManifest(path.join(packageRoot, 'node_modules', ...segments))) return null
    if (await hasPackageManifest(path.join(nodeModulesRoot, ...segments))) return null
  }
  const preferred = `${packageName}-${platform}-${process.arch}`
  return candidates.includes(preferred) ? preferred : candidates[0]
}

/** 面向客户的那句话：不出现包名，只说怎么办。 */
export function cliNativePackageMissingMessage(toolName: string): string {
  return `${toolName} 的主程序没有下载完整，多半是网络不稳定。请关掉代理或换个网络后再装一次`
}
