'use strict'
// 临时检查（Mac 一键装 Codex 桌面端与 Claude Desktop 那条线程，yoyo 2026-10-03 选「用 GitHub」）：
// 只下载两家官方 Mac 包，读包里的身份、系统要求和签名，不安装、不运行。核完连同工作流一起删掉。
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const root = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mac-desktop-check')
const expected = {
  claude: { team: 'Q6L2SF6YDW', bundle: 'com.anthropic.claudefordesktop', app: 'Claude.app' },
  chatgpt: { team: '2DC432GLL2', bundle: 'com.openai.codex', app: 'ChatGPT.app' },
}

function log(title, value) {
  console.log(`\n### ${title}`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function run(executable, argv, timeout = 15 * 60_000) {
  const started = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(executable, argv, {
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', HOME: process.env.HOME || '/tmp' },
    })
    return { code: 0, stdout, stderr, seconds: (Date.now() - started) / 1000 }
  } catch (error) {
    return { code: error.code ?? 'unknown', signal: error.signal ?? null, stdout: error.stdout || '', stderr: error.stderr || String(error.message), seconds: (Date.now() - started) / 1000 }
  }
}

function redact(value) {
  const url = new URL(value)
  return `${url.protocol}//${url.host}${url.pathname}${url.search ? ` (query ${url.search.length} chars)` : ''}`
}

async function follow(url, init = {}) {
  const hops = []
  let current = new URL(url)
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20 * 60_000) })
    hops.push({
      url: redact(current.href),
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      acceptRanges: response.headers.get('accept-ranges'),
      etag: response.headers.get('etag'),
      server: response.headers.get('server'),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, hops }
    await response.body?.cancel()
    current = new URL(response.headers.get('location'), current)
  }
  throw new Error('too many redirects')
}

async function download(url, target) {
  const started = Date.now()
  const { response, hops } = await follow(url)
  if (response.status !== 200) throw new Error(`download HTTP ${response.status}`)
  const hash = crypto.createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target))
  return { hops, bytes, sha256: hash.digest('hex'), seconds: (Date.now() - started) / 1000 }
}

async function rangeProbe(url) {
  // downloadWithResume 断点续传靠 Range；看最终那一跳认不认。
  const { response, hops } = await follow(url, { headers: { Range: 'bytes=100-199' } })
  const status = response.status
  const contentRange = response.headers.get('content-range')
  await response.body?.cancel()
  return { finalHop: hops[hops.length - 1], status, contentRange }
}

async function zipLayout(archive) {
  const short = await run('/usr/bin/zipinfo', ['-1', archive])
  const names = short.stdout.split('\n').filter(Boolean)
  const topLevel = {}
  for (const name of names) {
    const top = name.split('/')[0]
    topLevel[top] = (topLevel[top] || 0) + 1
  }
  const long = await run('/usr/bin/zipinfo', [archive])
  const lines = long.stdout.split('\n')
  const symlinks = lines.filter((line) => line.startsWith('l')).length
  return {
    zipinfoCode: short.code,
    entries: names.length,
    topLevel,
    macosx: names.filter((name) => name.startsWith('__MACOSX/')).length,
    dotUnderscore: names.filter((name) => path.posix.basename(name).startsWith('._')).length,
    absoluteOrParent: names.filter((name) => name.startsWith('/') || name.split('/').includes('..')).length,
    symlinkEntries: symlinks,
    firstEntries: names.slice(0, 5),
    trailer: lines.filter(Boolean).slice(-1)[0],
  }
}

async function symlinkReport(bundle) {
  const found = await run('/usr/bin/find', [bundle, '-type', 'l'])
  const links = found.stdout.split('\n').filter(Boolean)
  let absolute = 0
  let escaping = 0
  const samples = []
  for (const link of links) {
    const target = await fsp.readlink(link)
    const resolved = path.resolve(path.dirname(link), target)
    const outside = !resolved.startsWith(`${bundle}${path.sep}`)
    if (path.isAbsolute(target)) absolute += 1
    if (outside) escaping += 1
    if (samples.length < 6 || outside) samples.push({ link: path.relative(bundle, link), target, outside })
  }
  return { count: links.length, absolute, escaping, samples: samples.slice(0, 12) }
}

function pickSignatureDisplay(stderr) {
  return stderr.split('\n').filter((line) => /^(Identifier|Format|TeamIdentifier|Authority|Timestamp|Runtime Version|CodeDirectory|Signed Time|Notarization)/.test(line))
}

function pinnedRequirement(product) {
  const want = expected[product]
  return [`identifier "${want.bundle}"`, 'anchor apple generic', 'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists', `certificate leaf[subject.OU] = "${want.team}"`].join(' and ')
}

async function inspectBundle(bundle, product) {
  const plistRun = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])
  let plist = {}
  try { plist = JSON.parse(plistRun.stdout) } catch { plist = { parseError: plistRun.stderr } }
  const keys = ['CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable', 'CFBundleShortVersionString', 'CFBundleVersion',
    'LSMinimumSystemVersion', 'LSArchitecturePriority', 'LSRequiresNativeExecution', 'SUFeedURL', 'SUPublicEDKey', 'ElectronAsarIntegrity']
  const info = Object.fromEntries(keys.filter((key) => key in plist).map((key) => [key, key === 'ElectronAsarIntegrity' ? '(present)' : plist[key]]))
  const executable = path.join(bundle, 'Contents', 'MacOS', String(plist.CFBundleExecutable || ''))
  const archs = await run('/usr/bin/lipo', ['-archs', executable])
  const display = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle])
  const verify = await run('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${pinnedRequirement(product)}`, bundle])
  const wrongTeam = await run('/usr/bin/codesign', ['--verify', '--strict', `-R=anchor apple generic and certificate leaf[subject.OU] = "AAAAAAAAAA"`, bundle])
  const gatekeeper = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', bundle])
  const size = await run('/usr/bin/du', ['-sk', bundle])
  const rootXattr = await run('/usr/bin/xattr', [bundle])
  const worldWritable = await run('/usr/bin/find', [bundle, '-perm', '-o+w', '-not', '-type', 'l'])
  return {
    info,
    mainExecutableArchs: archs.stdout.trim() || archs.stderr.trim(),
    signature: pickSignatureDisplay(display.stderr),
    pinnedRequirementExit: verify.code,
    pinnedRequirementSeconds: verify.seconds,
    pinnedRequirementStderr: verify.stderr.trim().split('\n').slice(0, 6),
    wrongTeamExit: wrongTeam.code,
    gatekeeperExit: gatekeeper.code,
    gatekeeperSeconds: gatekeeper.seconds,
    gatekeeper: gatekeeper.stderr.trim().split('\n').slice(0, 6),
    sizeKiB: Number(size.stdout.split(/\s+/)[0]),
    rootXattrs: rootXattr.stdout.trim().split('\n').filter(Boolean),
    worldWritable: worldWritable.stdout.split('\n').filter(Boolean).length,
    symlinks: await symlinkReport(bundle),
  }
}

async function extractAndInspect(label, archive, product) {
  const result = {}
  for (const [tool, executable, argv] of [
    ['bsdtar', '/usr/bin/tar', (target) => ['-xf', archive, '-C', target]],
    ['ditto', '/usr/bin/ditto', (target) => ['-x', '-k', archive, target]],
  ]) {
    const target = path.join(root, `${label}-${tool}`)
    await fsp.mkdir(target, { recursive: true })
    const extracted = await run(executable, argv(target))
    const entries = await fsp.readdir(target)
    const entry = { exit: extracted.code, seconds: extracted.seconds, stderr: extracted.stderr.trim().split('\n').slice(0, 4), topLevel: entries }
    const app = entries.find((name) => name.endsWith('.app'))
    if (app) {
      // 两种解法都要看签名能不能过；身份细节只看 bsdtar 那份（客户端用的是它）。
      entry.bundle = tool === 'bsdtar' ? await inspectBundle(path.join(target, app), product)
        : { pinnedRequirementExit: (await run('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${pinnedRequirement(product)}`, path.join(target, app)])).code }
    }
    result[tool] = entry
    await fsp.rm(target, { recursive: true, force: true })
  }
  return result
}

function summarizeAppcast(text) {
  const withoutNotes = text.replace(/<description>[\s\S]*?<\/description>/g, '<description>…</description>')
    .replace(/<sparkle:releaseNotesLink>[\s\S]*?<\/sparkle:releaseNotesLink>/g, '<sparkle:releaseNotesLink>…</sparkle:releaseNotesLink>')
  const items = [...withoutNotes.matchAll(/<item(?:\s[^<>]*)?>([\s\S]*?)<\/item>/g)].map((match) => match[1])
  return {
    bytes: Buffer.byteLength(text),
    items: items.length,
    head: withoutNotes.slice(0, withoutNotes.indexOf('<item') > 0 ? withoutNotes.indexOf('<item') : 600).slice(0, 1200),
    firstItem: (items[0] || '').slice(0, 4000),
    secondItemHead: (items[1] || '').slice(0, 1200),
  }
}

function latestFullEnclosure(text) {
  const items = [...text.matchAll(/<item(?:\s[^<>]*)?>([\s\S]*?)<\/item>/g)].map((match) => match[1].replace(/<sparkle:deltas(?:\s[^<>]*)?>[\s\S]*?<\/sparkle:deltas>/g, ''))
  const candidates = []
  for (const item of items) {
    const build = /<sparkle:version>\s*([^<\s]+)\s*<\/sparkle:version>/.exec(item)?.[1]
    const short = /<sparkle:shortVersionString>\s*([^<\s]+)\s*<\/sparkle:shortVersionString>/.exec(item)?.[1]
    const minimum = /<sparkle:minimumSystemVersion>\s*([^<\s]+)\s*<\/sparkle:minimumSystemVersion>/.exec(item)?.[1]
    for (const enclosure of item.matchAll(/<enclosure(\s[^<>]*?)\s*\/?>/g)) {
      const attributes = Object.fromEntries([...enclosure[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]))
      if (attributes['sparkle:deltaFrom']) continue
      candidates.push({ build, short, minimum, url: attributes.url, length: Number(attributes.length), type: attributes.type, attributeNames: Object.keys(attributes) })
    }
  }
  candidates.sort((left, right) => Number(right.build) - Number(left.build))
  return candidates[0]
}

async function checkClaude(osVersion) {
  const feedUrl = new URL('https://api.anthropic.com/api/desktop/darwin/arm64/squirrel/update')
  feedUrl.search = new URLSearchParams({ device_id: crypto.randomUUID(), os_version: osVersion }).toString()
  const { response, hops } = await follow(feedUrl.href, { headers: { Accept: 'application/json' } })
  const feedText = await response.text()
  log('Claude feed', { hops, body: JSON.parse(feedText) })
  const feed = JSON.parse(feedText)
  const update = feed.releases.find((entry) => entry.version === feed.currentRelease).updateTo
  log('Claude range support', await rangeProbe(update.url))
  const archive = path.join(root, 'claude.zip')
  const fetched = await download(update.url, archive)
  log('Claude download', { ...fetched, feedSize: update.size, feedSha256: update.sha256, sizeMatches: fetched.bytes === update.size, sha256Matches: fetched.sha256 === update.sha256 })
  log('Claude zip layout', await zipLayout(archive))
  log('Claude extraction', await extractAndInspect('claude', archive, 'claude'))
  await fsp.rm(archive, { force: true })
}

async function checkChatgpt(appcastName, label) {
  const { response, hops } = await follow(`https://persistent.oaistatic.com/codex-app-prod/${appcastName}`)
  const text = await response.text()
  log(`ChatGPT ${label} appcast`, { hops, status: response.status, ...summarizeAppcast(text) })
  const latest = latestFullEnclosure(text)
  log(`ChatGPT ${label} latest full package`, latest)
  log(`ChatGPT ${label} range support`, await rangeProbe(latest.url))
  const archive = path.join(root, `chatgpt-${label}.zip`)
  const fetched = await download(latest.url, archive)
  log(`ChatGPT ${label} download`, { ...fetched, declaredLength: latest.length, lengthMatches: fetched.bytes === latest.length })
  log(`ChatGPT ${label} zip layout`, await zipLayout(archive))
  log(`ChatGPT ${label} extraction`, await extractAndInspect(`chatgpt-${label}`, archive, 'chatgpt'))
  await fsp.rm(archive, { force: true })
}

async function main() {
  await fsp.mkdir(root, { recursive: true })
  const osVersion = (await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim()
  log('Runner', { osVersion, arch: (await run('/usr/bin/uname', ['-m'])).stdout.trim(), gatekeeper: (await run('/usr/sbin/spctl', ['--status'])).stdout.trim(), node: process.version })
  const failures = []
  for (const [name, check] of [
    ['claude', () => checkClaude(osVersion)],
    ['chatgpt-arm64', () => checkChatgpt('appcast.xml', 'arm64')],
    ['chatgpt-x64', () => checkChatgpt('appcast-x64.xml', 'x64')],
  ]) {
    try {
      await check()
    } catch (error) {
      failures.push(name)
      log(`${name} FAILED`, error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
    }
  }
  if (failures.length) {
    console.log(`\nFailed: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}

main()
