const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { validateLocalRelease } = require('./update-release-utils.cjs')

const packageVersion = require('../package.json').version
const PROJECT_ROOT = path.resolve(__dirname, '..')

// This repository is public. The production origin's address, SSH port, login user,
// key file name and document root are an attack surface on their own, so none of them
// may live here: every one is supplied at run time and the script refuses to run when
// any is missing. A built-in fallback would silently re-publish the secret, so there
// is deliberately none.
const CONFIG_FILE_NAME = 'dl-landing.config.json'
const TARGET_FIELDS = [
  { key: 'host', env: 'DL_LANDING_SSH_HOST', flag: '--host', label: '源站主机' },
  { key: 'port', env: 'DL_LANDING_SSH_PORT', flag: '--port', label: 'SSH 端口' },
  { key: 'user', env: 'DL_LANDING_SSH_USER', flag: '--user', label: 'SSH 用户' },
  { key: 'key', env: 'DL_LANDING_SSH_KEY', flag: '--key', label: 'SSH 私钥路径' },
  { key: 'knownHosts', env: 'DL_LANDING_KNOWN_HOSTS', flag: '--known-hosts', label: 'known_hosts 文件' },
  { key: 'remoteRoot', env: 'DL_LANDING_REMOTE_ROOT', flag: '--remote-root', label: '站点根目录' },
]
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// The CI step that prints artifact checksums emits one line per file:
//   XingMang-AI-Manager-0.1.22-Setup.exe  120586240 bytes  SHA256=<hex>
const CHECKSUM_LINE_PATTERN = /^\s*(\S+)\s+.*?SHA256=([0-9a-fA-F]{64})\s*$/
const MAX_CHECKSUM_FILE_BYTES = 256 * 1024
// The remote root is interpolated into commands that a root login shell runs on
// the production origin. Restrict it to characters that carry no meaning to that
// shell, so a stray value can never become a second command or a glob.
const REMOTE_ROOT_PATTERN = /^\/[A-Za-z0-9._/-]*$/

function assertSafeVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version.trim())) {
    throw new Error(`版本号不合法：${version || '(空)'}。例如 0.1.22`)
  }
  return version.trim()
}

function assertSafeRemoteRoot(remoteRoot) {
  const raw = typeof remoteRoot === 'string' ? remoteRoot.trim() : ''
  const invalid = `远端目录不合法：${remoteRoot === undefined || remoteRoot === '' ? '(空)' : String(remoteRoot)}。必须是绝对路径，只允许字母、数字和 . _ - /，且不含 .. 段。例如 /srv/dl-landing`
  if (!REMOTE_ROOT_PATTERN.test(raw)) {
    throw new Error(invalid)
  }
  const normalized = raw.replace(/\/+$/, '')
  if (!normalized || normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(invalid)
  }
  return normalized
}

// Defence in depth: assertSafeRemoteRoot already rejects every shell metacharacter,
// but each path still reaches the remote shell quoted, so a future relaxation of the
// pattern cannot silently turn into command injection.
function quoteRemotePath(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function installerFileNames(version) {
  const safe = assertSafeVersion(version)
  return {
    win: `XingMang-AI-Manager-${safe}-Setup.exe`,
    macArm64: `XingMang-AI-Manager-${safe}-arm64.dmg`,
    macX64: `XingMang-AI-Manager-${safe}-x64.dmg`,
    windowsArtifact: `windows-release-${safe}`,
    testSignedArtifact: `TEST-SIGNED-DO-NOT-PUBLISH-${safe}`,
  }
}

function buildLatestManifest(version) {
  const names = installerFileNames(version)
  return {
    version: assertSafeVersion(version),
    win: `/files/latest/${names.win}`,
    macArm64: `/files/latest/${names.macArm64}`,
    macX64: `/files/latest/${names.macX64}`,
  }
}

function formatLatestJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function argumentValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} 后面要跟一个值`)
  }
  return value
}

function configFilePath(env, cwd) {
  const override = typeof env.DL_LANDING_CONFIG === 'string' ? env.DL_LANDING_CONFIG.trim() : ''
  if (override) return path.resolve(override)
  return path.resolve(cwd || process.cwd(), CONFIG_FILE_NAME)
}

// The local config file is git-ignored on purpose: it is the place an operator keeps the
// origin details that must never reach the public repository.
function readPublishConfigFile(env = process.env, cwd = process.cwd()) {
  const filePath = configFilePath(env, cwd)
  let body
  try {
    body = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw new Error(`读取 ${filePath} 失败：${error && error.message ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`${filePath} 不是合法的 JSON：${error && error.message ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} 必须是一个 JSON 对象。参考 ${CONFIG_FILE_NAME}.example。`)
  }
  return parsed
}

function firstProvided(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function resolvePublishTarget(sources = {}) {
  const env = sources.env || {}
  const config = sources.config || {}
  const overrides = sources.overrides || {}
  const target = {}
  for (const field of TARGET_FIELDS) {
    target[field.key] = firstProvided(overrides[field.key], env[field.env], config[field.key])
  }
  return target
}

function assertPublishTarget(target) {
  const missing = TARGET_FIELDS.filter((field) => !firstProvided(target && target[field.key]))
  if (missing.length === 0) return target
  const detail = missing.map((field) => `${field.label}（${field.env} 或 ${field.flag}）`).join('、')
  throw new Error(
    `缺少源站配置：${detail}。脚本不带任何内置默认值，请用环境变量、命令行参数，或仓库根目录下被 .gitignore 忽略的 ${CONFIG_FILE_NAME} 提供；模板见 ${CONFIG_FILE_NAME}.example。`,
  )
}

function parsePublishArgs(argv, defaults = {}, sources = {}) {
  const env = sources.env || process.env
  const config = sources.config || readPublishConfigFile(env, sources.cwd)
  const target = resolvePublishTarget({ env, config, overrides: defaults })
  const options = {
    version: defaults.version || packageVersion,
    runId: '',
    localDir: '',
    macDir: '',
    checksums: '',
    yes: false,
    dryRun: false,
    keepDownload: false,
    host: target.host,
    port: target.port,
    user: target.user,
    key: target.key,
    knownHosts: target.knownHosts,
    remoteRoot: target.remoteRoot,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--yes') {
      options.yes = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--keep-download') {
      options.keepDownload = true
    } else if (arg === '--version') {
      options.version = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--run-id') {
      options.runId = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--local-dir') {
      options.localDir = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--mac-dir') {
      options.macDir = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--host') {
      options.host = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--port') {
      options.port = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--user') {
      options.user = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--key') {
      options.key = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--known-hosts') {
      options.knownHosts = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--checksums') {
      options.checksums = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--remote-root') {
      options.remoteRoot = argumentValue(argv, index + 1, arg)
      index += 1
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  // --help must stay usable on a machine that has no origin configuration at all.
  if (options.help) return options

  assertPublishTarget(options)
  options.version = assertSafeVersion(options.version)
  options.remoteRoot = assertSafeRemoteRoot(options.remoteRoot)
  options.port = Number(options.port)
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('SSH 端口必须是 1-65535 之间的整数（DL_LANDING_SSH_PORT 或 --port）')
  }
  if (options.dryRun) options.yes = false
  return options
}

function helpText() {
  return [
    '把 GitHub release-build 的安装包传到 dl.solov.cc（不是自动更新 R2）。',
    '',
    '  node scripts/publish-dl-landing.cjs --version 0.1.22',
    '  node scripts/publish-dl-landing.cjs --version 0.1.22 --yes',
    '',
    '默认只下载并打印计划。加上 --yes 才会 scp 三个安装包，最后写 latest.json。',
    'release-build 只出 Windows。两个 dmg 从 --mac-dir 或仓库里的 release-<version>/ 收集。',
    '不要传 .blockmap / latest.yml / zip。自签名 TEST-SIGNED 包会被拒绝。',
    '',
    '常用参数：',
    '  --version         默认读 package.json',
    '  --run-id          指定 Actions run，不填则按产物名找最新的 windows-release-<version>',
    '  --local-dir       跳过 gh，直接用已经下载好的目录',
    '  --mac-dir         额外找两个 dmg',
    '  --checksums       CI「Print artifact checksums」那一步的输出，逐个比对 SHA-256',
    '  --dry-run         只打印，不上传',
    '  --yes             确认上传到源站',
    '  --keep-download   保留临时下载目录',
    '',
    '--yes 生效前会先跑一次本地产物校验（latest.yml ↔ 安装包的大小、SHA-512、blockmap），',
    '不通过就拒绝上传。只挑出 exe、不带 latest.yml 的目录会被直接拒绝。',
    '',
    '源站连接信息不写在仓库里，必须由运行时提供，缺一个就拒绝执行：',
    ...TARGET_FIELDS.map((field) => `  ${field.env.padEnd(24)}${field.label}（也可用 ${field.flag}）`),
    '',
    `也可以把同样的字段写进仓库根目录的 ${CONFIG_FILE_NAME}（已被 .gitignore 忽略），`,
    `或用 DL_LANDING_CONFIG 指向仓库外的一份。模板见 ${CONFIG_FILE_NAME}.example。`,
  ].join('\n')
}

function walkFiles(root, visit) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkFiles(fullPath, visit)
      continue
    }
    if (entry.isFile()) visit(fullPath, entry.name)
  }
}

function collectInstallers(roots, names) {
  const found = { win: '', macArm64: '', macX64: '' }
  const wanted = new Map([
    [names.win, 'win'],
    [names.macArm64, 'macArm64'],
    [names.macX64, 'macX64'],
  ])
  for (const root of roots) {
    if (!root) continue
    const resolved = path.resolve(root)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue
    walkFiles(resolved, (filePath, fileName) => {
      const key = wanted.get(fileName)
      if (!key || found[key]) return
      const stat = fs.statSync(filePath)
      if (stat.size <= 0) {
        throw new Error(`${fileName} 是空文件：${filePath}`)
      }
      found[key] = filePath
    })
  }
  return found
}

function missingInstallerMessage(names, found) {
  const missing = []
  if (!found.win) missing.push(names.win)
  if (!found.macArm64) missing.push(names.macArm64)
  if (!found.macX64) missing.push(names.macX64)
  if (missing.length === 0) return ''
  const macMissing = !found.macArm64 || !found.macX64
  const hint = macMissing
    ? ' GitHub 的 release-build 只出 Windows 包。把本机 `npm run dist:mac:free` 的两个 dmg 放到 --mac-dir，或放进仓库旁的 release-<version>/。'
    : ''
  return `缺少落地页安装包：${missing.join('、')}。${hint}`.trim()
}

function pickWindowsArtifact(artifacts, version) {
  const names = installerFileNames(version)
  const usable = (artifacts || []).filter((item) => item && item.expired !== true)
  if (usable.some((item) => item.name === names.testSignedArtifact) && !usable.some((item) => item.name === names.windowsArtifact)) {
    throw new Error(`找到的是自签名测试包 ${names.testSignedArtifact}，不能传到 dl.solov.cc`)
  }
  const matches = usable
    .filter((item) => item.name === names.windowsArtifact)
    .slice()
    .sort((left, right) => Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0))
  if (matches.length === 0) return null
  const chosen = matches[0]
  return {
    name: names.windowsArtifact,
    id: chosen.id,
    runId: chosen.workflow_run && chosen.workflow_run.id,
    size: chosen.size_in_bytes,
  }
}

// The Windows installer is well over a hundred megabytes and the two dmg files are
// larger still. readFileSync held every byte of each one in memory at once purely to
// hash it, which on a modest release machine is the difference between a plan printout
// and an out-of-memory abort halfway through a release.
async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function buildPublishPlan(options, files, names) {
  const remoteRoot = assertSafeRemoteRoot(options.remoteRoot)
  const remoteFiles = `${remoteRoot}/files/latest`
  return {
    uploads: [
      { slot: 'win', local: files.win, remoteDir: remoteFiles, fileName: names.win },
      { slot: 'macArm64', local: files.macArm64, remoteDir: remoteFiles, fileName: names.macArm64 },
      { slot: 'macX64', local: files.macX64, remoteDir: remoteFiles, fileName: names.macX64 },
    ],
    manifest: buildLatestManifest(options.version),
    manifestRemote: `${remoteRoot}/latest.json`,
  }
}

async function printPlan(plan) {
  for (const item of plan.uploads) {
    const digest = await fileSha256(item.local)
    const size = fs.statSync(item.local).size
    process.stdout.write(`${item.fileName}  ${size} bytes  SHA256=${digest}\n`)
    process.stdout.write(`  ${item.local}\n  -> ${item.remoteDir}/${item.fileName}\n`)
  }
  process.stdout.write(`latest.json -> ${plan.manifestRemote}\n`)
  process.stdout.write(formatLatestJson(plan.manifest))
}

// The operator pastes the output of the release workflow's "Print artifact checksums"
// step, so anything that is not one of those lines is ignored rather than rejected.
function parseExpectedChecksums(text) {
  const expected = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = CHECKSUM_LINE_PATTERN.exec(line)
    if (!match) continue
    const fileName = path.basename(match[1])
    const digest = match[2].toLowerCase()
    const previous = expected.get(fileName)
    if (previous && previous !== digest) {
      throw new Error(`校验清单里 ${fileName} 出现了两个不同的 SHA-256，无法判断该信哪一个`)
    }
    expected.set(fileName, digest)
  }
  if (expected.size === 0) {
    throw new Error('校验清单里没有一行能解析出 SHA-256。请原样粘贴 Actions 里「Print artifact checksums」那一步的输出。')
  }
  return expected
}

function readExpectedChecksums(filePath) {
  const resolved = path.resolve(filePath)
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(`找不到校验清单：${resolved}`)
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`校验清单为空或不是普通文件：${resolved}`)
  }
  if (stat.size > MAX_CHECKSUM_FILE_BYTES) {
    throw new Error(`校验清单超过 ${MAX_CHECKSUM_FILE_BYTES} 字节上限：${resolved}`)
  }
  return parseExpectedChecksums(fs.readFileSync(resolved, 'utf8'))
}

async function assertExpectedChecksums(uploads, expected) {
  const compared = []
  for (const item of uploads) {
    const wanted = expected.get(item.fileName)
    if (!wanted) continue
    const actual = await fileSha256(item.local)
    if (actual !== wanted) {
      throw new Error(`${item.fileName} 的 SHA-256 与校验清单不一致：期望 ${wanted}，实际 ${actual}。不上传。`)
    }
    compared.push(item.fileName)
  }
  if (compared.length === 0) {
    const names = uploads.map((item) => item.fileName).join('、')
    throw new Error(`校验清单里没有任何一个要上传的文件：${names}。版本对得上吗？`)
  }
  return compared
}

// `gh run download` unpacks whatever the Actions artifact happens to hold, and --local-dir
// points at a directory an operator assembled by hand. Neither is proof that the bytes
// about to land on the origin are the ones the release gate passed, so the same local
// check runs again here before --yes has any effect.
//
// latest.yml travels inside the same artifact as the installer, so it is the one manifest
// available here: it pins the installer's version, size, SHA-512 and blockmap. The two dmg
// files are built on a Mac by hand and no manifest that reaches this script references
// them, which is why --checksums stays available as their only external cross-check.
async function verifyUploadCandidates(options, plan, deps = {}) {
  const validate = deps.validateLocalRelease || validateLocalRelease
  const windowsUpload = plan.uploads.find((item) => item.slot === 'win')
  const releaseDirectory = path.dirname(path.resolve(windowsUpload.local))
  if (!fs.existsSync(path.join(releaseDirectory, 'latest.yml'))) {
    throw new Error(
      `${releaseDirectory} 里没有 latest.yml，无法在上传前复核安装包完整性。`
      + 'release-build 的产物本来就带着它，请用完整的产物目录，不要只挑出 exe。',
    )
  }
  try {
    await validate(releaseDirectory, { expectedVersion: options.version })
  } catch (error) {
    const code = error && error.code ? `[${error.code}] ` : ''
    throw new Error(`上传前的产物校验未通过，已拒绝上传：${code}${error && error.message ? error.message : String(error)}`)
  }
  process.stdout.write(`产物校验通过：${releaseDirectory} 的 latest.yml 与安装包一致\n`)

  if (!options.checksums) {
    process.stdout.write('未提供 --checksums，跳过与 CI 打印的 SHA-256 比对（两个 dmg 因此没有外部校验源）。\n')
    return { verifiedDirectory: releaseDirectory, comparedChecksums: [] }
  }
  const comparedChecksums = await assertExpectedChecksums(plan.uploads, readExpectedChecksums(options.checksums))
  process.stdout.write(`SHA-256 与校验清单一致：${comparedChecksums.join('、')}\n`)
  return { verifiedDirectory: releaseDirectory, comparedChecksums }
}

function runTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: options.cwd,
    stdio: options.stdio || 'pipe',
  })
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`未找到 ${command}。请确认已安装并在 PATH 里。`)
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n')
      .trim()
      .slice(0, 1200)
    throw new Error(`${command} ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`)
  }
  return result
}

// BatchMode=yes makes an unknown host key fail instead of prompting, but on its own it
// still trusts whatever ~/.ssh/known_hosts happens to hold — including an entry a first
// connection accepted from whoever answered at the time. Pinning a dedicated file plus
// StrictHostKeyChecking=yes means the upload only ever reaches the host whose public key
// the operator wrote down, so a hijacked route or a replaced origin aborts the transfer
// instead of receiving the installers and the deploy key.
function assertKnownHostsFile(value) {
  const knownHosts = firstProvided(value)
  if (!knownHosts) {
    throw new Error(
      '缺少 known_hosts 文件（DL_LANDING_KNOWN_HOSTS 或 --known-hosts）。'
      + '里面只放源站这一台主机的公钥，路径必须在仓库之外。',
    )
  }
  const resolved = path.resolve(knownHosts)
  // The repository is public: a host key file committed by accident would publish the
  // origin's identity, which is exactly what the rest of this script keeps out of git.
  const relative = path.relative(PROJECT_ROOT, resolved)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(`known_hosts 文件不能放在仓库目录里：${resolved}。仓库是公开的，请把它放到仓库之外。`)
  }
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(`找不到 known_hosts 文件：${resolved}。请先用 ssh-keyscan 把源站公钥写进去并核对指纹。`)
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`known_hosts 文件为空或不是普通文件：${resolved}。里面至少要有源站的一条主机公钥。`)
  }
  return resolved
}

function sshArgs(options) {
  const key = firstProvided(options.key)
  if (!key) {
    throw new Error('缺少 SSH 私钥路径（DL_LANDING_SSH_KEY 或 --key）。密钥文件名不写在仓库里。')
  }
  if (!fs.existsSync(key)) {
    throw new Error(`找不到 SSH 密钥：${key}`)
  }
  const knownHosts = assertKnownHostsFile(options.knownHosts)
  return [
    '-i', key,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-p', String(options.port),
  ]
}

function scpArgs(options) {
  const args = sshArgs(options)
  const portIndex = args.indexOf('-p')
  if (portIndex !== -1) args[portIndex] = '-P'
  return args
}

function resolveRepo() {
  const result = runTool('gh', ['repo', 'view', '--json', 'nameWithOwner'])
  const payload = JSON.parse(result.stdout)
  if (!payload || !payload.nameWithOwner) {
    throw new Error('无法从 gh repo view 读到仓库名。请在仓库目录里执行，并先 gh auth login。')
  }
  return payload.nameWithOwner
}

function listArtifacts(repo) {
  const result = runTool('gh', [
    'api',
    `repos/${repo}/actions/artifacts?per_page=100`,
  ])
  const payload = JSON.parse(result.stdout)
  return payload.artifacts || []
}

function downloadWindowsArtifact(options, names, dest) {
  fs.mkdirSync(dest, { recursive: true })
  let runId = options.runId
  if (!runId) {
    const artifact = pickWindowsArtifact(listArtifacts(resolveRepo()), options.version)
    if (!artifact || !artifact.runId) {
      throw new Error(`GitHub 上没有未过期的 ${names.windowsArtifact}。先跑完 Actions 的 release-build，或改用 --local-dir / --run-id。`)
    }
    runId = String(artifact.runId)
    process.stdout.write(`使用 artifact ${artifact.name}（run ${runId}）\n`)
  }
  runTool('gh', ['run', 'download', String(runId), '-n', names.windowsArtifact, '-D', dest])
  return dest
}

function resolveSearchRoots(options, downloadDir) {
  const roots = []
  if (options.localDir) roots.push(options.localDir)
  if (downloadDir) roots.push(downloadDir)
  if (options.macDir) roots.push(options.macDir)
  roots.push(path.resolve(process.cwd(), `release-${options.version}`))
  return roots
}

async function publishDlLanding(rawOptions = {}, deps = {}) {
  const options = {
    ...parsePublishArgs([], {
      version: rawOptions.version,
      host: rawOptions.host,
      port: rawOptions.port,
      user: rawOptions.user,
      key: rawOptions.key,
      knownHosts: rawOptions.knownHosts,
      remoteRoot: rawOptions.remoteRoot,
    }, rawOptions.sources),
    ...rawOptions,
  }
  // The spread above lets a caller hand in raw values, so every guard runs again on
  // what actually reaches ssh/scp rather than on what parsePublishArgs returned.
  assertPublishTarget(options)
  options.version = assertSafeVersion(options.version)
  options.remoteRoot = assertSafeRemoteRoot(options.remoteRoot)
  const names = installerFileNames(options.version)
  const io = {
    collect: deps.collectInstallers || collectInstallers,
    download: deps.downloadWindowsArtifact || downloadWindowsArtifact,
    run: deps.runTool || runTool,
    writeFile: deps.writeFile || ((filePath, body) => fs.writeFileSync(filePath, body, 'utf8')),
    now: deps.now || (() => Date.now()),
    tmpdir: deps.tmpdir || os.tmpdir,
    cwd: deps.cwd || process.cwd(),
  }

  let downloadDir = ''
  if (!options.localDir) {
    downloadDir = path.join(io.tmpdir(), `xingmang-dl-landing-${options.version}-${io.now()}`)
    io.download(options, names, downloadDir)
  }

  try {
    const found = io.collect(resolveSearchRoots(options, downloadDir), names)
    const missing = missingInstallerMessage(names, found)
    if (missing) throw new Error(missing)
    const plan = buildPublishPlan(options, found, names)
    await printPlan(plan)
    if (!options.yes) {
      process.stdout.write('\n未上传。确认无误后加上 --yes。\n')
      return { uploaded: false, plan, found }
    }

    const verification = await (deps.verifyUploadCandidates || verifyUploadCandidates)(options, plan, deps)

    const sshBase = sshArgs(options)
    const scpBase = scpArgs(options)
    const target = `${options.user}@${options.host}`
    // Only the ssh commands below are quoted: since OpenSSH 9 scp speaks SFTP, where a
    // remote path is taken literally, so quotes there would become part of the directory
    // name. assertSafeRemoteRoot is what keeps the scp destinations safe.
    io.run('ssh', [...sshBase, target, `mkdir -p ${quoteRemotePath(plan.uploads[0].remoteDir)}`])
    io.run('scp', [
      ...scpBase,
      found.win,
      found.macArm64,
      found.macX64,
      `${target}:${plan.uploads[0].remoteDir}/`,
    ])

    const manifestBody = formatLatestJson(plan.manifest)
    const manifestLocal = path.join(io.tmpdir(), `xingmang-latest-${options.version}-${io.now()}.json`)
    io.writeFile(manifestLocal, manifestBody)
    io.run('scp', [...scpBase, manifestLocal, `${target}:${plan.manifestRemote}`])

    const remoteFiles = plan.uploads.map((item) => `${item.remoteDir}/${item.fileName}`)
    const quotedFiles = remoteFiles.map(quoteRemotePath)
    const quotedManifest = quoteRemotePath(plan.manifestRemote)
    io.run('ssh', [
      ...sshBase,
      target,
      `chown www:www ${quotedManifest} ${quotedFiles.join(' ')}`,
    ])
    const remoteCheck = io.run('ssh', [
      ...sshBase,
      target,
      `test -f ${quotedFiles[0]} && test -f ${quotedFiles[1]} && test -f ${quotedFiles[2]} && cat ${quotedManifest}`,
    ])
    const localManifest = path.resolve(io.cwd, 'dl-landing', 'latest.json')
    io.writeFile(localManifest, manifestBody)
    process.stdout.write(`已写入 ${localManifest}\n`)
    process.stdout.write('源站 latest.json：\n')
    process.stdout.write(`${remoteCheck.stdout || ''}`)
    process.stdout.write('上传完成。落地页注册成功后会读这份清单。\n')
    return { uploaded: true, plan, found, verification }
  } finally {
    if (downloadDir && !options.keepDownload) {
      fs.rmSync(downloadDir, { recursive: true, force: true })
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parsePublishArgs(argv)
  if (options.help) {
    process.stdout.write(`${helpText()}\n`)
    return
  }
  await publishDlLanding(options)
}

module.exports = {
  assertSafeVersion,
  assertSafeRemoteRoot,
  assertKnownHostsFile,
  parseExpectedChecksums,
  readExpectedChecksums,
  assertExpectedChecksums,
  verifyUploadCandidates,
  fileSha256,
  quoteRemotePath,
  readPublishConfigFile,
  resolvePublishTarget,
  assertPublishTarget,
  installerFileNames,
  buildLatestManifest,
  formatLatestJson,
  parsePublishArgs,
  collectInstallers,
  missingInstallerMessage,
  pickWindowsArtifact,
  buildPublishPlan,
  helpText,
  publishDlLanding,
  main,
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
