// 「旧版升新版」冒烟（G13）：在 Windows / macOS runner 上装一个客户手上的正式旧版本，让它从本机的假更新源
// 自己发现、下载、校验、安装这次出的新版本，再看新版本有没有起来、是不是接着用旧版本那份数据和设置。
//
//   node scripts/upgrade-smoke.cjs --old-installer <Setup.exe 或 .dmg> --old-version 0.2.19 \
//     --new-release <放着 latest.yml / latest-mac.yml 和安装包的目录> [--work <工作目录>] [--port 18123]
//   node scripts/upgrade-smoke.cjs test-version --package 0.2.21 --released 0.2.19,0.2.22
//
// 走的是客户那条路，一步不替它做：
//   1. 第一次打开旧版本：它自己查到新版本、在后台下载，核 SHA-512（Windows 再核发布者签名，
//      Mac 交给 Squirrel.Mac 核代码签名），记下「已下载」。
//   2. 关掉（强制结束，客户关机、被杀毒结束都是这样）。这时往设置里写几样客户自己选的外观。
//   3. 第二次打开：它认出上次下好的版本，预告 5 秒后自己装上（打开时装，auto-update-install.ts），
//      安装程序（Mac 上是 Squirrel.Mac 的 ShipIt）装完把新版本拉起来。Mac 上新版本第一次打开会弹
//      钥匙串框，这一步替客户点「始终允许」，见 macos.approveNewVersion。
//   4. 新版本起来以后写下「本次启动是更新后的第一次」（version.updated，带旧、新版本号），
//      上次运行版本记成新版本，第 2 步写的设置原样还在。三样都在旧版本那份数据目录里。
//
// 只在一次性托管 runner 上跑：要装进「所有用户」目录、开防火墙或改 hosts、往钥匙串里放临时签名身份。
// 为什么要改装好的旧版本、改了哪几处，见 scripts/upgrade-smoke-support.cjs 开头。
// 断网在第一次打开之前做好并先自证，跑完也不撤：旧版本和新版本从头到尾只连得到本机，
// 一个请求也不会到生产的账号站和更新目录；runner 跑完就整台丢掉。
const { execFile, spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const dns = require('node:dns')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { signManifestText } = require('./update-manifest-signature.cjs')
const { compareReleaseVersions, parseLatestMetadata } = require('./update-release-utils.cjs')
const {
  UPDATE_KEY_MODULE,
  addHostsBlock,
  allowNewVersionPartition,
  applyCustomerSettings,
  asarHeaderHash,
  createFeedServer,
  describeLogEntry,
  describeUpdaterEntries,
  extractNetworkTargets,
  findLostSettings,
  findPinnedUpdateKeys,
  findSafeStorageItem,
  findVersionUpdatedEntry,
  generateUpdateSigningKey,
  parseRuntimeLog,
  readDownloadedVersion,
  readLastRunVersion,
  readWindowsAsarIntegrity,
  resolveUpgradeTestVersion,
  rewriteMacManifestEntry,
  rewriteUpdateFeedUrl,
  selectMacUpdateFile,
  setWindowsAsarIntegrity,
  sha512Base64,
  swapAsarText,
} = require('./upgrade-smoke-support.cjs')

// electron-builder.config.cjs 的 productName：程序文件和 .app 叫这个名字。
const PRODUCT_NAME = '星芒AI管理工具'
// NSIS 的默认安装目录不用 productName，用 package.json 的 name（electron-builder 的 APP_FILENAME），
// 客户电脑上是 C:\Program Files\xingmang-ai-manager。
const WINDOWS_INSTALL_DIRECTORY_NAME = 'xingmang-ai-manager'
const DEFAULT_PORT = 18123
// 下载 120~150 MB 走本机回环只要几秒，慢的是旧版本自己核摘要、Windows Defender 扫安装包。
const DOWNLOAD_BUDGET_MS = 8 * 60 * 1000
// 打开时装：开始查更新后 2 分钟内认出上次下好的版本、预告 5 秒，再加安装程序跑完、新版本冷启动。
const INSTALL_BUDGET_MS = 10 * 60 * 1000
// 新版本起来以后至少要撑这么久没退出，才算「重开」这一步过了。
const STAY_ALIVE_MS = 20 * 1000
const POLL_MS = 2000
const FIREWALL_RULE = 'xingmang-upgrade-smoke'
const PF_ANCHOR = 'com.apple/xingmang-upgrade-smoke'
// Everything except loopback, for the Windows firewall rule. Loopback is left
// out explicitly rather than trusting the firewall's own loopback exemption:
// the whole run depends on the app reaching the feed on 127.0.0.1.
const NON_LOOPBACK_ADDRESSES = '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
// A host every runner reaches anyway, used only to prove the isolation holds.
// Never a production host: the proof must not itself be the request it rules out.
const ISOLATION_PROBE_HOST = 'github.com'

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function report(message) {
  process.stdout.write(`[upgrade-smoke] ${message}\n`)
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} 后面缺了值`)
  return value
}

function assertKnownArguments(argv, known) {
  for (let index = 0; index < argv.length; index += 2) {
    if (!known.includes(argv[index])) throw new Error(`无法识别的参数：${argv[index]}`)
  }
}

function parseArguments(argv) {
  assertKnownArguments(argv, ['--old-installer', '--old-version', '--new-release', '--work', '--port'])
  const oldInstaller = argumentValue(argv, '--old-installer')
  const oldVersion = argumentValue(argv, '--old-version')
  const newRelease = argumentValue(argv, '--new-release')
  if (!oldInstaller || !oldVersion || !newRelease) {
    throw new Error('用法：--old-installer <安装包> --old-version <版本号> --new-release <新版本目录> [--work <目录>] [--port <端口>]')
  }
  const port = Number(argumentValue(argv, '--port') ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port 必须是 1024-65535 之间的整数')
  const work = argumentValue(argv, '--work')
  return {
    oldInstaller: path.resolve(oldInstaller),
    oldVersion: oldVersion.replace(/^v/i, ''),
    newRelease: path.resolve(newRelease),
    work: work ? path.resolve(work) : null,
    port,
  }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs ?? 120_000,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw new Error(`无法运行 ${path.basename(executable)}：${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    const output = `${result.stderr || ''}${result.stdout || ''}`.trim()
    throw new Error(`${path.basename(executable)} ${args[0] || ''} 失败（退出码 ${result.status}）：${output.slice(-2000)}`)
  }
  return result
}

// The feed server lives in this process, so anything that has to reach it
// while running must not block the event loop the way spawnSync does.
function runWithoutBlocking(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 60_000 }, (error, stdout) => {
      if (error) reject(new Error(`无法运行 ${path.basename(executable)}：${error.message}`))
      else resolve(stdout)
    })
  })
}

function readTextIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function readPackagedPackageJson(asarPath) {
  const asar = require('@electron/asar')
  // @electron/asar caches each archive's header by path, and the installer
  // replaces this one in place.
  asar.uncacheAll()
  return JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
}

async function waitFor(label, budgetMs, probe, onTick) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (onTick) onTick()
    if (Date.now() >= deadline) throw new Error(`等了 ${Math.round(budgetMs / 1000)} 秒，${label}`)
    await delay(POLL_MS)
  }
}

/** Prints the updater lines the app adds to its runtime log as the run goes. */
function createLogFollower(logPath) {
  let printed = 0
  return {
    entries() {
      return parseRuntimeLog(readTextIfPresent(logPath) || '')
    },
    flush() {
      const lines = describeUpdaterEntries(this.entries())
      for (const line of lines.slice(printed)) report(`  log: ${line}`)
      printed = Math.max(printed, lines.length)
    },
  }
}

/**
 * Starts `executable` as a Node.js runtime and has it try the feed on loopback
 * and a neutral outside host. Isolation holds when the first works and the
 * second does not.
 */
async function probeConnections(executable, feedPort) {
  const script = [
    "const net = require('node:net')",
    'function attempt(host, port) {',
    '  return new Promise((resolve) => {',
    '    const socket = net.connect({ host, port, timeout: 8000 })',
    "    socket.once('connect', () => { socket.destroy(); resolve(true) })",
    "    socket.once('timeout', () => { socket.destroy(); resolve(false) })",
    "    socket.once('error', () => resolve(false))",
    '  })',
    '}',
    `Promise.all([attempt('127.0.0.1', ${feedPort}), attempt('${ISOLATION_PROBE_HOST}', 443)])`,
    '  .then(([loopback, outside]) => process.stdout.write(JSON.stringify({ loopback, outside })))',
  ].join('\n')
  return JSON.parse(await runWithoutBlocking(executable, ['-e', script]))
}

function isLoopbackEndpoint(endpoint) {
  return /^(?:127\.\d+\.\d+\.\d+|\[::1\]|::1|localhost)[:.]\d+$/.test(endpoint)
}

// ---- Windows ---------------------------------------------------------------

function systemTool(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name)
}

function windowsInstallDirectory() {
  return path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', WINDOWS_INSTALL_DIRECTORY_NAME)
}

function windowsAppPids() {
  // tasklist prints in the console code page; only the ASCII PID column is read.
  const listed = run(systemTool('tasklist.exe'), ['/FI', `IMAGENAME eq ${PRODUCT_NAME}.exe`, '/FO', 'CSV', '/NH']).stdout
  return [...listed.matchAll(/^"[^"\r\n]*","(\d+)"/gm)].map((match) => match[1])
}

const windows = {
  manifestName: 'latest.yml',

  async prepareFeed({ release, feed, oldVersion, oldInstaller }) {
    const text = fs.readFileSync(path.join(release, 'latest.yml'), 'utf8')
    const metadata = parseLatestMetadata(text, 'latest.yml')
    for (const file of metadata.files) {
      fs.copyFileSync(path.join(release, file.relativePath), path.join(feed, file.relativePath))
      const blockmap = path.join(release, `${file.relativePath}.blockmap`)
      if (fs.existsSync(blockmap)) fs.copyFileSync(blockmap, path.join(feed, `${file.relativePath}.blockmap`))
    }
    // A key made for this run only. The installed old version is switched to
    // trust it (patchOld), so the signature check it runs on the download is
    // the real one, against a key nobody else holds.
    const key = generateUpdateSigningKey()
    fs.writeFileSync(path.join(feed, 'latest.yml'), signManifestText(text, key.privateKey, [key.publicKeyBase64]))
    // electron-updater downloads only what changed when it can read the old
    // installer's block map next to the new one; on a customer's machine that
    // is the common path. The map is built here from the very installer that
    // gets installed (the NSIS installer keeps a copy of itself for this).
    const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
    const primary = metadata.files.find((file) => file.relativePath === metadata.primaryPath)
    await buildBlockMap(oldInstaller, 'gzip', path.join(feed, `${primary.relativePath.split(metadata.version).join(oldVersion)}.blockmap`))
    return { key }
  },

  // The firewall goes up before the installer runs: the rule names the program
  // by path, and nothing may start from that path un-isolated, not even if an
  // installer were to launch the app the moment it finishes.
  async setUp({ installer, work, feedPort }) {
    const directory = windowsInstallDirectory()
    const executable = path.join(directory, `${PRODUCT_NAME}.exe`)
    const netsh = systemTool('netsh.exe')
    if (/\bOFF\b/i.test(run(netsh, ['advfirewall', 'show', 'allprofiles', 'state']).stdout)) {
      // Turning the firewall on must change nothing but the rules below, so
      // both default policies are set to allow first.
      run(netsh, ['advfirewall', 'set', 'allprofiles', 'firewallpolicy', 'allowinbound,allowoutbound'])
      run(netsh, ['advfirewall', 'set', 'allprofiles', 'state', 'on'])
    }
    // The same rule on a copy of this Node.js runtime proves it holds before
    // the app ever starts: the copy must still reach the feed on loopback and
    // must no longer reach the outside.
    const probe = path.join(work, 'isolation-probe.exe')
    fs.copyFileSync(process.execPath, probe)
    for (const program of [executable, probe]) {
      run(netsh, ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=out', 'action=block',
        `program=${program}`, `remoteip=${NON_LOOPBACK_ADDRESSES}`, 'enable=yes'])
    }
    const reach = await probeConnections(probe, feedPort)
    if (!reach.loopback || reach.outside) {
      throw new Error(`防火墙规则没按预期生效（本机${reach.loopback ? '通' : '不通'}，外网${reach.outside ? '通' : '不通'}），不敢打开旧版本`)
    }
    report(`防火墙已挡住 ${PRODUCT_NAME}.exe 的全部外网连接，只留本机（同一条规则先自证过：本机通、外网不通）`)

    report(`静默安装旧版本：${path.basename(installer)}`)
    // The customer's installer, run the way a first install runs. The job is
    // already elevated on this runner, so the exit of this process is the end
    // of the install.
    run(installer, ['/S'], { timeoutMs: 15 * 60 * 1000 })
    if (!fs.existsSync(executable)) {
      const parent = path.dirname(directory)
      throw new Error(`装完没在 ${directory} 找到程序文件；${parent} 下有：${fs.readdirSync(parent).join('、')}`)
    }
    return {
      executable,
      resources: path.join(directory, 'resources'),
      userDataRoot: process.env.APPDATA,
    }
  },

  patchOld(installed, { feedUrl, key }) {
    const configPath = path.join(installed.resources, 'app-update.yml')
    fs.writeFileSync(configPath, rewriteUpdateFeedUrl(fs.readFileSync(configPath, 'utf8'), feedUrl))
    const asarPath = path.join(installed.resources, 'app.asar')
    const archive = fs.readFileSync(asarPath)
    const executable = fs.readFileSync(installed.executable)
    // Check the installed pair agrees before touching either: a mismatch here
    // means this code reads the integrity record wrongly, not that the patch failed.
    if (readWindowsAsarIntegrity(executable) !== asarHeaderHash(archive)) {
      throw new Error('装好的程序文件里记的 app.asar 哈希和 app.asar 本身对不上，不敢改')
    }
    const { changed, headerHash } = swapAsarText(archive, {
      from: findPinnedUpdateKeys(archive),
      to: key.publicKeyBase64,
      files: [UPDATE_KEY_MODULE],
    })
    fs.writeFileSync(asarPath, archive)
    fs.writeFileSync(installed.executable, setWindowsAsarIntegrity(executable, headerHash).executable)
    report(`旧版本已改成认本机假源和这次的临时钥匙（换了 ${changed.join('、')}）`)
  },

  launch(installed) {
    spawn(installed.executable, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  },

  kill() {
    run(systemTool('taskkill.exe'), ['/F', '/T', '/IM', `${PRODUCT_NAME}.exe`], { allowFailure: true })
  },

  alive() {
    return windowsAppPids().length > 0
  },

  // NSIS runs from the old version's own quit; nothing to wait for between runs.
  async settle() {},

  // With the firewall rule in place a connection to the outside can only show
  // up here if the rule stopped holding, so this is the second line of proof.
  outsideConnections() {
    const pids = new Set(windowsAppPids())
    if (pids.size === 0) return []
    const listed = run(systemTool('netstat.exe'), ['-ano']).stdout
    const remotes = []
    for (const match of listed.matchAll(/^\s*TCP\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)\s*$/gm)) {
      const [, remote, state, pid] = match
      if (!pids.has(pid) || state === 'LISTENING' || /^(?:0\.0\.0\.0|\[::\]):0$/.test(remote)) continue
      if (!isLoopbackEndpoint(remote)) remotes.push(remote)
    }
    return remotes
  },

  installedVersion(installed) {
    return readPackagedPackageJson(path.join(installed.resources, 'app.asar')).version
  },

  // Where the old version left the download and the installer it started.
  // Windows keeps Chromium's key under DPAPI, bound to the user rather than
  // the program: the new version reads it without asking anyone.
  approveNewVersion() {},

  describeScene() {
    const cache = path.join(process.env.LOCALAPPDATA || '', 'xingmang-ai-manager-updater')
    const listed = fs.existsSync(cache) ? fs.readdirSync(cache, { recursive: true }).join('、') : '（没有）'
    return [`更新缓存 ${cache}：${listed}`]
  },
}

// ---- macOS -----------------------------------------------------------------

function sudo(args, options) {
  return run('/usr/bin/sudo', ['-n', ...args], options)
}

function findAppBundle(directory) {
  const apps = fs.readdirSync(directory).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`${directory} 里应当正好有一个 .app，实际有：${apps.join('、') || '没有'}`)
  return path.join(directory, apps[0])
}

/**
 * A signing identity made for this run in its own keychain. Both the old app
 * and the new one are re-signed with it: Squirrel.Mac only installs an update
 * signed by the identity the running app was signed with, and neither the
 * publisher's certificate nor the one the test package was built with is
 * available here.
 */
function createMacSigningIdentity(work, cleanups) {
  const { createFreeMacSigningCertificate } = require('./create-macos-free-signing-certificate.cjs')
  const { resolveMacosSecurityCommand } = require('./run-macos-free-build.cjs')
  const security = (args, secrets = []) => {
    const command = resolveMacosSecurityCommand(args, { secrets })
    return run(command.executable, command.argv, { input: command.stdin }).stdout
  }
  const keychainPassword = `Upgrade!${crypto.randomBytes(16).toString('hex')}Aa1`
  const p12Password = `UpgradeP12!${crypto.randomBytes(16).toString('hex')}Aa1`
  const keychainPath = path.join(work, 'upgrade-smoke.keychain-db')
  const certificate = createFreeMacSigningCertificate({
    outputDirectory: path.join(work, 'certificate'),
    commonName: 'XingMang Upgrade Smoke Identity',
    password: p12Password,
  })
  security(['create-keychain', '-p', keychainPassword, keychainPath], [keychainPassword])
  cleanups.push(() => security(['delete-keychain', keychainPath]))
  security(['set-keychain-settings', '-lut', '21600', keychainPath])
  security(['unlock-keychain', '-p', keychainPassword, keychainPath], [keychainPassword])
  security(['import', certificate.p12Path, '-k', keychainPath, '-f', 'pkcs12', '-P', p12Password, '-T', '/usr/bin/codesign'], [p12Password])
  security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychainPath], [keychainPassword])
  const searchList = security(['list-keychains', '-d', 'user']).split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  if (searchList.length === 0) throw new Error('读不出当前用户的钥匙串搜索列表，不敢改')
  security(['list-keychains', '-d', 'user', '-s', keychainPath, ...searchList])
  cleanups.push(() => security(['list-keychains', '-d', 'user', '-s', ...searchList]))
  // The old version creates its Safe Storage key in the default keychain on
  // first start. Here that is this run's keychain, whose password the run
  // knows, so it can answer for the customer the prompt the new version
  // raises (approveNewVersion); the runner's own login keychain password is
  // not the run's to type.
  const defaultKeychain = security(['default-keychain', '-d', 'user']).trim().replace(/^"(.*)"$/, '$1')
  if (!defaultKeychain) throw new Error('读不出当前用户的默认钥匙串，不敢改')
  // EXPERIMENT (reverted before the PR): leave the login keychain as default.
  report(`实验：默认钥匙串保持 ${defaultKeychain}`)
  const sha1 = run('/usr/bin/openssl', ['x509', '-in', certificate.certificatePath, '-noout', '-fingerprint', '-sha1'])
    .stdout.split('=').at(-1).trim().replaceAll(':', '').toUpperCase()
  fs.rmSync(path.join(work, 'certificate'), { recursive: true, force: true })
  return { sha1, keychainPath, keychainPassword, security }
}

function macResign(appPath, identity) {
  // --deep re-signs every nested framework and helper with the same identity,
  // keeping each one's own entitlements, flags and hardened-runtime setting:
  // a helper left on another identity would be refused by library validation
  // the moment the app loads it.
  run('/usr/bin/codesign', ['--force', '--deep', '--preserve-metadata=identifier,entitlements,flags,runtime', '--timestamp=none',
    '--sign', identity.sha1, '--keychain', identity.keychainPath, appPath], { timeoutMs: 10 * 60 * 1000 })
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeoutMs: 10 * 60 * 1000 })
}

// The hash a keychain partition list admits a program by when it has no
// Apple team identifier (allowNewVersionPartition).
function macCdhash(appPath) {
  const signature = run('/usr/bin/codesign', ['-d', '-vvv', appPath])
  const cdhash = /^CDHash=([0-9a-f]{40})$/im.exec(`${signature.stderr}${signature.stdout}`)?.[1]
  if (!cdhash) throw new Error(`读不出 ${path.basename(appPath)} 的 CDHash`)
  return cdhash
}

function macBundleValue(installed, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(installed.appPath, 'Contents', 'Info.plist')]).stdout.trim()
}

const SOURCE_EXTENSIONS = /\.(?:c?js|mjs|tsx?|json|html)$/i

function* sourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(filePath)
    else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !/\.test\./.test(entry.name)) yield filePath
  }
}

/**
 * Every host either version can dial: the old version's packed code, and the
 * new version's sources in this checkout (the package under test was built
 * from it).
 */
function collectNetworkTargets(oldAsarPath, sourceRoots) {
  const asar = require('@electron/asar')
  const texts = []
  for (const file of asar.listPackage(oldAsarPath, { isPack: false })) {
    const name = file.replace(/^[\\/]+/, '').replaceAll('\\', '/')
    if (!SOURCE_EXTENSIONS.test(name)) continue
    try {
      texts.push(asar.extractFile(oldAsarPath, name).toString('utf8'))
    } catch {
      // Unpacked files live outside the archive and are not code the app dials from.
    }
  }
  for (const root of sourceRoots) {
    for (const filePath of sourceFiles(root)) texts.push(fs.readFileSync(filePath, 'utf8'))
  }
  return extractNetworkTargets(texts)
}

const macos = {
  manifestName: 'latest-mac.yml',

  async prepareFeed({ release, feed, identity }) {
    const text = fs.readFileSync(path.join(release, 'latest-mac.yml'), 'utf8')
    const metadata = parseLatestMetadata(text, 'latest-mac.yml')
    const file = selectMacUpdateFile(metadata, process.arch)
    const unpacked = path.join(feed, '..', 'new-app')
    fs.mkdirSync(unpacked)
    run('/usr/bin/ditto', ['-x', '-k', path.join(release, file.relativePath), unpacked], { timeoutMs: 10 * 60 * 1000 })
    const appPath = findAppBundle(unpacked)
    macResign(appPath, identity)
    const newCdhash = macCdhash(appPath)
    const zipPath = path.join(feed, file.relativePath)
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], { timeoutMs: 10 * 60 * 1000 })
    const zip = fs.readFileSync(zipPath)
    // The re-signed ZIP is a different file, so the block map built for the
    // original is left behind: the old version downloads the whole package.
    fs.writeFileSync(path.join(feed, 'latest-mac.yml'), rewriteMacManifestEntry(text, file.relativePath, {
      sha512: sha512Base64(zip),
      size: zip.length,
    }))
    fs.rmSync(unpacked, { recursive: true, force: true })
    return { newCdhash }
  },

  // Copying the app out of the disk image starts nothing, so here the app is
  // installed first and its own code read for the hosts to block. A hosts file
  // cannot redirect an address the code dials directly; pf drops those.
  async setUp({ installer, work }) {
    report(`从 ${path.basename(installer)} 把旧版本拷进「应用程序」`)
    const appPath = path.join('/Applications', `${PRODUCT_NAME}.app`)
    if (fs.existsSync(appPath)) throw new Error(`${appPath} 已经存在，这台 runner 不是干净的`)
    const mountPoint = path.join(work, 'old-dmg')
    fs.mkdirSync(mountPoint)
    run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint, installer], { timeoutMs: 5 * 60 * 1000 })
    try {
      run('/usr/bin/ditto', [findAppBundle(mountPoint), appPath], { timeoutMs: 10 * 60 * 1000 })
    } finally {
      run('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { allowFailure: true })
    }
    const installed = {
      appPath,
      resources: path.join(appPath, 'Contents', 'Resources'),
      userDataRoot: path.join(os.homedir(), 'Library', 'Application Support'),
    }

    const repository = path.resolve(__dirname, '..')
    const { hosts, addresses } = collectNetworkTargets(path.join(installed.resources, 'app.asar'),
      [path.join(repository, 'electron'), path.join(repository, 'src', 'renderer-v2')])
    const staged = path.join(work, 'hosts')
    fs.writeFileSync(staged, addHostsBlock(fs.readFileSync('/etc/hosts', 'utf8'), hosts))
    sudo(['/bin/cp', staged, '/etc/hosts'])
    sudo(['/usr/bin/dscacheutil', '-flushcache'], { allowFailure: true })
    sudo(['/usr/bin/killall', '-HUP', 'mDNSResponder'], { allowFailure: true })
    if (addresses.length > 0) {
      sudo(['/sbin/pfctl', '-E'], { allowFailure: true })
      const rules = path.join(work, 'pf.conf')
      fs.writeFileSync(rules, `block drop out quick proto { tcp udp } from any to { ${addresses.join(' ')} }\n`)
      sudo(['/sbin/pfctl', '-a', PF_ANCHOR, '-f', rules])
    }
    // Every blocked name goes through the system resolver before the app
    // starts: one that still resolves outward means the block did not take.
    const leaking = []
    for (const host of hosts) {
      const results = await dns.promises.lookup(host, { all: true }).catch(() => [])
      if (results.some((result) => !/^(?:127\.|::1$)/.test(result.address))) leaking.push(host)
    }
    if (leaking.length > 0) throw new Error(`hosts 改了但这些域名还解析到外面：${leaking.join('、')}，不敢打开旧版本`)
    report(`这台 runner 上星芒只连得到本机：hosts 把 ${hosts.length} 个域名指回本机（逐个解析过），${addresses.length} 个地址直接挡掉`)
    return installed
  },

  patchOld(installed, { feedUrl, identity }) {
    const configPath = path.join(installed.resources, 'app-update.yml')
    fs.writeFileSync(configPath, rewriteUpdateFeedUrl(fs.readFileSync(configPath, 'utf8'), feedUrl))
    macResign(installed.appPath, identity)
    report('旧版本已改成认本机假源，并和新版本换成同一个临时签名身份')
    return { oldCdhash: macCdhash(installed.appPath) }
  },

  // The app encrypts its cookies (the enableCookieEncryption fuse), so on
  // every start Chromium reads its Safe Storage key from the keychain before
  // the app's own code runs. The key admits the version that created it by its code hash, and
  // the first start of an update asks for the login password: the dialog
  // customers met on 10-27, answered with "Always Allow". Unanswered it holds
  // the new version before its first log line. The run answers it the way
  // the customer does, and only when the old version was admitted the way
  // that dialog implies.
  approveNewVersion(installed, { identity, oldCdhash, newCdhash }) {
    // EXPERIMENT (reverted before the PR): read the item where the customer has it.
    const loginKeychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
    const loginItem = findSafeStorageItem(identity.security(['dump-keychain', '-a', loginKeychain]))
    report(`实验：登录钥匙串里的那把钥匙：${loginItem ? loginItem.service : '没有'}`)
    if (loginItem) for (const line of loginItem.access.split('\n').slice(0, 60)) report(`  ${line}`)
    const item = findSafeStorageItem(identity.security(['dump-keychain', '-a', identity.keychainPath]))
    if (!item) {
      const service = `${PRODUCT_NAME} Safe Storage`
      if (run('/usr/bin/security', ['find-generic-password', '-s', service], { allowFailure: true }).status === 0) {
        throw new Error(`旧版本把「${service}」建在了别的钥匙串里，不是这次的临时钥匙串，替不了客户点「始终允许」`)
      }
      report('旧版本没往钥匙串里存钥匙，新版本第一次打开时自己建，不会弹框')
      return
    }
    report(`旧版本建的钥匙「${item.service}」，谁能不问就读：`)
    for (const line of item.access.split('\n').slice(0, 60)) report(`  ${line}`)
    let partitions
    try {
      partitions = allowNewVersionPartition(item.partitions, { oldCdhash, newCdhash })
    } catch (error) {
      // Not the prompt the run knows how to answer. It goes on unanswered: if
      // the new version then hangs, the scene shows where.
      report(`${error.message}；不替客户点，接着看新版本会不会停在钥匙串框前`)
      return
    }
    if (partitions.length === item.partitions.length) return
    identity.security(['set-generic-password-partition-list', '-s', item.service, ...(item.account ? ['-a', item.account] : []),
      '-S', partitions.join(','), '-k', identity.keychainPassword, identity.keychainPath], [identity.keychainPassword])
    // `security -i`, which carries the password on stdin, need not report a
    // failed subcommand in its exit status; the list is read back instead.
    const updated = findSafeStorageItem(identity.security(['dump-keychain', '-a', identity.keychainPath]))
    if (!updated || partitions.some((partition) => !updated.partitions.includes(partition))) {
      throw new Error(`没能把新版本加进「${item.service}」的放行名单，现在是：${updated ? updated.partitions.join('、') : '钥匙不见了'}`)
    }
    report(`新版本第一次打开会弹钥匙串框要「${item.service}」；替客户输了密码点「始终允许」：放行名单 ${item.partitions.join('、')} 加上新版本`)
  },

  launch(installed) {
    run('/usr/bin/open', [installed.appPath])
  },

  kill(installed) {
    run('/usr/bin/pkill', ['-9', '-f', `${installed.appPath}/Contents/`], { allowFailure: true })
  },

  alive(installed) {
    return run('/usr/bin/pgrep', ['-f', `${installed.appPath}/Contents/MacOS/`], { allowFailure: true }).status === 0
  },

  // A force-killed app never hands Squirrel.Mac's ShipIt the update (the runs
  // so far show none), but one already queued would swap the bundle once the
  // app is gone; opening the app halfway through would race it.
  async settle() {
    await delay(5000)
    await waitFor('ShipIt 还没装完', 3 * 60 * 1000, () => run('/usr/bin/pgrep', ['-x', 'ShipIt'], { allowFailure: true }).status !== 0)
  },

  // macOS has no per-program firewall to lean on, so the run watches what the
  // app and its helpers are connected to and fails on anything that is not
  // loopback: proof the hosts block held, not a hope.
  outsideConnections(installed) {
    const pids = run('/usr/bin/pgrep', ['-f', `${installed.appPath}/Contents/`], { allowFailure: true }).stdout.trim().split(/\s+/).filter(Boolean)
    if (pids.length === 0) return []
    const listed = run('/usr/sbin/lsof', ['-nP', '-a', '-i', '-p', pids.join(',')], { allowFailure: true }).stdout
    return listed.split('\n').map((line) => /->(\S+)/.exec(line)?.[1]).filter(Boolean)
      .filter((remote) => !isLoopbackEndpoint(remote))
  },

  installedVersion(installed) {
    return macBundleValue(installed, 'CFBundleShortVersionString')
  },

  // Squirrel.Mac hands the swap to ShipIt, a separate launchd job that logs to
  // its own files and the unified log; neither shows in the app's runtime log.
  describeScene(installed) {
    const shipItCache = path.join(os.homedir(), 'Library', 'Caches', `${macBundleValue(installed, 'CFBundleIdentifier')}.ShipIt`)
    const lines = []
    for (const name of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
      const text = readTextIfPresent(path.join(shipItCache, name))
      lines.push(`${name}：${text === null ? '（没有）' : ''}`, ...(text || '').trim().split('\n').slice(-40).map((line) => `  ${line}`))
    }
    const unified = sudo(['/usr/bin/log', 'show', '--last', '20m', '--style', 'compact', '--predicate',
      'process == "ShipIt" OR eventMessage CONTAINS[c] "squirrel" OR eventMessage CONTAINS[c] "ShipIt"'], { allowFailure: true, timeoutMs: 180_000 })
    lines.push('系统日志里 ShipIt / Squirrel 的最后 60 行：', ...`${unified.stdout}${unified.stderr}`.trim().split('\n').slice(-60).map((line) => `  ${line}`))
    // An app that is running but never logged is held by something before its
    // own code: a system dialog nobody on a runner can answer shows as a live
    // SecurityAgent, and the main thread's stack says what it is waiting on.
    const agent = run('/usr/bin/pgrep', ['-x', 'SecurityAgent'], { allowFailure: true }).status === 0
    lines.push(`系统授权框（SecurityAgent）开着吗：${agent ? '开着' : '没有'}`)
    const pid = run('/usr/bin/pgrep', ['-f', `${installed.appPath}/Contents/MacOS/`], { allowFailure: true }).stdout.trim().split(/\s+/)[0]
    if (pid) {
      lines.push(run('/bin/ps', ['-o', 'pid,stat,etime,command', '-p', pid], { allowFailure: true }).stdout.trim())
      const sampled = run('/usr/bin/sample', [pid, '1'], { allowFailure: true, timeoutMs: 60_000 }).stdout.split('\n')
      const start = sampled.findIndex((line) => line.includes('com.apple.main-thread'))
      const end = start === -1 ? -1 : sampled.findIndex((line, index) => index > start && /^\s{4}\d+ Thread_/.test(line))
      const stack = start === -1 ? ['（没取到）'] : sampled.slice(start, end === -1 ? start + 45 : Math.min(end, start + 45))
      lines.push('主线程卡在哪：', ...stack.map((line) => `  ${line.slice(0, 220)}`))
    }
    return lines
  },
}

// ---- the run ---------------------------------------------------------------

function reportScene(platform, installed, userData, log, feedLog, outside) {
  report('失败时的现场：')
  for (const name of ['pending-update.json', 'last-run-version.json', 'settings.json']) {
    report(`  ${name}: ${(readTextIfPresent(path.join(userData, name)) || '（没有）').trim()}`)
  }
  // Every source, not just the updater: a quit, a crash or a startup failure
  // between the two runs shows up under main or window.
  const lines = log.entries().map(describeLogEntry)
  report(`  运行日志最后 ${Math.min(lines.length, 80)} 行：`)
  for (const line of lines.slice(-80)) report(`    ${line}`)
  report(`  假更新源一共收到 ${feedLog.length} 个请求`)
  if (outside.size > 0) report(`  星芒连过的本机以外地址：${[...outside].join('、')}`)
  try {
    report(`  程序还在跑吗：${platform.alive(installed) ? '在' : '不在'}；装着的版本：${platform.installedVersion(installed)}`)
    for (const line of platform.describeScene(installed)) report(`  ${line}`)
  } catch (error) {
    report(`  读系统这边的现场时出错：${error.message}`)
  }
}

async function upgrade(options) {
  const platform = process.platform === 'win32' ? windows : process.platform === 'darwin' ? macos : null
  if (!platform) throw new Error('「旧版升新版」冒烟只在 Windows 和 macOS 上跑')
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('这个冒烟会装软件、开防火墙或改 hosts，只能在一次性托管 runner 上跑')
  }
  const newManifestText = fs.readFileSync(path.join(options.newRelease, platform.manifestName), 'utf8')
  const newVersion = parseLatestMetadata(newManifestText, platform.manifestName).version
  if (compareReleaseVersions(newVersion, options.oldVersion) <= 0) {
    report(`新版本 ${newVersion} 不比 ${options.oldVersion} 高，旧版本不会去装它，这一项跳过`)
    return
  }
  report(`从 ${options.oldVersion} 升到 ${newVersion}`)
  const work = options.work || fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-upgrade-'))
  const feed = path.join(work, 'feed')
  fs.mkdirSync(feed, { recursive: true })
  const feedUrl = `http://127.0.0.1:${options.port}/`
  const cleanups = []
  const feedLog = []
  const outside = new Set()
  let installed = null
  let server = null
  let userData = null
  let log = null
  try {
    const identity = platform === macos ? createMacSigningIdentity(work, cleanups) : null
    const prepared = await platform.prepareFeed({
      release: options.newRelease, feed, oldVersion: options.oldVersion, oldInstaller: options.oldInstaller, identity,
    })
    report(`假更新源备好了：${fs.readdirSync(feed).join('、')}`)
    server = createFeedServer(feed, (line) => {
      feedLog.push(line)
      report(`  feed: ${line}`)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, '127.0.0.1', resolve)
    })

    installed = await platform.setUp({ installer: options.oldInstaller, work, feedPort: options.port })
    const installedVersion = platform.installedVersion(installed)
    if (installedVersion !== options.oldVersion) throw new Error(`装上的是 ${installedVersion}，不是要测的 ${options.oldVersion}`)
    const packageJson = readPackagedPackageJson(path.join(installed.resources, 'app.asar'))
    // Electron names the data directory after the packaged package.json.
    userData = path.join(installed.userDataRoot, packageJson.productName || packageJson.name)
    const pendingPath = path.join(userData, 'pending-update.json')
    const lastRunPath = path.join(userData, 'last-run-version.json')
    const settingsPath = path.join(userData, 'settings.json')
    log = createLogFollower(path.join(userData, 'logs', 'runtime.jsonl'))
    const patched = platform.patchOld(installed, { feedUrl, key: prepared.key, identity })

    const tick = () => {
      log.flush()
      for (const remote of platform.outsideConnections(installed)) outside.add(remote)
    }
    report('第一次打开旧版本，等它自己查到新版本、下载并核对')
    platform.launch(installed)
    await waitFor(`旧版本还没把 ${newVersion} 记成已下载`, DOWNLOAD_BUDGET_MS,
      () => readDownloadedVersion(readTextIfPresent(pendingPath) || '') === newVersion, tick)
    tick()
    report('旧版本已下好并核对过新版本；强制结束它，像客户关机那样')
    platform.kill(installed)
    await waitFor('旧版本还没退出', 60_000, () => !platform.alive(installed))
    await platform.settle()
    // The customer's own choices go in while the app is closed, the way a
    // settings file looks after weeks of use; the new version has to keep them.
    const settingsBefore = applyCustomerSettings(fs.readFileSync(settingsPath, 'utf8'))
    fs.writeFileSync(settingsPath, settingsBefore)
    platform.approveNewVersion(installed, { ...prepared, ...patched, identity })

    report(`第二次打开（这时装着的是 ${platform.installedVersion(installed)}），等它自己装上新版本并重开`)
    platform.launch(installed)
    await waitFor(`新版本 ${newVersion} 还没起来`, INSTALL_BUDGET_MS,
      () => readLastRunVersion(readTextIfPresent(lastRunPath) || '') === newVersion, tick)
    tick()
    const finalVersion = platform.installedVersion(installed)
    if (finalVersion !== newVersion) throw new Error(`新版本记下了自己的版本号，但装着的程序是 ${finalVersion}`)
    if (!findVersionUpdatedEntry(log.entries(), { from: options.oldVersion, to: newVersion })) {
      throw new Error('新版本没有记下「本次启动是更新后的第一次」：它没认出旧版本留下的记录，像是重新装的')
    }
    for (const until = Date.now() + STAY_ALIVE_MS; Date.now() < until; await delay(POLL_MS)) {
      if (!platform.alive(installed)) throw new Error(`新版本起来以后 ${STAY_ALIVE_MS / 1000} 秒内又退出了`)
      tick()
    }
    const lost = findLostSettings(settingsBefore, fs.readFileSync(settingsPath, 'utf8'))
    if (lost.length > 0) throw new Error(`新版本没留住旧版本的设置：${lost.join('；')}`)
    if (outside.size > 0) throw new Error(`星芒连到了本机以外的地址：${[...outside].join('、')}`)
    report(`通过：${options.oldVersion} 自己下载、核对、安装了 ${newVersion}，新版本接着用原来的数据和设置起来了`)
  } catch (error) {
    if (userData && log) {
      reportScene(platform, installed, userData, log, feedLog, outside)
      // The workflow keeps <work>/app-logs when a run fails: the whole log,
      // not just the updater lines above.
      try {
        fs.cpSync(path.join(userData, 'logs'), path.join(work, 'app-logs'), { recursive: true })
      } catch {
        // No log directory means the app never got far enough to write one; the scene above says so.
      }
    }
    throw error
  } finally {
    if (installed) platform.kill(installed)
    if (server) await new Promise((resolve) => server.close(resolve))
    // Only the signing identity is taken back out. The isolation stays until
    // the runner is thrown away: an installer still finishing after a failed
    // wait could start the app again, and it must find the network shut.
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch (error) {
        report(`收尾时有一步没做成：${error.message}`)
      }
    }
  }
}

/** The version the workflow stamps on a package it builds for this run (resolveUpgradeTestVersion). */
function printTestVersion(argv) {
  assertKnownArguments(argv, ['--package', '--released'])
  const packageVersion = argumentValue(argv, '--package')
  const released = (argumentValue(argv, '--released') || '').split(',').map((value) => value.trim().replace(/^v/i, '')).filter(Boolean)
  if (!packageVersion || released.length === 0) throw new Error('用法：test-version --package <版本号> --released <版本号,版本号>')
  process.stdout.write(`${resolveUpgradeTestVersion(packageVersion, released)}\n`)
}

async function main(argv) {
  if (argv[0] === 'test-version') {
    printTestVersion(argv.slice(1))
    return
  }
  await upgrade(parseArguments(argv))
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[upgrade-smoke] ${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { collectNetworkTargets, parseArguments }
