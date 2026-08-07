const {
  DEFAULT_UPDATE_URL,
  normalizeUpdateBaseUrl,
} = require('./scripts/update-release-utils.cjs')
const path = require('node:path')

function resolveUpdateUrl() {
  const rawUrl = process.env.XINGMANG_UPDATE_URL?.trim() || DEFAULT_UPDATE_URL
  const allowsLocalHttp = process.env.XINGMANG_UPDATE_DEV === '1'
  return normalizeUpdateBaseUrl(rawUrl, { allowLocalHttp: allowsLocalHttp })
}

const outputDirectory = process.env.XINGMANG_OUTPUT_DIR?.trim() || 'release'
const localBuildMode = process.env.XINGMANG_LOCAL_BUILD === '1'
const releaseMode = !localBuildMode && process.env.XINGMANG_RELEASE === '1'
const freeMacReleaseMode = !localBuildMode && process.env.XINGMANG_MAC_FREE_RELEASE === '1'
if (releaseMode && freeMacReleaseMode) {
  throw new Error('XINGMANG_RELEASE=1 与 XINGMANG_MAC_FREE_RELEASE=1 不能同时启用')
}
const publicReleaseMode = releaseMode || freeMacReleaseMode
if (publicReleaseMode && process.env.XINGMANG_UPDATE_DEV === '1') {
  throw new Error('公开发布模式不能启用 XINGMANG_UPDATE_DEV=1')
}
const freeMacSigningIdentity = process.env.CSC_NAME?.trim()
if (freeMacReleaseMode && !freeMacSigningIdentity) {
  throw new Error('XINGMANG_MAC_FREE_RELEASE=1 需要通过 CSC_NAME 指定签名身份')
}
const ephemeralMacSigningMarker = process.env.XINGMANG_MAC_CI_EPHEMERAL_SIGNING
if (ephemeralMacSigningMarker !== undefined
  && ephemeralMacSigningMarker !== ''
  && ephemeralMacSigningMarker !== '0'
  && ephemeralMacSigningMarker !== '1') {
  throw new Error('XINGMANG_MAC_CI_EPHEMERAL_SIGNING 只接受精确的 0 或 1')
}
const ephemeralMacSigningMode = ephemeralMacSigningMarker === '1'
const pullRequestSigningMarker = process.env.CSC_FOR_PULL_REQUEST
const pullRequestSigningEnabled = pullRequestSigningMarker !== undefined
  && ['true', '1', ''].includes(pullRequestSigningMarker.trim())
if (pullRequestSigningEnabled && !ephemeralMacSigningMode) {
  throw new Error('CSC_FOR_PULL_REQUEST 只能由 CI ephemeral macOS signing 启用')
}
if (ephemeralMacSigningMode && !freeMacReleaseMode) {
  throw new Error('CI ephemeral macOS signing requires XINGMANG_MAC_FREE_RELEASE=1')
}
if (ephemeralMacSigningMode) {
  const identitySha1 = process.env.XINGMANG_MAC_SIGNING_SHA1?.trim() || ''
  const keychainPath = process.env.CSC_KEYCHAIN?.trim() || ''
  if (!/^[A-Fa-f0-9]{40}$/.test(identitySha1)) {
    throw new Error('CI ephemeral macOS signing requires a 40-character SHA-1 fingerprint')
  }
  if (!keychainPath || !path.isAbsolute(keychainPath)) {
    throw new Error('CI ephemeral macOS signing requires an absolute keychain path')
  }
  if (process.env.CSC_FOR_PULL_REQUEST !== 'true') {
    throw new Error('CI ephemeral macOS signing requires CSC_FOR_PULL_REQUEST=true')
  }
}
const signingPublisher = process.env.XINGMANG_SIGNING_PUBLISHER?.trim() || undefined
const updatePublisher = signingPublisher || '绍兴星芒文化传媒有限责任公司'

module.exports = {
  appId: 'com.xingmang.ai.manager',
  productName: '星芒AI管理工具',
  copyright: 'Copyright © 2026 绍兴星芒文化传媒有限责任公司',
  asar: true,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  directories: {
    output: outputDirectory,
  },
  // The main process uses this integrity-protected package metadata to keep
  // unpacked/ad-hoc artifacts away from the production update channel.
  extraMetadata: {
    xingmangLocalBuild: !publicReleaseMode,
  },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    'assets/**/*',
    'package.json',
  ],
  publish: {
    provider: 'generic',
    url: resolveUpdateUrl(),
    // publisherName is what makes electron-updater verify a downloaded
    // installer; without it the verifier is skipped entirely. It is therefore
    // enabled only together with real signing (releaseMode) - shipping it in an
    // unsigned build would leave those clients unable to accept any later
    // unsigned update, with no way back short of a manual reinstall.
    ...(releaseMode ? { publisherName: [updatePublisher] } : {}),
  },
  releaseInfo: {
    releaseNotesFile: 'release-notes.md',
  },
  forceCodeSigning: publicReleaseMode,
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    artifactName: 'XingMang-AI-Manager-${version}-${arch}.${ext}',
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '13.0',
    hardenedRuntime: true,
    icon: 'assets/icon.icns',
    // Local packages need an ad-hoc signature after Electron fuses are changed,
    // otherwise macOS rejects the invalidated upstream seal. This is not a
    // distributable Developer ID signature; release mode discovers that identity.
    identity: ephemeralMacSigningMode ? '-' : freeMacReleaseMode ? freeMacSigningIdentity : releaseMode ? undefined : '-',
    ...(ephemeralMacSigningMode ? { sign: './scripts/macos-ephemeral-signing.cjs' } : {}),
    notarize: releaseMode,
    ...(freeMacReleaseMode ? { timestamp: 'none' } : {}),
  },
  ...(freeMacReleaseMode ? {
    dmg: {
      // The free update channel is ZIP-only. DMGs remain manual installers and
      // must not create blockmaps or enter latest-mac.yml.
      writeUpdateInfo: false,
    },
  } : {}),
  win: {
    requestedExecutionLevel: 'asInvoker',
    // Stated explicitly because the strict verifier in update-signature.ts is
    // only reached while electron-updater performs its own signature check.
    verifyUpdateCodeSignature: true,
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/windows-icon.png',
    legalTrademarks: '星芒AI',
    artifactName: 'XingMang-AI-Manager-${version}-Setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '星芒AI管理工具',
    uninstallDisplayName: '星芒AI管理工具',
  },
}
