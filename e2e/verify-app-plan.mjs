// Pure half of `npm run verify:app`: turns the command line into a plan and the
// recorded steps into a report. Nothing here touches Electron, the disk or the
// network, so scripts/verify-app.test.cjs can pin every rule below.
//
// The point of the tool (and of keeping this half small and pinned) is that a
// thread can hand back evidence instead of a list of things for yoyo to click:
// the real client is started, driven through the steps a real-device note asks
// for, and every screen it reaches is kept as a screenshot plus its visible text.

// Pages reachable from the sidebar, in sidebar order. `account` has no sidebar
// row of its own; the account card at the bottom of the sidebar opens it.
// `canvas` opens a separate window. The settings aliases (acceleration, backups,
// updates), the retired maintenance page and the four pages merged into 插件 in
// 0.2.25 (featured, mcp, skills, plugins) are not listed: they land on other
// pages, so a step naming them would screenshot something it did not ask for.
//
// `canvas` and `video` lost their sidebar rows when chat, canvas and the video
// studio became one page (「创作」, page id still `chat`). They stay here so a
// step naming them keeps working: `via` is the page to go to first, `opener`
// the card on its start page that opens the canvas window or a new film.
export const verifyPages = Object.freeze([
  { id: 'home', label: '首页' },
  { id: 'chat', label: '创作' },
  { id: 'sessions', label: '记录' },
  { id: 'canvas', label: '画布', window: 'canvas', via: 'chat', opener: 'create-card-canvas' },
  { id: 'video', label: '视频剪辑', via: 'chat', opener: 'create-card-video' },
  { id: 'remote', label: '手机遥控' },
  { id: 'extensions', label: '插件' },
  { id: 'tutorial', label: '教程' },
  { id: 'health', label: '检查' },
  { id: 'feedback', label: '反馈与客服' },
  { id: 'settings', label: '设置' },
  { id: 'account', label: '个人中心', opener: 'sidebar-account-open' },
])

// What a run with no steps visits: every page above except the canvas, whose
// separate window is slower to start and has its own smoke in CI.
export const defaultTour = Object.freeze(verifyPages.filter((page) => page.window !== 'canvas').map((page) => page.id))

export const accountKinds = Object.freeze(['xm', 'api', 'none'])
export const themes = Object.freeze(['light', 'dark'])

const stepKinds = Object.freeze({
  click: 'testid',
  tap: 'text',
  hover: 'testid',
  fill: 'assignment',
  key: 'key',
  wait: 'testid',
  sleep: 'milliseconds',
  look: 'text',
  expect: 'text',
  shot: 'name',
})

export const usage = `用法：npm run verify:app -- [选项] [步骤…]

在本机（云端容器里自动套 xvfb）编译好的真客户端里走一遍，账号站一律用本地假接口，别的网站一律不连。
每到一个页面截一张图，并把这一屏的文字存成同名 .txt；结尾写 report.md 和 steps.json。
先跑过 npm run compile。

选项：
  --account xm|api|none   登哪个账号：xm = 星芒账号（默认），api = 历史账号，none = 不登录停在欢迎页
  --balance <美元>        假账号的余额，默认 25
  --theme light|dark      浅色（默认）或深色
  --size <宽>x<高>        窗口大小，默认 1280x820
  --installed             首页按「Codex CLI、Grok CLI 已装好」显示（开发版自带的界面夹具）
  --out <目录>            截图放哪，默认 output/verify-app/<时间>

步骤（不写就把侧栏每一页走一遍，画布除外）：
  <页面>                  从侧栏进这一页并截图：${verifyPages.map((page) => page.id).join(' ')}
  account:<分区>          个人中心的某个分区，比如 account:keys
  click:<data-testid>     点一下
  tap:<文字>              点读屏名或文字是这句的按钮、页签、菜单项、开关
  hover:<data-testid>     鼠标停上去，把它的悬停提示记进记录
  fill:<data-testid>=<值> 往输入框里填字
  key:<按键>              按键，比如 key:Escape、key:Control+K
  wait:<data-testid>      等它出现
  sleep:<毫秒>            干等
  look:<文字>             把含这句的地方滚进来并截图；找不到算这一步没过
  expect:<文字>           这一屏上必须有这句（不截图）；没有算这一步没过
  shot:<名字>             截一张图
`

export class VerifyPlanError extends Error {}

function fail(message) {
  throw new VerifyPlanError(message)
}

export function findVerifyPage(id) {
  return verifyPages.find((page) => page.id === id) ?? null
}

function parseSize(value) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value ?? '')
  if (!match) fail(`--size 要写成 宽x高，比如 1280x820，收到的是「${value ?? ''}」`)
  const width = Number(match[1])
  const height = Number(match[2])
  // Below the shell's minimum window size the layout is not one a customer can
  // reach; above it the screenshot is just a larger canvas of the same layout.
  if (width < 800 || height < 560 || width > 3840 || height > 2160) fail(`窗口大小 ${value} 超出范围（宽 800～3840，高 560～2160）`)
  return { width, height }
}

function parseBalance(value) {
  const amount = Number(value)
  if (value === undefined || value === '' || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
    fail(`--balance 要写成 0 到 1000000 之间的美元数，收到的是「${value ?? ''}」`)
  }
  return amount
}

export function parseVerifyStep(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') fail('步骤不能是空的')
  const text = raw.trim()
  const page = findVerifyPage(text)
  if (page) return { kind: 'page', page: page.id, raw: text }
  const colon = text.indexOf(':')
  if (colon <= 0) fail(`认不出这一步：「${text}」。页面只能是 ${verifyPages.map((entry) => entry.id).join('、')}`)
  const head = text.slice(0, colon)
  const value = text.slice(colon + 1)
  if (head === 'account') {
    if (!/^[a-z][a-z-]{0,31}$/.test(value)) fail(`account: 后面要写分区名，比如 account:keys，收到的是「${text}」`)
    return { kind: 'page', page: 'account', section: value, raw: text }
  }
  const shape = stepKinds[head]
  if (!shape) fail(`认不出这一步：「${text}」`)
  if (value === '') fail(`「${head}:」后面不能是空的`)
  if (shape === 'testid' && !/^[A-Za-z0-9_-]{1,96}$/.test(value)) fail(`「${text}」里的 data-testid 只能有字母、数字、- 和 _`)
  if (shape === 'milliseconds') {
    const milliseconds = Number(value)
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 60_000) fail(`sleep 要写 0 到 60000 毫秒，收到的是「${value}」`)
    return { kind: head, milliseconds, raw: text }
  }
  if (shape === 'assignment') {
    const equals = value.indexOf('=')
    const testId = equals > 0 ? value.slice(0, equals) : ''
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(testId)) fail(`fill 要写成 fill:<data-testid>=<值>，收到的是「${text}」`)
    return { kind: head, testId, value: value.slice(equals + 1), raw: text }
  }
  if (shape === 'testid') return { kind: head, testId: value, raw: text }
  if (shape === 'key') return { kind: head, key: value, raw: text }
  if (shape === 'name') return { kind: head, name: value, raw: text }
  return { kind: head, text: value, raw: text }
}

function timestampLabel(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function parseVerifyArgs(argv, { now = new Date() } = {}) {
  const plan = { account: 'xm', balance: 25, theme: 'light', size: { width: 1280, height: 820 }, installed: false,
    out: `output/verify-app/${timestampLabel(now)}`, steps: [], help: false }
  const rawSteps = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { plan.help = true; continue }
    if (argument === '--installed') { plan.installed = true; continue }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      const name = equals > 0 ? argument.slice(2, equals) : argument.slice(2)
      const value = equals > 0 ? argument.slice(equals + 1) : argv[++index]
      if (name === 'account') {
        if (!accountKinds.includes(value)) fail(`--account 只能是 ${accountKinds.join('、')}，收到的是「${value ?? ''}」`)
        plan.account = value
      } else if (name === 'balance') plan.balance = parseBalance(value)
      else if (name === 'theme') {
        if (!themes.includes(value)) fail(`--theme 只能是 light 或 dark，收到的是「${value ?? ''}」`)
        plan.theme = value
      } else if (name === 'size') plan.size = parseSize(value)
      else if (name === 'out') {
        if (!value) fail('--out 后面要写目录')
        plan.out = value
      } else fail(`认不出这个选项：${argument}`)
      continue
    }
    rawSteps.push(argument)
  }
  plan.steps = (rawSteps.length ? rawSteps : defaultTour).map(parseVerifyStep)
  if (plan.account === 'none') {
    // Signed out (and with no tool holding a key) v2 stops on the welcome page:
    // there is no sidebar to reach a page from.
    const page = plan.steps.find((step) => step.kind === 'page')
    if (page && rawSteps.length) fail(`--account none 停在欢迎页，进不了「${findVerifyPage(page.page).label}」；要看登录后的页面去掉 --account none`)
    if (!rawSteps.length) plan.steps = [{ kind: 'shot', name: 'welcome', raw: 'shot:welcome' }]
  }
  return plan
}

// File names keep the words a reader recognises (Chinese included) and drop
// everything a file system or an artifact upload could choke on.
export function screenshotName(index, label) {
  const slug = String(label).normalize('NFKC').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shot'
  return `${String(index).padStart(2, '0')}-${slug}`
}

// Collapses the visible text of a screen into lines a reader (or grep) can use:
// trailing spaces and runs of blank lines are layout, not content.
export function normaliseScreenText(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n').trim()
}

function describeStep(step) {
  if (step.kind === 'page') {
    const page = findVerifyPage(step.page)
    return step.section ? `进「${page.label}」的 ${step.section} 分区` : `进「${page.label}」`
  }
  if (step.kind === 'click') return `点 ${step.testId}`
  if (step.kind === 'tap') return `点「${step.text}」`
  if (step.kind === 'hover') return `鼠标停在 ${step.testId} 上`
  if (step.kind === 'fill') return `往 ${step.testId} 里填「${step.value}」`
  if (step.kind === 'key') return `按 ${step.key}`
  if (step.kind === 'wait') return `等 ${step.testId} 出现`
  if (step.kind === 'sleep') return `等 ${step.milliseconds} 毫秒`
  if (step.kind === 'look') return `找「${step.text}」并截图`
  if (step.kind === 'expect') return `这一屏要有「${step.text}」`
  return `截图 ${step.name}`
}

// A CI desktop can be smaller than the size asked for; say what the screenshots
// actually are rather than what was requested.
function windowLabel(requested, actual) {
  const asked = `${requested.width}x${requested.height}`
  if (!actual) return `窗口 ${asked}`
  const reached = `${actual.width}x${actual.height}`
  return Math.abs(actual.width - requested.width) <= 8 && Math.abs(actual.height - requested.height) <= 40
    ? `窗口 ${asked}` : `窗口要的是 ${asked}，屏幕只放得下 ${reached}`
}

// The report is written to be pasted into the 「机器能核」 half of a real-device
// note: what was started, every step with its verdict, the files it left, and
// what the fixture could not answer (a screen showing 「读不到」 because the fake
// account site had no route for it is a fixture gap, not a product bug).
export function buildVerifyReport({ plan, platform, commit, startedAt, finishedAt, results, unrouted, withheld = [], pageErrors, consoleErrors, fatal, actualSize = null }) {
  const passed = !fatal && results.every((result) => result.ok) && pageErrors.length === 0
  const account = { xm: '星芒账号（假账号站）', api: '历史账号（假账号站）', none: '不登录' }[plan.account]
  const lines = [
    `# 沙箱真开客户端：${passed ? '全部通过' : '有没过的'}`,
    '',
    `- 平台：${platform}；提交：${commit || '未知'}；${startedAt} 开始，${finishedAt} 结束`,
    `- 账号：${account}${plan.account === 'none' ? '' : `，余额 $${plan.balance}`}；${plan.theme === 'dark' ? '深色' : '浅色'}；${windowLabel(plan.size, actualSize)}${plan.installed ? '；Codex CLI、Grok CLI 按已装好显示' : ''}`,
    '- 账号站是本地假接口，别的网站一律不连；截图是编译好的真客户端窗口，不是真机，也不是浏览器夹具。',
    '',
    '## 每一步',
    '',
  ]
  results.forEach((result, index) => {
    const files = result.files.length ? `（${result.files.map((file) => `\`${file}\``).join('、')}）` : ''
    const note = result.note ? `：${result.note}` : ''
    lines.push(`${index + 1}. ${result.ok ? '✓' : '✗'} ${describeStep(result.step)}${files}${note}${result.ok ? '' : `\n   没过：${result.error}`}`)
  })
  if (fatal) lines.push('', `**中途停下**：${fatal}`)
  if (unrouted.length) {
    lines.push('', '## 假账号站没答的请求', '', '这些界面上显示「读不到」一类的字，是夹具没答，不算客户端的毛病；要看就给 e2e/verify-app-fixture.cjs 补一条路由。', '')
    for (const entry of unrouted) lines.push(`- ${entry.method} ${entry.origin}${entry.route} × ${entry.count}`)
  }
  if (withheld.length) {
    lines.push('', '## 故意不答的请求', '', '测连接、聊天、生图这类请求夹具一律不答（不假装生成，也不连真站），界面上会显示连不上或失败。', '')
    for (const entry of withheld) lines.push(`- ${entry.method} ${entry.origin}${entry.route} × ${entry.count}`)
  }
  if (pageErrors.length) {
    lines.push('', '## 页面报错（算没过）', '')
    for (const message of pageErrors) lines.push(`- ${message}`)
  }
  if (consoleErrors.length) {
    lines.push('', '## 控制台错误（只记录）', '')
    for (const message of consoleErrors.slice(0, 30)) lines.push(`- ${message}`)
    if (consoleErrors.length > 30) lines.push(`- ……另有 ${consoleErrors.length - 30} 条，见 steps.json`)
  }
  return { passed, markdown: `${lines.join('\n')}\n` }
}

// Requests repeat (every refresh asks again); one line per route reads better.
// `unrouted` is an account route the fixture lacks, `withheld` a generation
// request it never answers.
export function summariseOutcome(calls, outcome) {
  const counts = new Map()
  for (const call of calls) {
    if (call.outcome !== outcome) continue
    const key = `${call.method} ${call.origin}${call.route}`
    const entry = counts.get(key) ?? { method: call.method, origin: call.origin, route: call.route, count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  return [...counts.values()]
}
