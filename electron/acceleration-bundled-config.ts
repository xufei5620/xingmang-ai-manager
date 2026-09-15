import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AccelerationDevelopmentConfig } from './acceleration-development-host'
import { assertSafeDataFile, readSafeUtf8File } from './safe-local-data'
import { readBoundedFile } from './bounded-file'
import { assertMacosAccelerationBinary } from './acceleration-binary'

const invalidBundle = '内置加速资源无效，请重新安装软件。'

export interface BundledAccelerationConfig extends AccelerationDevelopmentConfig {
  profileSha256: string
}

function resourceDefinitions(platform: string) {
  return [
    { fileKey: 'coreFile', digestKey: 'coreSha256', name: platform === 'darwin' ? 'mihomo' : 'mihomo.exe', limit: 100 * 1024 * 1024, label: '内置加速内核' },
    { fileKey: 'profileFile', digestKey: 'profileSha256', name: 'profile.yaml', limit: 2 * 1024 * 1024, label: '内置加速节点' },
  ] as const
}

function projectPins(value: unknown, platform: string, architecture: string): Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalidBundle)
  const manifest = value as Record<string, unknown>
  const mac = platform === 'darwin'
  if (mac ? manifest.version !== 2 || manifest.platform !== 'darwin' || manifest.arch !== architecture
    || !['arm64', 'x64'].includes(architecture) : manifest.version !== 1) throw new Error(invalidBundle)
  const pins: Record<string, string | number> = mac ? { version: 2, platform: 'darwin', arch: architecture } : { version: 1 }
  for (const resource of resourceDefinitions(platform)) {
    const digest = manifest[resource.digestKey]
    if (manifest[resource.fileKey] !== resource.name || typeof digest !== 'string' || !/^[a-f\d]{64}$/i.test(digest)) throw new Error(invalidBundle)
    pins[resource.fileKey] = resource.name
    pins[resource.digestKey] = digest.toLowerCase()
  }
  return pins
}

/** Only the installed bundle may opt a release into the local-device trial. */
export async function readBundledAccelerationConfig(options: {
  isPackaged: boolean
  platform: string
  architecture?: string
  resourcesPath: string
  /** Pins read from the installed application's ASAR-protected package metadata. */
  bundledMetadata?: unknown
}): Promise<BundledAccelerationConfig | null> {
  if (!options.isPackaged || !['win32', 'darwin'].includes(options.platform)) return null
  // An external manifest alone must never enable a bundle absent from the app.
  if (options.bundledMetadata === undefined || options.bundledMetadata === null) return null
  try {
    const architecture = options.architecture ?? process.arch
    const expected = projectPins(options.bundledMetadata, options.platform, architecture)
    if (typeof options.resourcesPath !== 'string' || !path.isAbsolute(options.resourcesPath)
      || options.resourcesPath.length > 4096 || /[\x00-\x1f]/.test(options.resourcesPath)) throw new Error(invalidBundle)
    const directory = path.join(options.resourcesPath, 'acceleration')
    const source = await readSafeUtf8File(path.join(directory, 'manifest.json'), '内置加速清单', 16 * 1024)
    if (source === null) throw new Error(invalidBundle)
    const manifest = projectPins(JSON.parse(source) as unknown, options.platform, architecture)
    if (Object.keys(expected).some(key => manifest[key] !== expected[key])) throw new Error(invalidBundle)
    // Names are exact constants, not general relative paths. A manifest cannot
    // point outside the installed resources or select a user-data config.
    // Read sequentially to keep the maximum simultaneous binary allocation
    // bounded. Never return any node contents through this config object.
    for (const resource of resourceDefinitions(options.platform)) {
      const filePath = path.join(directory, resource.name)
      if (!assertSafeDataFile(filePath, resource.label)) throw new Error(invalidBundle)
      const content = await readBoundedFile(filePath, resource.limit, resource.label)
      if (!content.length || createHash('sha256').update(content).digest('hex') !== expected[resource.digestKey]) throw new Error(invalidBundle)
      if (options.platform === 'darwin' && resource.fileKey === 'coreFile') assertMacosAccelerationBinary(content, architecture)
    }
    // Callers recheck these pins on the copied executable and every
    // freshly read profile, so later replacement cannot bypass this first read.
    return {
      version: 1,
      corePath: path.join(directory, String(expected.coreFile)), coreSha256: String(expected.coreSha256),
      profilePath: path.join(directory, 'profile.yaml'), profileSha256: String(expected.profileSha256),
    }
  } catch { throw new Error(invalidBundle) }
}
