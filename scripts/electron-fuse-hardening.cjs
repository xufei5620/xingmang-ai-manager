const fs = require('node:fs')
const { FuseV1Options, FuseVersion } = require('@electron/fuses')
const { FuseState, SENTINEL } = require('@electron/fuses/dist/constants')

// Mirrors electron-builder.config.cjs `electronFuses`. That block is top-level,
// so every platform's package carries it, and every platform's package must be
// held to it: a Mac build that quietly fell back to the defaults would ship a
// binary usable as a general-purpose Node runtime through ELECTRON_RUN_AS_NODE
// and open to a debugger, with nothing in the release gate noticing.
const EXPECTED_FUSES = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
])

// @electron/fuses' own reader cannot be used here for two reasons. It rewrites
// any path containing `.app`, so it would walk away from the exact binary the
// caller pinned and back through the symlinks this verifier refuses to follow;
// and it stops at the first sentinel, which would let the second slice of a
// universal binary carry different fuses unseen.
function readFuseWires(binary) {
  const wires = []
  for (let index = binary.indexOf(SENTINEL); index !== -1; index = binary.indexOf(SENTINEL, index + 1)) {
    const position = index + SENTINEL.length
    const version = binary[position]
    const length = binary[position + 1]
    if (version === undefined || length === undefined) throw new Error('Electron fuse 线缆被截断')
    const states = [...binary.subarray(position + 2, position + 2 + length)]
    if (states.length !== length) throw new Error('Electron fuse 线缆被截断')
    wires.push({ version: `${version}`, states })
  }
  return wires
}

function describeFuseMismatches(states) {
  const mismatches = []
  for (const [option, expected] of EXPECTED_FUSES) {
    const actual = states[option]
    if (actual !== expected) {
      mismatches.push(`${FuseV1Options[option]}=${FuseState[actual] || actual}，期望 ${FuseState[expected]}`)
    }
  }
  return mismatches
}

// `binaryPath` is whatever carries the fuse wire on this platform: the packaged
// executable on Windows, the Electron Framework binary inside the bundle on
// macOS.
async function assertElectronFuseHardening(binaryPath, label) {
  const wires = readFuseWires(await fs.promises.readFile(binaryPath))
  if (wires.length === 0) {
    throw new Error(`${label}未找到 Electron fuse 线缆，无法确认加固状态`)
  }
  for (const wire of wires) {
    if (wire.version !== FuseVersion.V1) {
      throw new Error(`${label}的 Electron fuse 版本不受支持：${wire.version}`)
    }
    if (wire.states.length < EXPECTED_FUSES.size) {
      throw new Error(`${label}的 Electron fuse 线缆短于 ${EXPECTED_FUSES.size} 项，无法确认加固状态`)
    }
    const mismatches = describeFuseMismatches(wire.states)
    if (mismatches.length > 0) {
      throw new Error(`${label}的 Electron fuse 加固校验失败：${mismatches.join('；')}`)
    }
  }
  return EXPECTED_FUSES.size
}

module.exports = { EXPECTED_FUSES, assertElectronFuseHardening, describeFuseMismatches, readFuseWires }
