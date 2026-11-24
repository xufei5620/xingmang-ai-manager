// CI 里真开的星芒不连正式环境：把星芒自己的线上域名在这台 runner 的 hosts 里指回本机，再逐个解析一遍，
// 确认真的指回来了才放后面的步骤跑。要真开星芒（装好的包，或 `electron .`）的 CI 作业在 `npm ci` 之后跑它：
//
//   node scripts/ci-block-production-hosts.cjs
//
// 为什么要断：服务端 2026-11-21 核对装机量，24 小时里有 275 台「Linux 电脑」只请求了 xm.solov.cc 的
// /api/status，来源 IP 全在 GitHub Actions 的地址段里，就是 quality 里装好 deb 再真开的那几步（一天上百次）；
// Windows、Mac 作业里没断网的真开（renderer-v2-native、装好的包冒烟）也一样会被数进去。星芒一打开就查账号站
// 的公开状态、读更新目录的状态文件，自己的冒烟没有一个需要正式环境，所以整台 runner 上一起断。
//
// 断哪些：账号站、两条线路、更新目录这些「星芒自己的线上服务」，从客户端源码里按域名找出来
// （productionDomains 下面的全部名字），新加一个线上地址不用回来改这里。npm、GitHub、Playwright 的下载
// 都不在这两个域名下，照常能用。客户端代码里有一个直连线路的 IP（38.147.105.28），那只用来认出老配置、
// 从来不往它发请求（relay-sites.ts 的 aliases），所以不需要另外挡。
//
// 指回本机以后那里没有服务在听，客户端连过去当场被拒，跟客户断网时看到的一样。万一哪条请求还是出去了，
// 客户端在 CI 里发的请求 UA 末尾带「 ci」（electron/ci-user-agent.ts），服务端能认出来剔掉。
//
// 只在 GitHub 托管的一次性 runner 上跑：改的是整台机器的 hosts，跑完不撤，runner 用完整台丢掉。
const { spawnSync } = require('node:child_process')
const dns = require('node:dns')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
// 星芒自己的线上服务都在这两个域名下：账号站和线路是 solov.cc，更新目录是 shenfengwl.fun。
// electron/third-party-user-agent.ts 只对这两个域名（和自家存储桶）带完整的 UA，两边由它的测试核对一致。
const productionDomains = Object.freeze(['solov.cc', 'shenfengwl.fun'])
// 客户端自己的源码：主进程、出货的渲染层，加上打包时写进 app-update.yml 的更新地址。
const clientSourceDirectories = Object.freeze(['electron', path.join('src', 'renderer-v2')])
const clientSourceFiles = Object.freeze(['electron-builder.config.cjs', path.join('scripts', 'update-release-utils.cjs')])
const clientSourceExtensions = new Set(['.ts', '.tsx', '.cjs', '.mjs', '.js'])
const HOSTS_BLOCK_BEGIN = '# xingmang-ci-production-block begin'
const HOSTS_BLOCK_END = '# xingmang-ci-production-block end'
// Mac 改完 hosts 到系统解析认它，平时问第一遍就认了；upgrade-smoke 在 10-28 碰到过一整遍都还解析到外面，
// 所以没生效就重写一遍再问，给够一分钟。
const settleBudgetMs = 60 * 1000
const pollMs = 2000

function isTestSource(fileName) {
  return /\.test(?:-support)?\.[cm]?[jt]sx?$/.test(fileName) || /\.browser\.test\./.test(fileName)
}

function listSourceFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      // 渲染层的测试夹具（testing/、__fixtures__/）不进客户端，里面的假地址不算。
      if (entry.name === 'node_modules' || entry.name === 'testing' || entry.name.startsWith('__')) continue
      files.push(...listSourceFiles(entryPath))
    } else if (entry.isFile() && clientSourceExtensions.has(path.extname(entry.name)) && !isTestSource(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

/** 一段文本里出现的、在 productionDomains 下面的主机名（含域名本身），小写去重排好序。 */
function extractProductionHosts(texts, domains = productionDomains) {
  const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
  const escaped = domains.map((domain) => domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // 前面不能紧挨着字母数字、点或连字符，否则 evil-xm.solov.cc 这类拼接会被截成别的名字。
  const pattern = new RegExp(`(?<![a-z0-9.-])((?:${label}\\.)*(?:${escaped.join('|')}))(?![a-z0-9-])`, 'gi')
  const hosts = new Set()
  for (const text of texts) {
    for (const match of String(text).matchAll(pattern)) hosts.add(match[1].toLowerCase())
  }
  return [...hosts].sort()
}

function collectProductionHosts(repositoryRoot = root) {
  const files = [
    ...clientSourceDirectories.flatMap((directory) => listSourceFiles(path.join(repositoryRoot, directory))),
    ...clientSourceFiles.map((file) => path.join(repositoryRoot, file)),
  ]
  return extractProductionHosts(files.map((file) => fs.readFileSync(file, 'utf8')))
}

function removeHostsBlock(text) {
  const source = String(text).replace(/\r\n/g, '\n')
  const begin = source.indexOf(`${HOSTS_BLOCK_BEGIN}\n`)
  if (begin === -1) return source
  const end = source.indexOf(`${HOSTS_BLOCK_END}\n`, begin)
  if (end === -1) throw new Error('hosts 文件里上次加的那段没有结尾，不敢动')
  return source.slice(0, begin) + source.slice(end + HOSTS_BLOCK_END.length + 1)
}

/** 在 hosts 文本末尾加上（或换掉）这一段：每个名字同时指到 IPv4 和 IPv6 的本机，哪一族都解析不到外面。 */
function addHostsBlock(text, hosts) {
  const base = removeHostsBlock(text)
  const lines = hosts.flatMap((host) => [`127.0.0.1 ${host}`, `::1 ${host}`])
  const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n'
  return `${base}${separator}${HOSTS_BLOCK_BEGIN}\n${lines.join('\n')}${lines.length ? '\n' : ''}${HOSTS_BLOCK_END}\n`
}

function isLoopbackAddress(address) {
  return /^127\./.test(address) || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 每个名字都问一遍系统解析，一整遍全是本机才算生效；有漏的就重写一遍（retry）再问，
 * 过了 budgetMs 还漏就报错，后面要真开星芒的步骤一个都不跑。
 */
async function waitUntilBlocked(hosts, { resolve, retry, sleep, budgetMs, pollMs: interval, now = Date.now }) {
  const started = now()
  for (let retries = 0; ; retries += 1) {
    const leaking = []
    for (const host of hosts) {
      const addresses = await resolve(host)
      if (addresses.some((address) => !isLoopbackAddress(address))) leaking.push(host)
    }
    const elapsedMs = now() - started
    if (leaking.length === 0) return { retries, elapsedMs }
    if (elapsedMs >= budgetMs) {
      throw new Error(`hosts 改了，重写 ${retries} 遍、等了 ${Math.round(elapsedMs / 1000)} 秒，这些正式环境的域名还解析到外面：${leaking.join('、')}`)
    }
    retry(leaking)
    await sleep(interval)
  }
}

function run(executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 60_000 })
  if (result.error) throw new Error(`无法运行 ${path.basename(executable)}：${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${path.basename(executable)} 失败（退出码 ${result.status}）：${`${result.stderr || ''}${result.stdout || ''}`.trim().slice(-2000)}`)
  }
  return result
}

function windowsSystemPath(...segments) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...segments)
}

// 三个系统各自的 hosts 位置和「让解析马上认新文件」的办法。Mac 的 mDNSResponder 看到文件被写才重读，
// HUP 只清它自己的缓存，dscacheutil 清掉前面那一层（同 upgrade-smoke.cjs 的 installMacHostsFile）。
function installHostsFile(text, platform = process.platform) {
  if (platform === 'win32') {
    fs.writeFileSync(windowsSystemPath('drivers', 'etc', 'hosts'), text.replace(/\n/g, '\r\n'), 'utf8')
    run(windowsSystemPath('ipconfig.exe'), ['/flushdns'], { allowFailure: true })
    return
  }
  const staged = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ci-hosts-')), 'hosts')
  fs.writeFileSync(staged, text, 'utf8')
  run('/usr/bin/sudo', ['-n', '/bin/cp', staged, '/etc/hosts'])
  if (platform === 'darwin') {
    run('/usr/bin/sudo', ['-n', '/usr/bin/dscacheutil', '-flushcache'], { allowFailure: true })
    run('/usr/bin/sudo', ['-n', '/usr/bin/killall', '-HUP', 'mDNSResponder'], { allowFailure: true })
  }
}

function readHostsFile(platform = process.platform) {
  return fs.readFileSync(platform === 'win32' ? windowsSystemPath('drivers', 'etc', 'hosts') : '/etc/hosts', 'utf8')
}

async function resolveAddresses(host) {
  const results = await dns.promises.lookup(host, { all: true }).catch(() => [])
  return results.map((result) => result.address)
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('这一步改的是整台机器的 hosts，只能在 GitHub 托管的一次性 runner 上跑')
  }
  const hosts = collectProductionHosts()
  if (hosts.length === 0) throw new Error('客户端源码里一个正式环境的域名也没找到，多半是源码目录变了')
  const text = addHostsBlock(readHostsFile(), hosts)
  installHostsFile(text)
  const settled = await waitUntilBlocked(hosts, {
    resolve: resolveAddresses,
    retry: (leaking) => {
      process.stdout.write(`hosts 还没生效，${leaking.length} 个域名解析到外面，重写一遍再问\n`)
      installHostsFile(text)
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    budgetMs: settleBudgetMs,
    pollMs,
  })
  const waited = settled.retries > 0 ? `（解析等了 ${Math.round(settled.elapsedMs / 1000)} 秒、重写 ${settled.retries} 遍才生效）` : ''
  process.stdout.write(`这台 runner 上的星芒连不到正式环境了：${hosts.length} 个域名指回本机、逐个解析过${waited}：${hosts.join('、')}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}

module.exports = {
  HOSTS_BLOCK_BEGIN,
  HOSTS_BLOCK_END,
  addHostsBlock,
  collectProductionHosts,
  extractProductionHosts,
  isLoopbackAddress,
  productionDomains,
  removeHostsBlock,
  waitUntilBlocked,
}
