const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const packageVersion = require('../package.json').version

const DEFAULT_HOST = '38.147.105.28'
const DEFAULT_PORT = 5620
const DEFAULT_USER = 'root'
const DEFAULT_REMOTE_ROOT = '/www/wwwroot/dl.solov.cc'
const DEFAULT_KEY_NAME = 'solov_fleet_ed25519'
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function assertSafeVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version.trim())) {
    throw new Error(`版本号不合法：${version || '(空)'}。例如 0.1.22`)
  }
  return version.trim()
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

function parsePublishArgs(argv, defaults = {}) {
  const options = {
    version: defaults.version || packageVersion,
    runId: '',
    localDir: '',
    macDir: '',
    yes: false,
    dryRun: false,
    keepDownload: false,
    host: defaults.host || process.env.DL_LANDING_SSH_HOST || DEFAULT_HOST,
    port: Number(defaults.port || process.env.DL_LANDING_SSH_PORT || DEFAULT_PORT),
    user: defaults.user || process.env.DL_LANDING_SSH_USER || DEFAULT_USER,
    key: defaults.key || process.env.DL_LANDING_SSH_KEY || '',
    remoteRoot: defaults.remoteRoot || process.env.DL_LANDING_REMOTE_ROOT || DEFAULT_REMOTE_ROOT,
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
      options.port = Number(argumentValue(argv, index + 1, arg))
      index += 1
    } else if (arg === '--user') {
      options.user = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--key') {
      options.key = argumentValue(argv, index + 1, arg)
      index += 1
    } else if (arg === '--remote-root') {
      options.remoteRoot = argumentValue(argv, index + 1, arg)
      index += 1
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  options.version = assertSafeVersion(options.version)
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port 必须是 1-65535 之间的整数')
  }
  if (options.dryRun) options.yes = false
  return options
}

function defaultSshKey() {
  return path.join(os.homedir(), '.ssh', DEFAULT_KEY_NAME)
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
    '  --dry-run         只打印，不上传',
    '  --yes             确认上传到源站',
    '  --keep-download   保留临时下载目录',
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

function fileSha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function buildPublishPlan(options, files, names) {
  const remoteFiles = `${options.remoteRoot.replace(/\/+$/, '')}/files/latest`
  return {
    uploads: [
      { slot: 'win', local: files.win, remoteDir: remoteFiles, fileName: names.win },
      { slot: 'macArm64', local: files.macArm64, remoteDir: remoteFiles, fileName: names.macArm64 },
      { slot: 'macX64', local: files.macX64, remoteDir: remoteFiles, fileName: names.macX64 },
    ],
    manifest: buildLatestManifest(options.version),
    manifestRemote: `${options.remoteRoot.replace(/\/+$/, '')}/latest.json`,
  }
}

function printPlan(plan) {
  for (const item of plan.uploads) {
    const digest = fileSha256(item.local)
    const size = fs.statSync(item.local).size
    process.stdout.write(`${item.fileName}  ${size} bytes  SHA256=${digest}\n`)
    process.stdout.write(`  ${item.local}\n  -> ${item.remoteDir}/${item.fileName}\n`)
  }
  process.stdout.write(`latest.json -> ${plan.manifestRemote}\n`)
  process.stdout.write(formatLatestJson(plan.manifest))
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

function sshArgs(options) {
  const key = options.key || defaultSshKey()
  if (!fs.existsSync(key)) {
    throw new Error(`找不到 SSH 密钥：${key}`)
  }
  return [
    '-i', key,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
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

function publishDlLanding(rawOptions = {}, deps = {}) {
  const options = {
    ...parsePublishArgs([], {
      version: rawOptions.version,
      host: rawOptions.host,
      port: rawOptions.port,
      user: rawOptions.user,
      key: rawOptions.key,
      remoteRoot: rawOptions.remoteRoot,
    }),
    ...rawOptions,
  }
  options.version = assertSafeVersion(options.version)
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
    printPlan(plan)
    if (!options.yes) {
      process.stdout.write('\n未上传。确认无误后加上 --yes。\n')
      return { uploaded: false, plan, found }
    }

    const sshBase = sshArgs(options)
    const scpBase = scpArgs(options)
    const target = `${options.user}@${options.host}`
    io.run('ssh', [...sshBase, target, `mkdir -p ${plan.uploads[0].remoteDir}`])
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
    io.run('ssh', [
      ...sshBase,
      target,
      `chown www:www ${plan.manifestRemote} ${remoteFiles.join(' ')}`,
    ])
    const remoteCheck = io.run('ssh', [
      ...sshBase,
      target,
      `test -f ${remoteFiles[0]} && test -f ${remoteFiles[1]} && test -f ${remoteFiles[2]} && cat ${plan.manifestRemote}`,
    ])
    const localManifest = path.resolve(io.cwd, 'dl-landing', 'latest.json')
    io.writeFile(localManifest, manifestBody)
    process.stdout.write(`已写入 ${localManifest}\n`)
    process.stdout.write('源站 latest.json：\n')
    process.stdout.write(`${remoteCheck.stdout || ''}`)
    process.stdout.write('上传完成。落地页注册成功后会读这份清单。\n')
    return { uploaded: true, plan, found }
  } finally {
    if (downloadDir && !options.keepDownload) {
      fs.rmSync(downloadDir, { recursive: true, force: true })
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parsePublishArgs(argv)
  if (options.help) {
    process.stdout.write(`${helpText()}\n`)
    return
  }
  publishDlLanding(options)
}

module.exports = {
  assertSafeVersion,
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
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
