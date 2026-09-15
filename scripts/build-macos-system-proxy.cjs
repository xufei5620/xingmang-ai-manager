const { mkdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
if (process.platform !== 'darwin') throw new Error('macOS helper requires the macOS SDK')
mkdirSync(path.join(root, 'dist-native'), { recursive: true })
const fixture = process.argv.includes('--test')
for (const arch of fixture ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : ['arm64', 'x86_64']) {
  const target = fixture ? 'test' : arch === 'x86_64' ? 'x64' : arch
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-target', `${arch}-apple-macosx13.0`, ...(fixture ? ['-D', 'PROXY_TEST_BACKEND'] : []), '-O', path.join(root, 'native/macos-system-proxy.swift'), '-o', path.join(root, `dist-native/macos-system-proxy-${target}`)], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
