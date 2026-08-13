import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const npmProviders = ['claude', 'codex', 'gemini']

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function externalVersionSourceFailure(message) {
  return /(?:x\.ai|official|mirror|manifest|registry|source|network|proxy|timeout|timed out|dns|fetch|json|response|http|tls|certificate|connect|econn|enotfound|官方|镜像|清单|注册表|版本源|网络|代理|超时|连接|响应|返回|证书)/i.test(message)
}

const runtimeLogExemptionPolicies = [
  {
    id: 'development-updater-disabled',
    basis: '开发态主程序更新器默认禁用，disabled 是预期状态。',
    matches: (entry) => entry.source === 'updater'
      && entry.event === 'state.changed'
      && entry.detail?.phase === 'disabled',
  },
  {
    id: 'grok-remote-update-source-unavailable',
    basis: 'Grok 本地版本已成功识别时，x.ai 官方在线版本源可因无代理或网络限制不可达。',
    matches: (entry, context) => entry.source === 'system'
      && entry.event === 'cli.update-check.failed'
      && entry.detail?.provider === 'grok'
      && nonEmptyText(context.systemSnapshot?.clis?.grok?.version)
      && externalVersionSourceFailure(entry.message),
  },
  {
    id: 'codex-desktop-remote-update-source-unavailable',
    basis: 'Codex 桌面端官方或国内镜像在线版本源可因网络限制不可达，不影响本地安装状态识别。',
    matches: (entry) => entry.source === 'system'
      && entry.event === 'desktop.update-check.failed'
      && externalVersionSourceFailure(entry.message),
  },
]

async function waitForConfigModelState(page, dialog, timeout = 15_000) {
  try {
    await page.waitForFunction(() => {
      const configDialog = document.querySelector('.config-dialog')
      if (!configDialog) return false
      const modelStatus = configDialog.querySelector('.model-count')?.textContent?.trim() ?? ''
      const detectButton = configDialog.querySelector('.detect-models-button')
      return modelStatus !== '正在查询可用模型'
        && detectButton?.textContent?.trim() !== '检测中'
        && !detectButton?.querySelector('.spin')
    }, null, { timeout })
  } catch {
    return false
  }
  return dialog.getByLabel('使用模型').evaluate((select) => !select.closest('.field')?.textContent?.includes('正在查询可用模型'))
}

async function inspectManagementPageTerminalState(page, pageRoot, id, timeout = 60_000) {
  let settled = true
  try {
    await page.waitForFunction((pageId) => {
      const root = document.querySelector(`.main-content [data-page-id="${pageId}"]`)
      if (!root) return false
      const busy = [...root.querySelectorAll('[aria-busy="true"]')].length > 0
      const toolbarLoading = Boolean(root.querySelector('.page-toolbar .spin'))
      const loadingCopy = [...root.querySelectorAll('h2')].some((heading) => (
        heading.textContent?.trim().startsWith('正在读取')
      ))
      return !busy && !toolbarLoading && !loadingCopy
    }, id, { timeout })
  } catch {
    settled = false
  }
  const busyRegionCount = await pageRoot.locator('[aria-busy="true"]').count()
  const toolbarLoadingCount = await pageRoot.locator('.page-toolbar .spin').count()
  const loadingMessageCount = await pageRoot.getByRole('heading', { name: /^正在读取/ }).count()
  const errors = await pageRoot.locator('[role="alert"]').allInnerTexts()
  return {
    settled: settled && busyRegionCount === 0 && toolbarLoadingCount === 0 && loadingMessageCount === 0,
    busyRegionCount,
    toolbarLoadingCount,
    loadingMessageCount,
    errors: errors.map((message) => message.trim()).filter(Boolean),
  }
}

function auditRuntimeLogs(snapshot, systemSnapshot) {
  const failures = []
  const exemptions = []
  for (const entry of snapshot.entries) {
    if (entry.level !== 'error' && entry.level !== 'warn') continue
    const policy = runtimeLogExemptionPolicies.find((candidate) => (
      candidate.matches(entry, { systemSnapshot })
    ))
    const summary = {
      id: entry.id,
      timestamp: entry.timestamp,
      level: entry.level,
      source: entry.source,
      event: entry.event,
      message: entry.message,
    }
    if (policy) {
      exemptions.push({ ...summary, policy: policy.id, basis: policy.basis })
    } else {
      failures.push(summary)
    }
  }
  return {
    policies: runtimeLogExemptionPolicies.map(({ id, basis }) => ({ id, basis })),
    totalEntries: snapshot.total,
    reviewedEntries: snapshot.entries.length,
    truncated: snapshot.truncated,
    exemptions,
    failures,
  }
}

const artifactDir = path.resolve('artifacts')
await fs.mkdir(artifactDir, { recursive: true })
const testUserDataDir = path.join(artifactDir, '.e2e-dashboard-user-data')
const testHomeDir = path.join(artifactDir, '.e2e-dashboard-home')
const testCodexHomeDir = path.join(testHomeDir, '.codex')
const testNpmPrefix = path.join(testHomeDir, '.local')
const testNpmBinDir = path.join(testNpmPrefix, 'bin')
const testCodexPackageRoot = path.join(testNpmPrefix, 'lib', 'node_modules', '@openai', 'codex')
const testCodexEntrypoint = path.join(testCodexPackageRoot, 'bin', 'codex.js')
await fs.rm(testUserDataDir, { recursive: true, force: true })
await fs.rm(testHomeDir, { recursive: true, force: true })
// 登录先行(2026-08-11)之后,账号站点在未登录时进的是欢迎页而不是工作台,
// 于是这个只验主界面的冒烟测试永远等不到 .app-shell。本测试要断言的是工作台
// 本身,不是账号流程,所以预置成「Key 直连」站点(manual-key,无账号后端)——
// 这是产品里真实存在的一种配置,不需要伪造任何登录态或凭据。
// 账号站点的登录门本身另有 src/App.test.tsx 的用例覆盖。
// workspace 不能省:parseSettingsValue 的 requireWorkspace 缺字段就抛错,
// 整份设置会被判无效而回落默认值,relaySiteId 一并丢失(本测试初次修复时
// 就踩了这个坑——表现为界面仍停在欢迎页,像是站点没生效)。
await fs.mkdir(testUserDataDir, { recursive: true })
await fs.writeFile(
  path.join(testUserDataDir, 'settings.json'),
  `${JSON.stringify({ version: 2, workspace: testHomeDir, relaySiteId: 'sub2api' }, null, 2)}\n`,
  'utf8',
)
await fs.mkdir(path.join(testCodexHomeDir, 'packages'), { recursive: true })
await fs.mkdir(path.dirname(testCodexEntrypoint), { recursive: true })
await fs.mkdir(testNpmBinDir, { recursive: true })
await fs.writeFile(
  path.join(testCodexPackageRoot, 'package.json'),
  `${JSON.stringify({ name: '@openai/codex', version: '0.146.0', bin: { codex: 'bin/codex.js' } }, null, 2)}\n`,
  'utf8',
)
await fs.writeFile(
  testCodexEntrypoint,
  [
    '#!/usr/bin/env node',
    "const argv = process.argv.slice(2)",
    "if (argv.includes('--version')) console.log('codex-cli 0.146.0')",
    "else if (argv[0] === 'mcp' && argv[1] === 'list') console.log('[]')",
    "else if (argv[0] === 'plugin' && argv[1] === 'list') console.log(JSON.stringify({ installed: [], available: [] }))",
    "else if (argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'list') console.log(JSON.stringify({ marketplaces: [] }))",
    "else { console.error(`unsupported smoke fixture command: ${argv.join(' ')}`); process.exitCode = 2 }",
    '',
  ].join('\n'),
  'utf8',
)
await fs.chmod(testCodexEntrypoint, 0o700)
if (process.platform === 'win32') {
  await fs.writeFile(
    path.join(testNpmBinDir, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${testCodexEntrypoint}" %*\r\n`,
    'utf8',
  )
} else {
  await fs.symlink(path.relative(testNpmBinDir, testCodexEntrypoint), path.join(testNpmBinDir, 'codex'))
}
await fs.writeFile(
  path.join(testCodexHomeDir, 'config.toml'),
  [
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
  ].join('\n'),
  'utf8',
)
await fs.writeFile(
  path.join(testCodexHomeDir, 'auth.json'),
  `${JSON.stringify({ OPENAI_API_KEY: 'e2e-smoke-placeholder-key' }, null, 2)}\n`,
  'utf8',
)

const application = await electron.launch({
  args: ['.', `--user-data-dir=${testUserDataDir}`],
  env: {
    ...process.env,
    HOME: testHomeDir,
    USERPROFILE: testHomeDir,
    PATH: [testNpmBinDir, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    npm_config_prefix: testNpmPrefix,
    XINGMANG_CODEX_HOME_OVERRIDE: testCodexHomeDir,
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
  },
})
const page = await application.firstWindow()
const pageErrors = []
const nativeDialogs = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('dialog', async (dialog) => {
  nativeDialogs.push({ type: dialog.type(), message: dialog.message() })
  await dialog.dismiss()
})

try {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => !document.body.textContent?.includes('检测中...'), null, { timeout: 60_000 })
  const windowMetrics = await application.evaluate(({ BrowserWindow, screen }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    if (!browserWindow) return null
    const bounds = browserWindow.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workAreaSize
    return {
      bounds,
      expected: {
        width: Math.min(1590, workArea.width),
        height: Math.min(875, workArea.height),
      },
    }
  })
  const platformCapabilities = await page.evaluate(() => window.xingmang.getPlatformCapabilities())

  const result = {
    title: await page.title(),
    bodyText: await page.locator('body').innerText(),
    viewport: page.viewportSize(),
    windowMetrics,
    platformCapabilities,
    horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    pageErrors,
  }
  let systemSnapshot = null
  result.systemSnapshotError = null
  try {
    systemSnapshot = await page.evaluate(() => window.xingmang.scanSystem())
  } catch (error) {
    result.systemSnapshotError = error instanceof Error ? error.message : String(error)
  }
  result.systemAudit = {
    runtime: systemSnapshot?.runtime ?? null,
    clis: systemSnapshot?.clis ?? null,
    installedRuntimeVersionFailures: systemSnapshot
      ? Object.entries(systemSnapshot.runtime)
          .filter(([, status]) => status.installed && !nonEmptyText(status.version))
          .map(([id]) => id)
      : ['system-snapshot-unavailable'],
    npmUpdateFailures: systemSnapshot
      ? npmProviders.filter((provider) => {
          const status = systemSnapshot.clis[provider]
          return status.installed && (status.updateCheck !== 'checked'
            || status.updateSource !== 'npm'
            || !nonEmptyText(status.latestVersion)
            || status.updateError !== null)
        })
      : [...npmProviders],
    grokLocalVersionFailure: Boolean(
      systemSnapshot?.clis?.grok?.installed
      && !nonEmptyText(systemSnapshot.clis.grok.version),
    ),
  }
  const themeToggle = page.locator('.sidebar .theme-toggle')
  result.themeToggleVisible = await themeToggle.isVisible()
  result.defaultThemeDark = await page.locator('html').getAttribute('data-theme') === 'dark'
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  result.darkThemeApplied = await page.evaluate(() => (
    document.documentElement.dataset.theme === 'dark'
      && window.localStorage.getItem('xingmang-theme-v2') === 'dark'
  ))
  await page.waitForTimeout(220)
  result.darkTitleBarApplied = await page.locator('.window-titlebar').evaluate((titlebar) => (
    getComputedStyle(titlebar).backgroundColor !== 'rgb(255, 255, 255)'
  ))
  result.darkGreenLaunchButtonsApplied = await page.locator('.cli-card .launch-button').evaluateAll((buttons) => (
    buttons.every((button) => {
      const color = getComputedStyle(button).backgroundColor.match(/\d+/g)?.map(Number) ?? []
      return color.length >= 3 && color[1] > color[0] && color[1] > color[2]
    })
  ))
  const networkLocation = page.locator('.network-location')
  result.networkLocationVisible = await networkLocation.isVisible()
  result.networkLocationText = (await networkLocation.innerText()).trim()
  result.networkLocationFormatValid = result.networkLocationText === '网络位置未知'
    || /^[^·]+ · (?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)$/i.test(result.networkLocationText)
  await page.evaluate(() => {
    const toast = document.createElement('div')
    toast.id = 'smoke-toast'
    toast.className = 'toast success'
    toast.textContent = 'CLI 已在新窗口启动'
    document.querySelector('.app-shell')?.appendChild(toast)
  })
  result.toastClearsWindowControls = await page.evaluate(() => {
    const toast = document.querySelector('#smoke-toast')?.getBoundingClientRect()
    const titlebar = document.querySelector('.window-titlebar')?.getBoundingClientRect()
    const toolbarButtons = [...document.querySelectorAll('.page-header .header-actions button, .page-header .page-toolbar button')]
      .map((button) => button.getBoundingClientRect())
    if (!toast || !titlebar || !toolbarButtons.length) return false
    const overlapsToolbar = toolbarButtons.some((button) => !(
      toast.right <= button.left
      || toast.left >= button.right
      || toast.bottom <= button.top
      || toast.top >= button.bottom
    ))
    return toast.top >= titlebar.bottom
      && toast.left >= 0
      && toast.right <= window.innerWidth
      && !overlapsToolbar
  })
  await page.screenshot({ path: path.join(artifactDir, 'toast-position-dark.png') })
  await page.evaluate(() => document.querySelector('#smoke-toast')?.remove())
  await page.screenshot({ path: path.join(artifactDir, 'dashboard-dark.png') })
  await page.locator('.cli-card').first().getByRole('button', { name: '配置' }).click()
  const darkConfigDialog = page.getByRole('dialog', { name: 'Codex 桌面端 配置' })
  await darkConfigDialog.waitFor({ state: 'visible' })
  result.darkConfigModelStateSettled = await waitForConfigModelState(page, darkConfigDialog)
  result.darkConfigDialogApplied = await darkConfigDialog.evaluate((dialog) => (
    getComputedStyle(dialog).backgroundColor !== 'rgb(255, 255, 255)'
  ))
  await page.screenshot({ path: path.join(artifactDir, 'api-config-dark.png') })
  await darkConfigDialog.getByTitle('关闭配置').click()
  await application.evaluate(({ BrowserWindow }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    browserWindow?.webContents.send('update:state-changed', {
      phase: 'available',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      releaseName: '星芒AI管理工具 0.2.0',
      releaseNotesText: '冒烟测试更新',
      checkedAt: new Date().toISOString(),
      progress: null,
      error: null,
      development: true,
    })
  })
  const globalUpdateButton = page.getByRole('button', { name: '发现主程序新版本 0.2.0' })
  await globalUpdateButton.waitFor({ state: 'visible' })
  result.globalUpdateIndicatorVisible = await globalUpdateButton.isVisible()
  result.globalUpdateRingVisible = await globalUpdateButton.locator('.brand-update-ring').isVisible()
  result.globalUpdateRingAnimated = await globalUpdateButton.locator('.brand-update-ring').evaluate((ring) => (
    getComputedStyle(ring).animationName.includes('brand-update-ring-pulse')
  ))
  result.globalUpdateArrowVisible = await globalUpdateButton.locator('.brand-update-ring svg').count() === 1
  await globalUpdateButton.click()
  const updatePageFromIndicator = page.locator('.main-content [data-page-id="updates"]')
  await updatePageFromIndicator.waitFor({ state: 'visible' })
  result.globalUpdateIndicatorNavigates = await updatePageFromIndicator.getByRole('heading', { name: '检查更新', exact: true }).isVisible()
    && await updatePageFromIndicator.getByText('0.2.0', { exact: true }).isVisible()
  result.updateReleaseNotesVisible = await updatePageFromIndicator.getByLabel('更新日志').getByText('冒烟测试更新', { exact: true }).isVisible()
  await page.screenshot({ path: path.join(artifactDir, 'global-update-indicator.png') })
  await page.locator('.main-nav').getByRole('button', { name: '工具概览', exact: true }).click()
  const collapseButton = page.getByRole('button', { name: '收起侧边栏' })
  result.sidebarCollapseVisible = await collapseButton.isVisible()
  await collapseButton.click()
  await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed'))
  await page.waitForTimeout(240)
  result.sidebarCollapsed = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar')
    return Boolean(sidebar && sidebar.getBoundingClientRect().width <= 72)
  })
  result.sidebarCollapsedPersisted = await page.evaluate(() => (
    window.localStorage.getItem('xingmang-sidebar-collapsed') === 'true'
  ))
  const collapsedOverview = page.locator('.sidebar-collapsed .nav-item[data-sidebar-tooltip="工具概览"]')
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.show()
    window?.focus()
  })
  await page.bringToFront()
  await collapsedOverview.hover({ force: true })
  await page.waitForFunction(() => {
    const item = document.querySelector('.sidebar-collapsed .nav-item[data-sidebar-tooltip="工具概览"]')
    if (!item || !item.matches(':hover')) return false
    const tooltip = getComputedStyle(item, '::after')
    return Number.parseFloat(tooltip.opacity) > 0.9
      && tooltip.visibility === 'visible'
      && tooltip.content.includes('工具概览')
  })
  result.sidebarTooltipVisible = await collapsedOverview.evaluate((item) => {
    const tooltip = getComputedStyle(item, '::after')
    return Number.parseFloat(tooltip.opacity) > 0.9
      && tooltip.visibility === 'visible'
      && tooltip.content.includes('工具概览')
  })
  await page.screenshot({ path: path.join(artifactDir, 'sidebar-collapsed-dark.png') })
  await page.getByRole('button', { name: '展开侧边栏' }).click()
  await page.waitForFunction(() => !document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed'))
  result.sidebarExpandedAgain = await page.getByText('工具概览', { exact: true }).first().isVisible()
  const navigationPages = [
    {
      id: 'sessions',
      label: '会话管理',
      heading: '会话管理',
      keyControl: (root) => root.getByRole('textbox', { name: '搜索会话' }),
    },
    {
      id: 'mcp',
      label: 'MCP 管理',
      heading: 'MCP 管理',
      keyControl: (root) => root.getByRole('textbox', { name: '搜索 MCP' }),
    },
    {
      id: 'skills',
      label: 'Skills 管理',
      heading: 'Skills 管理',
      keyControl: (root) => root.getByRole('group', { name: 'Skill 范围' }),
    },
    {
      id: 'plugins',
      label: '插件市场',
      heading: 'Plugins / 市场',
      keyControl: (root) => root.getByRole('tablist', { name: 'Plugin 视图' }),
    },
    {
      id: 'backups',
      label: '配置备份',
      heading: '配置备份',
      keyControl: (root) => root.getByRole('combobox', { name: '选择 AI 工具' }),
    },
    {
      id: 'health',
      label: '健康诊断',
      heading: '健康诊断',
      keyControl: (root) => root.getByRole('button', { name: /^(运行诊断|诊断中)$/ }),
    },
    {
      id: 'maintenance',
      label: '安装维护',
      heading: '安装维护',
      keyControl: (root) => root.locator('.maintenance-cli-section .maintenance-row .secondary-button').first(),
    },
    {
      id: 'feedback',
      label: '反馈与诊断',
      heading: '反馈与诊断',
      keyControl: (root) => root.getByRole('textbox', { name: '搜索运行日志' }),
    },
    {
      id: 'updates',
      label: '检查更新',
      heading: '检查更新',
      keyControl: (root) => root.getByRole('button', { name: '检查更新', exact: true }),
    },
    {
      id: 'settings',
      label: '设置',
      heading: '设置',
      keyControl: (root) => root.getByRole('group', { name: '主题' }),
    },
  ]
  // Sidebar IA (navigation.ts / Sidebar.tsx, nav scheme A #67 W1): 'use'
  // (工具概览/会话管理/无限画布) and 'extensions' (MCP/Skills/插件市场) render
  // inline; the other six pages live behind "更多", collapsed by default (a
  // fresh profile has no persisted app-settings sidebarMoreExpanded). The
  // toggle itself is a .nav-item, so 7 top-level items are visible before
  // anyone expands anything (docs/PROPOSAL-nav-onboarding.md: "✓≤8").
  const topLevelNavLabels = ['工具概览', '会话管理', '无限画布', 'MCP 管理', 'Skills 管理', '插件市场', '更多']
  const moreGroupPageIds = new Set(['backups', 'health', 'maintenance', 'feedback', 'updates', 'settings'])
  const sidebarNavigationItems = page.locator('.main-nav .nav-item')
  result.navigationItemCount = await sidebarNavigationItems.count()
  result.navigationItemsFullyVisible = await sidebarNavigationItems.evaluateAll((items) => (
    items.every((item) => {
      const bounds = item.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight
    })
  ))
  const moreToggle = page.locator('.main-nav .nav-more-toggle')
  result.moreGroupCollapsedByDefault = await moreToggle.getAttribute('aria-expanded') === 'false'
    && await page.locator('#sidebar-more-items').count() === 0
  await moreToggle.click()
  await page.locator('#sidebar-more-items').waitFor({ state: 'visible' })
  result.moreGroupExpandsOnDemand = await moreToggle.getAttribute('aria-expanded') === 'true'
    && await page.locator('#sidebar-more-items .nav-item').count() === moreGroupPageIds.size
  result.navigationPagesReachable = true
  result.navigationPagesNoHorizontalOverflow = true
  result.navigationActiveStateCorrect = true
  result.navigationPageChecks = []
  const multiProviderPageIds = new Set(['sessions', 'mcp', 'skills', 'plugins'])
  for (const { id, label, heading, keyControl } of navigationPages) {
    // "更多" was already expanded above (it stays expanded across navigation
    // — Sidebar's onNavigate never touches moreExpanded), so every page's
    // button, grouped or not, is reachable through the same container.
    await page.locator('.main-nav').getByRole('button', { name: label, exact: true }).click()
    const pageRoot = page.locator(`.main-content [data-page-id="${id}"]`)
    await pageRoot.waitFor({ state: 'visible', timeout: 10_000 })
    if (id === 'mcp' || id === 'plugins') {
      result[`${id}TerminalState`] = await inspectManagementPageTerminalState(page, pageRoot, id)
    }
    if (id === 'maintenance') {
      await pageRoot.locator('.maintenance-cli-section .maintenance-row').first().waitFor({ state: 'visible', timeout: 60_000 })
      result.maintenanceCliActions = await pageRoot.locator('.maintenance-cli-section .maintenance-row').evaluateAll((rows) => rows.map((row) => ({
        state: row.querySelector('.operation-state')?.textContent?.trim() ?? '',
        action: row.querySelector('.secondary-button')?.textContent?.trim() ?? '',
      })))
      result.maintenanceCliUninstallButtonCount = await pageRoot.locator('.maintenance-cli-section .maintenance-uninstall-button').count()
      result.maintenanceCliUninstallContractCorrect = await pageRoot.locator('.maintenance-cli-section .maintenance-row').evaluateAll((rows) => rows.every((row) => {
        const state = row.querySelector('.operation-state')?.textContent?.trim() ?? ''
        const button = row.querySelector('.maintenance-uninstall-button')
        const guidance = row.querySelector('.uninstall-guidance')?.textContent?.trim() ?? ''
        if (!(button instanceof HTMLButtonElement)) return false
        const manualHelp = button.classList.contains('maintenance-help-button')
        if (state === '未安装') return button.disabled && !manualHelp
        if (manualHelp) return !button.disabled
          && button.textContent?.trim().includes('卸载帮助') === true
          && guidance.length > 0
        return !button.disabled && button.textContent?.trim().includes('卸载') === true
      }))
      result.maintenanceCliManualUninstallCount = await pageRoot.locator(
        '.maintenance-cli-section .maintenance-help-button',
      ).count()
      const desktopUninstallButton = pageRoot.locator('.maintenance-desktop-section .maintenance-uninstall-button')
      const desktopUninstallButtonCount = await desktopUninstallButton.count()
      result.maintenanceDesktopUninstallContractCorrect = platformCapabilities.codexDesktop.uninstall
        ? desktopUninstallButtonCount === 1 && await desktopUninstallButton.isVisible()
        : desktopUninstallButtonCount === 0
      result.maintenanceInstallDirectoriesHidden = await pageRoot.getByText(/^安装目录：/).count() === 0
      result.maintenanceCliActionsCorrect = result.maintenanceCliActions.every(({ state, action }) => (
        state === '可更新' ? action === '安装最新版'
          : state === '未安装' ? action === '安装'
            : action === '检查更新'
      ))
      result.maintenanceDesktopAction = {
        state: await pageRoot.locator('.maintenance-desktop-section .operation-state').innerText(),
        action: await pageRoot.locator('.maintenance-desktop-section .secondary-button').innerText(),
      }
      const desktopAction = result.maintenanceDesktopAction.action.trim()
      result.maintenanceDesktopActionCorrect = platformCapabilities.platform === 'macos'
        ? ['正在运行', '可打开', '未安装'].includes(result.maintenanceDesktopAction.state.trim())
          && desktopAction === '打开 Codex App'
        : result.maintenanceDesktopAction.state === '可更新'
          ? desktopAction === '安装最新版'
          : result.maintenanceDesktopAction.state === '未安装'
            ? desktopAction === '一键安装'
            : desktopAction === '检查更新'
      const availableUninstallButton = pageRoot.locator(
        '.maintenance-cli-section .maintenance-uninstall-button:not(.maintenance-help-button):not([disabled])',
      ).first()
      result.maintenanceAutomaticUninstallButtonCount = await pageRoot.locator(
        '.maintenance-cli-section .maintenance-uninstall-button:not(.maintenance-help-button):not([disabled])',
      ).count()
      result.maintenanceUninstallDialogVisible = result.maintenanceAutomaticUninstallButtonCount === 0
      result.maintenanceUninstallPreservesDataHint = result.maintenanceAutomaticUninstallButtonCount === 0
      if (result.maintenanceAutomaticUninstallButtonCount > 0) {
        const toolLabel = await availableUninstallButton.locator('xpath=ancestor::article[1]').locator('.operation-row-title strong').innerText()
        await availableUninstallButton.click()
        const uninstallDialog = page.getByRole('alertdialog', { name: `卸载 ${toolLabel}？` })
        await uninstallDialog.waitFor({ state: 'visible' })
        result.maintenanceUninstallDialogVisible = await uninstallDialog.isVisible()
        result.maintenanceUninstallPreservesDataHint = await uninstallDialog.getByText(/不删除配置、会话、Skills、Plugins 和备份/).isVisible()
        await page.screenshot({ path: path.join(artifactDir, 'tool-uninstall-dialog.png') })
        await uninstallDialog.getByRole('button', { name: '取消', exact: true }).last().click()
      }
      const shouldCheckInstallSourceDialog = platformCapabilities.platform === 'windows'
        && desktopAction !== '检查更新'
      result.maintenanceInstallSourceDialogChecked = !shouldCheckInstallSourceDialog
      if (shouldCheckInstallSourceDialog) {
        await pageRoot.locator('.maintenance-desktop-section .secondary-button').click()
        const installSourceDialog = page.getByRole('dialog', { name: '选择 Codex 桌面端安装方式' })
        await installSourceDialog.waitFor({ state: 'visible' })
        const mirrorButton = installSourceDialog.getByRole('button', { name: /国内镜像/ })
        const mirrorVersionText = await installSourceDialog.locator('.mirror-source-option .install-source-version').innerText()
        const mirrorMatchesInstalled = mirrorVersionText.includes('当前已安装')
        const mirrorActionText = await installSourceDialog.locator('.mirror-source-option .install-source-action').innerText()
        result.maintenanceMirrorVersion = mirrorVersionText
        result.maintenanceMirrorActionCorrect = mirrorMatchesInstalled
          ? await mirrorButton.isDisabled() && mirrorActionText === '已是镜像最新版'
          : await mirrorButton.isEnabled() && mirrorActionText === '应用内安装'
        result.maintenanceInstallSourceDialogChecked = await mirrorButton.isVisible()
          && await installSourceDialog.getByRole('button', { name: /打开本机微软商店/ }).isVisible()
          && /^可下载版本 \d+(?:\.\d+){3}/.test(mirrorVersionText)
          && result.maintenanceMirrorActionCorrect
          && await installSourceDialog.getByText(/官方最新/).isVisible()
        await page.screenshot({ path: path.join(artifactDir, 'codex-install-source-dialog.png') })
        await installSourceDialog.getByRole('button', { name: '取消', exact: true }).click()
      }
    }
    const pageCheck = {
      id,
      rootVisible: await pageRoot.isVisible(),
      headingVisible: await pageRoot.getByRole('heading', { name: heading, exact: true }).isVisible(),
      keyControlVisible: await keyControl(pageRoot).isVisible(),
      activeStateCorrect: await page.locator('.sidebar .nav-item[aria-current="page"]').innerText() === label,
      providerTabCount: multiProviderPageIds.has(id)
        ? await pageRoot.locator('.provider-tabs [role="tab"]').count()
        : null,
    }
    result.navigationPageChecks.push(pageCheck)
    result.navigationPagesReachable = result.navigationPagesReachable
      && pageCheck.rootVisible
      && pageCheck.headingVisible
      && pageCheck.keyControlVisible
      && (pageCheck.providerTabCount === null || pageCheck.providerTabCount === 4)
    result.navigationPagesNoHorizontalOverflow = result.navigationPagesNoHorizontalOverflow
      && await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    result.navigationActiveStateCorrect = result.navigationActiveStateCorrect
      && pageCheck.activeStateCorrect
    await page.waitForTimeout(120)
    await page.screenshot({ path: path.join(artifactDir, `${id}-page-dark.png`) })
  }
  await page.locator('.main-nav').getByRole('button', { name: '工具概览', exact: true }).click()
  const overviewPage = page.locator('.main-content .dashboard-page')
  result.overviewRestoredAfterNavigation = await overviewPage.isVisible()
    && await overviewPage.getByRole('heading', { name: '工具概览', exact: true }).isVisible()
    && await overviewPage.getByRole('heading', { name: '本机环境', exact: true }).isVisible()
    && await page.locator('.main-nav .nav-item[aria-current="page"]').innerText() === '工具概览'
  await themeToggle.click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  result.lightThemeRestored = await page.evaluate(() => (
    document.documentElement.dataset.theme === 'light'
      && window.localStorage.getItem('xingmang-theme-v2') === 'light'
  ))
  await page.waitForTimeout(220)
  result.lightTitleBarApplied = await page.locator('.window-titlebar').evaluate((titlebar) => (
    getComputedStyle(titlebar).backgroundColor === 'rgb(255, 255, 255)'
  ))
  result.windowTitleVisible = await page.getByText('星芒AI管理工具', { exact: true }).isVisible()
  await page.screenshot({ path: path.join(artifactDir, 'dashboard.png') })
  result.toolCardCount = await page.locator('.cli-card').count()
  result.codexDesktopVisible = await page.getByRole('heading', { name: 'Codex 桌面端' }).isVisible()
  result.codexDesktopWindowState = await page.locator('.desktop-card .version-pill').innerText()
  const codexDesktopCardText = await page.locator('.desktop-card').innerText()
  result.codexDesktopPackageVersionVisible = platformCapabilities.platform !== 'windows'
    || /\b\d+(?:\.\d+){3}\b/.test(codexDesktopCardText)
  result.codexDesktopAppVersionHidden = !codexDesktopCardText.includes('26.721.31836')
  result.codexDesktopUpdateAvailable = codexDesktopCardText.includes('可更新至')
  result.codexDesktopUpdateActionCorrect = !result.codexDesktopUpdateAvailable
    || await page.locator('.desktop-card').getByRole('button', { name: '安装最新版', exact: true }).isVisible()
  result.codexDesktopLegacyUpdateHidden = await page.locator('.desktop-card').getByRole('button', { name: '打开更新', exact: true }).count() === 0
  result.firstToolCard = await page.locator('.cli-card').first().getByRole('heading').innerText()
  result.secondToolCard = await page.locator('.cli-card').nth(1).getByRole('heading').innerText()
  result.apiConfigNavHidden = await page.getByText('API 配置', { exact: true }).count() === 0
  result.officialWebsiteVisible = await page.getByRole('button', { name: /官方网站/ }).isVisible()
  result.officialWebsiteAtBottom = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar')
    const website = document.querySelector('.sidebar-bottom .official-site-button')
    if (!sidebar || !website) return false
    return website.getBoundingClientRect().top > sidebar.getBoundingClientRect().height / 2
  })
  result.sidebarStatusHidden = await page.locator('.sidebar-status').count() === 0
  result.nativeConfigFooterHidden = await page.getByText('本机原生配置', { exact: true }).count() === 0
  result.officialWebsiteDomainVisible = await page.getByText('api.solov.cc', { exact: true }).isVisible()
  result.tutorialDocsVisible = await page.getByRole('button', { name: /教程文档/ }).isVisible()
  result.tutorialDocsLabelVisible = await page.getByText('售后群', { exact: true }).isVisible()
  result.cardModelCount = await page.locator('.configured-model').count()
  result.configuredToolCardCount = await page.locator('.cli-card').evaluateAll((cards) => cards.filter((card) => {
    const state = card.querySelector('.config-state')?.textContent?.trim()
    return state === '星芒 AI 已配置' || state === '与 Codex CLI 共用星芒配置'
  }).length)
  result.cardModelLabelsHidden = await page.locator('.configured-model').getByText('使用模型', { exact: true }).count() === 0
  result.providerBrandIconCount = await page.locator('.cli-card .provider-icon img').count()
  result.providerBrandIconsLoaded = await page.locator('.cli-card .provider-icon img').evaluateAll(
    (icons) => icons.every((icon) => icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0),
  )
  result.launchButtonCount = await page.locator('.cli-card .launch-button').count()
  result.toolPrimaryActionCount = await page.locator('.cli-card .primary-button').count()
  result.lightGreenLaunchButtonsApplied = await page.locator('.cli-card .launch-button').evaluateAll((buttons) => (
    buttons.every((button) => {
      const color = getComputedStyle(button).backgroundColor.match(/\d+/g)?.map(Number) ?? []
      return color.length >= 3 && color[1] > color[0] && color[1] > color[2]
    })
  ))
  result.allToolCardsFullyVisible = await page.locator('.cli-card').evaluateAll((cards) => (
    cards.every((card) => {
      const bounds = card.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight
    })
  ))
  const shouldCheckCodexLaunchDialog = platformCapabilities.platform === 'windows'
    && result.codexDesktopWindowState === '窗口已打开'
  result.codexLaunchDialogChecked = !shouldCheckCodexLaunchDialog
  if (shouldCheckCodexLaunchDialog) {
    await page.locator('.desktop-card').getByRole('button', { name: '打开', exact: true }).click()
    const codexLaunchDialog = page.getByRole('alertdialog', { name: 'Codex 桌面端已运行' })
    await codexLaunchDialog.waitFor({ state: 'visible' })
    result.codexLaunchDialogVisible = await codexLaunchDialog.isVisible()
    result.codexLaunchHintVisible = await codexLaunchDialog.getByText('修改了配置请选择重启 Codex，若无修改直接打开即可。', { exact: true }).isVisible()
    result.codexDirectOpenVisible = await codexLaunchDialog.getByRole('button', { name: /^直接打开 / }).isVisible()
    result.codexRestartVisible = await codexLaunchDialog.getByRole('button', { name: /^重启 Codex / }).isVisible()
    result.codexLaunchDialogChecked = result.codexLaunchDialogVisible
      && result.codexLaunchHintVisible
      && result.codexDirectOpenVisible
      && result.codexRestartVisible
    await page.screenshot({ path: path.join(artifactDir, 'codex-launch-dialog.png') })
    await codexLaunchDialog.getByRole('button', { name: '取消', exact: true }).last().click()
  }

  await page.locator('.cli-card').first().getByRole('button', { name: '配置' }).click()
  const lightConfigDialog = page.getByRole('dialog', { name: 'Codex 桌面端 配置' })
  await lightConfigDialog.waitFor({ state: 'visible' })
  result.lightConfigModelStateSettled = await waitForConfigModelState(page, lightConfigDialog)
  await page.screenshot({ path: path.join(artifactDir, 'api-config.png') })
  result.configDialogVisible = await page.getByRole('dialog', { name: 'Codex 桌面端 配置' }).isVisible()
  result.configVisible = await page.getByRole('heading', { name: 'Codex 桌面端 配置' }).isVisible()
  result.configTabsHidden = await page.getByRole('tab').count() === 0
  result.configBrandIconVisible = await page.locator('.config-dialog .provider-icon img').isVisible()
  result.saveAndLaunchHidden = await page.getByRole('button', { name: '保存并启动' }).count() === 0
  const maskedApiKey = await page.getByLabel('API Key').inputValue()
  result.apiKeyInputType = await page.getByLabel('API Key').getAttribute('type')
  result.apiKeyMasked = /^.{5}•{8,}.{1,4}$/.test(maskedApiKey)
  result.keyGenerationLinkVisible = await page.getByRole('button', { name: /没有 Key？前往生成/ }).isVisible()
  result.modelSelectorVisible = await page.getByLabel('使用模型').isVisible()
  result.configuredModel = await page.getByLabel('使用模型').inputValue()
  result.detectModelsButtonVisible = await page.getByRole('button', { name: '检测模型' }).isVisible()
  result.workspaceHidden = await page.getByLabel('工作目录').count() === 0
  const saveConfigButton = page.getByRole('button', { name: '保存配置', exact: true })
  result.saveInitiallyDisabled = await saveConfigButton.isDisabled()
  await page.getByTitle('显示 API Key').click()
  const apiKeyInput = page.getByLabel('API Key')
  await page.waitForFunction(() => {
    const input = document.querySelector('#api-key-input')
    return input instanceof HTMLInputElement && input.value.length > 0 && !input.value.includes('•')
  }, null, { timeout: 15_000 })
  const revealedApiKey = await apiKeyInput.inputValue()
  result.apiKeyRevealPlaintext = revealedApiKey.length > 0 && !revealedApiKey.includes('•')
  await apiKeyInput.fill('sk-smoke-test-key-not-saved')
  result.saveRequiresValidationAfterKeyChange = await saveConfigButton.isDisabled()
  result.modelValidationReturnedOptions = false
  result.alternateModelAvailable = false
  result.saveEnabledAfterValidatedModelChange = false
  result.saveModeDialogVisible = false
  result.mergeModeVisible = false
  result.resetModeVisible = false
  result.resetModeDescriptionVisible = false
  result.nativeConfigVisible = await page.getByText('API Key 写入 CLI 原生配置').isVisible()
  result.installDirectoryVisible = await page.getByText('安装目录', { exact: true }).isVisible()
  result.dataDirectoryVisible = await page.getByText('数据目录', { exact: true }).isVisible()
  const displayedCodexDataDirectory = await page.locator('.data-directory-list code').innerText()
  result.dataDirectoryPathVisible = displayedCodexDataDirectory.startsWith(
    process.platform === 'win32' ? '%USERPROFILE%' : '~/',
  ) && displayedCodexDataDirectory.endsWith(process.platform === 'win32' ? '\\.codex' : '/.codex')
    && await page.locator('.data-directory-list').getByText('已识别', { exact: true }).isVisible()
  result.relayUrlHidden = await page.getByLabel('中转 URL（固定）').count() === 0
  result.detectedFiles = await page.locator('.config-file-list').getByText('已存在', { exact: true }).count()
  await page.getByTitle('关闭配置').click()
  const discardChangesDialog = page.getByRole('alertdialog', { name: '放弃未保存的修改？' })
  await discardChangesDialog.waitFor({ state: 'visible' })
  result.discardChangesDialogVisible = await discardChangesDialog.isVisible()
  result.discardChangesActionsVisible = await discardChangesDialog.locator('.secondary-button').filter({ hasText: '继续编辑' }).isVisible()
    && await discardChangesDialog.getByRole('button', { name: '放弃修改', exact: true }).isVisible()
  await discardChangesDialog.getByRole('button', { name: '放弃修改', exact: true }).click()
  result.nativeDialogCount = nativeDialogs.length
  result.runtimeLogError = null
  try {
    const runtimeLogs = await page.evaluate(() => window.xingmang.getRuntimeLogs(2_000))
    result.runtimeLogAudit = auditRuntimeLogs(runtimeLogs, systemSnapshot)
  } catch (error) {
    result.runtimeLogError = error instanceof Error ? error.message : String(error)
    result.runtimeLogAudit = {
      policies: runtimeLogExemptionPolicies.map(({ id, basis }) => ({ id, basis })),
      totalEntries: null,
      reviewedEntries: 0,
      truncated: null,
      exemptions: [],
      failures: [],
    }
  }

  await fs.writeFile(path.join(artifactDir, 'smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  if (
    pageErrors.length
    || result.systemSnapshotError
    || result.systemAudit.installedRuntimeVersionFailures.length > 0
    || result.systemAudit.npmUpdateFailures.length > 0
    || result.systemAudit.grokLocalVersionFailure
    || !result.darkConfigModelStateSettled
    || !result.lightConfigModelStateSettled
    || !result.mcpTerminalState?.settled
    || !result.pluginsTerminalState?.settled
    || result.runtimeLogError
    || result.runtimeLogAudit.truncated
    || result.runtimeLogAudit.failures.length > 0
    || result.horizontalOverflow
    || Math.abs((result.windowMetrics?.bounds.width ?? 0) - (result.windowMetrics?.expected.width ?? 0)) > 4
    || Math.abs((result.windowMetrics?.bounds.height ?? 0) - (result.windowMetrics?.expected.height ?? 0)) > 4
    || !result.themeToggleVisible
    || !result.defaultThemeDark
    || !result.darkThemeApplied
    || !result.darkTitleBarApplied
    || !result.darkGreenLaunchButtonsApplied
    || !result.networkLocationVisible
    || !result.networkLocationFormatValid
    || !result.toastClearsWindowControls
    || !result.darkConfigDialogApplied
    || !result.globalUpdateIndicatorVisible
    || !result.globalUpdateRingVisible
    || !result.globalUpdateRingAnimated
    || !result.globalUpdateArrowVisible
    || !result.globalUpdateIndicatorNavigates
    || !result.updateReleaseNotesVisible
    || !result.sidebarCollapseVisible
    || !result.sidebarCollapsed
    || !result.sidebarCollapsedPersisted
    || !result.sidebarTooltipVisible
    || !result.sidebarExpandedAgain
    || result.navigationItemCount !== topLevelNavLabels.length
    || !result.navigationItemsFullyVisible
    || !result.moreGroupCollapsedByDefault
    || !result.moreGroupExpandsOnDemand
    || !result.navigationPagesReachable
    || !result.navigationPagesNoHorizontalOverflow
    || !result.navigationActiveStateCorrect
    || !result.maintenanceCliActionsCorrect
    || result.maintenanceCliUninstallButtonCount !== 4
    || !result.maintenanceCliUninstallContractCorrect
    || !result.maintenanceDesktopUninstallContractCorrect
    || !result.maintenanceInstallDirectoriesHidden
    || !result.maintenanceUninstallDialogVisible
    || !result.maintenanceUninstallPreservesDataHint
    || !result.maintenanceDesktopActionCorrect
    || !result.maintenanceInstallSourceDialogChecked
    || !result.overviewRestoredAfterNavigation
    || !result.lightThemeRestored
    || !result.lightTitleBarApplied
    || !result.windowTitleVisible
    || result.toolCardCount !== 5
    || !result.codexDesktopVisible
    || !result.codexDesktopPackageVersionVisible
    || !result.codexDesktopAppVersionHidden
    || !['窗口已打开', '窗口未打开', '未安装'].includes(result.codexDesktopWindowState)
    || !result.codexDesktopUpdateActionCorrect
    || !result.codexDesktopLegacyUpdateHidden
    || result.firstToolCard !== 'Codex 桌面端'
    || result.secondToolCard !== 'Codex CLI'
    || !result.apiConfigNavHidden
    || !result.officialWebsiteVisible
    || !result.officialWebsiteAtBottom
    || !result.officialWebsiteDomainVisible
    || !result.tutorialDocsVisible
    || !result.tutorialDocsLabelVisible
    || !result.sidebarStatusHidden
    || !result.nativeConfigFooterHidden
    || result.cardModelCount !== result.configuredToolCardCount
    || !result.cardModelLabelsHidden
    || result.providerBrandIconCount !== 5
    || !result.providerBrandIconsLoaded
    || result.toolPrimaryActionCount !== 5
    || !result.lightGreenLaunchButtonsApplied
    || !result.allToolCardsFullyVisible
    || !result.codexLaunchDialogChecked
    || !result.configDialogVisible
    || !result.configVisible
    || !result.configTabsHidden
    || !result.configBrandIconVisible
    || !result.saveAndLaunchHidden
    || !result.nativeConfigVisible
    || !result.installDirectoryVisible
    || !result.dataDirectoryVisible
    || !result.dataDirectoryPathVisible
    || result.apiKeyInputType !== 'text'
    || !result.apiKeyMasked
    || !result.apiKeyRevealPlaintext
    || !result.keyGenerationLinkVisible
    || !result.modelSelectorVisible
    || !result.configuredModel
    || !result.detectModelsButtonVisible
    || !result.workspaceHidden
    || !result.saveInitiallyDisabled
    || !result.saveRequiresValidationAfterKeyChange
    || !result.relayUrlHidden
    || result.detectedFiles !== 2
    || !result.discardChangesDialogVisible
    || !result.discardChangesActionsVisible
    || result.nativeDialogCount !== 0
  ) {
    throw new Error(JSON.stringify(result))
  }
} finally {
  await application.close()
}
