// CI-only. 装上 electron/cli-verified-versions.ts 钉住的每一个 CLI 版本,然后
// 对 relay-sites.ts 里的每个中转站点各跑一次最小请求,回答「这些版本在我们
// 自己的中转上还能不能用」。
//
// 为什么非跑真的 CLI 不可:名单要挡的三次上游回归(Claude Code 2.1.265-2.1.267、
// 2.1.275-2.1.276,Codex 0.155.0)都是 CLI 自己发出的请求体被第三方端点拒掉,用
// curl 手搓一个请求验证不了 —— 出问题的正是 CLI 构造请求的那一段。连接自检
// (connection-check.ts)也验证不了:它只读模型清单,而 Codex 打的是 /responses、
// Gemini 打的是 /v1beta/models/<model>:streamGenerateContent,请求体天差地别。
//
// The probe key is a real, billable credential. Claude Code and Gemini CLI take
// it from the child process environment; Codex ignores OPENAI_API_KEY for a
// custom model provider (verified against 0.155.1: `auth.header_attached=false`
// with the variable set) and reads $CODEX_HOME/auth.json instead, so its key is
// written 0600 into a per-probe temporary home that is removed in a finally.
// It never reaches argv -- argv is world-readable on a shared host -- and every
// line this script prints or writes to the job summary goes through redact().
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

/** 探测哪几个 CLI,按这个顺序。名单里 recommended 为 null 的会被跳过。 */
const PROBED_PROVIDERS = ['claude', 'codex', 'gemini']

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
 * 凭据、分组、额度、网络问题是探测本身坏了,要分开说,不能混成「这个版本不能用」。
 *
 * 分组这一层是三个工具一起探测之后才出现的:每个 CLI 的托管 Key 绑在各自的
 * new-api 分组上(catalog.ts 的 managedCliKeyProfiles),一把只覆盖 Claude 分组
 * 的巡检 Key 打到 Codex 或 Gemini 上就会被判成「当前分组下无可用渠道」。那不是
 * 版本的问题,报告要说清需要的是一把什么样的 Key。关键词与
 * connection-check.ts 的 groupHints 同源。
 */
function classifyProbe({ code, output }) {
  if (code === 0) return { verdict: 'ok', detail: '请求成功返回' }
  const text = String(output)
  if (/无可用渠道|无可用的渠道|当前分组|no available channel/i.test(text)) {
    return { verdict: 'group', detail: `探测 Key 的分组里没有这个工具的渠道,换一把覆盖该分组的 ${KEY_VARIABLE}` }
  }
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
  return { ok: true, headline: '每个推荐版本在每个中转站点上都跑通了' }
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

/**
 * Codex 的 config.toml。字段与 config-files.ts 的 buildCodexRelayConfigTemplate
 * 一致 —— 探测的价值全在「请求体和客户装到的那一份配置长得一样」,尤其是
 * wire_api 与 model_reasoning_effort:0.155.0 那次回归改的正是请求里的推理摘要。
 */
function codexProbeConfigText(baseUrl, model) {
  return [
    'model_provider = "xingmang"',
    `model = ${JSON.stringify(model)}`,
    `review_model = ${JSON.stringify(model)}`,
    'model_reasoning_effort = "xhigh"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.xingmang]',
    'name = "xingmang"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n')
}

/**
 * 每个 CLI 一条:它的 base URL 从哪来、探测前要在这个临时 HOME 里放什么、
 * 拿什么环境和什么 argv 去跑。每条都刻意窄:CLI 不许继承 runner 的代理、npm、
 * 遥测设置,也不许捡到第二份凭据。
 */
const probeRunners = {
  claude: {
    baseUrlFor: (site) => site.providerBaseUrls.claude,
    prepare: () => {},
    environment: (baseUrl, secret, home) => ({
      PATH: process.env.PATH,
      HOME: home,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: secret,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CI: '1',
    }),
    argv: (model) => ['-p', PROBE_PROMPT, '--model', model],
  },
  codex: {
    baseUrlFor: (site) => site.providerBaseUrls.codex,
    prepare: (home, baseUrl, secret, model) => {
      const codexHome = path.join(home, '.codex')
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(path.join(codexHome, 'config.toml'), codexProbeConfigText(baseUrl, model), 'utf8')
      // 与 config-files.ts 的 buildCodexApiKeyAuth 同形:只有 OPENAI_API_KEY,
      // 不掺 ChatGPT tokens。0600 —— 这是整条链路上密钥唯一一次落盘。
      fs.writeFileSync(path.join(codexHome, 'auth.json'), `${JSON.stringify({ OPENAI_API_KEY: secret })}\n`, { encoding: 'utf8', mode: 0o600 })
    },
    environment: (baseUrl, secret, home) => ({
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CI: '1',
    }),
    // --skip-git-repo-check:临时 HOME 不是 git 仓库,不给这个标志 codex 直接拒跑。
    argv: () => ['exec', '--skip-git-repo-check', '--color', 'never', PROBE_PROMPT],
  },
  gemini: {
    baseUrlFor: (site) => site.providerBaseUrls.gemini,
    prepare: (home) => {
      const geminiHome = path.join(home, '.gemini')
      fs.mkdirSync(geminiHome, { recursive: true })
      // 与 config-files.ts 写给客户的那份同形。ide 关掉:CI 里没有编辑器可接。
      fs.writeFileSync(
        path.join(geminiHome, 'settings.json'),
        `${JSON.stringify({ ide: { enabled: false }, security: { auth: { selectedType: 'gemini-api-key' } } }, null, 2)}\n`,
        'utf8',
      )
    },
    environment: (baseUrl, secret, home) => ({
      PATH: process.env.PATH,
      HOME: home,
      GEMINI_API_KEY: secret,
      GOOGLE_GEMINI_BASE_URL: baseUrl,
      NO_COLOR: '1',
      CI: '1',
    }),
    // --skip-trust:未信任目录下 Gemini 会跳过一部分配置(system-service.ts 同一处
    // 注释);--approval-mode plan 让它只读,探测不该在 runner 上动文件。
    argv: (model) => ['-p', PROBE_PROMPT, '-m', model, '--skip-trust', '--approval-mode', 'plan'],
  },
}

/**
 * 全局安装后 CLI 的绝对路径。不靠 PATH 里正好有一个同名命令:runner 镜像本来
 * 就可能带一个别的版本,那样这个作业就在测另一个版本。
 */
async function resolveGlobalCli(command) {
  const prefix = await runCommand('npm', ['prefix', '--global'], { cwd: root, env: process.env, timeoutMs: 60_000 })
  const directory = prefix.code === 0 ? prefix.output.trim().split('\n').pop().trim() : ''
  const candidate = directory ? path.join(directory, 'bin', command) : ''
  if (candidate && fs.existsSync(candidate)) return candidate
  throw new Error(`装完之后找不到 ${command} 可执行文件`)
}

async function probeSite(provider, executable, site, version, secret, model) {
  const runner = probeRunners[provider]
  const baseUrl = runner.baseUrlFor(site)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-home-'))
  try {
    runner.prepare(home, baseUrl, secret, model)
    const result = await runCommand(executable, runner.argv(model), {
      cwd: home,
      env: runner.environment(baseUrl, secret, home),
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const classified = classifyProbe(result)
    return { provider, siteId: site.id, baseUrl, version, output: redact(result.output, secret), ...classified }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function renderSummary(lines) {
  const text = `${lines.join('\n')}\n`
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text, 'utf8')
  console.log(text)
}

/** 名单里填了推荐版本的那几个工具,按 PROBED_PROVIDERS 的顺序。 */
function pinnedProviders(list) {
  return PROBED_PROVIDERS.filter((provider) => list[provider] && list[provider].recommended)
}

async function main() {
  const { cliVerifiedVersions } = loadTypeScriptModule('electron/cli-verified-versions.ts')
  const { relaySites } = loadTypeScriptModule('electron/relay-sites.ts')
  const { defaultCliModels } = loadTypeScriptModule('electron/cli-model-defaults.ts')
  const { cliCatalog } = loadTypeScriptModule('electron/catalog.ts')
  const providers = pinnedProviders(cliVerifiedVersions)

  if (providers.length === 0) {
    renderSummary(['## 中转实测', '', '名单里目前没有任何钉住的推荐版本,没有可探测的对象。'])
    return
  }

  const skipped = PROBED_PROVIDERS.filter((provider) => !providers.includes(provider))
  const pinnedList = providers
    .map((provider) => `${cliCatalog[provider].name} \`${cliVerifiedVersions[provider].recommended.version}\``)
    .join('、')

  const secret = process.env[KEY_VARIABLE]
  if (!secret) {
    renderSummary([
      '## 中转实测',
      '',
      `**未在中转实测** —— 仓库 secret \`${KEY_VARIABLE}\` 不存在。`,
      '',
      `本次只验证了「上游 changelog 里没有与网关/第三方 base URL 相关的回归」，${pinnedList} **没有**在任何中转站点上跑过真实请求。`,
      `补上这个 secret（一把额度很小的测试 Key）之后，这个作业会对 ${relaySites.map((site) => `\`${site.id}\``).join('、')} 各跑一次真实请求。`,
      '',
      '这把 Key 要能覆盖上面每个工具各自的分组（`catalog.ts` 的 `managedCliKeyProfiles`）；只覆盖其中一个分组时，别的工具会报「分组里没有可用渠道」而不是版本问题。',
      ...(skipped.length ? ['', `名单里还没填推荐版本、因此没有探测的：${skipped.map((provider) => cliCatalog[provider].name).join('、')}。`] : []),
    ])
    return
  }

  const results = []
  for (const provider of providers) {
    const recommended = cliVerifiedVersions[provider].recommended
    const install = await runCommand('npm', [
      'install', '--global', '--registry=https://registry.npmjs.org/',
      `${cliCatalog[provider].packageName}@${recommended.version}`,
    ], { cwd: root, env: process.env, timeoutMs: INSTALL_TIMEOUT_MS })
    if (install.code !== 0) {
      renderSummary(['## 中转实测', '', `**装不上 ${cliCatalog[provider].name} \`${recommended.version}\`**，探测中止。`, '', '```', redact(install.output, secret), '```'])
      process.exitCode = 1
      return
    }
    const executable = await resolveGlobalCli(cliCatalog[provider].command)
    for (const site of relaySites) {
      results.push(await probeSite(provider, executable, site, recommended.version, secret, defaultCliModels[provider]))
    }
  }

  const { ok, headline } = summarize(results)
  const lines = [
    '## 中转实测',
    '',
    `**${headline}**`,
    '',
    `探测对象：${pinnedList}。`,
    ...(skipped.length ? [`名单里还没填推荐版本、因此没有探测的：${skipped.map((provider) => cliCatalog[provider].name).join('、')}。`] : []),
    '',
    '| 工具 | 版本 | 站点 | 结论 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...results.map((result) => `| ${cliCatalog[result.provider].name} | \`${result.version}\` | \`${result.siteId}\` | ${result.verdict === 'ok' ? '通过' : '未通过'} | ${result.detail} |`),
    '',
    '跑通的站点 id 请写进名单里对应那条 `recommended` 的 `verifiedSites`，当前分别是：',
    ...providers.map((provider) => `- ${cliCatalog[provider].name}：\`[${cliVerifiedVersions[provider].recommended.verifiedSites.join(', ')}]\``),
  ]
  for (const result of results.filter((entry) => entry.verdict !== 'ok')) {
    lines.push('', `<details><summary><code>${result.provider}</code> @ <code>${result.siteId}</code> 的输出</summary>`, '', '```', result.output || '(没有输出)', '```', '', '</details>')
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

module.exports = { classifyProbe, summarize, redact, probeRunners, codexProbeConfigText, pinnedProviders, PROBED_PROVIDERS, KEY_VARIABLE }
