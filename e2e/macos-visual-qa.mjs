import { _electron as electron } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

if (process.platform !== 'darwin') {
  throw new Error('macOS visual QA must run on macOS')
}

const artifactDir = path.resolve('artifacts', 'macos-qa')
const resultPath = path.join(artifactDir, 'visual-qa-result.json')
const stateRoot = path.join(artifactDir, '.state')
const homeDirectory = path.join(stateRoot, 'home')
const codexHome = path.join(homeDirectory, '.codex')
const userDataDirectory = path.join(stateRoot, 'user-data')
const startedAt = new Date().toISOString()

const scenarios = [
  { width: 1340, height: 845, theme: 'dark', manual: 'codex-command' },
  { width: 1340, height: 845, theme: 'light', manual: 'grok-unknown-source' },
  { width: 980, height: 680, theme: 'dark', manual: 'grok-unknown-source' },
  { width: 980, height: 680, theme: 'light', manual: 'codex-command' },
]
const manualCases = {
  'codex-command': {
    provider: 'Codex CLI',
    reason: '已识别 OpenAI 官方 Codex standalone 安装；为保留配置和会话，请按教程将 CLI 程序移动到废纸篓',
    directory: `${homeDirectory}/Applications/Codex-standalone`,
    hasCommand: true,
  },
  'grok-unknown-source': {
    provider: 'Grok CLI',
    reason: '当前安装来源或目录不支持安全自动卸载，请使用该发行版自带的卸载方式',
    directory: `${homeDirectory}/Library/Application Support/unknown-grok-installation`,
    hasCommand: false,
  },
}
const results = []
const pageErrors = []
let application = null
let page = null
let runError = null
let runPhase = 'setup'
let electronStderr = ''

function scenarioName(scenario) {
  return `${scenario.width}x${scenario.height}-${scenario.theme}-${scenario.manual}`
}

function retainElectronStderr(chunk) {
  electronStderr = `${electronStderr}${String(chunk)}`.slice(-65_536)
}

await fs.mkdir(artifactDir, { recursive: true })
await fs.rm(resultPath, { force: true })
await Promise.all(scenarios.map((scenario) => (
  fs.rm(path.join(artifactDir, `${scenarioName(scenario)}.png`), { force: true })
)))

async function selectTheme(theme) {
  const currentTheme = await page.locator('html').getAttribute('data-theme')
  if (currentTheme !== theme) {
    await page.locator('.sidebar .theme-toggle').click()
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme)
    await page.waitForTimeout(220)
  }
}

async function inspectDashboardLayout() {
  return page.evaluate(() => {
    const rectangle = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const bounds = element.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      }
    }
    const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
    const cards = [...document.querySelectorAll('.cli-card')].map(rectangle).filter(Boolean)
    const cardOverlaps = []
    for (let left = 0; left < cards.length; left += 1) {
      for (let right = left + 1; right < cards.length; right += 1) {
        if (intersects(cards[left], cards[right])) cardOverlaps.push([left, right])
      }
    }
    const clippedControls = [...document.querySelectorAll('button, [role="tab"]')]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName)
    const sidebar = rectangle(document.querySelector('.sidebar'))
    const main = rectangle(document.querySelector('.main-content'))
    const titlebar = rectangle(document.querySelector('.window-titlebar'))
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebar,
      main,
      titlebar,
      regionsSeparated: Boolean(sidebar && main && main.left >= sidebar.right - 1),
      mainInsideViewport: Boolean(main && main.left >= 0 && main.right <= window.innerWidth + 1),
      titlebarInsideViewport: Boolean(titlebar && titlebar.left >= 0 && titlebar.right <= window.innerWidth + 1),
      cardCount: cards.length,
      cardOverlaps,
      clippedControls,
      imagesLoaded: [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    }
  })
}

async function inspectManualDialog() {
  return page.evaluate(() => {
    const rectangle = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const bounds = element.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      }
    }
    const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
    const dialog = document.querySelector('.manual-uninstall-dialog')
    const content = dialog?.querySelector('.manual-uninstall-content')
    const header = dialog?.querySelector('.save-mode-head')
    const footer = dialog?.querySelector('.manual-uninstall-footer')
    const command = dialog?.querySelector('.manual-command-code pre')
    const commandContainer = dialog?.querySelector('.manual-command-code')
    const headerCopy = header?.querySelector(':scope > div')
    const headerClose = header?.querySelector('button')
    const dialogRect = rectangle(dialog)
    const contentRect = rectangle(content)
    const headerRect = rectangle(header)
    const footerRect = rectangle(footer)
    const buttonRects = [...(dialog?.querySelectorAll('button') ?? [])].map(rectangle).filter(Boolean)
    const buttonsInsideDialog = Boolean(dialogRect) && buttonRects.every((button) => (
      button.left >= dialogRect.left - 1
      && button.right <= dialogRect.right + 1
      && button.top >= dialogRect.top - 1
      && button.bottom <= dialogRect.bottom + 1
    ))
    const clippedControls = [...(dialog?.querySelectorAll('button') ?? [])]
      .filter((element) => element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 2)
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName)
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogHorizontalOverflow: dialog instanceof HTMLElement && dialog.scrollWidth > dialog.clientWidth + 1,
      dialogInsideViewport: Boolean(dialogRect && dialogRect.left >= 0 && dialogRect.right <= window.innerWidth + 1
        && dialogRect.top >= 0 && dialogRect.bottom <= window.innerHeight + 1),
      contentInsideDialog: Boolean(dialogRect && contentRect && contentRect.left >= dialogRect.left - 1
        && contentRect.right <= dialogRect.right + 1 && contentRect.top >= dialogRect.top - 1
        && contentRect.bottom <= dialogRect.bottom + 1),
      contentOverflowY: content instanceof HTMLElement ? getComputedStyle(content).overflowY : null,
      contentCanScroll: content instanceof HTMLElement && content.scrollHeight > content.clientHeight,
      commandScrollStyle: command instanceof HTMLElement ? {
        overflowX: getComputedStyle(command).overflowX,
        overflowY: getComputedStyle(command).overflowY,
      } : null,
      commandCanScrollY: command instanceof HTMLElement
        && command.scrollHeight > command.clientHeight + 1,
      commandContainerHorizontalOverflow: commandContainer instanceof HTMLElement
        && commandContainer.scrollWidth > commandContainer.clientWidth + 1,
      buttonsInsideDialog,
      clippedControls,
      headerContentOverlap: Boolean(headerRect && contentRect && intersects(headerRect, contentRect)),
      contentFooterOverlap: Boolean(contentRect && footerRect && intersects(contentRect, footerRect)),
      headerTextCloseOverlap: Boolean(rectangle(headerCopy) && rectangle(headerClose)
        && intersects(rectangle(headerCopy), rectangle(headerClose))),
      footerButtonOverlaps: buttonRects.filter((button) => footerRect && button.top >= footerRect.top - 1).some((button, index, buttons) => (
        buttons.some((other, otherIndex) => index !== otherIndex && intersects(button, other))
      )),
    }
  })
}

try {
  runPhase = 'setup'
  await fs.rm(stateRoot, { recursive: true, force: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "solov"',
    'model = "gpt-5.6-sol"',
    'review_model = "gpt-5.6-sol"',
    '',
    '[model_providers.solov]',
    'name = "solov"',
    'base_url = "https://api.solov.cc"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n'), 'utf8')
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    `${JSON.stringify({ OPENAI_API_KEY: 'macos-visual-placeholder-key' }, null, 2)}\n`,
    'utf8',
  )

  runPhase = 'launch'
  application = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDirectory}`],
    env: {
      ...process.env,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      XINGMANG_CODEX_HOME_OVERRIDE: codexHome,
      XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
      // The main process accepts this fixture only when app.isPackaged is false.
      XINGMANG_E2E_MANUAL_UNINSTALL_FIXTURE: '1',
    },
  })
  application.process().stderr?.on('data', retainElectronStderr)

  runPhase = 'first-window'
  page = await application.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))

  runPhase = 'scenario'
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => !document.body.textContent?.includes('检测中...'), null, { timeout: 60_000 })

  const capabilities = await page.evaluate(() => window.xingmang.getPlatformCapabilities())
  if (capabilities.platform !== 'macos') throw new Error('renderer did not receive macOS capabilities')

  for (const scenario of scenarios) {
    const manual = manualCases[scenario.manual]
    await application.evaluate(({ BrowserWindow }, requested) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setSize(requested.width, requested.height, false)
      window?.center()
    }, scenario)
    await page.waitForTimeout(300)
    await selectTheme(scenario.theme)
    await page.locator('.main-nav').getByRole('button', { name: '工具概览', exact: true }).click()
    await page.locator('.dashboard-page').waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForFunction(() => document.querySelectorAll('.cli-card').length === 5, null, { timeout: 60_000 })

    const windowBounds = await application.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows()[0]?.getBounds() ?? null
    ))
    const result = {
      name: scenarioName(scenario),
      requested: { width: scenario.width, height: scenario.height },
      windowBounds,
      theme: scenario.theme,
      manual: scenario.manual,
      pageErrors: [...pageErrors],
      dashboardLayout: await inspectDashboardLayout(),
      dialog: null,
      titleVisible: false,
      reasonVisible: false,
      directoryVisible: false,
      stepCount: 0,
      commandBranchCorrect: false,
      copyButtonWorked: null,
      closeButtonVisible: false,
      refreshButtonVisible: false,
      closeButtonWorked: false,
      refreshButtonWorked: null,
      manualError: null,
    }
    results.push(result)

    try {
      await page.locator('.main-nav').getByRole('button', { name: '安装维护', exact: true }).click()
      const maintenance = page.locator('.main-content [data-page-id="maintenance"]')
      await maintenance.waitFor({ state: 'visible', timeout: 10_000 })
      await maintenance.locator('.maintenance-cli-section .maintenance-row').first().waitFor({ state: 'visible', timeout: 60_000 })
      const row = maintenance.locator('.maintenance-cli-section .maintenance-row').filter({
        has: page.getByText(manual.provider, { exact: true }),
      })
      const helpButton = row.getByRole('button', { name: '卸载帮助', exact: true })
      await helpButton.click()
      const dialog = page.getByRole('dialog', { name: `手动卸载 ${manual.provider}` })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })

      result.titleVisible = await dialog.getByRole('heading', { name: `手动卸载 ${manual.provider}`, exact: true }).isVisible()
      result.reasonVisible = await dialog.getByText(manual.reason, { exact: true }).isVisible()
      result.directoryVisible = await dialog.getByText(manual.directory, { exact: true }).isVisible()
      result.stepCount = await dialog.locator('.manual-uninstall-steps li').count()
      result.closeButtonVisible = await dialog.getByRole('button', { name: '关闭', exact: true }).isVisible()
      result.refreshButtonVisible = await dialog.getByRole('button', { name: '执行完成后重新检测', exact: true }).isVisible()
      if (manual.hasCommand) {
        const copy = dialog.getByRole('button', { name: '复制卸载命令', exact: true })
        await copy.click()
        await dialog.getByRole('status').filter({ hasText: '命令已复制' }).waitFor({
          state: 'visible',
          timeout: 5_000,
        })
        result.copyButtonWorked = true
        result.commandBranchCorrect = await dialog.locator('.manual-command-block').isVisible()
          && await dialog.getByText('终端命令', { exact: true }).isVisible()
      } else {
        result.copyButtonWorked = null
        result.commandBranchCorrect = await dialog.locator('.manual-command-block').count() === 0
          && await dialog.getByText(/来源无法安全确认，因此没有生成删除命令/).isVisible()
      }
      result.dialog = await inspectManualDialog()
      await page.screenshot({
        path: path.join(artifactDir, `${result.name}.png`),
        animations: 'disabled',
      })

      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
      result.closeButtonWorked = true

      if (scenario.width === 980 && manual.hasCommand) {
        await helpButton.click()
        await dialog.waitFor({ state: 'visible', timeout: 10_000 })
        await dialog.getByRole('button', { name: '执行完成后重新检测', exact: true }).click()
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        result.refreshButtonWorked = true
      }
    } catch (error) {
      result.manualError = error instanceof Error ? error.message : String(error)
      const openDialog = page.locator('.manual-uninstall-dialog')
      if (await openDialog.isVisible().catch(() => false)) {
        await openDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => undefined)
      }
    }
  }
  runPhase = 'complete'
} catch (error) {
  runError = error instanceof Error ? error.message : String(error)
} finally {
  if (application) {
    await application.close().catch((error) => {
      if (!runError) {
        runPhase = 'close'
        runError = error instanceof Error ? error.message : String(error)
      }
    })
  }
  await fs.rm(stateRoot, { recursive: true, force: true }).catch((error) => {
    if (!runError) {
      runPhase = 'cleanup'
      runError = error instanceof Error ? error.message : String(error)
    }
  })
}

for (const result of results) result.pageErrors = [...pageErrors]

await fs.writeFile(
  resultPath,
  `${JSON.stringify({
    schemaVersion: 2,
    capabilities: 'macos',
    startedAt,
    finishedAt: new Date().toISOString(),
    phase: runPhase,
    runError,
    electronStderr: electronStderr.trim() || null,
    results,
  }, null, 2)}\n`,
  'utf8',
)

if (runError) throw new Error(runError)

const failed = results.filter((result) => {
  const layout = result.dashboardLayout
  const dialog = result.dialog
  return result.pageErrors.length > 0
    || Math.abs(result.windowBounds.width - result.requested.width) > 4
    || Math.abs(result.windowBounds.height - result.requested.height) > 4
    || layout.horizontalOverflow
    || !layout.regionsSeparated
    || !layout.mainInsideViewport
    || !layout.titlebarInsideViewport
    || layout.cardCount !== 5
    || layout.cardOverlaps.length > 0
    || layout.clippedControls.length > 0
    || !layout.imagesLoaded
    || result.manualError !== null
    || !result.titleVisible
    || !result.reasonVisible
    || !result.directoryVisible
    || result.stepCount !== 3
    || !result.commandBranchCorrect
    || (result.manual === 'codex-command' && result.copyButtonWorked !== true)
    || (result.manual === 'grok-unknown-source' && result.copyButtonWorked !== null)
    || !result.closeButtonVisible
    || !result.refreshButtonVisible
    || !result.closeButtonWorked
    || (result.name === '980x680-light-codex-command' && result.refreshButtonWorked !== true)
    || !dialog
    || dialog.documentHorizontalOverflow
    || dialog.dialogHorizontalOverflow
    || !dialog.dialogInsideViewport
    || !dialog.contentInsideDialog
    || dialog.contentOverflowY !== 'auto'
    || (result.manual === 'codex-command' && (
      dialog.commandScrollStyle?.overflowX !== 'auto'
      || dialog.commandScrollStyle?.overflowY !== 'auto'
      || dialog.commandContainerHorizontalOverflow
    ))
    || (result.name === '980x680-light-codex-command'
      && !dialog.contentCanScroll
      && !dialog.commandCanScrollY)
    || !dialog.buttonsInsideDialog
    || dialog.clippedControls.length > 0
    || dialog.headerContentOverlap
    || dialog.contentFooterOverlap
    || dialog.headerTextCloseOverlap
    || dialog.footerButtonOverlaps
})

if (failed.length > 0) throw new Error(JSON.stringify(failed, null, 2))
