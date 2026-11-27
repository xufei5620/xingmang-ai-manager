/**
 * A stand-in for Claude Desktop's app.asar with the two manifests the seeds read out of it:
 * the Claude Code pin (`JSON.parse('{"version":…}')`) and the Cowork workspace versions
 * (`versions:[{sha:…}]`). Values are the real ones from 4.4212.0 used by
 * claude-desktop-code-seed.test.ts and claude-desktop-component-manifest.test.ts.
 */
import fs from 'node:fs'

export const claudeDesktopFixtureWinChecksum = '9078b9c1d466965d3faee8d13128f03d79b61794fb2130255ca1f5eab84e602c'
export const claudeDesktopFixtureMacBundleChecksum = '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba'
export const claudeDesktopFixtureWorkspaceSha = '072b6cbfe74f428a98bd86035f83b322b369d1f1'

function workspaceFile(name: string, checksum: string, size: number): string {
  return `{name:"${name}",checksum:"${checksum}",size:${size},progressStart:0,progressEnd:80}`
}

/** One minified `.vite/build/` chunk carrying both manifests; `version` is the Claude Code version it pins. */
export function claudeDesktopBuildScript(version = '2.1.309'): string {
  const code = JSON.stringify({
    version,
    manifest: {
      version,
      platforms: {
        'darwin-arm64': { binary: 'claude.zst', checksum: '614eb35bb650dee9cfa4a7821a60d5eab75fbcabe2c1b8aa408d2e93f06c1370', size: 93159896, bundle: { checksum: claudeDesktopFixtureMacBundleChecksum, size: 93151388 } },
        'linux-x64': { binary: 'claude.zst', checksum: 'e52289b95def16148c8d0a48b1ccc0d357429e73473a9a20ac0638fb7460a59b', size: 103411745 },
        'win32-x64': { binary: 'claude.exe.zst', checksum: claudeDesktopFixtureWinChecksum, size: 106715810 },
      },
    },
  })
  const winRootfs = workspaceFile('rootfs.vhdx', 'c480f8a62d0d9be20e1a1ee31b9f25c73097f793127dcefa90b0c59ada0e12ad', 1309889215)
  const macRootfs = workspaceFile('rootfs.img', '40818968b6929fcb32ab01f45116cf9fa7eebf5b078c1603b44a6da0eb262d69', 1246877094)
  return `function M_(){return JSON.parse('${code}')}`
    + `var VG={versions:[{sha:"${claudeDesktopFixtureWorkspaceSha}",publishedAt:"2026-10-22",`
    + `files:{unix:{arm64:[${macRootfs}],x64:[${macRootfs}]},win32:{arm64:[${winRootfs}],x64:[${winRootfs}]}}}]};`
}

/**
 * Writes an asar archive (a Chromium Pickle header holding the JSON file index, then the
 * bodies) with the given files, keyed by their slash-separated path inside the archive.
 * Electron's own asar layer accepts it as a real archive.
 */
export function writeAsarArchive(target: string, entries: Record<string, string>): void {
  const root: Record<string, unknown> = {}
  const bodies: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text)
    const segments = name.split('/')
    let folder = root
    for (const segment of segments.slice(0, -1)) {
      const child = (folder[segment] ??= { files: {} }) as { files: Record<string, unknown> }
      folder = child.files
    }
    folder[segments[segments.length - 1]] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const json = Buffer.from(JSON.stringify({ files: root }))
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(header.length, 4)
  fs.writeFileSync(target, Buffer.concat([prefix, header, ...bodies]))
}

/** Claude Desktop's app.asar as far as the seeds care: one `.vite/build/` script. */
export function writeClaudeDesktopAsar(target: string, script: string): void {
  writeAsarArchive(target, { '.vite/build/index.js': script, 'package.json': '{}' })
}
