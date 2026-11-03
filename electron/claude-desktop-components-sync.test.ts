import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as manifestModule from './claude-desktop-component-manifest'
import type { ClaudeDesktopComponentManifest, ClaudeDesktopVmArchitecture } from './claude-desktop-component-manifest'
import * as macCodeModule from './claude-desktop-mac-code-seed'
import * as workspaceModule from './claude-desktop-workspace-seed'
import { desktopPackageBucketOrigin, validateDesktopBucketUrl } from './desktop-package-bucket'

// scripts/sync-claude-components-cos.cjs copies these files into the bucket using the compiled
// copies of these very modules. This runs its plan against the TypeScript sources, so a renamed
// export or a moved key shows up here instead of as a red scheduled sync or an empty bucket.
interface PlanItem {
  label: string
  key: string
  sourceUrl: string
  bytes: number
  sha256: string
}

interface ComponentsSyncScript {
  PART_IDS: readonly string[]
  componentsFromModules: (manifest: unknown, workspace: unknown, macCode: unknown) => unknown
  buildPlan: (part: string, manifest: ClaudeDesktopComponentManifest, components: unknown) => { items: PlanItem[] }
}

const sync = createRequire(__filename)(path.join(__dirname, '..', 'scripts', 'sync-claude-components-cos.cjs')) as ComponentsSyncScript

// Real values from Claude Desktop 4.4212.0 (probe run 41623510171, 2026-11-03), trimmed to one or two files a platform.
const sha = '072b6cbfe74f428a98bd86035f83b322b369d1f1'
const manifest: ClaudeDesktopComponentManifest = {
  code: {
    version: '2.1.309',
    macBundles: {
      'darwin-arm64': { checksum: '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba', size: 93151388 },
      'darwin-x64': { checksum: '300ae7409767b5bf31c77b466987278ee4493cfc82099ef4ad89841f7bfc71d4', size: 98585917 },
    },
    linux: {},
  },
  vm: {
    sha,
    files: {
      win32: {
        x64: [
          { name: 'rootfs.vhdx', checksum: 'c480f8a62d0d9be20e1a1ee31b9f25c73097f793127dcefa90b0c59ada0e12ad', size: 1309889215, rawChecksum: null, rawSize: null },
          { name: 'initrd', checksum: 'e3c5ce2b8e9e9adf67de7ec83cafa4a0c65fab8a22036a6b53f03c9765b3342a', size: 28024101, rawChecksum: null, rawSize: null },
        ],
        arm64: [{ name: 'rootfs.vhdx', checksum: 'a'.repeat(64), size: 1290000000, rawChecksum: null, rawSize: null }],
      },
      unix: {
        x64: [{ name: 'rootfs.img', checksum: 'b'.repeat(64), size: 1360000000, rawChecksum: null, rawSize: null }],
        arm64: [
          { name: 'rootfs.img', checksum: '40818968b6929fcb32ab01f45116cf9fa7eebf5b078c1603b44a6da0eb262d69', size: 1246877094, rawChecksum: null, rawSize: null },
          { name: 'initrd-micro', checksum: 'c'.repeat(64), size: 9000000, rawChecksum: null, rawSize: null },
        ],
      },
    },
  },
}

/** Every key a client computes for the machines it runs on: Windows and Mac, both chips. */
function clientKeys(): string[] {
  const keys: string[] = []
  for (const platform of ['win32', 'darwin'] as const) {
    const platformKey = workspaceModule.claudeDesktopVmPlatformKey(platform)
    if (!platformKey || !manifest.vm) throw new Error('fixture')
    for (const architecture of ['x64', 'arm64'] as ClaudeDesktopVmArchitecture[]) {
      for (const file of manifest.vm.files[platformKey][architecture] ?? []) keys.push(workspaceModule.claudeDesktopWorkspaceObjectKey(sha, platformKey, architecture, file))
    }
  }
  for (const architecture of ['arm64', 'x64'] as ClaudeDesktopVmArchitecture[]) {
    const pin = macCodeModule.resolveClaudeCodeMacPin(manifest, architecture)
    if (pin) keys.push(macCodeModule.claudeCodeMacObjectKey(pin))
  }
  return keys
}

describe('sync-claude-components-cos against the client modules', () => {
  const components = sync.componentsFromModules(manifestModule, workspaceModule, macCodeModule)

  it('uploads exactly the files the Windows and Mac clients will ask the bucket for', () => {
    const planned = sync.PART_IDS.flatMap((part) => sync.buildPlan(part, manifest, components).items.map((item) => item.key))
    expect([...planned].sort()).toEqual(clientKeys().sort())
    expect(new Set(planned).size).toBe(planned.length)
  })

  it('puts every file where the client is allowed to download from', () => {
    for (const part of sync.PART_IDS) {
      for (const item of sync.buildPlan(part, manifest, components).items) {
        expect(validateDesktopBucketUrl(`${desktopPackageBucketOrigin}/${item.key}`).pathname).toBe(`/${item.key}`)
      }
    }
  })

  it('takes the size and checksum the client will check each file against', () => {
    const [rootfs] = sync.buildPlan('vm-win32-x64', manifest, components).items
    expect(rootfs).toMatchObject({ label: 'rootfs.vhdx.zst', bytes: 1309889215, sha256: 'c480f8a62d0d9be20e1a1ee31b9f25c73097f793127dcefa90b0c59ada0e12ad', sourceUrl: `https://downloads.claude.ai/vms/linux/x64/${sha}/rootfs.vhdx.zst` })
    const [arm] = sync.buildPlan('code-mac', manifest, components).items
    expect(arm).toMatchObject({ bytes: 93151388, sha256: '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba', sourceUrl: 'https://downloads.claude.ai/claude-code-releases/2.1.309/darwin-arm64/claude.app.tar.zst' })
  })
})
