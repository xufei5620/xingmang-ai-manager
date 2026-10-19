import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { directCallPositions, enclosingFunction, mainWiringFiles, moduleFunction, parseWiringFile, readMainWiringSource, startupCallback } from './bootstrap/main-source.test-support'
import { ipcEventChannels } from './ipc-contract'

// main.ts boots the whole app on import, so these read its source instead.
function mainSource() {
  return parseWiringFile(path.join(__dirname, 'main.ts'))
}

describe('main process window events', () => {
  it('never sends an IPC event to every open window', () => {
    // 画布跑第三方前端代码，支付窗口是支付商的网页：挨个窗口发，订单号、账号就送到了它们手边（#1069）。
    const broadcasts: string[] = []
    for (const file of mainWiringFiles()) {
      const { source } = parseWiringFile(file)
      function visit(node: ts.Node): void {
        if (ts.isForOfStatement(node) && /\bBrowserWindow\.getAllWindows\(\)/.test(node.expression.getText(source))
          && /\.send\(/.test(node.statement.getText(source))) {
          broadcasts.push(`${path.basename(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(broadcasts).toEqual([])
  })

  it('delivers account, payment and update events to the main window only', () => {
    const sourceText = readMainWiringSource()
    const helpers: string[] = []
    for (const file of mainWiringFiles()) {
      const { source } = parseWiringFile(file)
      function visit(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sendToMainWindow' && node.initializer) {
          helpers.push(node.initializer.getText(source))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(helpers).toHaveLength(1)
    expect(helpers[0]).toContain('managedMainWindow')
    expect(helpers[0]).not.toContain('getAllWindows')
    expect(sourceText.match(/sendToMainWindow\('onAccountSessionChanged', /g)).toHaveLength(2)
    expect(sourceText.match(/sendToMainWindow\('onAccountPaymentWindowTerminal', /g)).toHaveLength(1)
    expect(sourceText.match(/sendToMainWindow\('onUpdateState', /g)).toHaveLength(1)
    for (const event of ['onAccountSessionChanged', 'onAccountPaymentWindowTerminal', 'onUpdateState'] as const) {
      expect(sourceText).not.toContain(`ipcEventChannels.${event}`)
      expect(sourceText).not.toContain(`'${ipcEventChannels[event]}'`)
    }
  })
})

// Every `quitCleanup.add` in main.ts with what a reader needs to check its place:
// the function it runs in and the `if` it sits behind, if any.
function quitCleanupSteps() {
  const { source } = mainSource()
  const steps: Array<{ name: string, body: string, owner: ts.Node | undefined, guard: string | null }> = []
  function enclosingGuard(node: ts.Node): string | null {
    for (let child = node, parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent) && parent.thenStatement === child) return parent.expression.getText(source)
    }
    return null
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'quitCleanup.add') {
      const [name, step] = node.arguments
      if (!name || !ts.isStringLiteral(name) || !step) throw new Error(`quitCleanup.add needs a literal name: ${node.getText(source)}`)
      steps.push({ name: name.text, body: step.getText(source), owner: enclosingFunction(node), guard: enclosingGuard(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return steps
}

describe('main process quit cleanup', () => {
  it('hangs the whole quit cleanup on a single will-quit listener', () => {
    const { sourceText } = mainSource()
    expect(sourceText.match(/'will-quit'/g)).toHaveLength(1)
    expect(sourceText).toContain("app.once('will-quit', () => quitCleanup.run())")
  })

  it('registers the steps in the order the separate will-quit listeners used to run', () => {
    const steps = quitCleanupSteps()
    expect(steps.map((step) => step.name)).toEqual([
      'acceleration-power',
      'cli-hook-events',
      'keep-awake',
      'routes',
      'acceleration-notices',
      'acceleration',
      'acceleration-host',
      'runtime-log-hooks',
      'updates-and-notifications',
      'ipc',
      'business-services',
      'asset-protocol-and-windows',
      'updater',
      'display-watch',
      'power-off-watch',
      'unexpected-exit-flag',
      'unexpected-exit-handler',
      'window-lifecycle-and-tray',
    ])
    // Source order is run order only while every step is registered straight
    // from the startup callback, never from a callback that fires later.
    const owner = startupCallback(mainSource().source).getStart()
    for (const step of steps) expect(step.owner?.getStart()).toBe(owner)
  })

  it('leaves registering cleanup steps to main.ts', () => {
    // 拆到 bootstrap/ 的启动步骤把要收拾的东西交回 main.ts 登记：登记都在一处，上面钉的先后才是退出时的先后。
    for (const file of mainWiringFiles()) {
      if (file.endsWith('main.ts') || file.endsWith('lifecycle.ts')) continue
      const { sourceText } = parseWiringFile(file)
      expect({ file: path.basename(file), registers: /quitCleanup|'will-quit'/.test(sourceText) }).toEqual({ file: path.basename(file), registers: false })
    }
  })

  it('keeps the steps that only exist on some machines behind the same guards', () => {
    const guards = Object.fromEntries(quitCleanupSteps().map((step) => [step.name, step.guard]))
    expect(guards['acceleration-power']).toBe('developmentAcceleration')
    expect(guards['power-off-watch']).toBe("process.platform === 'darwin'")
    for (const [name, guard] of Object.entries(guards)) {
      if (name !== 'acceleration-power' && name !== 'power-off-watch') expect({ name, guard }).toEqual({ name, guard: null })
    }
  })

  it('disconnects acceleration after its notices, then lets the worker go exactly once', () => {
    // 独立加速进程被放掉后自己还原系统代理，失败按次数上限重试（#1265）：它必须排在加速服务之后，
    // 而且整个退出只放一次。
    const steps = quitCleanupSteps()
    const names = steps.map((step) => step.name)
    expect(names.indexOf('acceleration-notices')).toBeLessThan(names.indexOf('acceleration'))
    expect(names.indexOf('acceleration')).toBeLessThan(names.indexOf('acceleration-host'))
    const bodies = Object.fromEntries(steps.map((step) => [step.name, step.body]))
    expect(bodies.acceleration).toContain("void acceleration?.dispose().catch((error) => runtimeLog.exception('network', 'acceleration.shutdown.failed', error))")
    expect(bodies['acceleration-host']).toContain('void developmentAcceleration?.dispose().catch(() => undefined)')
    const all = steps.map((step) => step.body).join('\n')
    expect(all.match(/(?<![\w.])acceleration\?\.dispose\(\)/g)).toHaveLength(1)
    expect(all.match(/developmentAcceleration\?\.dispose\(\)/g)).toHaveLength(1)
  })
})

describe('main process startup order', () => {
  it('starts the subsystems in the order they depend on each other', () => {
    // 启动回调里直接跑的语句按源码先后执行（中间的 await 也是一句等完再走下一句），所以这里的先后就是启动时的先后。
    // 依赖举几条：线路先建好、先开始查，系统服务才拿得到线路；更新服务建在服务状态文件之前（读到的结果要交给它）；
    // 账号服务建好才恢复登录；加速宿主读完随包资源才恢复上次没改回的系统代理；通道先注册、协议先挂上，窗口才建，
    // 页面一加载就要调用它们；托盘最后建，它的菜单要读窗口和退出流程。
    const { source } = mainSource()
    const order = [
      'createQuitCleanup',
      'runCodexContextLimitsMigration',
      'createNetworkRoutes',
      'runClaudeDesktopModelRepair',
      'createDownloadAccelerationCoordinator',
      'createCodexDesktopAccelerationCoordinator',
      'createSystemService',
      'startToolRouteFollowing',
      'createUpdaterService',
      'serviceStatusMonitor?.start',
      'cliHookEvents.start',
      'createDesktopNotificationController',
      'registerApplicationProtocol',
      'createRealmAccountService',
      'createRealmBusinesses',
      'ensureBusiness',
      'protocol.handle',
      'createCanvasWindowController',
      'createPaymentWindowController',
      'settingsStore.normalize',
      'installXingmangAiSkillFiles',
      'accounts.restoreActive',
      'createAccelerationDevelopmentHost',
      'developmentAcceleration.recover',
      'createAccelerationService',
      'createTrayAccelerationCoordinator',
      'createAccelerationPower',
      'registerIpcHandlers',
      'attachTrayAvailability',
      'createWindow',
      'createWindowLifecycle',
      'lifecycle.attach',
      'createApplicationTray',
    ]
    const calls = directCallPositions(source, startupCallback(source), order)
    for (const { callee, positions } of calls) expect({ callee, calls: positions.length }).toEqual({ callee, calls: 1 })
    const started = calls.map(({ callee, positions }) => ({ callee, at: positions[0] }))
    expect([...started].sort((a, b) => a.at - b.at).map(({ callee }) => callee)).toEqual(order)
  })

  it('builds the routes before it starts checking them, and follows tool routes once a listener is attached', () => {
    // 应用线路先建、先订阅换线路的通知，再开始查；直连会话和工具线路在它们之间建好（查线路走的就是 relayFetch）。
    // 工具线路先挂上监听再开始查，换了线路才不会漏掉第一声。
    const { source } = parseWiringFile(path.join(__dirname, 'bootstrap', 'network-routes.ts'))
    const orders: Array<[string, string[]]> = [
      ['createNetworkRoutes', [
        'createRelayRouteController',
        'createSiteRouting',
        'createToolRouteController',
        'createToolRouteStatusBoard',
        'relayRouteController.subscribe',
        'relayRouteController.start',
      ]],
      ['startToolRouteFollowing', ['toolRouteController.subscribe', 'toolRouteController.start', 'powerMonitor.on', 'setInterval']],
    ]
    for (const [owner, order] of orders) {
      const calls = directCallPositions(source, moduleFunction(source, owner), order)
      for (const { callee, positions } of calls) expect({ owner, callee, calls: positions.length }).toEqual({ owner, callee, calls: 1 })
      const started = calls.map(({ callee, positions }) => ({ callee, at: positions[0] }))
      expect([...started].sort((a, b) => a.at - b.at).map(({ callee }) => callee)).toEqual(order)
    }
  })

  it('only hands a bootstrap module work from the startup callback itself', () => {
    // 从别的回调里才调用的启动步骤，先后就不再是源码里的先后了。
    const { source } = mainSource()
    const callback = startupCallback(source)
    const factories = new Set<string>()
    function collectImports(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text.startsWith('./bootstrap/') && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if (!element.isTypeOnly && !node.importClause.isTypeOnly) factories.add(element.name.text)
        }
      }
      ts.forEachChild(node, collectImports)
    }
    collectImports(source)
    const misplaced: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && factories.has(node.expression.getText(source)) && enclosingFunction(node) !== callback) {
        misplaced.push(`${node.expression.getText(source)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(factories.size).toBeGreaterThan(0)
    expect(misplaced).toEqual([])
  })
})
