/**
 * Claude Desktop 的 Cowork 工作区和 Mac 上的 Claude Code 程序包在星芒存储桶里放在哪。
 *
 * 存储桶同步作业（scripts/sync-claude-components-cos.cjs）编译后加载这个模块算位置往桶里传，客户端以后也用它
 * 算位置去桶里取，两边是同一个函数，位置不会对不上（claude-desktop-components-sync.test.ts 钉着）。位置里带着
 * 版本和官网文件的 sha256，同一个位置永远是同一份内容，桶里只增不改。
 */
import type {
  ClaudeCodeMacPlatform,
  ClaudeCodePackagePin,
  ClaudeDesktopComponentManifest,
  ClaudeDesktopVmArchitecture,
  ClaudeDesktopVmFile,
  ClaudeDesktopVmPlatformKey,
} from './claude-desktop-component-manifest'

export const claudeDesktopComponentsBucketPrefix = 'xingmang/offline/claude-components'

export interface ClaudeCodeMacPin extends ClaudeCodePackagePin {
  version: string
  platform: ClaudeCodeMacPlatform
}

const shaPattern = /^[0-9a-f]{40}$/
const checksumPattern = /^[0-9a-f]{64}$/
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// Mac 程序包压缩后 2.1.309 九十来 MB、2.1.326 约 120 MB；比上限还大就不是它了。
const macArchiveLimitBytes = 768 * 1024 * 1024

/** 这台电脑的 Claude 用清单里哪一边的工作区：Windows 用 win32，Mac 用 unix，别的系统没有 Cowork。 */
export function claudeDesktopVmPlatformKey(platform: NodeJS.Platform): ClaudeDesktopVmPlatformKey | null {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'unix'
  return null
}

export function claudeDesktopWorkspaceObjectKey(sha: string, platformKey: ClaudeDesktopVmPlatformKey, architecture: ClaudeDesktopVmArchitecture, file: Pick<ClaudeDesktopVmFile, 'name' | 'checksum'>): string {
  if (!shaPattern.test(sha) || !checksumPattern.test(file.checksum) || !fileNamePattern.test(file.name) || file.name.includes('..')) {
    throw new Error('工作区版本号、文件名或校验值格式无效')
  }
  return `${claudeDesktopComponentsBucketPrefix}/vm/${sha}/${platformKey}-${architecture}/${file.checksum}/${file.name}.zst`
}

/** Mac 上这一版 Claude 要的 Claude Code 程序包：跟着芯片走。版本号、校验值或大小不像样就当没有。 */
export function resolveClaudeCodeMacPin(manifest: ClaudeDesktopComponentManifest, architecture: ClaudeDesktopVmArchitecture): ClaudeCodeMacPin | null {
  const code = manifest.code
  if (!code || !versionPattern.test(code.version)) return null
  const platform: ClaudeCodeMacPlatform = architecture === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  const bundle = code.macBundles[platform]
  if (!bundle || !checksumPattern.test(bundle.checksum) || !Number.isSafeInteger(bundle.size) || bundle.size <= 0 || bundle.size > macArchiveLimitBytes) return null
  return { version: code.version, platform, checksum: bundle.checksum, size: bundle.size }
}

/** 桶里那一份的位置：版本、平台、校验值都在路径里，同一个名字永远是同一份内容。 */
export function claudeCodeMacObjectKey(pin: Pick<ClaudeCodeMacPin, 'version' | 'platform' | 'checksum'>): string {
  if (!versionPattern.test(pin.version) || !checksumPattern.test(pin.checksum) || (pin.platform !== 'darwin-arm64' && pin.platform !== 'darwin-x64')) {
    throw new Error('Claude Code 版本号、平台或校验值格式无效')
  }
  return `${claudeDesktopComponentsBucketPrefix}/code/${pin.version}/${pin.platform}/${pin.checksum}/claude.app.tar.zst`
}
