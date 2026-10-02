// Linux has no code signature and no ASAR integrity check (the
// EnableEmbeddedAsarIntegrityValidation fuse embeds nothing into a Linux
// binary), so what protects an installed copy is ownership alone: everything
// under /opt/xingmang-ai-manager belongs to root and nobody else can write it.
// This verifier holds the .deb to that, plus the handful of package details
// that decide whether the app starts at all for a customer: chrome-sandbox
// made setuid by postinst, a menu entry that cannot switch the sandbox off,
// and a binary built for the architecture the package claims.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { extractFile } = require('@electron/asar')
const YAML = require('yaml')
const {
  DEB_ARCHITECTURES,
  PACKAGE_NAME,
  debFileName,
  debianVersion,
} = require('./linux-artifact-names.cjs')
const {
  normalizeUpdateBaseUrl,
  resolveUpdateUrlForVersion,
  validateLocalLinuxRelease,
} = require('./update-release-utils.cjs')

const INSTALL_DIRECTORY = `/opt/${PACKAGE_NAME}`
const DESKTOP_FILE = `/usr/share/applications/${PACKAGE_NAME}.desktop`
const DPKG_DEB = '/usr/bin/dpkg-deb'
const ELF_MACHINES = Object.freeze({ 62: 'x64', 183: 'arm64' })
// Libraries the Electron binary links against or Chromium opens at start-up
// that electron-builder's default Depends leaves out; a missing one is a
// dynamic loader error on the first launch, not an install error.
const REQUIRED_DEPENDENCIES = Object.freeze([
  'libsecret-1-0',
  'libgbm1',
  'libnss3',
  'libxkbcommon0',
  'libudev1',
  ['libasound2t64', 'libasound2'],
  ['libgtk-3-0t64', 'libgtk-3-0'],
])
const SANDBOX_DISABLING = /no-sandbox|disable-gpu-sandbox|disable-setuid-sandbox|ELECTRON_DISABLE_SANDBOX/i
const ALLOWED_PAYLOAD_ROOTS = Object.freeze([
  `.${INSTALL_DIRECTORY}/`,
  '.' + DESKTOP_FILE,
  './usr/share/icons/hicolor/',
  `./usr/share/doc/${PACKAGE_NAME}/`,
])
// Parent directories every payload root needs; they are listed as entries too.
const ALLOWED_PAYLOAD_DIRECTORIES = Object.freeze(['./', './opt/', './usr/', './usr/share/', './usr/share/applications/', './usr/share/icons/', './usr/share/doc/'])
const REQUIRED_PAYLOAD_FILES = Object.freeze([
  `.${INSTALL_DIRECTORY}/${PACKAGE_NAME}`,
  `.${INSTALL_DIRECTORY}/chrome-sandbox`,
  `.${INSTALL_DIRECTORY}/resources/app.asar`,
  `.${INSTALL_DIRECTORY}/resources/package-type`,
  '.' + DESKTOP_FILE,
])

function parseControlFields(text) {
  const fields = new Map()
  let current = null
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue
    if (/^\s/.test(line)) {
      if (current === null) throw new Error(`控制文件的续行前面没有字段：${line}`)
      fields.set(current, `${fields.get(current)}\n${line.trim()}`)
      continue
    }
    const match = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line)
    if (!match) throw new Error(`无法解析控制文件这一行：${line}`)
    current = match[1]
    fields.set(current, match[2])
  }
  return fields
}

// "a, b | c (>= 1)" -> [['a'], ['b', 'c']]
function parseDependencies(value) {
  return String(value || '')
    .split(',')
    .map((group) => group.split('|').map((item) => item.trim().split(/\s|\(/)[0]).filter(Boolean))
    .filter((group) => group.length > 0)
}

function assertControlFields(fields, { version, arch }) {
  const expectedArchitecture = DEB_ARCHITECTURES[arch]
  if (!expectedArchitecture) throw new Error(`不支持的 Linux 架构：${arch}`)
  const expect = (name, expected) => {
    if (fields.get(name) !== expected) {
      throw new Error(`deb 控制字段 ${name} 是「${fields.get(name) ?? '（缺失）'}」，期望「${expected}」`)
    }
  }
  expect('Package', PACKAGE_NAME)
  expect('Version', debianVersion(version))
  expect('Architecture', expectedArchitecture)
  for (const name of ['Maintainer', 'Description', 'Homepage']) {
    if (!String(fields.get(name) || '').trim()) throw new Error(`deb 控制字段 ${name} 不能为空`)
  }
  const depends = parseDependencies(fields.get('Depends'))
  for (const required of REQUIRED_DEPENDENCIES) {
    const alternatives = Array.isArray(required) ? required : [required]
    const satisfied = depends.some((group) => alternatives.every((name) => group.includes(name)))
    if (!satisfied) throw new Error(`deb 依赖里缺少 ${alternatives.join(' | ')}，缺了它首次启动就会报找不到动态库`)
  }
  for (const name of ['Pre-Depends', 'Depends', 'Recommends']) {
    if (/appindicator3-1\b/.test(String(fields.get(name) || '')) && !/ayatana/.test(String(fields.get(name)))) {
      throw new Error(`deb 的 ${name} 仍引用新版 Ubuntu 已删除的 libappindicator3-1`)
    }
  }
}

const LISTING_PATTERN = /^([-dlhbcps])([rwxsStT-]{9})\s+(\S+)\/(\S+)\s+\d+\s+\S+\s+\S+\s+(.+)$/

function parseContentsListing(text) {
  const entries = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = LISTING_PATTERN.exec(line)
    if (!match) throw new Error(`无法解析 deb 内容清单这一行：${line}`)
    const [, type, permissions, owner, group, rest] = match
    const arrow = type === 'l' ? rest.indexOf(' -> ') : -1
    entries.push({
      type,
      permissions,
      owner,
      group,
      path: arrow === -1 ? rest : rest.slice(0, arrow),
      target: arrow === -1 ? null : rest.slice(arrow + 4),
    })
  }
  return entries
}

function isRoot(principal) {
  return principal === '0' || principal === 'root'
}

function assertPayloadEntries(entries) {
  if (entries.length === 0) throw new Error('deb 的内容清单是空的')
  const paths = new Set()
  for (const entry of entries) {
    paths.add(entry.path)
    if (!isRoot(entry.owner) || !isRoot(entry.group)) {
      throw new Error(`${entry.path} 的属主是 ${entry.owner}/${entry.group}，安装后普通用户就能改写程序文件`)
    }
    const allowed = ALLOWED_PAYLOAD_DIRECTORIES.includes(entry.path)
      || ALLOWED_PAYLOAD_ROOTS.some((root) => entry.path === root || entry.path.startsWith(root))
    if (!allowed) throw new Error(`deb 往意料之外的位置写文件：${entry.path}`)
    // A setuid bit in the payload would be root for every user from the moment
    // dpkg unpacks it; postinst sets the one that is needed, by name.
    if (/[sS]/.test(entry.permissions[2]) || /[sS]/.test(entry.permissions[5])) {
      throw new Error(`${entry.path} 在包里就带着 setuid/setgid 位`)
    }
    if (entry.type === 'l') {
      if (path.posix.isAbsolute(entry.target) || entry.target.split('/').includes('..')) {
        throw new Error(`${entry.path} 是指向包外的链接：${entry.target}`)
      }
      continue
    }
    if (entry.permissions[4] === 'w' || entry.permissions[7] === 'w') {
      throw new Error(`${entry.path} 安装后组或其他用户可写（${entry.type}${entry.permissions}）`)
    }
  }
  for (const required of REQUIRED_PAYLOAD_FILES) {
    if (!paths.has(required)) throw new Error(`deb 里缺少 ${required}`)
  }
  if (paths.has(`.${INSTALL_DIRECTORY}/resources/default_app.asar`)) {
    throw new Error('deb 里仍保留 Electron 默认应用 default_app.asar')
  }
  const executable = entries.find((entry) => entry.path === `.${INSTALL_DIRECTORY}/${PACKAGE_NAME}`)
  if (executable.type !== '-' || executable.permissions[2] !== 'x') {
    throw new Error('deb 里的主程序不是可执行的普通文件')
  }
}

function assertPostinst(text) {
  const source = String(text)
  if (!source.startsWith('#!/bin/bash\n')) throw new Error('postinst 第一行必须是 #!/bin/bash')
  for (const line of [
    `chown root:root '${INSTALL_DIRECTORY}/chrome-sandbox'`,
    `chmod 4755 '${INSTALL_DIRECTORY}/chrome-sandbox'`,
  ]) {
    if (!source.includes(line)) throw new Error(`postinst 没有无条件执行：${line}`)
  }
  const commands = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  if (/\bunshare\b/.test(commands)) throw new Error('postinst 仍按 root 身份探测用户命名空间来决定沙箱，普通用户可能启动不了')
  if (SANDBOX_DISABLING.test(source)) throw new Error('postinst 里出现了关闭沙箱的参数')
}

function parseDesktopEntry(text) {
  const entry = new Map()
  let inMainGroup = false
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const group = /^\[(.+)\]$/.exec(line)
    if (group) {
      inMainGroup = group[1] === 'Desktop Entry'
      continue
    }
    if (!inMainGroup) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`无法解析菜单文件这一行：${line}`)
    entry.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return entry
}

function assertDesktopEntry(text) {
  if (SANDBOX_DISABLING.test(String(text))) throw new Error('菜单文件里出现了关闭沙箱的参数')
  const entry = parseDesktopEntry(text)
  const expect = (name, expected) => {
    if (entry.get(name) !== expected) {
      throw new Error(`菜单文件的 ${name} 是「${entry.get(name) ?? '（缺失）'}」，期望「${expected}」`)
    }
  }
  expect('Type', 'Application')
  expect('Name', '星芒AI管理工具')
  expect('Exec', `${INSTALL_DIRECTORY}/${PACKAGE_NAME} %U`)
  expect('Icon', PACKAGE_NAME)
  // Electron reports desktopName as the window's app_id / WM_CLASS; a mismatch
  // leaves the running window without its menu icon in the dock or taskbar.
  expect('StartupWMClass', PACKAGE_NAME)
  expect('Terminal', 'false')
  const mimeTypes = String(entry.get('MimeType') || '').split(';')
  if (!mimeTypes.includes('x-scheme-handler/xingmang')) {
    throw new Error('菜单文件没有登记 xingmang:// 链接，网页上的「打开星芒」按钮会没有反应')
  }
}

function elfArchitecture(header) {
  const bytes = Buffer.from(header)
  if (bytes.length < 20 || bytes.readUInt32BE(0) !== 0x7f454c46) throw new Error('不是 ELF 可执行文件')
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('不是 64 位小端 ELF 可执行文件')
  const machine = bytes.readUInt16LE(18)
  const architecture = ELF_MACHINES[machine]
  if (!architecture) throw new Error(`未知的 ELF 机器类型 ${machine}`)
  return architecture
}

// A local test package keeps its updater pointed at nothing, so it can never
// pull a release over itself. A release package is the one publish-release
// uploads: its updater is on, and it must say it is unsigned, because that is
// what makes the main process ask before downloading and recheck the SHA-512
// itself (electron-builder.config.cjs, xingmangUnsignedRelease).
function assertPackagedMetadata(packageJson, { release = false } = {}) {
  if (packageJson.name !== PACKAGE_NAME) throw new Error(`包内 package.json 的 name 是 ${packageJson.name}`)
  if (packageJson.desktopName !== `${PACKAGE_NAME}.desktop`) {
    throw new Error('包内 package.json 缺少 desktopName，窗口会和菜单图标对不上')
  }
  if (!release) {
    if (packageJson.xingmangLocalBuild !== true) {
      throw new Error('本地测试包的自动更新必须关着，xingmangLocalBuild 必须为 true')
    }
    return
  }
  if (packageJson.xingmangLocalBuild !== false) {
    throw new Error('发布包的 xingmangLocalBuild 必须为 false，否则装上以后永远收不到更新')
  }
  if (packageJson.xingmangUnsignedRelease !== true) {
    throw new Error('Linux 发布包没有代码签名，xingmangUnsignedRelease 必须为 true')
  }
}

// electron-updater reads its feed from resources/app-update.yml. A release
// deb pointing anywhere but the feed this version publishes to would update
// from somewhere nobody approved, or from nowhere. publisherName switches on
// the Windows Authenticode check, which no Linux package can ever pass.
function assertUpdateConfig(text, { version }) {
  let config
  try {
    config = YAML.parse(String(text), { maxAliasCount: 0, uniqueKeys: true })
  } catch {
    throw new Error('resources/app-update.yml 不是有效的 YAML')
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('resources/app-update.yml 顶层必须是对象')
  }
  if (config.provider !== 'generic') throw new Error(`resources/app-update.yml 的 provider 是「${config.provider}」，期望 generic`)
  const expected = normalizeUpdateBaseUrl(resolveUpdateUrlForVersion(version))
  let actual
  try {
    actual = normalizeUpdateBaseUrl(config.url)
  } catch (error) {
    throw new Error(`resources/app-update.yml 的更新地址不合格：${error.message}`)
  }
  if (actual !== expected) throw new Error(`resources/app-update.yml 的更新地址是 ${actual}，期望 ${expected}`)
  if ('publisherName' in config) throw new Error('resources/app-update.yml 不能带 publisherName（Linux 包没有代码签名）')
}

function dpkgDeb(args) {
  if (!fs.existsSync(DPKG_DEB)) throw new Error(`找不到 ${DPKG_DEB}，这个校验只能在 Debian/Ubuntu 上运行`)
  return execFileSync(DPKG_DEB, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: false })
}

function readElfHeader(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(64)
    fs.readSync(handle, header, 0, header.length, 0)
    return header
  } finally {
    fs.closeSync(handle)
  }
}

function resolveDebPath(releaseDirectory, version, arch) {
  const names = fs.readdirSync(releaseDirectory)
  const unexpected = names.filter((name) => /\.(AppImage|snap|rpm|pacman|tar\.(gz|xz))$/i.test(name))
  if (unexpected.length > 0) throw new Error(`Linux 只出 deb，产物目录里多了：${unexpected.join('、')}`)
  const expected = debFileName(version, arch)
  if (!names.includes(expected)) throw new Error(`${releaseDirectory} 里找不到 ${expected}`)
  return path.join(releaseDirectory, expected)
}

async function verifyLinuxDeb(releaseDirectory, { version, arch, release = false }) {
  const deb = resolveDebPath(releaseDirectory, version, arch)
  assertControlFields(parseControlFields(dpkgDeb(['--field', deb])), { version, arch })
  assertPayloadEntries(parseContentsListing(dpkgDeb(['--contents', deb])))

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-deb-'))
  try {
    const controlDirectory = path.join(temporaryRoot, 'control')
    const payloadDirectory = path.join(temporaryRoot, 'payload')
    dpkgDeb(['--control', deb, controlDirectory])
    dpkgDeb(['--extract', deb, payloadDirectory])
    assertPostinst(fs.readFileSync(path.join(controlDirectory, 'postinst'), 'utf8'))
    if (SANDBOX_DISABLING.test(fs.readFileSync(path.join(controlDirectory, 'postrm'), 'utf8'))) {
      throw new Error('postrm 里出现了关闭沙箱的参数')
    }
    assertDesktopEntry(fs.readFileSync(path.join(payloadDirectory, DESKTOP_FILE), 'utf8'))
    const installRoot = path.join(payloadDirectory, INSTALL_DIRECTORY)
    for (const binary of [PACKAGE_NAME, 'chrome-sandbox']) {
      const actual = elfArchitecture(readElfHeader(path.join(installRoot, binary)))
      if (actual !== arch) throw new Error(`${binary} 是 ${actual} 程序，但安装包标的是 ${arch}`)
    }
    // electron-updater picks its Linux updater from this file; anything other
    // than "deb" would send a deb install down the AppImage path.
    const packageType = fs.readFileSync(path.join(installRoot, 'resources', 'package-type'), 'utf8').trim()
    if (packageType !== 'deb') throw new Error(`resources/package-type 是「${packageType}」，期望 deb`)
    const asar = path.join(installRoot, 'resources', 'app.asar')
    assertPackagedMetadata(JSON.parse(extractFile(asar, 'package.json').toString('utf8')), { release })
    if (release) {
      const updateConfig = path.join(installRoot, 'resources', 'app-update.yml')
      if (!fs.existsSync(updateConfig)) throw new Error('发布包里缺少 resources/app-update.yml，装上以后收不到更新')
      assertUpdateConfig(fs.readFileSync(updateConfig, 'utf8'), { version })
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
  // electron-builder writes the update manifest next to the deb in both modes;
  // publish-release uploads the two together, so they have to agree.
  const { metadataPath } = await validateLocalLinuxRelease(releaseDirectory, { arch, expectedVersion: version })
  return { deb, metadataPath }
}

function parseArguments(argv) {
  const positional = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'release'
  const releaseDirectory = path.resolve(positional)
  const archIndex = argv.indexOf('--arch')
  const arch = archIndex === -1 ? process.arch : argv[archIndex + 1]
  if (!DEB_ARCHITECTURES[arch]) throw new Error(`--arch 只接受 x64 或 arm64，收到：${arch}`)
  return { releaseDirectory, arch, release: argv.includes('--release') }
}

async function main() {
  const { releaseDirectory, arch, release } = parseArguments(process.argv.slice(2))
  const { version } = require(path.join(__dirname, '..', 'package.json'))
  const { deb, metadataPath } = await verifyLinuxDeb(releaseDirectory, { version, arch, release })
  const mode = release ? '发布包，自动更新指向正式更新目录' : '本地测试包，自动更新关着'
  console.log(`Linux 安装包校验通过：${path.basename(deb)}（${arch}，${mode}），文件全归 root、chrome-sandbox 由安装脚本设为 setuid、菜单入口不关沙箱，${path.basename(metadataPath)} 与安装包一致`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Linux 安装包校验失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = {
  PACKAGE_NAME,
  INSTALL_DIRECTORY,
  assertControlFields,
  assertDesktopEntry,
  assertPackagedMetadata,
  assertPayloadEntries,
  assertPostinst,
  assertUpdateConfig,
  debianVersion,
  elfArchitecture,
  parseArguments,
  parseContentsListing,
  parseControlFields,
  parseDependencies,
  parseDesktopEntry,
  resolveDebPath,
  verifyLinuxDeb,
}
