// 密钥扫描：只扫这次改动新加进来的提交，挡住两类东西。
//
// 仓库是公开的，提交一推上来就等于公开了，所以这道检查管的不是「别让密钥进 main」，
// 而是「推上来的那一刻就告诉人去作废它」。挡合并只是让它没法被当成小事放过去。
//
// 挡的：
//   1. TruffleHog 拿去对方平台核实过、现在还能用的密钥（GitHub、OpenAI、Anthropic、
//      AWS、Cloudflare 等八百多种）。核实不了的不挡：测试里到处是故意写的假值，
//      按样子挡会天天误挡正常的 PR。
//   2. 和星芒 Key 一个样子的字符串（sk- 加 48～64 位字母数字）。星芒 Key 没有外部平台
//      能帮着核实，又是这个项目最可能漏、漏了直接花客户余额的那一种，所以单独按样子挡。
//      加这条规则时（2026-10）把仓库全部分支的全部历史连同 zip 里的文件都扫过一遍，
//      一处都没有，正常 PR 不会被它误挡。
//
// 只提示、不挡的：核实时出了错的（对方平台连不上之类），和私钥。私钥没有接口可以试，
// TruffleHog 说「没核实」只代表它没在 GitHub、GitLab 上开得了门，不代表是假的。
//
// 本机跑：没有 docker 的话，把 XINGMANG_TRUFFLEHOG 设成本机 trufflehog 程序的路径，
// 再按 GitHub 的格式准备好 GITHUB_EVENT_PATH 和 GITHUB_EVENT_NAME。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Pinned by digest, not tag: a tag can be pointed at different bytes after it
// was reviewed, a digest cannot. To move to a newer release, look up the new
// tag's manifest-list digest on ghcr.io and change both constants together;
// the binary copied out of the image has to report this version or the scan
// refuses to run.
const TRUFFLEHOG_VERSION = '3.97.9'
const TRUFFLEHOG_IMAGE = 'ghcr.io/trufflesecurity/trufflehog@sha256:52e67fef4d054ecff5c2ce4b4ae376626d1ef54aa0898b53cac19c25e92e14db'
const TRUFFLEHOG_IN_IMAGE = '/usr/bin/trufflehog'
const PULL_ATTEMPTS = 3

const RELAY_KEY_DETECTOR = 'XingmangRelayKey'
// new-api 签发的 Key 是 sk- 后面 48 位字母数字；上限放到 64，把同类中转站更长的 Key
// 也算进来。OpenAI 的老格式（中间带 T3BlbkFJ）长度也落在这个区间，排除掉交给 TruffleHog
// 自己的 OpenAI 检测去核实：两条规则命中同一串时它会停掉核实，真 Key 反而只剩个「没核实」。
const RELAY_KEY_PATTERN = '\\bsk-[A-Za-z0-9]{48,64}\\b'
const OPENAI_LEGACY_MARKER = 'T3BlbkFJ'

// A private key cannot be tried against an API the way a token can. The
// detector's "unverified" only means it did not open a known door, not that
// the key is dead, so a person has to look at it.
const REVIEW_WHEN_UNVERIFIED = new Set(['PrivateKey'])

const ROTATION_GUIDE = /^https:\/\/howtorotate\.com\/[\w./-]*$/
const COMMIT = /^[0-9a-f]{40}$/i

function scanRange(event, eventName) {
  const pull = eventName === 'pull_request'
  const base = pull ? event?.pull_request?.base?.sha : event?.before
  const head = pull ? event?.pull_request?.head?.sha : event?.after
  if (typeof head !== 'string' || !COMMIT.test(head) || /^0+$/.test(head)) return null
  // A push that creates a branch has an all-zero `before`. Without a lower end
  // the whole history of head is scanned: more than was asked, never less.
  const knownBase = typeof base === 'string' && COMMIT.test(base) && !/^0+$/.test(base)
  return { base: knownBase ? base.toLowerCase() : '', head: head.toLowerCase() }
}

function buildDetectorConfig() {
  return {
    detectors: [{
      name: RELAY_KEY_DETECTOR,
      keywords: ['sk-'],
      regex: { key: RELAY_KEY_PATTERN },
      exclude_regexes_match: [OPENAI_LEGACY_MARKER],
    }],
  }
}

function buildScanArgs({ repository, base, head, configPath }) {
  const args = ['git', `file://${repository}`, '--branch', head]
  // TruffleHog moves this down to the merge base itself, so a base branch that
  // moved on after the pull request was opened still yields only its commits.
  if (base) args.push('--since-commit', base)
  args.push(
    '--json',
    '--results=verified,unknown,unverified',
    // The URI detector "verifies" a URL with credentials in it by sending a
    // request to that URL. Our tests are full of fake ones pointing at the
    // production relay and update hosts, and CI must never send them requests.
    '--exclude-detectors=URI',
    `--config=${configPath}`,
    // Without this a scan that could not read the range still exits 0 with no
    // findings, which would read as a clean pass.
    '--fail-on-scan-errors',
    '--no-update',
  )
  return args
}

function isRelayKeyFinding(result) {
  return result?.DetectorName === 'CustomRegex' && result?.ExtraData?.name === RELAY_KEY_DETECTOR
}

function classifyFinding(result) {
  if (result?.Verified === true) return 'live'
  if (isRelayKeyFinding(result)) return 'relay-key'
  if (typeof result?.VerificationError === 'string' && result.VerificationError) return 'unchecked'
  if (REVIEW_WHEN_UNVERIFIED.has(result?.DetectorName)) return 'unchecked'
  return 'unconfirmed'
}

// Everything printed comes from here, and nothing here reads the secret
// itself (Raw, RawV2, Redacted, SecretParts) or the verifier's error text,
// which can carry the request URL and with it a key passed as a query
// parameter.
function describeFinding(result) {
  const git = result?.SourceMetadata?.Data?.Git ?? {}
  const guide = result?.ExtraData?.rotation_guide
  return {
    kind: classifyFinding(result),
    detector: isRelayKeyFinding(result) ? '星芒 Key' : String(result?.DetectorName || '未知类型'),
    // The path comes from the pull request. A line break in a file name would
    // start a new log line, and the runner reads a log line that starts with
    // `::` as a workflow command.
    file: typeof git.file === 'string' ? git.file.replace(/[\u0000-\u001f\u007f]/g, '?') : '',
    line: Number.isInteger(git.line) && git.line > 0 ? git.line : 0,
    commit: typeof git.commit === 'string' && COMMIT.test(git.commit) ? git.commit.slice(0, 7).toLowerCase() : '',
    rotationGuide: typeof guide === 'string' && ROTATION_GUIDE.test(guide) ? guide : '',
  }
}

function where(finding) {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '位置不明'
  return finding.commit ? `${location}（提交 ${finding.commit}）` : location
}

function findingMessage(finding) {
  if (finding.kind === 'live') {
    return {
      title: `发现还能用的 ${finding.detector} 密钥`,
      text: `这把 ${finding.detector} 密钥经对方平台核实现在还能用。仓库是公开的，推上来就已经泄露：`
        + `先去 ${finding.detector} 那边作废它、换一把新的，再从代码里拿掉。光删掉或改写提交不够，旧提交别人照样看得到。`
        + (finding.rotationGuide ? `作废办法：${finding.rotationGuide}` : ''),
    }
  }
  if (finding.kind === 'relay-key') {
    return {
      title: '发现星芒 Key',
      text: '这里有一串和星芒 Key 一个样子的字符串。是真 Key 的话它已经公开了：先在星芒账号的 Key 管理里删掉它、'
        + '换一把新的，再从代码里拿掉。是测试用的假值的话，在这一行末尾加注释 trufflehog:ignore，'
        + '或者写成不像真 Key 的样子（比如中间带短横线）。',
    }
  }
  return {
    title: `有一处疑似 ${finding.detector} 密钥没能核实`,
    text: `这里像是一把 ${finding.detector} 密钥，这次没能确认真假，所以没挡合并。请人看一眼：是真的就先作废再拿掉。`,
  }
}

function escapeData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function escapeProperty(value) {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

function annotation(level, finding) {
  const { title, text } = findingMessage(finding)
  const properties = [
    finding.file ? `file=${escapeProperty(finding.file)}` : '',
    finding.line ? `line=${finding.line}` : '',
    `title=${escapeProperty(title)}`,
  ].filter(Boolean).join(',')
  const commit = finding.commit ? `（提交 ${finding.commit}）` : ''
  return `::${level} ${properties}::${escapeData(`${text}${commit}`)}`
}

function parseResults(stdout) {
  const results = []
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue
    let result
    try {
      result = JSON.parse(line)
    } catch {
      // Never echo the line: it is scanner output and may hold a secret.
      throw new Error('TruffleHog 的输出里有一行读不懂，没法判断结果，不能当作通过。')
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('TruffleHog 的输出格式不对，没法判断结果，不能当作通过。')
    }
    results.push(result)
  }
  return results
}

function scanErrors(stderr) {
  const errors = []
  for (const line of String(stderr).split(/\r?\n/)) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.level !== 'error') continue
    const detail = Array.isArray(entry.errors) ? entry.errors.join('；') : entry.error
    errors.push(`${entry.msg ?? '扫描出错'}${detail ? `：${detail}` : ''}`.slice(0, 500))
  }
  return errors
}

function buildReport(results) {
  const findings = results.map(describeFinding)
  return {
    blocking: findings.filter((finding) => finding.kind === 'live' || finding.kind === 'relay-key'),
    unchecked: findings.filter((finding) => finding.kind === 'unchecked'),
    unconfirmed: findings.filter((finding) => finding.kind === 'unconfirmed'),
  }
}

function reportLines(report, scope) {
  const lines = []
  if (report.blocking.length) {
    lines.push(`${scope}里发现 ${report.blocking.length} 处必须处理的密钥，这次改动不能合并：`)
    for (const finding of report.blocking) {
      lines.push(`- ${where(finding)}：${finding.detector}。${findingMessage(finding).text}`)
    }
  } else {
    lines.push(`已扫${scope}：没发现还能用的密钥，也没有星芒 Key。`)
  }
  if (report.unchecked.length) {
    lines.push(`有 ${report.unchecked.length} 处疑似密钥没能核实，不挡合并，请人看一眼：`)
    for (const finding of report.unchecked) lines.push(`- ${where(finding)}：${finding.detector}`)
  }
  if (report.unconfirmed.length) {
    lines.push(`另有 ${report.unconfirmed.length} 处像密钥的写法，对方平台说是假的或没法核实（多半是测试里故意写的假值），不挡合并：`)
    for (const finding of report.unconfirmed) lines.push(`- ${where(finding)}：${finding.detector}`)
  }
  return lines
}

function tail(text) {
  const trimmed = String(text || '').trim()
  return trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? String(result.error.message) : (result.stderr ?? ''),
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// The binary is copied out of the pinned image and run on the runner itself,
// rather than run inside the container: the image's entrypoint re-splits its
// last argument through `bash -c`, and natively the checkout needs no
// safe.directory override because its owner is the one scanning it.
async function installTrufflehog({ run = defaultRun, directory, wait = delay }) {
  for (let attempt = 1; ; attempt += 1) {
    const pulled = run('docker', ['pull', TRUFFLEHOG_IMAGE])
    if (pulled.status === 0) break
    // No status means docker itself could not be started, and a second try
    // will not start it either.
    if (pulled.status === null) {
      throw new Error(`这台机器上运行不了 docker，取不到 TruffleHog，这次没扫，不能当作通过：${tail(pulled.stderr)}`)
    }
    if (attempt >= PULL_ATTEMPTS) {
      throw new Error(`拉取 TruffleHog 镜像失败（试了 ${PULL_ATTEMPTS} 次），这次没扫，不能当作通过：${tail(pulled.stderr)}`)
    }
    await wait(attempt * 10_000)
  }
  const created = run('docker', ['create', TRUFFLEHOG_IMAGE])
  const container = String(created.stdout).trim()
  if (created.status !== 0 || !/^[0-9a-f]{12,64}$/.test(container)) {
    throw new Error(`没能从 TruffleHog 镜像建出容器，这次没扫，不能当作通过：${tail(created.stderr)}`)
  }
  const binary = path.join(directory, 'trufflehog')
  try {
    const copied = run('docker', ['cp', `${container}:${TRUFFLEHOG_IN_IMAGE}`, binary])
    if (copied.status !== 0) {
      throw new Error(`没能从 TruffleHog 镜像里取出程序，这次没扫，不能当作通过：${tail(copied.stderr)}`)
    }
  } finally {
    run('docker', ['rm', container])
  }
  const version = run(binary, ['--version'])
  const reported = `${version.stdout}${version.stderr}`
  if (version.status !== 0 || !new RegExp(`\\b${TRUFFLEHOG_VERSION.replaceAll('.', '\\.')}\\b`).test(reported)) {
    throw new Error(`镜像里的 TruffleHog 不是钉住的 ${TRUFFLEHOG_VERSION} 版，这次没扫，不能当作通过。`)
  }
  return binary
}

function commitExists(run, repository, commit) {
  return run('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`]).status === 0
}

async function scanNewCommits({ env = process.env, run = defaultRun, log = console.log, wait = delay } = {}) {
  let event
  try {
    event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  } catch {
    throw new Error('读不到这次触发的事件信息，不知道该扫哪些提交，不能当作通过。')
  }
  const range = scanRange(event, env.GITHUB_EVENT_NAME)
  if (!range) throw new Error('事件里没有这次改动的提交范围，不知道该扫哪些提交，不能当作通过。')
  const repository = path.resolve(env.GITHUB_WORKSPACE || process.cwd())
  if (!commitExists(run, repository, range.head)) {
    throw new Error(`检出的代码里找不到要扫的提交 ${range.head.slice(0, 7)}，不能当作通过。`)
  }
  let base = range.base
  if (base && !commitExists(run, repository, base)) {
    log(`检出的代码里找不到起点提交 ${base.slice(0, 7)}，改为把 ${range.head.slice(0, 7)} 的整段历史都扫一遍。`)
    base = ''
  }
  const counted = run('git', ['-C', repository, 'rev-list', '--count', range.head, ...(base ? [`^${base}`] : [])])
  const count = counted.status === 0 ? Number.parseInt(String(counted.stdout).trim(), 10) : Number.NaN
  const known = Number.isInteger(count)
  const scope = base
    ? `这次新加的${known ? ` ${count} 个` : ''}提交`
    : `到 ${range.head.slice(0, 7)} 为止的整段历史${known ? `（${count} 个提交）` : ''}`

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-secret-scan-'))
  try {
    const configPath = path.join(directory, 'detectors.json')
    // JSON is YAML, and TruffleHog reads its config as YAML.
    fs.writeFileSync(configPath, JSON.stringify(buildDetectorConfig()), 'utf8')
    const binary = env.XINGMANG_TRUFFLEHOG || await installTrufflehog({ run, directory, wait })
    const scanned = run(binary, buildScanArgs({ repository, base, head: range.head, configPath }))
    if (scanned.status !== 0) {
      const errors = scanErrors(scanned.stderr)
      throw new Error(`TruffleHog 没扫完（退出码 ${scanned.status ?? '无'}），不能当作通过。${errors.length ? errors.join('\n') : tail(scanned.stderr)}`)
    }
    const report = buildReport(parseResults(scanned.stdout))
    for (const finding of report.blocking) log(annotation('error', finding))
    for (const finding of report.unchecked) log(annotation('warning', finding))
    const lines = reportLines(report, scope)
    for (const line of lines) log(line)
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### 密钥扫描\n\n${lines.join('\n')}\n`, 'utf8')
    }
    return report
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

if (require.main === module) {
  scanNewCommits().then((report) => {
    if (report.blocking.length) process.exitCode = 1
  }, (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  TRUFFLEHOG_IMAGE,
  TRUFFLEHOG_VERSION,
  RELAY_KEY_PATTERN,
  scanRange,
  buildDetectorConfig,
  buildScanArgs,
  classifyFinding,
  describeFinding,
  findingMessage,
  annotation,
  parseResults,
  scanErrors,
  buildReport,
  reportLines,
  installTrufflehog,
  scanNewCommits,
}
