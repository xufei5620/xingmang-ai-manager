// 主链路冒烟：星芒写给客户的那份 CLI 配置，真的 CLI 读了还能不能说出第一句话。
//
// 为什么要有（0.2.24 深查·测试和CI CV-1）：「星芒写配置 → 客户在终端里敲 claude / codex / grok →
// 请求到中转」是产品的命根子，可在这之前 CI 里没有一道真跑。配置文本有大量单测，但单测只证明
// 「写出来的字跟预期一样」，证明不了「这一版 CLI 还认这些字」；中转实测（probe-cli-relay.cjs）
// 要真密钥、只在改版本名单时跑，用的还是手写的配置，也不测 Grok。
//
// 这里的做法：
// 1. 从 npm 官方源装 electron/cli-verified-versions.ts 钉住的每个 CLI（只装包，不碰中转）。
// 2. 用主进程真正写配置的那个函数（config-files.ts 的 saveProviderConfig，参数照
//    config-save-service.ts 登录后自动写的那一笔：merge、状态行、提醒钩子、Codex 型号名单）
//    把配置写进一个临时主目录，地址照常是两个站的正式地址。
// 3. 写完只做一件事：把文件里的站点地址换成本机假中转的地址（cli-config-smoke-relay.cjs），
//    别的一个字不动。换不到就说明配置里根本没写当前账号的地址，直接算失败。
// 4. 用干净的环境（不带任何 ANTHROPIC_* / OPENAI_* / 代理变量）跑一句话，断言：正常退出、
//    打出了假中转的回答、对话请求送到了假中转、带的是写进去的那把密钥、型号是配置里那个、
//    WebSocket 没发 new-api 不认的消息。
// 5. 加 --compare-with <git 引用> 时，那个引用上钉的版本和现在不一样的工具，旧版本也照样跑一遍，
//    把两版发出去的请求（路径、请求头名、beta 标记、请求体字段、WebSocket 消息类型）列成差异表。
//    差异只报不拦：新冒出来的东西就是要到真中转上重点看的（建议第 3 条：抬版新旧对照）。
//
// Every request goes to 127.0.0.1. The key written into the config is a fixed
// fake string; no environment variable from the runner reaches the CLI, so a
// stray ANTHROPIC_BASE_URL or OPENAI_API_KEY cannot quietly redirect a run (or
// rescue a config that no longer works). Commands run through execFile with
// argv arrays, never a shell (AGENTS.md I1).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, execFileSync } = require('node:child_process')
const { startFakeRelay, isModelRequest } = require('./cli-config-smoke-relay.cjs')

const root = path.resolve(__dirname, '..')
// 假密钥：长得像中转的 sk- 密钥，好让写配置那一步的格式检查照常走，但谁都不认。
const FAKE_KEY = 'sk-xingmang-smoke-0000000000000000000000000000'
const REPLY_TEXT = 'xingmang-smoke-ok'
const PROMPT = '回答一个字：好'
const RUN_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 300_000
const INSTALL_ATTEMPTS = 3
const MAX_CAPTURED_BYTES = 64 * 1024
const CACHE_DIRECTORY = path.join(root, 'node_modules', '.cache', 'xingmang-cli-config-smoke')

// 主进程里写配置要用到的全部东西。打成一份 CommonJS 放进 node_modules/.cache：
// 第三方包（@iarna/toml、jsonc-parser）留成 require，从仓库的 node_modules 里找。
const APP_MODULE_ENTRY = [
  "export { saveProviderConfig } from './electron/config-files'",
  "export { relaySites, relaySiteEndpointChoices } from './electron/relay-sites'",
  "export { defaultCliModels } from './electron/cli-model-defaults'",
  "export { cliVerifiedVersions } from './electron/cli-verified-versions'",
  "export { activeProviderIds, cliCatalog } from './electron/catalog'",
  "export { resolveClaudeStatusLineScriptPath, buildClaudeStatusLineCommand } from './electron/claude-status-line'",
  "export { resolveCliHookScriptPath, buildCliHookInvocation, cliHookEventsDirectory } from './electron/cli-hooks'",
  "export { resolveBundledCodexModelCatalogPath, readBundledCodexModelCatalog, buildCodexRelayModelCatalog, codexModelCatalogListsModel, codexModelCatalogContent, codexCliAcceptsModelCatalog } from './electron/codex-model-catalog'",
].join('\n')

/** 每个工具怎么跑一句话。都是一次性的无界面模式，答完就退。 */
const cliRunners = {
  claude: { argv: () => ['-p', PROMPT] },
  // --skip-git-repo-check：临时目录不是 git 仓库，不给这个标志 codex 直接拒跑。
  codex: { argv: () => ['exec', '--skip-git-repo-check', PROMPT] },
  grok: { argv: () => ['-p', PROMPT] },
}

function bundleToCache(name, contents, resolveDir) {
  const { buildSync } = require(path.join(root, 'node_modules', 'esbuild'))
  const built = buildSync({
    stdin: { contents, resolveDir, loader: 'ts', sourcefile: `${name}.ts` },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    packages: 'external',
  })
  fs.mkdirSync(CACHE_DIRECTORY, { recursive: true })
  const file = path.join(CACHE_DIRECTORY, `${name}-${process.pid}.cjs`)
  fs.writeFileSync(file, built.outputFiles[0].text, 'utf8')
  try {
    return require(file)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function loadAppModules() {
  return bundleToCache('app', APP_MODULE_ENTRY, root)
}

/** 某个 git 引用上钉的推荐版本。只读这一个文件，写配置的代码仍用现在这份，变的只有 CLI 版本。 */
function loadVersionsAt(ref) {
  if (!/^[\w./-]+$/.test(ref)) throw new Error(`看不懂的 git 引用：${ref}`)
  const source = execFileSync('git', ['show', `${ref}:electron/cli-verified-versions.ts`], { cwd: root, encoding: 'utf8' })
  return bundleToCache('baseline-cli-verified-versions', source, path.join(root, 'electron')).cliVerifiedVersions
}

function runCommand(file, argv, options) {
  return new Promise((resolve) => {
    const child = execFile(file, argv, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: MAX_CAPTURED_BYTES * 8,
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        timedOut: Boolean(error && (error.killed || error.signal)),
        output: `${stdout || ''}${stderr || ''}`.slice(-MAX_CAPTURED_BYTES),
      })
    })
    // Nobody types into these children; an open stdin makes Codex wait for input.
    if (child.stdin) child.stdin.end()
  })
}

/** 装一个 CLI 的指定版本到自己的目录里，返回可执行文件。不装全局：机器上原有的那份不该被测到。 */
async function installCli(definition, version, installRoot) {
  const prefix = path.join(installRoot, `${definition.id}-${version}`)
  const executable = path.join(prefix, 'node_modules', '.bin', definition.command)
  if (fs.existsSync(executable)) return executable
  let last = null
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    last = await runCommand('npm', [
      'install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/',
      '--prefix', prefix, `${definition.packageName}@${version}`,
    ], { cwd: root, env: process.env, timeoutMs: INSTALL_TIMEOUT_MS })
    if (last.code === 0 && fs.existsSync(executable)) return executable
  }
  throw new Error(`装不上 ${definition.name} ${version}：\n${last ? last.output.slice(-2000) : ''}`)
}

/**
 * 照 config-save-service.ts 登录后自动写的那一笔调 saveProviderConfig：merge、账号能用的型号、
 * Claude 的状态行、三家的提醒钩子、Codex 的型号名单。状态行和钩子指向仓库里随包的那两个脚本，
 * node 用跑这个脚本的这一份（客户那边是星芒托管的那份）。
 */
function writeCustomerConfig(app, provider, site, home) {
  const model = app.defaultCliModels[provider]
  const availableModels = [model]
  const roots = { userHome: home, codexHome: path.join(home, '.codex') }
  const node = process.execPath
  const statusLineScript = app.resolveClaudeStatusLineScriptPath(root)
  const statusLine = provider === 'claude' && statusLineScript
    ? app.buildClaudeStatusLineCommand(node, statusLineScript) || undefined
    : undefined
  const hookScript = app.resolveCliHookScriptPath(root)
  const cliHook = hookScript
    ? app.buildCliHookInvocation(node, hookScript, app.cliHookEventsDirectory(path.join(home, 'xingmang-data')), process.platform) || undefined
    : undefined
  let codexModelCatalog
  if (provider === 'codex') {
    const official = app.readBundledCodexModelCatalog(app.resolveBundledCodexModelCatalogPath(root))
    const catalog = app.buildCodexRelayModelCatalog(official, availableModels)
    codexModelCatalog = catalog && app.codexModelCatalogListsModel(catalog, model) ? app.codexModelCatalogContent(catalog) : null
  }
  const result = app.saveProviderConfig(provider, FAKE_KEY, model, 'merge', roots, {}, site.providerBaseUrls,
    statusLine, availableModels, cliHook, codexModelCatalog, {})
  return { model, files: result.files.map((file) => (typeof file === 'string' ? file : file.path)) }
}

/** 把文本里出现的这几个 origin 全换成 target，返回新文本和换了几处。 */
function swapOrigins(text, origins, target) {
  let count = 0
  let next = text
  for (const origin of origins) {
    const parts = next.split(origin)
    count += parts.length - 1
    next = parts.join(target)
  }
  return { text: next, count }
}

/** 写好的配置里，把这个站的正式地址换成假中转。返回一共换了几处。 */
function pointConfigAtRelay(files, siteBaseUrls, target) {
  const origins = [...new Set(Object.values(siteBaseUrls).map((url) => new URL(url).origin))]
  let total = 0
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const swapped = swapOrigins(fs.readFileSync(file, 'utf8'), origins, target)
    if (swapped.count === 0) continue
    fs.writeFileSync(file, swapped.text, 'utf8')
    total += swapped.count
  }
  return total
}

/** 两个站全部线路（含别名）的主机名。换完地址以后配置里还剩哪一个，就不能跑：会对线上发请求。 */
function productionHosts(app) {
  const hosts = new Set()
  for (const site of app.relaySites) {
    for (const url of Object.values(site.providerBaseUrls)) hosts.add(new URL(url).host)
    for (const endpoint of app.relaySiteEndpointChoices(site.id)) {
      for (const origin of [endpoint.origin, ...(endpoint.aliases || [])]) hosts.add(new URL(origin).host)
    }
  }
  return [...hosts]
}

/** 这几个文件里还出现了哪些主机名。 */
function leftoverHosts(files, hosts) {
  const found = new Set()
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const host of hosts) if (text.includes(host)) found.add(host)
  }
  return [...found]
}

/**
 * 跑 CLI 的环境：只有 PATH、HOME 和语言。容器、runner 上的 ANTHROPIC_*、OPENAI_*、代理变量
 * 一个都不带，CLI 能用的只有星芒写的那份配置。
 */
function cliEnvironment(home, { isRoot = typeof process.getuid === 'function' && process.getuid() === 0 } = {}) {
  const env = {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    LANG: 'C.UTF-8',
  }
  // 云端容器里是 root。Claude Code 在 root 下不肯用星芒写的「免确认」权限模式，除非声明这是沙箱；
  // CI 的 runner 不是 root，不会走到这里，客户也不会。
  if (isRoot) env.IS_SANDBOX = '1'
  return env
}

function modelsOf(entry) {
  return entry.transport === 'websocket' ? entry.models : [entry.model].filter(Boolean)
}

/** 一次运行算不算过。返回发现的问题，空数组就是过了。 */
function judgeRun(result, requests, expectedModel, timeoutMs = RUN_TIMEOUT_MS) {
  const problems = []
  if (result.timedOut) problems.push(`${timeoutMs / 1000} 秒内没跑完，被强制结束`)
  else if (result.code !== 0) problems.push(`退出码 ${result.code}`)
  const modelRequests = requests.filter(isModelRequest)
  if (modelRequests.length === 0) {
    problems.push('没有一条对话请求送到假中转：CLI 没认配置里的地址')
  } else {
    if (modelRequests.some((entry) => entry.credential !== 'expected')) problems.push('对话请求带的不是星芒写进配置的那把密钥')
    const models = [...new Set(modelRequests.flatMap(modelsOf))]
    const wrong = models.filter((model) => model !== expectedModel)
    if (wrong.length > 0) problems.push(`请求里的型号是 ${wrong.join('、')}，配置里写的是 ${expectedModel}`)
  }
  const rejected = [...new Set(requests.flatMap((entry) => entry.rejectedTypes || []))]
  if (rejected.length > 0) problems.push(`WebSocket 发了中转不认的消息：${rejected.join('、')}`)
  if (!result.timedOut && result.code === 0 && !String(result.output).includes(REPLY_TEXT)) problems.push('输出里没有假中转的回答')
  return problems
}

/** 一次运行发出去的请求长什么样，只留不随每次运行变的那部分。 */
function requestShape(requests) {
  const union = (values) => [...new Set(values)].sort()
  return {
    endpoints: union(requests.map((entry) => `${entry.transport} ${entry.method} ${entry.path}`)),
    headers: union(requests.flatMap((entry) => entry.headers)),
    anthropicBeta: union(requests.flatMap((entry) => entry.anthropicBeta)),
    openaiBeta: union(requests.flatMap((entry) => entry.openaiBeta)),
    featureFlags: union(requests.flatMap((entry) => entry.featureFlags || [])),
    bodyKeys: union(requests.filter(isModelRequest).flatMap((entry) => entry.bodyKeys.map((key) => `${entry.path} ${key}`))),
    websocketTypes: union(requests.flatMap((entry) => entry.messageTypes || [])),
  }
}

const shapeLabels = {
  endpoints: '路径',
  headers: '请求头',
  anthropicBeta: 'anthropic-beta',
  openaiBeta: 'OpenAI-Beta',
  featureFlags: '功能标记',
  bodyKeys: '请求体字段',
  websocketTypes: 'WebSocket 消息',
}

/** 两份请求形状的差别。只列有变化的项。 */
function diffShapes(before, after) {
  const changes = []
  for (const field of Object.keys(shapeLabels)) {
    const previous = new Set(before[field] || [])
    const next = new Set(after[field] || [])
    const added = [...next].filter((value) => !previous.has(value))
    const removed = [...previous].filter((value) => !next.has(value))
    if (added.length || removed.length) changes.push({ field, label: shapeLabels[field], added, removed })
  }
  return changes
}

async function smokeOnce({ app, relay, provider, site, executable, workRoot }) {
  const home = fs.mkdtempSync(path.join(workRoot, `home-${provider}-`))
  const workspace = fs.mkdtempSync(path.join(workRoot, `workspace-${provider}-`))
  const written = writeCustomerConfig(app, provider, site, home)
  const swapped = pointConfigAtRelay(written.files, site.providerBaseUrls, relay.origin)
  if (swapped === 0) {
    return { provider, siteId: site.id, model: written.model, problems: ['写出来的配置里没有当前账号的地址'], requests: [], output: '' }
  }
  // 自动化测试绝不对线上发请求（AGENTS.md 第 1 节）：哪个文件里还留着线上地址，宁可不跑。
  const leftover = leftoverHosts(written.files, productionHosts(app))
  if (leftover.length > 0) {
    return { provider, siteId: site.id, model: written.model, problems: [`换完地址以后配置里还留着线上地址 ${leftover.join('、')}，为了不对线上发请求，这一项没有跑`], requests: [], output: '' }
  }
  const start = relay.requests.length
  const result = await runCommand(executable, cliRunners[provider].argv(), {
    cwd: workspace,
    env: cliEnvironment(home),
    timeoutMs: RUN_TIMEOUT_MS,
  })
  const requests = relay.requests.slice(start)
  return {
    provider,
    siteId: site.id,
    model: written.model,
    problems: judgeRun(result, requests, written.model),
    requests,
    output: result.output.split(FAKE_KEY).join('***'),
  }
}

function parseArguments(argv) {
  const options = { compareWith: null, report: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--compare-with') options.compareWith = argv[++index] || null
    else if (value === '--report') options.report = argv[++index] || null
    else throw new Error(`不认识的参数：${value}`)
  }
  return options
}

function renderSummary(lines) {
  const text = `${lines.join('\n')}\n`
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text, 'utf8')
  console.log(text)
}

function codeList(values) {
  return values.map((value) => `\`${value}\``).join('、')
}

async function main() {
  if (process.platform === 'win32') throw new Error('主链路冒烟只在 Linux、macOS 上跑（CI 用的是 Linux）')
  const options = parseArguments(process.argv.slice(2))
  const app = loadAppModules()
  const providers = app.activeProviderIds.filter((provider) => cliRunners[provider] && app.cliVerifiedVersions[provider]?.recommended)
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-config-smoke-'))
  const installRoot = path.join(CACHE_DIRECTORY, 'clis')
  const relay = await startFakeRelay({ key: FAKE_KEY, replyText: REPLY_TEXT })
  const runs = []
  const comparisons = []
  let comparisonError = null
  try {
    for (const provider of providers) {
      const definition = app.cliCatalog[provider]
      const version = app.cliVerifiedVersions[provider].recommended.version
      const executable = await installCli(definition, version, installRoot)
      for (const site of app.relaySites) {
        const run = await smokeOnce({ app, relay, provider, site, executable, workRoot })
        runs.push({ ...run, version })
        console.log(`${definition.name} ${version} @ ${site.id}: ${run.problems.length ? `未通过（${run.problems.join('；')}）` : '通过'}`)
        if (run.problems.length) console.log(run.output.slice(-4000))
      }
    }
    if (options.compareWith) {
      // 对照只报不拦：读不到 base 的名单、装不上旧版本，都只写进 summary，不让作业变红。
      let baseVersions = null
      try {
        baseVersions = loadVersionsAt(options.compareWith)
      } catch (error) {
        comparisonError = `读不到 \`${options.compareWith}\` 上的推荐版本名单，这次没有对照（${String(error && error.message || error).split('\n')[0]}）`
      }
      for (const provider of baseVersions ? providers : []) {
        const current = app.cliVerifiedVersions[provider].recommended.version
        const base = baseVersions[provider] && baseVersions[provider].recommended && baseVersions[provider].recommended.version
        if (!base || base === current) continue
        const definition = app.cliCatalog[provider]
        const site = app.relaySites[0]
        const after = runs.find((run) => run.provider === provider && run.siteId === site.id)
        try {
          const executable = await installCli(definition, base, installRoot)
          const before = await smokeOnce({ app, relay, provider, site, executable, workRoot })
          comparisons.push({
            provider,
            base,
            current,
            baseProblems: before.problems,
            changes: diffShapes(requestShape(before.requests), requestShape(after.requests)),
          })
        } catch (error) {
          comparisons.push({ provider, base, current, baseProblems: [`旧版本没装上：${String(error && error.message || error).split('\n')[0]}`], changes: null })
        }
      }
    }
  } finally {
    await relay.close()
    fs.rmSync(workRoot, { recursive: true, force: true })
  }

  const failed = runs.filter((run) => run.problems.length > 0)
  const lines = [
    '## 主链路冒烟',
    '',
    failed.length === 0
      ? `**星芒写的配置，${providers.map((provider) => app.cliCatalog[provider].name).join('、')} 都读得懂、打得通**（本机假中转，不碰线上）。`
      : '**有工具读了星芒写的配置以后说不出第一句话，不要合入**',
    '',
    '| 工具 | 版本 | 站点 | 型号 | 结论 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...runs.map((run) => `| ${app.cliCatalog[run.provider].name} | \`${run.version}\` | \`${run.siteId}\` | \`${run.model}\` | ${run.problems.length ? '未通过' : '通过'} | ${run.problems.join('；') || '请求带着写进去的密钥和型号送到了假中转，回答打出来了'} |`),
  ]
  for (const run of runs) {
    const shape = requestShape(run.requests)
    if (run.siteId !== app.relaySites[0].id) continue
    lines.push('', `<details><summary>${app.cliCatalog[run.provider].name} ${run.version} 发出去的请求</summary>`, '')
    for (const [field, label] of Object.entries(shapeLabels)) {
      if (shape[field].length) lines.push(`- ${label}：${codeList(shape[field])}`)
    }
    lines.push('', '</details>')
  }
  if (options.compareWith) {
    lines.push('', `### 抬版本：和 \`${options.compareWith}\` 上钉的版本对照`, '')
    if (comparisonError) lines.push(comparisonError)
    else if (comparisons.length === 0) lines.push('推荐版本没变，不用对照。')
    for (const comparison of comparisons) {
      const name = app.cliCatalog[comparison.provider].name
      lines.push(`**${name} \`${comparison.base}\` → \`${comparison.current}\`**${comparison.baseProblems.length ? `（旧版本这次也没跑通：${comparison.baseProblems.join('；')}）` : ''}`, '')
      if (comparison.changes && comparison.changes.length === 0) lines.push('- 发出去的请求长得一样。')
      for (const change of comparison.changes || []) {
        if (change.added.length) lines.push(`- ${change.label} 新多了：${codeList(change.added)}`)
        if (change.removed.length) lines.push(`- ${change.label} 不再有：${codeList(change.removed)}`)
      }
      lines.push('')
    }
    lines.push('差异只报不拦。新多出来的请求头、beta 标记、字段和消息类型，抬版本时要在真中转上重点看（`docs/CLI-VERIFIED-VERSIONS.md`）。')
  }
  renderSummary(lines)
  if (options.report) {
    fs.writeFileSync(options.report, `${JSON.stringify({ runs: runs.map(({ output: _output, ...run }) => run), comparisons }, null, 2)}\n`, 'utf8')
  }
  if (failed.length > 0) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
}

module.exports = {
  FAKE_KEY,
  REPLY_TEXT,
  cliEnvironment,
  diffShapes,
  judgeRun,
  leftoverHosts,
  parseArguments,
  pointConfigAtRelay,
  requestShape,
  swapOrigins,
}
