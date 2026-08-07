const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CODESIGN_PATH = '/usr/bin/codesign'
const DEFAULT_PROBE_BINARY = '/usr/bin/true'
const COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_OPTIONS = { retries: 3, interval: 5_000, backoff: 5_000 }

function normalizeSha1Fingerprint(value) {
  const input = String(value || '').trim()
  if (!/^[A-Fa-f0-9]{40}$/.test(input)) {
    throw new Error('ephemeral macOS signing requires a 40-character SHA-1 fingerprint')
  }
  return input.toUpperCase()
}

function requireAbsolutePath(value, label) {
  const input = String(value || '').trim()
  if (!input || input.includes('\0') || !path.isAbsolute(input)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return path.resolve(input)
}

function defaultCommandRunner(spec) {
  const result = spawnSync(spec.executable, spec.argv, {
    encoding: 'utf8',
    env: spec.env,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) throw new Error(`cannot start ${spec.label}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${spec.label} failed: ${result.stderr?.trim() || 'unknown error'}`)
  }
}

async function retrySigning(task, options, wait) {
  let attempt = 0
  while (true) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= options.retries) throw error
      await wait(options.interval + options.backoff * attempt)
      attempt += 1
    }
  }
}

function verifyEphemeralMacSigningIdentity(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('ephemeral macOS signing verification requires macOS')
  }
  const identitySha1 = normalizeSha1Fingerprint(options.identitySha1)
  const keychainPath = requireAbsolutePath(options.keychainPath, 'ephemeral signing keychain')
  const sourceBinary = requireAbsolutePath(
    options.sourceBinary || DEFAULT_PROBE_BINARY,
    'signing probe source binary',
  )
  const probePath = requireAbsolutePath(options.probePath, 'signing probe output')
  const commandRunner = options.commandRunner || defaultCommandRunner
  const env = options.env || process.env

  fs.copyFileSync(sourceBinary, probePath, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(probePath, 0o755)
  commandRunner({
    executable: CODESIGN_PATH,
    argv: [
      '--force', '--sign', identitySha1,
      '--keychain', keychainPath,
      '--timestamp=none',
      '--options', 'runtime',
      probePath,
    ],
    env,
    label: 'ephemeral private-key signing probe',
    shell: false,
  })
  commandRunner({
    executable: CODESIGN_PATH,
    argv: ['--verify', '--strict', '--verbose=2', probePath],
    env,
    label: 'ephemeral private-key signature verification',
    shell: false,
  })
  return { identitySha1, keychainPath, probePath }
}

async function sign(configuration, options = {}) {
  const env = options.env || process.env
  if (env.XINGMANG_MAC_CI_EPHEMERAL_SIGNING !== '1') {
    throw new Error('ephemeral macOS signer is disabled outside its CI build mode')
  }
  const identitySha1 = normalizeSha1Fingerprint(env.XINGMANG_MAC_SIGNING_SHA1)
  const keychainPath = requireAbsolutePath(env.CSC_KEYCHAIN, 'ephemeral signing keychain')
  if (!configuration || configuration.identity !== '-') {
    throw new Error('ephemeral macOS signer requires the ad-hoc identity placeholder')
  }
  const configuredKeychain = requireAbsolutePath(
    configuration.keychain,
    'electron-builder signing keychain',
  )
  if (configuredKeychain !== keychainPath) {
    throw new Error('electron-builder signing keychain does not match the ephemeral keychain')
  }

  const signAsync = options.signAsync || require('@electron/osx-sign').signAsync
  const signingOptions = {
    ...configuration,
    identity: identitySha1,
    keychain: keychainPath,
    identityValidation: false,
    strictVerify: true,
  }
  const retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retryOptions }
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  await retrySigning(() => signAsync(signingOptions), retryOptions, wait)
}

module.exports = {
  normalizeSha1Fingerprint,
  sign,
  verifyEphemeralMacSigningIdentity,
}
