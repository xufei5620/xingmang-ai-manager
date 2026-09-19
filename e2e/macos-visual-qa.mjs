import { _electron as electron } from '@playwright/test'
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

// `npm run compile` ships renderer-v2, so every selector below is a v2
// data-testid. The legacy shell's class names (.app-shell, .main-nav,
// .cli-card, .dashboard-page) exist nowhere in src/renderer-v2, which is why
// this script used to spend 60 seconds waiting for a node that never appears.
const shellRegions = {
  titlebar: 'window-titlebar',
  sidebar: 'sidebar',
  main: 'page-viewport',
  topbar: 'shell-topbar',
  statusbar: 'shell-statusbar',
}
// Home lists the four managed CLIs plus the Codex desktop app; on macOS
// platformCapabilities reports codexDesktop.launch, so all five rows render.
const expectedToolRows = ['codex', 'claude', 'gemini', 'grok', 'codexDesktop']

const scenarios = [
  { width: 1590, height: 875, theme: 'dark', tool: 'codex' },
  { width: 1590, height: 875, theme: 'light', tool: 'grok' },
  { width: 980, height: 680, theme: 'dark', tool: 'grok' },
  { width: 980, height: 680, theme: 'light', tool: 'codex' },
]
// The fixture below reports both tools as installed, which is what puts a row
// menu (and therefore the configuration dialog) within reach.
const toolCases = {
  codex: { name: 'Codex CLI' },
  grok: { name: 'Grok CLI' },
}
const dialogSubtitle = '选好账号后，保存并打开工具即可开始。'
const results = []
const pageErrors = []
let application = null
let page = null
let runError = null
let runPhase = 'setup'
let electronStderr = ''

function scenarioName(scenario) {
  return `${scenario.width}x${scenario.height}-${scenario.theme}-${scenario.tool}`
}

function retainElectronStderr(chunk) {
  electronStderr = `${electronStderr}${String(chunk)}`.slice(-65_536)
}

await fs.mkdir(artifactDir, { recursive: true })
await fs.rm(resultPath, { force: true })
await Promise.all(scenarios.map((scenario) => (
  fs.rm(path.join(artifactDir, `${scenarioName(scenario)}.png`), { force: true })
)))

// v2 has no shell-level theme toggle; the appearance group in 设置 is the only
// user-facing switch, and on macOS it routes through the platform theme
// preference before the renderer writes data-theme.
async function selectTheme(theme) {
  const currentTheme = await page.locator('html').getAttribute('data-theme')
  if (currentTheme === theme) return
  await page.getByTestId('nav-settings').click()
  const settings = page.getByTestId('page-settings')
  await settings.waitFor({ state: 'visible', timeout: 30_000 })
  await settings
    .getByTestId('settings-theme')
    .getByRole('button', { name: theme === 'dark' ? '暗色' : '亮色', exact: true })
    .click()
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme, {
    timeout: 30_000,
  })
  await page.waitForTimeout(220)
}

async function inspectDashboardLayout(expectedRows) {
  return page.evaluate(({ regions, expected }) => {
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
    const byTestId = (value) => document.querySelector(`[data-testid="${value}"]`)
    const rows = [...document.querySelectorAll('[data-testid^="tool-row-"]')]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    const rowRectangles = rows.map(rectangle).filter(Boolean)
    const rowOverlaps = []
    for (let left = 0; left < rowRectangles.length; left += 1) {
      for (let right = left + 1; right < rowRectangles.length; right += 1) {
        if (intersects(rowRectangles[left], rowRectangles[right])) rowOverlaps.push([left, right])
      }
    }
    const visibleRowIds = rows.map((element) => element.dataset.testid?.slice('tool-row-'.length) ?? '')
    const clippedControls = [...document.querySelectorAll('button, [role="tab"]')]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName)
    const sidebar = rectangle(byTestId(regions.sidebar))
    const main = rectangle(byTestId(regions.main))
    const titlebar = rectangle(byTestId(regions.titlebar))
    const topbar = rectangle(byTestId(regions.topbar))
    const statusbar = rectangle(byTestId(regions.statusbar))
    const insideViewport = (rect) => Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth + 1)
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebar,
      main,
      titlebar,
      topbar,
      statusbar,
      regionsSeparated: Boolean(sidebar && main && main.left >= sidebar.right - 1),
      mainInsideViewport: insideViewport(main),
      titlebarInsideViewport: insideViewport(titlebar),
      topbarInsideViewport: insideViewport(topbar),
      statusbarInsideViewport: insideViewport(statusbar),
      visibleRowIds,
      missingToolRows: expected.filter((id) => !visibleRowIds.includes(id)),
      rowOverlaps,
      clippedControls,
      imagesLoaded: [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    }
  }, { regions: shellRegions, expected: expectedRows })
}

// The v2 modal is a native <dialog>: header, then .xm-modal-content holding the
// scrollable .xm-dialog-body and the footer.
async function inspectConfigDialog() {
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
    const dialog = document.querySelector('dialog[data-testid="config-dialog"]')
    const content = dialog?.querySelector('.xm-modal-content')
    const body = dialog?.querySelector('.xm-dialog-body')
    const header = dialog?.querySelector(':scope > header')
    const footer = dialog?.querySelector('.xm-modal-content > footer')
    const headerCopy = header?.querySelector(':scope > div')
    const headerClose = header?.querySelector('button[data-modal-close="true"]')
    const dialogRect = rectangle(dialog)
    const contentRect = rectangle(content)
    const headerRect = rectangle(header)
    const footerRect = rectangle(footer)
    const buttonRects = [...(dialog?.querySelectorAll('button') ?? [])]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .map(rectangle)
      .filter(Boolean)
    const buttonsInsideDialog = Boolean(dialogRect) && buttonRects.every((button) => (
      button.left >= dialogRect.left - 1
      && button.right <= dialogRect.right + 1
      && button.top >= dialogRect.top - 1
      && button.bottom <= dialogRect.bottom + 1
    ))
    const clippedControls = [...(dialog?.querySelectorAll('button') ?? [])]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
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
      bodyOverflowY: body instanceof HTMLElement ? getComputedStyle(body).overflowY : null,
      bodyHorizontalOverflow: body instanceof HTMLElement && body.scrollWidth > body.clientWidth + 1,
      // Reported, not asserted: whether the body needs to scroll depends on the
      // account state this run happens to produce. `bodyOverflowY` is the
      // invariant — the body must stay able to scroll.
      bodyCanScroll: body instanceof HTMLElement && body.scrollHeight > body.clientHeight + 1,
      buttonsInsideDialog,
      clippedControls,
      headerContentOverlap: Boolean(headerRect && contentRect && intersects(headerRect, contentRect)),
      contentFooterOverlap: Boolean(rectangle(body) && footerRect && intersects(rectangle(body), footerRect)),
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
    'base_url = "https://xm.solov.cc/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n'), 'utf8')
  // A provider that already holds a key is also what lets v2 open the
  // workspace without a signed-in account; without it the renderer stops on
  // the welcome page and no shell selector ever resolves.
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
      // The main process accepts this fixture only when app.isPackaged is
      // false. v2 dropped the manual-uninstall dialog the fixture was written
      // for, but its projected snapshot still reports Codex CLI and Grok CLI as
      // installed, which is what this run needs.
      XINGMANG_E2E_MANUAL_UNINSTALL_FIXTURE: '1',
    },
  })
  application.process().stderr?.on('data', retainElectronStderr)

  runPhase = 'first-window'
  page = await application.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))

  runPhase = 'scenario'
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('app-frame').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => document.documentElement.dataset.rendererReady === 'true', null, {
    timeout: 60_000,
  })

  const capabilities = await page.evaluate(() => window.xingmang.getPlatformCapabilities())
  if (capabilities.platform !== 'macos') throw new Error('renderer did not receive macOS capabilities')

  for (const scenario of scenarios) {
    const subject = toolCases[scenario.tool]
    await application.evaluate(({ BrowserWindow }, requested) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setSize(requested.width, requested.height, false)
      window?.center()
    }, scenario)
    // Let the renderer catch up with the new window size before anything is
    // measured. A timeout here is not fatal on its own: the windowBounds and
    // overflow assertions below still fail loudly if the resize never landed.
    await page
      .waitForFunction((requested) => Math.abs(window.innerWidth - requested.width) <= 4, scenario, {
        timeout: 10_000,
      })
      .catch(() => undefined)
    await page.waitForTimeout(300)
    await selectTheme(scenario.theme)
    await page.getByTestId('nav-home').click()
    const home = page.getByTestId('page-home')
    await home.waitFor({ state: 'visible', timeout: 30_000 })
    const row = page.getByTestId(`tool-row-${scenario.tool}`)
    await row.waitFor({ state: 'visible', timeout: 60_000 })

    const windowBounds = await application.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows()[0]?.getBounds() ?? null
    ))
    const result = {
      name: scenarioName(scenario),
      requested: { width: scenario.width, height: scenario.height },
      windowBounds,
      theme: scenario.theme,
      tool: scenario.tool,
      pageErrors: [...pageErrors],
      dashboardLayout: await inspectDashboardLayout(expectedToolRows),
      maintenanceRowIds: [],
      dialog: null,
      titleVisible: false,
      subtitleVisible: false,
      toolTabsVisible: false,
      cancelButtonVisible: false,
      saveButtonVisible: false,
      closeButtonVisible: false,
      closeButtonWorked: false,
      dialogError: null,
    }
    results.push(result)

    try {
      // 安装卸载 lives behind the sidebar's 更多 group in v2, and that button
      // toggles: clicking it while the group is already open hides the entry.
      const moreNavigation = page.getByTestId('nav-more')
      if (await moreNavigation.getAttribute('aria-expanded') !== 'true') await moreNavigation.click()
      await page.getByTestId('nav-maintenance').click()
      const maintenance = page.getByTestId('page-maintenance')
      await maintenance.waitFor({ state: 'visible', timeout: 30_000 })
      await maintenance
        .getByTestId(`maintenance-tool-${scenario.tool}`)
        .waitFor({ state: 'visible', timeout: 60_000 })
      result.maintenanceRowIds = await maintenance.evaluate((element) => (
        [...element.querySelectorAll('[data-testid^="maintenance-tool-"]')]
          .map((node) => node.getAttribute('data-testid')?.slice('maintenance-tool-'.length) ?? '')
      ))

      await page.getByTestId('nav-home').click()
      await home.waitFor({ state: 'visible', timeout: 30_000 })
      await row.getByRole('button', { name: '更多操作', exact: true }).click()
      await row.getByRole('menuitem', { name: '配置', exact: true }).click()
      const dialog = page.getByTestId('config-dialog')
      await dialog.waitFor({ state: 'visible', timeout: 30_000 })

      result.titleVisible = await dialog
        .getByRole('heading', { name: `${subject.name} 配置`, exact: true })
        .isVisible()
      result.subtitleVisible = await dialog.getByText(dialogSubtitle, { exact: true }).isVisible()
      result.toolTabsVisible = await dialog.getByRole('tablist', { name: '选择要配置的工具' }).isVisible()
      result.cancelButtonVisible = await dialog.getByRole('button', { name: '取消', exact: true }).isVisible()
      result.saveButtonVisible = await dialog.getByTestId('tool-save-config').isVisible()
      const close = dialog.getByRole('button', { name: '关闭', exact: true })
      result.closeButtonVisible = await close.isVisible()
      result.dialog = await inspectConfigDialog()
      await page.screenshot({
        path: path.join(artifactDir, `${result.name}.png`),
        animations: 'disabled',
      })

      await close.click()
      await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
      result.closeButtonWorked = true
    } catch (error) {
      result.dialogError = error instanceof Error ? error.message : String(error)
      const openDialog = page.getByTestId('config-dialog')
      if (await openDialog.isVisible().catch(() => false)) {
        await openDialog
          .getByRole('button', { name: '关闭', exact: true })
          .click()
          .catch(() => undefined)
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
    schemaVersion: 3,
    renderer: 'renderer-v2',
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
    || !layout.topbarInsideViewport
    || !layout.statusbarInsideViewport
    || layout.missingToolRows.length > 0
    || layout.rowOverlaps.length > 0
    || layout.clippedControls.length > 0
    || !layout.imagesLoaded
    || result.dialogError !== null
    || !expectedToolRows.every((id) => result.maintenanceRowIds.includes(id))
    || !result.titleVisible
    || !result.subtitleVisible
    || !result.toolTabsVisible
    || !result.cancelButtonVisible
    || !result.saveButtonVisible
    || !result.closeButtonVisible
    || !result.closeButtonWorked
    || !dialog
    || dialog.documentHorizontalOverflow
    || dialog.dialogHorizontalOverflow
    || !dialog.dialogInsideViewport
    || !dialog.contentInsideDialog
    || dialog.bodyOverflowY !== 'auto'
    || dialog.bodyHorizontalOverflow
    || !dialog.buttonsInsideDialog
    || dialog.clippedControls.length > 0
    || dialog.headerContentOverlap
    || dialog.contentFooterOverlap
    || dialog.headerTextCloseOverlap
    || dialog.footerButtonOverlaps
})

if (failed.length > 0) throw new Error(JSON.stringify(failed, null, 2))
