const {
  resolveUpdateUrlForVersion,
  normalizeUpdateBaseUrl,
} = require('./scripts/update-release-utils.cjs')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Arch } = require('builder-util')
const packageVersion = require('./package.json').version
const { resolveAccelerationBundleResources, verifyAccelerationBundleCore } = require('./scripts/stage-acceleration-bundle.cjs')
const { ensureNoGroupOrOtherWrite } = require('./scripts/linux-payload-modes.cjs')
const { resolveLockedElectronZipChecksums } = require('./scripts/electron-zip-checksums.cjs')
const { buildReleaseCopyright } = require('./scripts/release-copyright.cjs')
const { feedReleaseNotes } = require('./scripts/extract-release-notes.cjs')
const { NOTICES_FILE_NAME, OUTPUT_DIRECTORY_NAME: THIRD_PARTY_DIRECTORY, copyMacElectronLicenses } = require('./scripts/third-party-notices.cjs')
const macDmgLayout = require('./scripts/macos-dmg-layout.cjs')
const accelerationBundle = resolveAccelerationBundleResources(process.env.XINGMANG_ACCELERATION_BUNDLE_DIR)

function resolveUpdateUrl() {
  const rawUrl = process.env.XINGMANG_UPDATE_URL?.trim() || resolveUpdateUrlForVersion(packageVersion)
  const allowsLocalHttp = process.env.XINGMANG_UPDATE_DEV === '1'
  return normalizeUpdateBaseUrl(rawUrl, { allowLocalHttp: allowsLocalHttp })
}

// 更新清单里的说明只带这一版那一节，为什么见 scripts/extract-release-notes.cjs 的 feedReleaseNotes。
// 首节对不上这一版（测试包临时调高了版本号）才照原来把整份文件交给 electron-builder。
function resolveReleaseInfo() {
  const releaseNotes = feedReleaseNotes(fs.readFileSync(path.join(__dirname, 'release-notes.md'), 'utf8'), packageVersion)
  return releaseNotes ? { releaseNotes } : { releaseNotesFile: 'release-notes.md' }
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
// 测试包（package-for-testing.yml 出给测试机装的那几份）照样开着更新、照样报崩溃，只是
// 主进程看见 xingmangTestingBuild 就把报错记在 Sentry 的 testing 环境下，免得发版前
// 测试机上的报错先算进这一版的正式名下（R4）。macOS 那份一定是 runner 现场生成的一次性
// 身份签的，本来就不能发给客户（publish-release.yml 开头），一次性签名本身就说明它是
// 测试包；Windows 那份和正式发布走同一条 release:build:unsigned，只能由工作流用
// XINGMANG_TESTING_BUILD=1 明说。本机快包根本不报崩溃，这个标记对它没有意义。
const testingBuildMarker = process.env.XINGMANG_TESTING_BUILD
if (testingBuildMarker !== undefined
  && testingBuildMarker !== ''
  && testingBuildMarker !== '0'
  && testingBuildMarker !== '1') {
  throw new Error('XINGMANG_TESTING_BUILD 只接受精确的 0 或 1')
}
if (testingBuildMarker === '1' && freeMacReleaseMode && !ephemeralMacSigningMode) {
  // 正式的 Mac 包被标成测试包，客户的报错就全落进 testing，按 production 看的人一条也看不到。
  throw new Error('XINGMANG_TESTING_BUILD=1 不能用于 macOS 免费发布通道：macOS 测试包只由一次性身份签名出')
}
const testingBuildMode = updateEnabledMode && (ephemeralMacSigningMode || testingBuildMarker === '1')

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

// The deb payload lands in /opt/<productName>, and that name is then spelled
// into postinst/postrm, update-alternatives and the AppArmor attachment path.
// An ASCII directory keeps every one of those consumers out of locale and
// parser questions; the menu still shows the Chinese name through
// linux.desktop.entry.Name. productName cannot be set per platform in
// electron-builder, so the Linux scripts set this marker and beforePack
// refuses a Linux build without it (and any other platform with it).
const linuxExecutableName = 'xingmang-ai-manager'
const linuxPackageMarker = process.env.XINGMANG_LINUX_PACKAGE
if (linuxPackageMarker !== undefined
  && linuxPackageMarker !== ''
  && linuxPackageMarker !== '0'
  && linuxPackageMarker !== '1') {
  throw new Error('XINGMANG_LINUX_PACKAGE 只接受精确的 0 或 1')
}
const linuxPackageMode = linuxPackageMarker === '1'
const productName = linuxPackageMode ? linuxExecutableName : '星芒AI管理工具'

function assertLinuxPackageMode(electronPlatformName) {
  if (electronPlatformName === 'linux' && !linuxPackageMode) {
    throw new Error('Linux 安装包请用 npm run build:linux 或 build:linux:ci 打包（需要 XINGMANG_LINUX_PACKAGE=1，安装目录才是英文名）。')
  }
  if (electronPlatformName !== 'linux' && linuxPackageMode) {
    throw new Error(`XINGMANG_LINUX_PACKAGE=1 只用于 Linux 安装包，不能用来构建 ${electronPlatformName}。`)
  }
  // Linux has no code signature, so its only release channel is the unsigned
  // one (npm run release:package:linux, docs/LINUX.md). XINGMANG_RELEASE=1
  // promises a Windows Authenticode signature and XINGMANG_MAC_FREE_RELEASE=1 a
  // self-signed Mac identity; a deb built under either would ship an updater
  // whose metadata claims a check the package can never pass.
  if (electronPlatformName === 'linux' && publicReleaseMode) {
    throw new Error('Linux 安装包没有代码签名，发布只能走 npm run release:package:linux（XINGMANG_UNSIGNED_RELEASE=1）。')
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
// 画布项目文件（.xingcanvas，D92）关联到星芒，双击直接在画布里打开（主进程那半在
// electron/canvas-project-file-launch.ts）。三个平台各写各的：Windows 的 name 是注册表里的
// ProgID，只能是这种不带空格的英文名，build/installer.nsh 按同一个名字重写「打开」命令
// （XINGMANG_CANVAS_PROGID）；Mac 的 name 是访达「种类」一栏显示的字，Linux 要一个 MIME 类型。
// 显示的名字跟导入导出对话框里的文件类型同一个说法。
const canvasProjectExtension = 'xingcanvas'
const canvasProjectTypeName = '星芒画布项目'
const windowsCanvasProjectProgId = 'XingMangAI.CanvasProject'

const macPrivacyUsageDescriptions = {
  NSDocumentsFolderUsageDescription: '星芒把 AI 画的图、做的视频存进“文稿”里的 XingmangAI 文件夹；你放在“文稿”里的项目，也要读得到才能帮你打开。',
  NSDesktopFolderUsageDescription: '你放在桌面上的项目，星芒要读得到才能帮你用 AI 工具打开。',
  NSDownloadsFolderUsageDescription: '你放在“下载”里的项目，星芒要读得到才能帮你用 AI 工具打开。',
  NSRemovableVolumesUsageDescription: '你放在 U 盘、移动硬盘上的项目，星芒要读得到才能帮你用 AI 工具打开。',
  NSNetworkVolumesUsageDescription: '你放在共享盘上的项目，星芒要读得到才能帮你用 AI 工具打开。',
}

// Electron 自带的 Info.plist 写着麦克风、摄像头、录音、蓝牙五条英文用途说明（「This app needs
// access to the microphone」这类），electron-builder 只往里合并不删，值写成 null 的键它才删
// （26.15.3 的 macPackager.js applyCommonInfo）。星芒用不到的三条在这里删掉（SP-2）：
// - 麦克风、摄像头、录音：主窗口和画布共用的会话把 media 一律拒（main.ts 的权限白名单），付款、
//   开票窗口什么都拒，也没设 setDisplayMediaRequestHandler，网页碰不到这几样设备，Chromium
//   就不会去问系统；主进程也没有 desktopCapturer、systemPreferences.askForMediaAccess。
// - 删了以后谁碰这几样设备，macOS 不弹询问框，直接结束碰它的那个进程。所以以后要加语音输入、
//   拍照这类功能，放开 main.ts 那张白名单的同一个改动里，必须把中文说明加回这里。星芒直接拉起
//   的子进程（手机遥控的 codex app-server，以及它跑的命令和客户配的 MCP）也算在星芒头上；
//   Codex 自己的命令在沙箱里碰不到这些设备，沙箱外的那部分以前是弹英文询问框，现在是被结束。
// - 蓝牙两条留着：网页蓝牙（navigator.bluetooth.requestDevice）不过权限白名单，Electron 45
//   的 MayUseBluetooth 恒为 true，Chromium 在发现没人接 select-bluetooth-device 之前已经建了
//   CBCentralManager。删掉说明，任何窗口里的网页点一下就能让整个星芒被系统结束。
const macUnusedElectronUsageDescriptions = {
  NSMicrophoneUsageDescription: null,
  NSCameraUsageDescription: null,
  NSAudioCaptureUsageDescription: null,
}

module.exports = {
  appId: 'com.xingmang.ai.manager',
  productName,
  protocols: [{ name: '星芒AI管理工具', schemes: ['xingmang'] }],
  // 年份按出包那天的北京时间算，理由见 scripts/release-copyright.cjs。
  copyright: buildReleaseCopyright(new Date()),
  // 浏览器内核自带 55 种语言的内置文字（表单校验提示、文件选择框、视频控件这类），星芒
  // 界面全是中文，只留简体、繁体（香港、澳门的系统也落到繁体）和 en-US：系统语言是别的
  // 时候，Chromium 一律退回 en-US，删了它就没有可退的。Electron 45.1.0 上 Windows 装好后
  // 少 47 MB、安装包少约 7 MB（2026-10-30 yoyo 同意）。这里是 Windows、Linux 的 .pak 名字，
  // macOS 用 .lproj 的名字，另列在 mac 里。
  electronLanguages: ['zh-CN', 'zh-TW', 'en-US'],
  // 打包要的 Electron 压缩包按锁文件钉住的 checksums.json 核对，不再每次去 GitHub 现拉
  // SHASUMS256.txt（那个文件从不进缓存，GitHub 一回 504 打包就红，原因与信任链见
  // scripts/electron-zip-checksums.cjs）。unsafelyDisableChecksums: false 不只是写明「校验
  // 开着」：electron-builder 26.15.3 只在这一组键出现时才把 checksums 原样交给
  // @electron/get，换成 electronDownload 的另一种写法，checksums 会被悄悄丢掉。
  electronDownload: {
    unsafelyDisableChecksums: false,
    checksums: resolveLockedElectronZipChecksums(),
  },
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
    // Files crash reports under Sentry's `testing` environment instead of
    // `production` (crash-report.ts crashReportEnvironmentName, R4).
    xingmangTestingBuild: testingBuildMode,
    // The main process reads this to know that electron-updater will skip its
    // installer signature check (no publisherName below), and switches the
    // updater to user-confirmed download/install plus its own SHA-512 check.
    xingmangUnsignedRelease: unsignedReleaseMode,
    ...(accelerationBundle.metadata ? { xingmangAccelerationBundle: accelerationBundle.metadata } : {}),
    // Linux packages only, so the Windows and macOS payloads stay byte-for-byte
    // what they were.
    ...(linuxPackageMode ? {
      // Electron takes the Linux app_id / WM_CLASS from this, and
      // electron-builder writes the same name into StartupWMClass, so the
      // running window groups with its menu entry.
      desktopName: `${linuxExecutableName}.desktop`,
      // The deb control file's Homepage. Without it fpm falls back to whatever
      // the checkout's git origin happens to be.
      homepage: 'https://github.com/xufei5620/xingmang-ai-manager',
      // The deb control file's License; fpm writes "unknown" otherwise. See LICENSE.
      license: 'Proprietary',
    } : {}),
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
    // Claude Code / Gemini CLI 钩子脚本。只把事件类型写进星芒数据目录，不出网、不读 Key。
    'bundled-catalog/cli-hooks/**/*',
    // 官方 Codex 型号名单（原样拷自 openai/codex，Apache-2.0，LICENSE / NOTICE 同目录）。
    // 主进程按账号挑出能用的型号写给 Codex，见 electron/codex-model-catalog.ts。
    'bundled-catalog/codex-models/**/*',
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
    // 同上：钩子命令由 CLI 起的外部 node 执行。
    {
      from: 'bundled-catalog/cli-hooks',
      to: 'bundled-catalog/cli-hooks',
      filter: ['**/*'],
    },
    // 第三方许可清单（D97）：compile 最后一步生成，放在 asar 外面，客户不用解包就能打开。
    // 少了它 electron-builder 不报错，靠出包后的 verify-packaged-hardening.cjs、
    // verify-macos-free-artifacts.cjs 拦。
    {
      from: `${THIRD_PARTY_DIRECTORY}/${NOTICES_FILE_NAME}`,
      to: NOTICES_FILE_NAME,
    },
    ...accelerationBundle.resources,
  ],
  // The last point at which an unshippable build mode can still be rejected,
  // and where the private binary is validated again. No private resource
  // directory is selected by default, including CI and ordinary source builds.
  beforePack: async (context) => {
    assertDistributableMacPlatform(context.electronPlatformName)
    assertLinuxPackageMode(context.electronPlatformName)
    if (!accelerationBundle.metadata) return
    await verifyAccelerationBundleCore(process.env.XINGMANG_ACCELERATION_BUNDLE_DIR, accelerationBundle.metadata, undefined, {
      platform: context.electronPlatformName, arch: Arch[context.arch],
    })
    if (context.electronPlatformName === 'darwin') {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'scripts/build-macos-system-proxy.cjs')], { stdio: 'inherit', shell: false })
      if (result.error || result.status !== 0) throw new Error('Mac 系统代理组件编译失败。')
    }
  },
  // Electron 压缩包刚解开、electron-builder 还没删掉它的两份许可文件时（Mac 上会删，
  // Windows、Linux 留在安装目录里），把它们拷进 Mac 应用的 Contents/Resources（LC-2）。
  afterExtract: async (context) => {
    if (context.electronPlatformName !== 'darwin') return
    copyMacElectronLicenses(context.appOutDir, context.packager.info.framework.distMacOsAppName)
  },
  // Runs on linux-unpacked before fpm turns it into the deb; see
  // scripts/linux-payload-modes.cjs for why the Electron 45 payload needs it.
  // Windows and macOS payloads are left byte-for-byte as they were.
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'linux') return
    await ensureNoGroupOrOtherWrite(context.appOutDir)
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
  releaseInfo: resolveReleaseInfo(),
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
    fileAssociations: [{ ext: canvasProjectExtension, name: canvasProjectTypeName, role: 'Editor', rank: 'Owner' }],
    // macOS 第一次碰「文稿」「桌面」「下载」、U 盘、共享盘时弹的隐私询问框，标题是系统写的，
    // 下面那行说明取这几项；不写就只有「不允许」「好」两个按钮，客户不知道为什么要给（已知34）。
    // 后面那三个 null 是删掉 Electron 自带的英文说明，理由见 macUnusedElectronUsageDescriptions。
    extendInfo: { ...macPrivacyUsageDescriptions, ...macUnusedElectronUsageDescriptions },
    // 同上面的 electronLanguages，换成 .lproj 的写法：下划线，en-US 在盘上就叫 en。带
    // _FEMININE 这类后缀的是 Chromium 按语法性别分出来的目录，这三种语言的都只是 18 字节的
    // 空壳，原样留着，这三种语言的文件就跟改之前一模一样。
    electronLanguages: ['zh_CN', 'zh_TW', 'en'].flatMap((name) => [name, `${name}_FEMININE`, `${name}_MASCULINE`, `${name}_NEUTER`]),
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
  dmg: {
    // 打开安装包看到的窗口（IC-9，2026-11-13 yoyo 回「改」）：品牌深蓝背景上一行中文告诉客户
    // 拖到右边的「应用程序」，替身也叫这个名字。背景、图标位置、替身名字都在
    // scripts/macos-dmg-layout.cjs，背景由 scripts/generate-dmg-background.mjs 按同一份画出来。
    // 写明背景名：文件不在时 electron-builder 当场报错，不会悄悄退回自带的灰底虚线箭头。
    background: macDmgLayout.backgroundName,
    iconSize: macDmgLayout.iconSize,
    contents: macDmgLayout.buildDmgContents(),
    // The free update channel is ZIP-only. DMGs remain manual installers and
    // must not create blockmaps or enter latest-mac.yml.
    ...(freeMacReleaseMode ? { writeUpdateInfo: false } : {}),
  },
  win: {
    requestedExecutionLevel: 'asInvoker',
    // Stated explicitly because the strict verifier in update-signature.ts is
    // only reached while electron-updater performs its own signature check.
    verifyUpdateCodeSignature: true,
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/brand/v3/favicon.ico',
    legalTrademarks: '星芒AI',
    artifactName: 'XingMang-AI-Manager-${version}-Setup.${ext}',
    // 作品文件自己的图标（白纸折角＋星芒，深查 IC-10）。不写 icon 时 electron-builder 让它借用程序图标
    // （"$appExe,0"），桌面上作品跟星芒的快捷方式一模一样。按名字在 build/ 里找，找不到打包直接报错；
    // 安装时拷到安装目录的 resources 下，DefaultIcon 指过去。重新生成见 scripts/generate-canvas-project-icon.mjs。
    fileAssociations: [{ ext: canvasProjectExtension, name: windowsCanvasProjectProgId, description: canvasProjectTypeName, icon: 'canvas-project.ico' }],
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    // 老板拍板(2026-08-10):安装时允许用户自选目录。默认仍是 Program
    // Files(管理员才可写)。选到 D 盘这类普通用户可写的地方时,build/installer.nsh
    // 的 xingmangLockInstallDirectory 会把安装目录改成跟 Program Files 一样只有
    // 管理员能改:以管理员身份跑的升级、卸载要执行这个目录里的文件,不收紧就是
    // 谁都能借客户下一次更新拿到管理员权限(Codex 逆向报告第 3 条,2026-10-08)。
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
    // 安装完成页、卸载欢迎页和完成页左边那张图（D93）。不写这一行时 electron-builder
    // 也会去 build/ 找同名文件，但找不到就悄悄换回 NSIS 自带的通用图；写明以后文件
    // 丢了打包直接报错。卸载向导没单独配，跟着用这一张。重新生成见
    // scripts/generate-installer-sidebar.mjs。
    installerSidebar: 'installerSidebar.bmp',
    shortcutName: '星芒AI管理工具',
    uninstallDisplayName: '星芒AI管理工具',
  },
  linux: {
    // deb only (docs/LINUX.md): it is the one format that installs a root-owned
    // /opt tree and runs postinst, which is what gives Chromium its sandbox on
    // Ubuntu 24.04. AppImage would start without one there.
    target: [{ target: 'deb', arch: ['x64', 'arm64'] }],
    executableName: linuxExecutableName,
    // Never set executableArgs: whatever is listed lands in the menu entry's
    // Exec line, and that is exactly where --no-sandbox would hide.
    syncDesktopName: true,
    icon: 'assets/brand/v3/app-icon.png',
    category: 'Development',
    synopsis: '星芒AI管理工具',
    description: '一键安装、配置和启动 Claude Code、Codex、Grok 等 AI 编程工具。',
    // 包里多一份 /usr/share/mime/packages/xingmang-ai-manager.xml，菜单文件的 MimeType 带上它，
    // after-install.tpl 照旧跑 update-mime-database 和 update-desktop-database。
    fileAssociations: [{
      ext: canvasProjectExtension,
      name: canvasProjectTypeName,
      description: canvasProjectTypeName,
      mimeType: 'application/x-xingcanvas',
    }],
    maintainer: '绍兴星芒文化传媒有限责任公司 <xufei5620136@gmail.com>',
    vendor: '绍兴星芒文化传媒有限责任公司',
    desktop: {
      entry: {
        Name: '星芒AI管理工具',
        GenericName: 'AI 编程工具管理',
        Keywords: 'AI;Claude;Codex;Grok;星芒;',
        StartupNotify: 'true',
      },
    },
  },
  deb: {
    packageName: linuxExecutableName,
    // Debian section; fpm writes "default" otherwise, which software centres show as is.
    packageCategory: 'devel',
    priority: 'optional',
    // Everything the Electron binary links against (readelf NEEDED), plus the
    // libraries Chromium opens at run time. Ubuntu 24.04 renamed several of
    // them with a t64 suffix; Debian 12, Ubuntu 22.04 and the Debian-based
    // UOS/deepin/Kylin releases still use the old names.
    depends: [
      'libgtk-3-0t64 | libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0t64 | libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'libgbm1',
      'libasound2t64 | libasound2',
      'libxkbcommon0',
      'libcups2t64 | libcups2',
      'libudev1',
    ],
    // The whole interface is Chinese, and the login session is kept in the
    // desktop's password store. Recommends, not Depends: a machine that already
    // has another CJK font or keyring stays installable.
    recommends: [
      'fonts-noto-cjk | fonts-wqy-microhei | fonts-wqy-zenhei',
      'gnome-keyring | kwalletmanager',
    ],
    afterInstall: 'build/linux/after-install.tpl',
  },
}
