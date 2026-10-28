import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { directCallPositions, enclosingFunction, innerFunction, mainWiringFiles, moduleFunction, parseWiringFile, readMainWiringSource, startupCallback } from './bootstrap/main-source.test-support'
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

  it('opens the macOS Settings menu command in the main window, brought to the front', () => {
    // 画布、付款窗口在前时按 ⌘, 以前发给了在前的那个窗口，没人接（#1210）。
    const { source } = mainSource()
    const callback = startupCallback(source)
    const menuHandlers: string[] = []
    const assignments: Array<{ value: string, owner: ts.Node | undefined }> = []
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'buildMacApplicationMenuTemplate') {
        menuHandlers.push(node.arguments[1]?.getText(source) ?? '')
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(source) === 'navigateFromAppMenu') {
        assignments.push({ value: node.right.getText(source), owner: enclosingFunction(node) })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(menuHandlers).toEqual(['(target) => navigateFromAppMenu?.(target)'])
    // Assigned once, straight from the startup callback, so it is set by the time the main window exists.
    expect(assignments).toHaveLength(1)
    expect(assignments[0].owner).toBe(callback)
    // 界面缩在托盘里被关掉时，跳页先存着，重新加载好了再发（renderer-release.ts）。
    expect(assignments[0].value).toBe("(target) => { showMainWindow(); deliverToMainWindow('onNavigate', target) }")
  })
})

// What a step runs, one entry per statement, whitespace and a trailing `;`
// dropped: a concise arrow body counts as one statement, and statements inside
// an `if` or a loop count on their own (callbacks handed to something else are
// left whole).
function stepStatements(source: ts.SourceFile, step: ts.Expression): string[] {
  function text(node: ts.Node): string {
    return node.getText(source).replace(/\s+/g, ' ').replace(/;$/, '')
  }
  if (!ts.isArrowFunction(step) && !ts.isFunctionExpression(step)) return [text(step)]
  if (!ts.isBlock(step.body)) return [text(step.body)]
  const found: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return
    if (ts.isExpressionStatement(node)) {
      found.push(text(node))
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(step.body, visit)
  return found
}

// Every `quitCleanup.add` in main.ts with what a reader needs to check its place:
// the function it runs in and the `if` it sits behind, if any.
function quitCleanupSteps() {
  const { source } = mainSource()
  const steps: Array<{ name: string, body: string, statements: string[], owner: ts.Node | undefined, guard: string | null }> = []
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
      steps.push({ name: name.text, body: step.getText(source), statements: stepStatements(source, step), owner: enclosingFunction(node), guard: enclosingGuard(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return steps
}

describe('main process quit cleanup', () => {
  it('hangs the whole quit cleanup on a single will-quit listener', () => {
    const { sourceText } = mainSource()
    expect(sourceText.match(/['"`]will-quit['"`]/g)).toHaveLength(1)
    const { source } = mainSource()
    const listeners: string[][] = []
    function visit(node: ts.Node): void {
      const [event, listener] = ts.isCallExpression(node) ? node.arguments : []
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.once' && event && ts.isStringLiteral(event)
        && event.text === 'will-quit' && listener) listeners.push(stepStatements(source, listener))
      ts.forEachChild(node, visit)
    }
    visit(source)
    // 运行日志先改成当场写，再跑清理：清理里哪一步失败、「即将退出」那一条才落得了盘（#1335 第 3 条）。
    expect(listeners).toEqual([['runtimeLog.writeSynchronouslyFromNowOn()', 'quitCleanup.run()']])
  })

  it('registers the steps in the order the separate will-quit listeners used to run', () => {
    const steps = quitCleanupSteps()
    expect(steps.map((step) => step.name)).toEqual([
      // 匿名使用统计最先停：后面那些步骤退出时报的错、窗口没响应都不该再记。
      'usage-stats',
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
      'codex-remote',
      'business-services',
      'asset-protocol-and-windows',
      'updater',
      'display-watch',
      'update-install-prompt',
      'renderer-release',
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

  it('runs exactly the teardown each step is meant to run', () => {
    // 上面只钉了步骤名和先后，步骤里删掉一句（比如 relayRouteController.dispose()）测试照过，退出时就有计时器
    // 或线路控制器没停（#1335 第 1 条）。改了哪一步要做的事，在这里跟着改。
    const statements = Object.fromEntries(quitCleanupSteps().map((step) => [step.name, step.statements]))
    expect(statements).toEqual({
      'usage-stats': [
        "app.off('browser-window-focus', resumeStallMonitor)",
        "app.off('browser-window-blur', pauseStallMonitor)",
        'mainStallMonitor.stop()',
        'detachPrivacyListener()',
        'usageStats.stop()',
        'noteUsageEvent = null',
      ],
      'acceleration-power': ["powerMonitor.off('suspend', onSuspend)", "powerMonitor.off('resume', onResume)"],
      'cli-hook-events': ['cliHookEvents.dispose()'],
      'keep-awake': [
        'cliKeepAwake.dispose()',
        'unsubscribeInstallKeepAwakeQueue()',
        'unsubscribeInstallKeepAwakeUpdate()',
        'installKeepAwake.dispose()',
        'codexRemoteKeepAwake.dispose()',
      ],
      routes: [
        'codexPayloadWatch.dispose()',
        'unsubscribeRelayRoute()',
        'unsubscribeToolRoutes()',
        'systemService.disposeToolRoutes?.()',
        'relayRouteController.dispose()',
        'toolRouteController.dispose()',
        "powerMonitor.off('resume', onRouteResume)",
        'clearInterval(routeOnlineTimer)',
      ],
      'acceleration-notices': ['accelerationExpiry?.dispose()', 'codexDesktopAcceleration.dispose()', 'claudeDesktopAcceleration.dispose()', 'accelerationInterruption?.dispose()'],
      acceleration: ["void acceleration?.dispose().catch((error) => runtimeLog.exception('network', 'acceleration.shutdown.failed', error))"],
      'acceleration-host': ['void developmentAcceleration?.dispose().catch(() => undefined)'],
      'runtime-log-hooks': [
        "runtimeLog.log('info', 'main', 'app.stopping', '应用主进程即将退出')",
        "process.off('uncaughtExceptionMonitor', onUncaughtException)",
        "process.off('unhandledRejection', onUnhandledRejection)",
      ],
      'updates-and-notifications': [
        'clearInterval(periodicUpdateTimer)',
        'serviceStatusMonitor?.dispose()',
        'accelerationNodes?.dispose()',
        'unsubscribeRemoteFeatures()',
        'unsubscribeDesktopNotifications()',
        'unsubscribeAutoUpdateInstall()',
        'desktopNotifications.dispose()',
      ],
      ipc: ['unregisterIpcHandlers()'],
      'codex-remote': ['unsubscribeRemoteFeatureFollowers()', 'codexRemote.dispose()'],
      'business-services': [
        'business.chatService.dispose()',
        'business.imageService.cancelAll()',
        'business.canvasImageService.cancelAll()',
        'business.videoService.cancelAll()',
        'business.chatVideoService.cancelAll()',
        'business.canvasRuns.shutdown()',
      ],
      'asset-protocol-and-windows': ["protocol.unhandle('xingmang-asset')", 'paymentWindow.destroy()', 'canvasController.dispose()'],
      updater: ['updaterService.dispose()'],
      'display-watch': [
        'clearTimeout(displayChangeTimer)',
        "screen.removeListener('display-removed', onDisplaysChanged)",
        "screen.removeListener('display-metrics-changed', onDisplaysChanged)",
      ],
      'update-install-prompt': ['unsubscribeUpdateInstallPrompt()', 'updateInstallPrompter.dispose()'],
      'renderer-release': ['releasedWatch.stop()', 'rendererRelease.dispose()', 'detachRendererDelivery(deliverWhenRendererReady)'],
      'power-off-watch': ["powerMonitor.off('shutdown', onPowerOff)"],
      'unexpected-exit-flag': ['appWillQuit = true'],
      'unexpected-exit-handler': ["process.off('uncaughtException', onUnexpectedException)"],
      'window-lifecycle-and-tray': ['lifecycle.dispose()', 'applicationTray?.dispose()'],
    })
  })

  it('hands every listener and interval a bootstrap module starts back to main.ts to undo', () => {
    // bootstrap/ 里挂的监听和计时器要把取消句柄交回 main.ts，在退出清理里撤掉；只挂不撤，退出时它们还在跑
    // （#1335 第 2 条）。真有不用撤的，写进 allowed（「文件 调用(句柄)」），旁边写明为什么。
    const allowed: string[] = []
    const listenerCall = /^(app|powerMonitor|process|screen|nativeTheme)\.(on|once|addListener)$/
    const cleanup = quitCleanupSteps().flatMap((step) => step.statements)
    const unhandled: string[] = []
    for (const file of mainWiringFiles()) {
      if (file.endsWith('main.ts') || file.endsWith('lifecycle.ts')) continue
      const { source } = parseWiringFile(file)
      // The names a function hands back as `return { a, b }`.
      function returnedNames(owner: ts.Node | undefined): Set<string> {
        const names = new Set<string>()
        function visit(node: ts.Node): void {
          if (ts.isReturnStatement(node) && enclosingFunction(node) === owner && node.expression && ts.isObjectLiteralExpression(node.expression)) {
            for (const property of node.expression.properties) {
              if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text)
            }
          }
          ts.forEachChild(node, visit)
        }
        if (owner) visit(owner)
        return names
      }
      function visit(node: ts.Node): void {
        const callee = ts.isCallExpression(node) ? node.expression.getText(source) : ''
        const listener = callee.match(listenerCall)
        if (ts.isCallExpression(node) && (callee === 'setInterval' || listener)) {
          const [event, callback] = node.arguments
          const handle = listener
            ? (callback && ts.isIdentifier(callback) ? callback.text : null)
            : (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : null)
          const undo = handle === null ? [] : listener
            ? [`${listener[1]}.off(${event?.getText(source)}, ${handle})`, `${listener[1]}.removeListener(${event?.getText(source)}, ${handle})`]
            : [`clearInterval(${handle})`]
          const handedBack = handle !== null && returnedNames(enclosingFunction(node)).has(handle)
          const undone = cleanup.some((statement) => undo.includes(statement))
          const name = `${path.basename(file)} ${callee}(${handle ?? '…'})`
          if (!(handedBack && undone) && !allowed.includes(name)) {
            unhandled.push(`${name} at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(unhandled).toEqual([])
  })

  it('leaves registering cleanup steps to main.ts', () => {
    // 拆到 bootstrap/ 的启动步骤把要收拾的东西交回 main.ts 登记：登记都在一处，上面钉的先后才是退出时的先后。
    for (const file of mainWiringFiles()) {
      if (file.endsWith('main.ts') || file.endsWith('lifecycle.ts')) continue
      const { sourceText } = parseWiringFile(file)
      expect({ file: path.basename(file), registers: /quitCleanup|['"`]will-quit['"`]/.test(sourceText) }).toEqual({ file: path.basename(file), registers: false })
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
    // 先停提醒，再叫加速服务断开，再放掉独立加速进程：后两步都是发出去就走、不等对方做完，这里钉的是发出去的
    // 先后和整个退出只放一次。独立加速进程被放掉后自己还原系统代理，失败按次数上限重试（#1265）。
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

describe('main process application protocol', () => {
  it('attaches the security policy to every xingmang:// file, worker scripts included', () => {
    // 页面的 <meta> 到不了后台线程，只有协议回包里的头才管得到拼片线程（app-protocol.ts）。
    const { source } = mainSource()
    const body = moduleFunction(source, 'registerApplicationProtocol').getText(source)
    expect(body).toContain("registerFileProtocol('xingmang'")
    expect(body).toContain('callback({ path: target, headers: applicationSecurityResponseHeaders() })')
    expect(body).not.toMatch(/callback\(\{ path: target \}\)/)
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
      'createAccelerationRouting',
      'createSystemService',
      'startToolRouteFollowing',
      'createDiagnostics',
      'createUpdateFeed',
      'updateFeed.createUpdater',
      'cliHookEvents.start',
      'diagnostics.attachFeedbackDescribers',
      'createDesktopNotificationController',
      'registerApplicationProtocol',
      'createAccountStorage',
      'createAccountClientFactory',
      'createRealmAccountService',
      'createRealmBusinesses',
      'ensureBusiness',
      'protocol.handle',
      'createCanvasWindowController',
      'createPaymentWindowController',
      'settingsStore.normalize',
      'installXingmangAiSkillFiles',
      'accounts.restoreActive',
      'createAccelerationHost',
      'createAccelerationServices',
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

  it('picks the update feed before it builds the updater, and reads service status once the updater exists', () => {
    // 包里那份还是直连那份更新目录开机就定（签名校验也在这时装上）；更新服务要等版本记录读好才建，
    // 服务状态文件读到的结果要交给它，所以监视器建在它后面。
    const { source } = parseWiringFile(path.join(__dirname, 'bootstrap', 'updates.ts'))
    const feed = moduleFunction(source, 'createUpdateFeed')
    const orders: Array<[ts.FunctionDeclaration, string[]]> = [
      [feed, ['installStrictUpdateCodeSignatureVerifier', 'locateDirectUpdateFeed', 'useUpdateFeedLine']],
      [innerFunction(feed, 'createUpdater'), ['createUpdateRequestGuard', 'createUpdaterService', 'createServiceStatusMonitor', 'serviceStatusMonitor?.start']],
    ]
    for (const [owner, order] of orders) {
      const calls = directCallPositions(source, owner, order)
      for (const { callee, positions } of calls) expect({ owner: owner.name?.text, callee, calls: positions.length }).toEqual({ owner: owner.name?.text, callee, calls: 1 })
      const started = calls.map(({ callee, positions }) => ({ callee, at: positions[0] }))
      expect([...started].sort((a, b) => a.at - b.at).map(({ callee }) => callee)).toEqual(order)
    }
  })

  it('wires acceleration in the order each piece reads the one before it', () => {
    // 下载用的那条专用会话先建，下载线路换了才有地方设代理；Codex 桌面端的启动线路靠上面那份自动连接兜底。
    // 宿主一建好就把上次崩溃没改回的系统代理改回去。两种提醒建在加速服务之前，加速服务一出状态就交给它们；
    // 托盘读的是加速页那一套，所以最后建。
    const { source } = parseWiringFile(path.join(__dirname, 'bootstrap', 'acceleration.ts'))
    const orders: Array<[string, string[]]> = [
      ['createAccelerationRouting', [
        'session.fromPartition',
        'createDownloadAccelerationCoordinator',
        'createCodexDesktopAccelerationCoordinator',
        'createCodexDesktopStartupRouteCoordinator',
        'createManualRedirectFetch',
      ]],
      ['createAccelerationHost', ['createAccelerationDevelopmentHost', 'developmentAcceleration.recover']],
      ['createAccelerationServices', [
        'createAccelerationExpiryNotice',
        'createAccelerationInterruptionNotice',
        'createAccelerationService',
        'createUserAccelerationApi',
        'createTrayAccelerationCoordinator',
      ]],
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
