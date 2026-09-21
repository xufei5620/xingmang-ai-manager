// CI-only. 装上 electron/cli-verified-versions.ts 钉住的那个 Claude Code 版本,
// 然后对 relay-sites.ts 里的每个中转站点各跑一次 `claude -p` 最小请求,回答
// 「这个版本在我们自己的中转上还能不能用」。
//
// 为什么非跑真的 CLI 不可:名单要挡的两次上游回归(2.1.265-2.1.267、
// 2.1.275-2.1.276)都是 CLI 自己发出的请求体被第三方端点拒掉,用 curl 手搓一个
// 请求验证不了 —— 出问题的正是 CLI 构造请求的那一段。
//
// The probe key is a real, billable credential. It only ever reaches the CLI
// through the child process environment, never argv (argv is world-readable on
// a shared host), and every line this script prints or writes to the job
// summary goes through redact() first.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const KEY_VARIABLE = 'XINGMANG_CLI_PATROL_KEY'
const PROBE_PROMPT = '回答一个字:好'
const MAX_CAPTURED_BYTES = 16 * 1024
const PROBE_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 300_000

/**
 * 把 TS 源码编译进内存再 require。名单与站点表都是零 Node 依赖模块(I6),
 * 但它们是 TypeScript,.cjs 脚本不能直接 require —— 用仓库已有的 esbuild
 * 打一次,比在这里用正则去抠版本号可靠得多(抠错了这个作业就在测空气)。
 */
function loadTypeScriptModule(entry) {
  const { buildSync } = require(path.join(root, 'node_modules', 'esbuild'))
  const built = buildSync({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-probe-'))
  const file = path.join(directory, 'module.cjs')
  fs.writeFileSync(file, built.outputFiles[0].text, 'utf8')
  try {
    return require(file)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** 密钥永远不许进日志或 job summary。 */
function redact(text, secret) {
  const bounded = String(text).slice(0, MAX_CAPTURED_BYTES)
  if (!secret) return bounded
  return bounded.split(secret).join('***')
}

/**
 * 判定一次探测的结论。只有「请求体被端点拒掉」这一类才算名单要挡的回归;
 * 凭据、额度、网络问题是探测本身坏了,要分开说,不能混成「这个版本不能用」。
 */
function classifyProbe({ code, output }) {
  if (code === 0) return { verdict: 'ok', detail: '请求成功返回' }
  const text = String(output)
  if (/\b400\b|invalid_request_error|Input tag|must be non-empty/i.test(text)) {
    return { verdict: 'rejected', detail: '端点拒绝了 CLI 发出的请求(400 类)' }
  }
  if (/\b401\b|\b403\b|authentication_error|permission_error|invalid api key|无效的令牌/i.test(text)) {
    return { verdict: 'credential', detail: `探测凭据被拒(401/403),请检查仓库 secret ${KEY_VARIABLE}` }
  }
  if (/\b429\b|rate_limit|quota|额度|余额/i.test(text)) {
    return { verdict: 'quota', detail: '探测账号额度或速率受限,这次判定不了版本' }
  }
  if (/\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(text)) {
    return { verdict: 'unreachable', detail: '中转不可达或返回 5xx,这次判定不了版本' }
  }
  return { verdict: 'unknown', detail: `CLI 以退出码 ${code} 结束,原因未归类` }
}

/** 只有 rejected 才让作业变红 —— 那是名单要挡的那一类。其余是探测自身的问题,也要红,但文案不同。 */
function summarize(results) {
  if (results.some((result) => result.verdict === 'rejected')) return { ok: false, headline: '推荐版本在中转上被拒绝,不要合入' }
  if (results.some((result) => result.verdict !== 'ok')) return { ok: false, headline: '探测没能得出结论,见下表' }
  return { ok: true, headline: '推荐版本在每个中转站点上都跑通了' }
}

function runCommand(file, argv, options) {
  return new Promise((resolve) => {
    execFile(file, argv, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: MAX_CAPTURED_BYTES * 4,
      // Never `shell: true` (I1): the base URLs and version come from repository
      // data, but a shell here would make any future caller's input executable.
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        output: `${stdout || ''}${stderr || ''}`,
      })
    })
  })
}

function probeEnvironment(baseUrl, secret, home) {
  // A deliberately narrow environment: the CLI must not inherit the runner's
  // proxy, npm or telemetry settings, and must not pick up a second credential.
  return {
    PATH: process.env.PATH,
    HOME: home,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: secret,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CI: '1',
  }
}

/**
 * 全局安装后 CLI 的绝对路径。不靠 PATH 里正好有一个 `claude`:runner 镜像本来
 * 就可能带一个别的版本,那样这个作业就在测另一个版本。
 */
async function resolveGlobalClaude() {
  const prefix = await runCommand('npm', ['prefix', '--global'], { cwd: root, env: process.env, timeoutMs: 60_000 })
  const directory = prefix.code === 0 ? prefix.output.trim().split('\n').pop().trim() : ''
  const candidate = directory ? path.join(directory, 'bin', 'claude') : ''
  if (candidate && fs.existsSync(candidate)) return candidate
  throw new Error('装完之后找不到 claude 可执行文件')
}

async function probeSite(executable, site, version, secret, model) {
  const baseUrl = site.providerBaseUrls.claude
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-home-'))
  try {
    const result = await runCommand(executable, ['-p', PROBE_PROMPT, '--model', model], {
      cwd: home,
      env: probeEnvironment(baseUrl, secret, home),
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const classified = classifyProbe(result)
    return { siteId: site.id, baseUrl, version, output: redact(result.output, secret), ...classified }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function renderSummary(lines) {
  const text = `${lines.join('\n')}\n`
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text, 'utf8')
  console.log(text)
}

async function main() {
  const { cliVerifiedVersions } = loadTypeScriptModule('electron/cli-verified-versions.ts')
  const { relaySites } = loadTypeScriptModule('electron/relay-sites.ts')
  const { defaultCliModels } = loadTypeScriptModule('electron/cli-model-defaults.ts')
  const recommended = cliVerifiedVersions.claude.recommended

  if (!recommended) {
    renderSummary(['## 中转实测', '', 'Claude Code 目前没有钉住的推荐版本,没有可探测的对象。'])
    return
  }

  const secret = process.env[KEY_VARIABLE]
  if (!secret) {
    renderSummary([
      '## 中转实测',
      '',
      `**未在中转实测** —— 仓库 secret \`${KEY_VARIABLE}\` 不存在。`,
      '',
      `本次只验证了「上游 changelog 里没有与网关/第三方 base URL 相关的回归」，推荐版本 \`${recommended.version}\` **没有**在任何中转站点上跑过真实请求。`,
      `补上这个 secret（一把额度很小的测试 Key）之后，这个作业会自动对 ${relaySites.map((site) => `\`${site.id}\``).join('、')} 各跑一次 \`claude -p\`。`,
      '',
      `名单里这条记录的 \`verifiedSites\` 应为空数组，当前是 \`[${recommended.verifiedSites.join(', ')}]\`。`,
    ])
    return
  }

  const install = await runCommand('npm', [
    'install', '--global', '--registry=https://registry.npmjs.org/',
    `@anthropic-ai/claude-code@${recommended.version}`,
  ], { cwd: root, env: process.env, timeoutMs: INSTALL_TIMEOUT_MS })
  if (install.code !== 0) {
    renderSummary(['## 中转实测', '', `**装不上 \`${recommended.version}\`**，探测中止。`, '', '```', redact(install.output, secret), '```'])
    process.exitCode = 1
    return
  }

  const executable = await resolveGlobalClaude()
  const results = []
  for (const site of relaySites) {
    results.push(await probeSite(executable, site, recommended.version, secret, defaultCliModels.claude))
  }

  const { ok, headline } = summarize(results)
  const lines = [
    '## 中转实测',
    '',
    `**${headline}**`,
    '',
    `探测版本：\`${recommended.version}\`（名单记录的验证日期 ${recommended.verifiedAt}），模型 \`${defaultCliModels.claude}\`。`,
    '',
    '| 站点 | 结论 | 说明 |',
    '| --- | --- | --- |',
    ...results.map((result) => `| \`${result.siteId}\` | ${result.verdict === 'ok' ? '通过' : '未通过'} | ${result.detail} |`),
    '',
    `跑通的站点 id 请写进名单里这条记录的 \`verifiedSites\`，当前是 \`[${recommended.verifiedSites.join(', ')}]\`。`,
  ]
  for (const result of results.filter((entry) => entry.verdict !== 'ok')) {
    lines.push('', `<details><summary><code>${result.siteId}</code> 的输出</summary>`, '', '```', result.output || '(没有输出)', '```', '', '</details>')
  }
  renderSummary(lines)
  if (!ok) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`中转实测脚本异常：${error && error.message ? error.message : error}`)
    process.exitCode = 1
  })
}

module.exports = { classifyProbe, summarize, redact, probeEnvironment, KEY_VARIABLE }
