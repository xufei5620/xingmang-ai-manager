// npm run verify:app: start the compiled client for real, sign in against a
// local fake of the account sites, walk the pages (or the steps) named on the
// command line, and keep a screenshot plus the visible text of every screen.
//
// This is the "run the change and look at it" half of verification, for the
// checks a real-device note lists that need no real device: text on a page, a
// dialog that opens, a button that leads somewhere. What genuinely needs a
// machine (an elevation prompt, the keychain, an installed package, a payment,
// the real network) stays in the note's 「必须真机」 half; docs/COLLABORATION.md
// §7.6 says how a note is split, docs/CLOUD-SANDBOX.md §7 how to run this.
//
// Usage and the step grammar live in e2e/verify-app-plan.mjs (npm run verify:app -- --help).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { fixtureReadyTimeoutMs, mainProcessCallInOwnTask } from './fixture-readiness.mjs'
import { createSmokeRuntime } from './smoke-runtime.mjs'
import { VerifyPlanError, buildVerifyReport, findVerifyPage, normaliseScreenText, parseVerifyArgs, screenshotName,
  summariseOutcome, usage } from './verify-app-plan.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = path.join(projectRoot, 'e2e', 'verify-app-fixture.cjs')
const { loginAccount, loginPassword } = await import('./verify-app-fixture.cjs').then((module) => module.default ?? module)

let plan
try {
  plan = parseVerifyArgs(process.argv.slice(2))
} catch (error) {
  if (!(error instanceof VerifyPlanError)) throw error
  process.stderr.write(`${error.message}\n\n${usage}`)
  process.exit(2)
}
if (plan.help) {
  process.stdout.write(usage)
  process.exit(0)
}

// A cloud container (and the Linux CI runner) has no display. Re-run this same
// command inside a virtual one rather than asking every caller to remember it.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.env.XINGMANG_VERIFY_APP_XVFB !== '1') {
  const wrapped = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, XINGMANG_VERIFY_APP_XVFB: '1' } })
  if (wrapped.error) {
    process.stderr.write(`没有图形界面，也找不到 xvfb-run（${wrapped.error.message}）。Ubuntu 上先装：sudo apt-get install -y xvfb\n`)
    process.exit(2)
  }
  process.exit(wrapped.status ?? 1)
}

for (const required of ['dist-electron/platform/entry.js', 'dist-electron/catalog.js', 'dist/renderer-v2.flag']) {
  if (!existsSync(path.join(projectRoot, required))) {
    process.stderr.write(`没找到 ${required}：先跑一次 npm run compile（它编译当前界面和主进程）。\n`)
    process.exit(2)
  }
}

const out = path.resolve(process.cwd(), plan.out)
const { stepBudgetMs, progress, withDeadline, trackProcessIds, releaseProcessIds, run } = createSmokeRuntime({
  name: 'verify-app',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 60_000),
  // Cold start and login take most of a minute on a loaded Windows runner;
  // a page step is a second or two when healthy. The CI step bound
  // (.github/workflows/quality.yml) sits above this for the default walk.
  totalBudgetMs: 150_000 + plan.steps.length * 20_000 + plan.steps.reduce((sum, step) => sum + (step.milliseconds ?? 0), 0),
})

const results = []
const pageErrors = []
const consoleErrors = []
let application
let mainWindow
let target
let shotIndex = 0
let fatal = null
let actualSize = null

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 })
  const commit = result.status === 0 ? result.stdout.trim() : ''
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 })
  return commit && dirty.status === 0 && dirty.stdout.trim() ? `${commit}（工作区有没提交的改动）` : commit
}

function platformLabel() {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] ?? process.platform
}

async function prepareSandbox() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-verify-app-'))
  const userHome = path.join(sandbox, 'home')
  const userData = path.join(sandbox, 'user-data')
  const workspace = path.join(userHome, 'projects')
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(userData)
  // A first start would otherwise open the crash-report and usage notices on
  // top of every screenshot, and go looking for updates and diagnostics. A
  // settings file without a workspace is rejected and replaced by defaults, and
  // one without uiSkin is read as an old file whose theme was never chosen.
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ version: 2, workspace, theme: plan.theme, uiSkin: 'mist',
    checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false, crashReportingNoticeShown: true, usageStatsNoticeShown: true }), 'utf8')
  // A settings file means "this machine ran the client before"; without a
  // recorded version that start would greet the run with 「已更新到…」.
  const { version } = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  await fs.writeFile(path.join(userData, 'last-run-version.json'), JSON.stringify({ version: 1, lastRunVersion: version }), 'utf8')
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, APPDATA: path.join(sandbox, 'appdata'),
    LOCALAPPDATA: path.join(sandbox, 'local-appdata'), XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'),
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1', XINGMANG_RENDERER: '', VITE_DEV_SERVER_URL: '', NODE_OPTIONS: '',
    XINGMANG_ONBOARDING_PREVIEW: '', XINGMANG_DASHBOARD_PREVIEW: '', XINGMANG_UPDATE_DEV: '',
    XINGMANG_VERIFY_APP_CONFIG: JSON.stringify({ userHome, userData, projectRoot, balance: plan.balance,
      entry: path.join(projectRoot, 'dist-electron/platform/entry.js'), catalog: path.join(projectRoot, 'dist-electron/catalog.js') }) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.XINGMANG_VERIFY_APP_XVFB
  // A cloud container exports its own model credentials; a CLI the client
  // probes must not pick them up (docs/CLOUD-SANDBOX.md §7).
  // CLAUDECODE alone makes a probed Claude Code refuse to start ("cannot be
  // launched inside another Claude Code session").
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|CLAUDE|OPENAI)/.test(key)) delete env[key]
  // Without a locale Electron dies on the first Chinese file name with nothing
  // but "Trace/breakpoint trap" (docs/CLOUD-SANDBOX.md §7).
  if (process.platform === 'linux' && !env.LANG && !env.LC_ALL) env.LANG = 'C.UTF-8'
  if (plan.installed) env.XINGMANG_E2E_MANUAL_UNINSTALL_FIXTURE = '1'
  else delete env.XINGMANG_E2E_MANUAL_UNINSTALL_FIXTURE
  return { sandbox, userData, env }
}

function evaluateInMain(label, body, argument) {
  return withDeadline(label, stepBudgetMs, () => application.evaluate(mainProcessCallInOwnTask, { source: String(body), argument }))
}

async function settle(page = target) {
  // Pages show a skeleton while their first read is in flight; a screenshot of
  // that is a screenshot of nothing. Give them a few seconds, then two frames.
  await page.waitForFunction(() => !document.querySelector('[data-testid="page-viewport"] [aria-busy="true"]'), null, { timeout: 5_000 }).catch(() => undefined)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => undefined)
  await page.waitForTimeout(400)
}

async function capture(label, page = target) {
  shotIndex += 1
  const base = screenshotName(shotIndex, label)
  await withDeadline(`screenshot ${base}`, stepBudgetMs, () => page.screenshot({ path: path.join(out, `${base}.png`), animations: 'disabled' }))
  const text = await page.evaluate(() => document.body.innerText).catch(() => '')
  await fs.writeFile(path.join(out, `${base}.txt`), `${normaliseScreenText(text)}\n`, 'utf8')
  return [`${base}.png`, `${base}.txt`]
}

async function visible(locator) {
  return locator.filter({ visible: true }).first()
}

async function openCanvas() {
  const opened = application.waitForEvent('window', { timeout: stepBudgetMs })
  await mainWindow.getByTestId('nav-canvas').click()
  const canvas = await opened
  canvas.on('pageerror', (error) => pageErrors.push(`画布窗口：${error.message}`))
  await canvas.waitForLoadState('domcontentloaded', { timeout: stepBudgetMs })
  await canvas.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: stepBudgetMs })
  target = canvas
  await settle(canvas)
  return capture('画布', canvas)
}

async function openPage(step) {
  const page = findVerifyPage(step.page)
  if (page.window === 'canvas') return { files: await openCanvas() }
  target = mainWindow
  const opener = mainWindow.getByTestId(page.opener ?? `nav-${page.id}`)
  if (!await opener.filter({ visible: true }).count()) throw new Error(`侧栏里没有「${page.label}」：当前账号或这个平台不显示这一页`)
  await (await visible(opener)).click()
  await mainWindow.getByTestId(`page-${page.id}`).first().waitFor({ state: 'visible', timeout: stepBudgetMs })
  if (step.section) {
    const tab = mainWindow.locator(`[id="v2-account-tab-${step.section}"]`)
    if (!await tab.count()) {
      const tabs = await mainWindow.locator('[data-testid="account-tabs"] [role="tab"]').evaluateAll((nodes) => nodes.map((node) => node.id.replace('v2-account-tab-', '')))
      throw new Error(`个人中心没有「${step.section}」这个分区，现有的是：${tabs.join('、') || '（一个都没有）'}`)
    }
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: stepBudgetMs })
  }
  await settle()
  return { files: await capture(step.section ? `${page.label}-${step.section}` : page.label) }
}

// Menu entries first: a menu that is open sits on top of the page, and the
// step after the one that opened it means its entry, not a page tab that
// happens to carry the same words (「立即备份」 then 「全部工具」 on settings).
const tappableRoles = ['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'button', 'tab', 'link', 'checkbox', 'radio', 'switch']

async function tap(text) {
  // With a modal open, the page behind it still has its buttons in the tree
  // (「恢复」 on a backup row behind 「恢复到…的配置？」), and clicking one of
  // those waits forever on the dialog in front. Look in the dialog first.
  const modal = target.locator('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]').filter({ visible: true })
  const scopes = await modal.count() ? [modal.last(), target] : [target]
  for (const scope of scopes) {
    for (const role of tappableRoles) {
      const candidates = scope.getByRole(role, { name: text, exact: true }).filter({ visible: true })
      if (await candidates.count()) {
        await candidates.first().click({ timeout: stepBudgetMs })
        return
      }
    }
    const byText = scope.getByText(text, { exact: true }).filter({ visible: true })
    if (await byText.count()) {
      await byText.first().click({ timeout: stepBudgetMs })
      return
    }
  }
  throw new Error(`这一屏上没有能点的「${text}」`)
}

async function hover(testId) {
  const element = await visible(target.getByTestId(testId))
  await element.hover({ timeout: stepBudgetMs })
  await target.waitForTimeout(700)
  // A native title tooltip is drawn by the OS, outside the page, so it never
  // shows up in a screenshot. Read what it would say instead.
  const hint = await element.evaluate((node) => {
    const own = node.getAttribute('title') || node.querySelector('[title]')?.getAttribute('title') || ''
    const described = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText?.trim()).filter(Boolean).join(' ')
    const tooltip = [...document.querySelectorAll('[role="tooltip"]')].map((entry) => entry.innerText.trim()).filter(Boolean).join(' ')
    return [own, described, tooltip].filter(Boolean).join(' / ')
  })
  return { note: hint ? `悬停提示：「${hint}」` : '没有悬停提示' }
}

async function screenContains(text) {
  const raw = await target.evaluate(() => document.body.innerText)
  const collapse = (value) => value.replace(/\s+/g, '')
  return raw.includes(text) || collapse(raw).includes(collapse(text))
}

async function runStep(step) {
  if (step.kind === 'page') return openPage(step)
  if (step.kind === 'click') {
    await (await visible(target.getByTestId(step.testId))).click({ timeout: stepBudgetMs })
    await settle()
    return {}
  }
  if (step.kind === 'tap') {
    await tap(step.text)
    await settle()
    return {}
  }
  if (step.kind === 'hover') return hover(step.testId)
  if (step.kind === 'fill') {
    // Field components put the test id on their wrapper as often as on the input.
    const element = await visible(target.getByTestId(step.testId))
    const editable = await element.evaluate((node) => node.matches('input, textarea, [contenteditable="true"]'))
    await (editable ? element : element.locator('input, textarea').first()).fill(step.value, { timeout: stepBudgetMs })
    await settle()
    return {}
  }
  if (step.kind === 'key') {
    await target.keyboard.press(step.key)
    await settle()
    return {}
  }
  if (step.kind === 'wait') {
    await target.getByTestId(step.testId).first().waitFor({ state: 'visible', timeout: stepBudgetMs })
    return {}
  }
  if (step.kind === 'sleep') {
    await target.waitForTimeout(step.milliseconds)
    return {}
  }
  if (step.kind === 'expect') {
    if (!await screenContains(step.text)) throw new Error(`这一屏上找不到「${step.text}」`)
    return { note: '找到了' }
  }
  if (step.kind === 'look') {
    const match = target.getByText(step.text).filter({ visible: true })
    if (!await match.count()) {
      // Text split across elements (a label and its value) is not one text node;
      // fall back to whether the screen says it at all before giving up.
      if (!await screenContains(step.text)) throw new Error(`这一屏上找不到「${step.text}」`)
      return { files: await capture(step.text), note: '这句跨了几个元素，没法单独滚到它，截的是当前这一屏' }
    }
    await match.first().scrollIntoViewIfNeeded({ timeout: stepBudgetMs })
    await settle()
    return { files: await capture(step.text) }
  }
  return { files: await capture(step.name) }
}

// The same sign-in a customer does: welcome page, login dialog, agree, submit.
// The start guide a new account gets is paused the way realm-account-smoke does
// it, because its 稍后继续 button can be greyed out for a moment while the guide
// checks keys, and a click in that moment is dropped.
async function signIn() {
  const welcome = mainWindow.getByTestId('welcome-page')
  await welcome.waitFor({ state: 'visible', timeout: fixtureReadyTimeoutMs })
  if (plan.account === 'none') return
  await mainWindow.getByTestId('welcome-login').click()
  await mainWindow.getByTestId('login-dialog').waitFor({ state: 'visible', timeout: fixtureReadyTimeoutMs })
  if (plan.account === 'api') {
    const segment = mainWindow.getByTestId('auth-source')
    if (!await segment.count()) await mainWindow.getByTestId('auth-source-expand').click()
    else await segment.getByRole('button', { name: '历史账号', exact: true }).click()
  }
  await mainWindow.getByTestId('login-account').fill(loginAccount)
  await mainWindow.getByTestId('login-password').fill(loginPassword)
  await mainWindow.getByTestId('auth-agree').check()
  await mainWindow.getByTestId('login-submit').click()
  await mainWindow.getByTestId('login-dialog').waitFor({ state: 'hidden', timeout: fixtureReadyTimeoutMs })
  const pause = mainWindow.getByTestId('guide-pause')
  const deadline = Date.now() + fixtureReadyTimeoutMs
  await mainWindow.getByTestId('start-guide').or(mainWindow.getByTestId('sidebar-account-open')).first()
    .waitFor({ state: 'visible', timeout: fixtureReadyTimeoutMs })
  while (await pause.count()) {
    if (Date.now() > deadline) throw new Error('开始引导点了「稍后继续」一直没收起')
    await pause.click({ timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined)
    await pause.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
  }
  await mainWindow.getByRole('button', { name: /^个人中心：/ }).waitFor({ state: 'visible', timeout: fixtureReadyTimeoutMs })
  await settle(mainWindow)
}

async function launch(sandbox) {
  const args = [fixturePath, `--user-data-dir=${sandbox.userData}`]
  // Chromium will not start its sandbox as root, and a cloud container is root.
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')
  application = await withDeadline('Electron launch', stepBudgetMs, () => electron.launch({ cwd: projectRoot, args, env: sandbox.env, timeout: stepBudgetMs }))
  const pid = application.process().pid
  if (pid) trackProcessIds([pid])
  let stderr = ''
  application.process().stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-32_000) })
  mainWindow = await withDeadline('first window', stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
  target = mainWindow
  mainWindow.on('pageerror', (error) => pageErrors.push(error.message))
  mainWindow.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)) })
  await withDeadline('preload bridge', fixtureReadyTimeoutMs, () => mainWindow.waitForFunction(() => Boolean(window.xingmang), null, { timeout: fixtureReadyTimeoutMs }))
  await evaluateInMain('window size', ({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang://app/'))
    // On a screen smaller than the saved size the client opens maximized, and a
    // maximized window ignores setSize on Windows. A CI runner's desktop is
    // 1024x768, so the size actually reached is read back for the report.
    if (window?.isMaximized()) window.unmaximize()
    window?.setSize(size.width, size.height, false)
    window?.center()
  }, plan.size)
  await mainWindow.waitForFunction((width) => Math.abs(window.innerWidth - width) <= 8, plan.size.width, { timeout: 10_000 }).catch(() => undefined)
  actualSize = await mainWindow.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null)
  return { pid, stderr: () => stderr }
}

async function shutdown(pid) {
  if (!application) return
  await withDeadline('main process exit', 20_000, () => application.evaluate(({ app }) => app.exit(0))).catch(() => undefined)
  await withDeadline('close', 20_000, () => application.close()).catch(() => undefined)
  if (pid) releaseProcessIds([pid])
}

async function main() {
  const startedAt = new Date().toISOString()
  await fs.mkdir(out, { recursive: true })
  progress(`writing evidence to ${out}`)
  const sandbox = await prepareSandbox()
  let instance
  let calls = []
  let opened = []
  try {
    progress('launching the compiled client against the fixture')
    instance = await launch(sandbox)
    progress(plan.account === 'none' ? 'waiting for the welcome page' : `signing in (${plan.account})`)
    await withDeadline('sign-in', fixtureReadyTimeoutMs * 2, signIn)
    for (const step of plan.steps) {
      progress(`step: ${step.raw}`)
      const started = Date.now()
      try {
        const outcome = await withDeadline(`step ${step.raw}`, stepBudgetMs * 2, () => runStep(step))
        results.push({ step, ok: true, ms: Date.now() - started, files: outcome.files ?? [], note: outcome.note ?? null })
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
        const files = await capture(`没过-${step.raw}`).catch(() => [])
        results.push({ step, ok: false, ms: Date.now() - started, files, note: null, error: message })
      }
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message.split('\n')[0] : String(error)
    if (mainWindow) await capture('中途停下', mainWindow).catch(() => undefined)
  } finally {
    if (application) {
      calls = await evaluateInMain('fixture calls', () => globalThis.__verifyApp.calls()).catch(() => [])
      opened = await evaluateInMain('external links', () => globalThis.__verifyApp.openedExternally()).catch(() => [])
    }
    await shutdown(instance?.pid)
    await fs.copyFile(path.join(sandbox.userData, 'logs', 'runtime.jsonl'), path.join(out, 'runtime.jsonl')).catch(() => undefined)
    await fs.rm(sandbox.sandbox, { recursive: true, force: true }).catch(() => undefined)
  }
  const unrouted = summariseOutcome(calls, 'unrouted')
  const withheld = summariseOutcome(calls, 'withheld')
  const report = buildVerifyReport({ plan, platform: platformLabel(), commit: gitCommit(), startedAt, finishedAt: new Date().toISOString(),
    results, unrouted, withheld, pageErrors, consoleErrors, fatal, actualSize })
  const externalNote = opened.length ? `\n## 点了会去浏览器的链接（没真打开）\n\n${opened.map((url) => `- ${url}`).join('\n')}\n` : ''
  await fs.writeFile(path.join(out, 'report.md'), report.markdown + externalNote, 'utf8')
  await fs.writeFile(path.join(out, 'steps.json'), `${JSON.stringify({ plan, results, unrouted, withheld, refused: calls.filter((call) => call.outcome === 'refused'),
    openedExternally: opened, pageErrors, consoleErrors, fatal }, null, 2)}\n`, 'utf8')
  process.stderr.write(`\n${report.markdown}\n证据在 ${out}\n`)
  if (!report.passed) throw new Error(`verify:app 有没过的，见 ${path.join(out, 'report.md')}`)
  return { out, passed: true, screenshots: results.flatMap((result) => result.files.filter((file) => file.endsWith('.png'))) }
}

await run(main)
