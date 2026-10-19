// 两个 npm 源的地址、谁先谁后、查询地址怎么拼（#1070 第 2 步从 system-service.ts 原样搬来）。装命令行工具、
// 首页查新版本、卸载都要用，单放一个小文件，那几块搬出去以后就不用互相 import。
import type { NetworkRegion } from './system-service'

// Version checks run during the dashboard's initial scan. Keep each registry
// attempt bounded so an offline machine reaches the UI with an explicit
// "检查失败" state instead of appearing frozen for a minute or longer.
export const npmLatestQueryTimeoutMs = 10_000
export const maximumNpmRegistryResponseBytes = 256 * 1024

export const npmOfficialRegistry = 'https://registry.npmjs.org'
export const npmMirrorRegistry = 'https://registry.npmmirror.com'

/**
 * An unknown region means the Cloudflare probe could not complete, and the
 * users whose network blocks that probe are overwhelmingly the ones who also
 * cannot reach registry.npmjs.org. Sending them to the official registry first
 * was exactly backwards.
 *
 * The costs are not symmetric. An overseas user wrongly routed to npmmirror
 * loses a few seconds to a CDN that still serves them; a mainland user wrongly
 * routed to the official registry cannot install at all. Both entries stay in
 * the list either way, so a wrong guess only changes which one is tried first.
 */
export function npmInstallRegistries(region: NetworkRegion): [string, string] {
  return region === 'outside-mainland-china'
    ? [npmOfficialRegistry, npmMirrorRegistry]
    : [npmMirrorRegistry, npmOfficialRegistry]
}

export function npmRegistryLabel(registry: string): string {
  return registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
}

export function npmPackageLatestUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/latest`
}

export function npmPackageVersionUrl(registry: string, packageName: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
}
