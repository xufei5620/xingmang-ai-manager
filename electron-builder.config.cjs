const {
  resolveUpdateUrlForVersion,
  normalizeUpdateBaseUrl,
} = require('./scripts/update-release-utils.cjs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Arch } = require('builder-util')
const packageVersion = require('./package.json').version
const { resolveAccelerationBundleResources, verifyAccelerationBundleCore } = require('./scripts/stage-acceleration-bundle.cjs')
const accelerationBundle = resolveAccelerationBundleResources(process.env.XINGMANG_ACCELERATION_BUNDLE_DIR)

function resolveUpdateUrl() {
  const rawUrl = process.env.XINGMANG_UPDATE_URL?.trim() || resolveUpdateUrlForVersion(packageVersion)
  const allowsLocalHttp = process.env.XINGMANG_UPDATE_DEV === '1'
  return normalizeUpdateBaseUrl(rawUrl, { allowLocalHttp: allowsLocalHttp })
}

const outputDirectory = process.env.XINGMANG_OUTPUT_DIR?.trim() || 'release'
const localBuildMode = process.env.XINGMANG_LOCAL_BUILD === '1'
const releaseMode = !localBuildMode && process.env.XINGMANG_RELEASE === '1'
const freeMacReleaseMode = !localBuildMode && process.env.XINGMANG_MAC_FREE_RELEASE === '1'
const unsignedReleaseMode = !localBuildMode && process.env.XINGMANG_UNSIGNED_RELEASE === '1'
if (releaseMode && freeMacReleaseMode) {
  throw new Error('XINGMANG_RELEASE=1 与 XINGMANG_MAC_FREE_RELEASE=1 不能同时启用')
}
if (unsignedReleaseMode && (releaseMode || freeMacReleaseMode)) {
  throw new Error('XINGMANG_UNSIGNED_RELEASE=1 不能与签名发布模式同时启用')
}
const publicReleaseMode = releaseMode || freeMacReleaseMode
const updateEnabledMode = publicReleaseMode || unsignedReleaseMode
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
// PR 上排练整条发布路径（quality.yml 的 macos-release-rehearsal）。它与一次性签名
// 是两条不同的路：一次性签名走自定义 sign 钩子，排练走的正是发布那条
// 「electron-builder 自己按 CSC_NAME 在 keychain 里找身份」，所以它不能借用上面
// 那个标记，只能自己有一个。两者都只是"PR 上也要真的签"的许可，不放松任何检查。
const releaseRehearsalMarker = process.env.XINGMANG_MAC_RELEASE_REHEARSAL
if (releaseRehearsalMarker !== undefined
  && releaseRehearsalMarker !== ''
  && releaseRehearsalMarker !== '0'
  && releaseRehearsalMarker !== '1') {
  throw new Error('XINGMANG_MAC_RELEASE_REHEARSAL 只接受精确的 0 或 1')
}
const releaseRehearsalMode = releaseRehearsalMarker === '1'
if (releaseRehearsalMode && ephemeralMacSigningMode) {
  throw new Error('发布路径排练与 CI ephemeral macOS signing 不能同时启用')
}
if (releaseRehearsalMode && !freeMacReleaseMode) {
  throw new Error('发布路径排练需要 XINGMANG_MAC_FREE_RELEASE=1')
}
const pullRequestSigningMarker = process.env.CSC_FOR_PULL_REQUEST
const pullRequestSigningEnabled = pullRequestSigningMarker !== undefined
  && ['true', '1', ''].includes(pullRequestSigningMarker.trim())
if (pullRequestSigningEnabled && !ephemeralMacSigningMode && !releaseRehearsalMode) {
  throw new Error('CSC_FOR_PULL_REQUEST 只能由 CI ephemeral macOS signing 或发布路径排练启用')
}
if (releaseRehearsalMode && process.env.CSC_FOR_PULL_REQUEST !== 'true') {
  // electron-builder 在 pull_request 事件上默认整段跳过签名，而且跳得很安静：包
  // 照样出，只是没签。排练如果没打开这一条，验的就是一个没签名的包。
  throw new Error('发布路径排练需要 CSC_FOR_PULL_REQUEST=true')
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
// XINGMANG_RELEASE=1 is the Windows Authenticode channel: the only release
// workflow runs on windows-latest, and run-release-build.cjs verifies
// win-unpacked artifacts. macOS distribution goes through the free self-signed
// channel instead, and this repository contains no notarytool or stapler step
// at all. A Developer ID signature without notarization is worse than refusing
// to build: the packaging log stays green while Gatekeeper rejects the app on
// every customer machine. Stop while nothing has been produced yet.
function assertDistributableMacPlatform(electronPlatformName) {
  if (electronPlatformName === 'darwin' && releaseMode) {
    throw new Error('XINGMANG_RELEASE=1 是 Windows 正式发布通道，不能用来构建 macOS 产物；macOS 分发请改用 XINGMANG_MAC_FREE_RELEASE=1（免费自签通道），本仓库没有 notarization 实现。')
  }
}

const signingPublisher = process.env.XINGMANG_SIGNING_PUBLISHER?.trim() || undefined
const updatePublisher = signingPublisher || '绍兴星芒文化传媒有限责任公司'
// Library validation loads a library only when its team identifier matches the
// signing process, and Apple issues that identifier: an ad-hoc signature has
// none, and neither does a self-signed certificate. 2026-09-19 settled that
// the hard way - the certificate gained an OU on the theory codesign would
// record it as the team identifier, and the packaged app still died in dyld
// with "mapping process and mapped file (non-platform) have different Team
// IDs" before running a line of its own code.
//
// So for every signature this repository can currently produce, withholding
// disable-library-validation protects nothing (there is no team for library
// validation to compare against) while guaranteeing the app cannot start. The
// product owner chose to grant it on 2026-09-19. The strict file stays for the
// day a Developer ID signature exists, and this exception is withdrawn in the
// same change. releaseMode is the Windows Authenticode channel and never
// builds darwin at all.
const adHocSigningMode = !ephemeralMacSigningMode && !freeMacReleaseMode && !releaseMode
const selfSignedMacSigningMode = adHocSigningMode || ephemeralMacSigningMode || freeMacReleaseMode
const macEntitlementsPrefix = selfSignedMacSigningMode ? 'build/entitlements.mac.adhoc' : 'build/entitlements.mac'

module.exports = {
  appId: 'com.xingmang.ai.manager',
  productName: '星芒AI管理工具',
  protocols: [{ name: '星芒AI管理工具', schemes: ['xingmang'] }],
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
    // Unsigned test releases intentionally keep the updater enabled, while
    // ordinary local builds remain isolated from every production feed.
    xingmangLocalBuild: !updateEnabledMode,
    // The main process reads this to know that electron-updater will skip its
    // installer signature check (no publisherName below), and switches the
    // updater to user-confirmed download/install plus its own SHA-512 check.
    xingmangUnsignedRelease: unsignedReleaseMode,
    ...(accelerationBundle.metadata ? { xingmangAccelerationBundle: accelerationBundle.metadata } : {}),
  },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    // Generated canvas-v2 build (scripts/copy-canvas-assets.mjs).
    'dist-canvas/**/*',
    'assets/**/*',
    // Default-installed 星芒AI skill template. Contains no API keys; the
    // main process copies it to the user skill roots and writes config.json.
    'bundled-skills/xingmang-ai/**/*',
    // Shared 中文 AGENTS.md template the main process copies into a project
    // directory that has no instruction file yet. Contains no secrets.
    'bundled-catalog/project-instructions/**/*',
    // Claude Code 状态行脚本。只读 CLI 从 stdin 递来的会话信息，不出网、不读 Key。
    'bundled-catalog/cli-status-line/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'bundled-skills/xingmang-ai',
      to: 'bundled-skills/xingmang-ai',
      filter: ['**/*'],
    },
    {
      from: 'bundled-catalog/project-instructions',
      to: 'bundled-catalog/project-instructions',
      filter: ['**/*'],
    },
    // 必须走 extraResources：写进 Claude settings.json 的那条命令由外部 node 执行，
    // 它读不了 asar 里的路径。
    {
      from: 'bundled-catalog/cli-status-line',
      to: 'bundled-catalog/cli-status-line',
      filter: ['**/*'],
    },
    ...accelerationBundle.resources,
  ],
  // The last point at which an unshippable build mode can still be rejected,
  // and where the private binary is validated again. No private resource
  // directory is selected by default, including CI and ordinary source builds.
  beforePack: async (context) => {
    assertDistributableMacPlatform(context.electronPlatformName)
    if (!accelerationBundle.metadata) return
    await verifyAccelerationBundleCore(process.env.XINGMANG_ACCELERATION_BUNDLE_DIR, accelerationBundle.metadata, undefined, {
      platform: context.electronPlatformName, arch: Arch[context.arch],
    })
    if (context.electronPlatformName === 'darwin') {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'scripts/build-macos-system-proxy.cjs')], { stdio: 'inherit', shell: false })
      if (result.error || result.status !== 0) throw new Error('Mac 系统代理组件编译失败。')
    }
  },
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
    ...(accelerationBundle.metadata?.version === 2 ? {
      extraResources: [{ from: 'dist-native', to: 'native', filter: ['macos-system-proxy-${arch}'] }],
      // Preserve the pinned upstream Mach-O bytes. Its own signature is checked
      // separately; the containing app seals the resource, and ASAR pins its hash.
      signIgnore: ['[/\\\\]Resources[/\\\\]acceleration[/\\\\]mihomo$'],
    } : {}),
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    artifactName: 'XingMang-AI-Manager-${version}-${arch}.${ext}',
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '13.0',
    hardenedRuntime: true,
    entitlements: `${macEntitlementsPrefix}.plist`,
    entitlementsInherit: `${macEntitlementsPrefix}.inherit.plist`,
    icon: 'assets/brand/v3/app-icon.icns',
    // Local packages need an ad-hoc signature after Electron fuses are changed,
    // otherwise macOS rejects the invalidated upstream seal. This is not a
    // distributable Developer ID signature; release mode discovers that identity.
    identity: ephemeralMacSigningMode ? '-' : freeMacReleaseMode ? freeMacSigningIdentity : releaseMode ? undefined : '-',
    ...(ephemeralMacSigningMode ? { sign: './scripts/macos-ephemeral-signing.cjs' } : {}),
    // macOS 只走免费自签通道，全仓没有 notarytool / stapler 实现，所以公证永远
    // 是关的。**这一行不能删**：electron-builder 只在 notarize 显式为 false 时
    // 跳过公证，留空(undefined)会让它在环境里碰巧存在 APPLE_ID / APPLE_API_KEY /
    // APPLE_KEYCHAIN_PROFILE 时自动把 .app 送去 Apple 公证——签免费自签包的那台
    // Mac 正是最可能装着这些凭据的机器。
    notarize: false,
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
    icon: 'assets/brand/v3/favicon.ico',
    legalTrademarks: '星芒AI',
    artifactName: 'XingMang-AI-Manager-${version}-Setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    // 老板拍板(2026-08-10):安装时允许用户自选目录。默认仍是 Program
    // Files(管理员才可写);用户改到普通用户可写的目录时,会失去"装好的
    // 程序文件不可被本机低权限进程篡改"这层保护——该取舍已明确告知并接受。
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // 上面两项打开的是 electron-builder 自己那一步,它有两条会一声不吭跳过的
    // 路径(更新器拉起的 --updated 安装、以及写公共桌面失败不检查返回值),客户
    // 机上就表现为"装完桌面没图标"。build/installer.nsh 的 customInstall 在安装
    // 收尾时补齐缺的那一个,只增不删,所以升级安装既不会多出图标也不会删掉用户
    // 已有的。**这一行不能删**:少了它兜底脚本不会被编进安装程序,而打包日志
    // 全绿,和现在一模一样。
    include: 'installer.nsh',
    shortcutName: '星芒AI管理工具',
    uninstallDisplayName: '星芒AI管理工具',
  },
}
