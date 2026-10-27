// 主程序自己的更新（#1070 第 5 步从 main.ts 的启动回调原样搬出）：用哪份更新目录（包里那份，还是 Windows
// 正式版走线路2时的直连那份）、更新服务本身、更新目录上的服务状态文件。上次下好的版本打开时装、退出时装
// 牵着窗口和退出流程，留在 main.ts。
import path from 'node:path'
import { app, autoUpdater as nativeAutoUpdater, shell } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import { accelerationOnlineNodesPath, createAccelerationNodesUpdater, resolveAccelerationNodesUrl } from '../acceleration-online-nodes'
import { previousAutoInstallFailureMessage, resolvePreviousAutoInstallFailure, type PendingUpdateRecord } from '../auto-update-install'
import { createCliModelHintsStore } from '../cli-model-hints-store'
import { runWithTrustedWindowsProcessEnvironment } from '../command-runner'
import { readDiskSpace, tightestDiskSpace, updateDownloadProbeTargets } from '../disk-space'
import type { InstalledRelease } from '../installed-release'
import { platformCapabilitiesFor } from '../platform-capabilities'
import { openWithSystemInstaller, readLinuxPackageType, resolveLinuxInstallMethod, resolveSystemPackageOpener, systemInstallerEnvironment, systemInstallerFailureMessage, type SystemInstallerError } from '../linux-deb-update'
import type { ReleaseGuardStore } from '../release-guard-store'
import type { RelayEndpointId } from '../relay-sites'
import type { RuntimeLogStore } from '../runtime-log'
import { createServiceStatusMonitor, locateServiceStatusUrl, readServiceStatus, resolveHiddenPaymentMethodsFor, resolveReleasePlatforms } from '../service-status'
import type { SystemService } from '../system-service'
import { classifyDirectFeedFailure, locateDirectUpdateFeed, packagedUpdateFeed, updateFeedLineFor } from '../update-feed-route'
import { verifyUpdatePackageDigest } from '../update-package-digest'
import { shouldVerifyUpdateSignature, verifyUpdateEntrySignature } from '../update-package-signature'
import { createUpdateRequestGuard } from '../update-request-guard'
import { installStrictUpdateCodeSignatureVerifier } from '../update-signature'
import { createUpdaterService } from '../updater'
import type { NetworkRoutes } from './network-routes'

export interface UpdateFeedOptions {
  applicationPackage: { xingmangLocalBuild?: unknown }
  routes: Pick<NetworkRoutes, 'relayRouteController' | 'readRouteStatus' | 'latestRouteStatus'>
  runtimeLog: RuntimeLogStore
}

export interface UpdaterWiringOptions {
  managerDataDirectory: string
  runtimeLog: RuntimeLogStore
  systemService: Pick<SystemService, 'readStoredConfig'>
  chromiumSessionFetch: (target: Electron.Session) => typeof fetch
  installedRelease: InstalledRelease
  unsignedChannel: boolean
  pendingUpdateAtLaunch: PendingUpdateRecord
  releaseGuardStore: ReleaseGuardStore
  releaseGuardAtLaunch: ReturnType<ReleaseGuardStore['read']>
  /** 退出交接在主窗口建好以后才接上，用到时再取。 */
  updateQuitHandoff: () => { prepare(): Promise<void> | undefined; abort(): void } | null
  /** 换线路时工具配置怎么改跟着服务状态文件走（R6），记在 main.ts 交给系统服务的那个开关上。 */
  setToolRouteRewriteMode: (mode: 'targeted' | 'merge') => void
}

export function createUpdateFeed(options: UpdateFeedOptions) {
  const { applicationPackage, routes: { relayRouteController, readRouteStatus, latestRouteStatus }, runtimeLog } = options
  if (process.platform === 'win32') {
    installStrictUpdateCodeSignatureVerifier(autoUpdater as typeof autoUpdater & {
      verifyUpdateCodeSignature: (publisherNames: string[], filePath: string) => Promise<string | null>
    }, {
      warn: (message) => runtimeLog.log('warn', 'updater', 'signature.publisher.cn-only', message),
    })
  }
  const localBuild = app.isPackaged && applicationPackage.xingmangLocalBuild === true
  const updateConfigPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app-update.yml')
    : path.join(app.getAppPath(), 'dev-app-update.yml')
  // 只有标准 Windows 正式版有直连那份更新目录（直连白名单里只有 Windows 的安装包）。星芒账号走
  // 直连时更新也走直连；「自动」会在运行中换线路，所以每次检查前按这会儿的线路选（feedRoute）。
  const directUpdateFeed = locateDirectUpdateFeed(updateConfigPath, {
    activeSolovEndpointId: 'direct',
    platform: process.platform,
    isPackaged: app.isPackaged,
    localBuild,
  })
  let updateFeedLine: RelayEndpointId = 'primary'
  // setFeedURL only changes transport. Keep configOnDisk intact: electron-updater
  // still reads publisherName and updaterCacheDirName there when verifying/installing.
  function useUpdateFeedLine(line: RelayEndpointId): void {
    if (!directUpdateFeed || line === updateFeedLine) return
    autoUpdater.setFeedURL((line === 'direct' ? directUpdateFeed : packagedUpdateFeed()).feed)
    updateFeedLine = line
  }
  // 应用线路在洛杉矶、可状态文件说那个域名这会儿指向香港：更新改用包里那份（C15，updateFeedLineFor）。
  // 状态文件只在这里顺手刷新（10 分钟缓存），读到的下一次检查才用上；读不到照旧。
  function currentUpdateFeedLine(): RelayEndpointId {
    const line = relayRouteController.route('solov').line
    if (directUpdateFeed && line === 'direct') void readRouteStatus({ fresh: false }).catch(() => null)
    return updateFeedLineFor(line, latestRouteStatus()?.status ?? null)
  }
  useUpdateFeedLine(currentUpdateFeedLine())
  // 更新服务建在版本记录、待装记录读好之后（下载完成那一刻就要用它们），比上面晚，由 main.ts 在原来的位置建。
  function createUpdater(wiring: UpdaterWiringOptions) {
    const {
      managerDataDirectory, systemService, chromiumSessionFetch, installedRelease, unsignedChannel, pendingUpdateAtLaunch,
      releaseGuardStore, releaseGuardAtLaunch, updateQuitHandoff, setToolRouteRewriteMode,
    } = wiring
    let previousAutoInstallFailureReported = false
    // Linux 只有 .deb 装的能自动更新，装这一步交给系统安装程序（linux-deb-update.ts）。
    const updateInstallMethod = process.platform === 'linux'
      ? resolveLinuxInstallMethod({
        isPackaged: app.isPackaged,
        packageType: app.isPackaged ? readLinuxPackageType(process.resourcesPath) : null,
      })
      : undefined
    // electron-updater 的请求在 Electron 里没有能用的超时，增量下载停住了也不认取消令牌，中途断网
    // 还会抛没人接的异常：包住它建请求的那一处，看门狗才看得到数据还来不来、停住时掐得断
    // （见 update-request-guard.ts）。httpExecutor 没写进 electron-updater 对外的类型，只能这样取；
    // 取不到就只剩取消令牌。
    const updateRequests = createUpdateRequestGuard(Reflect.get(autoUpdater, 'httpExecutor'))
    const updaterService = createUpdaterService(autoUpdater, {
      installMethod: updateInstallMethod,
      openSystemInstaller: updateInstallMethod === 'system-installer'
        ? async (packagePath) => {
          try {
            await openWithSystemInstaller({
              packagePath,
              opener: resolveSystemPackageOpener(),
              env: systemInstallerEnvironment(process.env),
            })
            runtimeLog.log('info', 'updater', 'install.system-installer.opened', '已把新版本安装包交给系统安装程序')
          } catch (error) {
            const code = (error as Partial<SystemInstallerError> | null)?.code ?? 'UPDATE_SYSTEM_INSTALLER_FAILED'
            runtimeLog.exception('updater', 'install.system-installer.failed', error)
            if (code === 'UPDATE_PACKAGE_PATH_MISSING') throw error
            // 安装程序没起来时替客户把安装包所在的文件夹打开，双击它照样能装。
            let revealed = false
            try {
              shell.showItemInFolder(packagePath)
              revealed = true
            } catch (cause) {
              runtimeLog.exception('updater', 'install.system-installer.reveal-failed', cause)
            }
            throw Object.assign(new Error(systemInstallerFailureMessage(code, revealed)), { code })
          }
        }
        : undefined,
      quitAfterSystemInstaller: () => { app.quit() },
      installedRelease,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      localBuild,
      unsignedChannel,
      // 未签名通道（Windows）也跟着「自动更新」开关走：yoyo 2026-09-25 在项目聊天亲口
      // 同意「Windows 也自动更新」。撤回名单、分批放量、SHA-512 复核照旧生效。
      unsignedAutoUpdate: true,
      readAutoUpdate: () => systemService.readStoredConfig().autoUpdate !== false,
      // 每次运行只认一次：用户点「重新安装」后又重新下载同一版时，不该再被判成上次失败。
      previousAutoInstallFailure: (version) => {
        if (previousAutoInstallFailureReported) return null
        const failed = resolvePreviousAutoInstallFailure(version, app.getVersion(), pendingUpdateAtLaunch)
        if (!failed) return null
        previousAutoInstallFailureReported = true
        runtimeLog.log('warn', 'updater', 'install.auto.previous-failed', `上次自动安装 ${failed} 没有装上，这次不再自动装`)
        return previousAutoInstallFailureMessage(process.platform)
      },
      verifyPackageDigest: verifyUpdatePackageDigest,
      // electron-updater 按 `uname -a`（带电脑名）判断 Apple 芯片，Intel Mac 会被挑上 arm64 包（#1155）。
      // Intel 版在 Apple 芯片上经 Rosetta 跑时 process.arch 是 x64，这时照样算能跑 arm64，让它换回 M 系列芯片版。
      ...(process.platform === 'darwin' ? { macRunsArm64: process.arch === 'arm64' || app.runningUnderARM64Translation } : {}),
      // 未签名通道里 Windows 和 Linux 的清单由发布者 Ed25519 签过（update-package-signature.ts），
      // 两边的包自己都没有装前能核的签名，只认它。Mac 的包由 Squirrel.Mac 按钉住的发布证书验签。
      // Linux 从第一次对外发的那一版起清单就带签名，没有不认签名的老客户端要照顾。
      ...(unsignedChannel && shouldVerifyUpdateSignature(process.platform) ? { verifyPackageSignature: verifyUpdateEntrySignature } : {}),
      // 盘快满的电脑上别每 3 小时下一次注定失败的安装包（第二十二批 2）。
      readFreeDiskBytes: async () => {
        const targets = updateDownloadProbeTargets(process.platform, {
          localAppData: process.env.LOCALAPPDATA,
          home: app.getPath('home'),
          temp: app.getPath('temp'),
        })
        const tightest = tightestDiskSpace(await Promise.all(targets.map((target) => readDiskSpace(target))))
        return tightest ? tightest.availableBytes : null
      },
      diskShortfallSkipped: (shortfall, version) => {
        runtimeLog.log('warn', 'updater', 'download.skipped.disk', `磁盘空间不够，先不下载 ${version ?? '新版本'}`, {
          neededBytes: shortfall.neededBytes,
          freeBytes: shortfall.freeBytes,
        })
      },
      // 下载停住时看门狗靠它取消。得是 electron-updater 自己导出的这个类：它认「已取消」
      // 靠 instanceof，别处来的令牌取消后会被当成下载出错。
      createDownloadCancellation: () => new CancellationToken(),
      downloadReceivedAt: () => updateRequests?.lastReceivedAt() ?? null,
      abortDownloadRequests: (reason) => {
        const aborted = updateRequests?.abortAll(reason) ?? 0
        // 检查挂住和下载停住都从这里掐，reason 分得清是哪个看门狗（UpdateCheckAborted / UpdateDownloadAborted）。
        runtimeLog.log('info', 'updater', 'download.requests.aborted', `掐断了 ${aborted} 个停住的更新请求`, { aborted, reason: reason.name })
      },
      downloadStalled: (stall) => {
        runtimeLog.log('warn', 'updater', 'download.stalled', stall.retrying ? '更新下载停住了，换直连重下一次' : '更新下载停住了，报下载失败', {
          retrying: stall.retrying,
          transferred: stall.transferred,
          total: stall.total,
          unsettled: stall.unsettled,
          fullPackage: stall.fullPackage,
          transferEnded: stall.transferEnded,
        })
      },
      // 监视器在更新服务之后才建（它要把结果交回更新服务），这里等真正检查时再取。
      refreshServiceStatus: () => serviceStatusMonitor ? serviceStatusMonitor.refresh() : Promise.resolve(null),
      releaseGuardAtLaunch,
      rememberReleaseGuard: (guard) => releaseGuardStore.write(guard).catch((cause: unknown) => {
        runtimeLog.exception('updater', 'release-guard.save-failed', cause)
        throw cause
      }),
      enableDevelopmentUpdates: process.env.XINGMANG_UPDATE_DEV === '1',
      macInstallHandoff: process.platform === 'darwin'
        ? {
            nativeUpdateDownloadedListenerCount: () => (
              nativeAutoUpdater.listenerCount('update-downloaded')
            ),
            retryNativeCheck: () => nativeAutoUpdater.checkForUpdates(),
          }
        : undefined,
      installEnvironmentGuard: process.platform === 'win32'
        ? (launch) => runWithTrustedWindowsProcessEnvironment(launch)
        : undefined,
      prepareInstallQuit: () => updateQuitHandoff()?.prepare(),
      installQuitAborted: () => { updateQuitHandoff()?.abort() },
      reportBackgroundError: (error) => runtimeLog.exception('updater', 'download.background.failed', error),
      retryWithoutProxy: async () => {
        await autoUpdater.netSession.setProxy({ mode: 'direct' })
      },
      // Bypassing the proxy is a per-request escape hatch, so the updater
      // session goes back to the default resolution as soon as the request is
      // over. 'system' is the mode a freshly created session already has.
      restoreProxy: async () => {
        await autoUpdater.netSession.setProxy({ mode: 'system' })
      },
      feedRoute: directUpdateFeed
        ? {
            prepare: () => useUpdateFeedLine(currentUpdateFeedLine()),
            // 「自动」时直连那份没查通：换回包里那份当场再查一次。连不上一类的报给线路那边再查直连；
            // 白名单 404 只是那一个文件的事，下次检查照样先走直连。
            fallBack: (error) => {
              if (updateFeedLine !== 'direct' || !relayRouteController.route('solov').automatic) return false
              const failure = classifyDirectFeedFailure(error)
              if (!failure) return false
              if (failure.lineFailure) relayRouteController.reportFailure('solov', 'direct', failure.reason)
              useUpdateFeedLine('primary')
              runtimeLog.log('info', 'updater', 'feed.fallback', '更新检查在线路2上没走通，改走线路1再查一次', { reason: failure.reason })
              return true
            },
          }
        : undefined,
    })
    // 更新目录上的服务状态文件：发布者在那里标「正在维护」，没登录的人也能看到。
    // 只在更新开着的包里读（地址来自安装包自己的更新配置）；读不到当没在维护，
    // 请求在后台走，不挡启动。Linux 上不是 .deb 装的那种更新关着，可维护提示照样
    // 要让他看到。
    const serviceStatusUrl = updaterService.getState().phase === 'disabled' && updateInstallMethod !== 'manual'
      ? null
      : locateServiceStatusUrl(updateConfigPath, { allowLocalHttp: !app.isPackaged })
    // 型号表也记在本地（#1154 第 6 条）：开机那轮换下架型号时状态文件还没读成功，也按上次读成功的那份算。
    const cliModelHintsStore = createCliModelHintsStore({ filePath: path.join(managerDataDirectory, 'cli-model-hints.json') })
    const cliModelsAtLaunch = serviceStatusUrl ? cliModelHintsStore.read() : null
    const serviceStatusMonitor = serviceStatusUrl
      ? createServiceStatusMonitor({
        // 状态文件和更新目录在一起：更新走直连那份时，状态文件也读直连上的那份。
        read: () => readServiceStatus({
          url: directUpdateFeed && updateFeedLine === 'direct' ? directUpdateFeed.serviceStatusUrl : serviceStatusUrl,
          fetch: chromiumSessionFetch(autoUpdater.netSession),
        }),
        onChange: (status) => {
          updaterService.setServiceStatus(status)
          const toolRouteRewriteMode = status?.toolRouteRewrite === 'merge' ? 'merge' : 'targeted'
          setToolRouteRewriteMode(toolRouteRewriteMode)
          runtimeLog.log('info', 'updater', 'service-status.changed', status?.maintenance ? '服务状态文件：正在维护' : '服务状态文件：没在维护', {
            maintenance: Boolean(status?.maintenance),
            toolRouteRewrite: toolRouteRewriteMode,
            ...(status?.accountGroups ? { accountGroups: status.accountGroups } : {}),
            ...(status?.cliModels ? { cliModels: status.cliModels } : {}),
          })
          // 读成功的才记，没写型号表的那次记成没有；没读到（null）不动记下的那份。
          if (status) {
            cliModelHintsStore.write(status.cliModels ?? null).catch((cause: unknown) => {
              runtimeLog.exception('updater', 'cli-models.save-failed', cause)
            })
          }
        },
      })
      : null
    serviceStatusMonitor?.start()
    // 充值方式开关跟分组对照一样搭启动那次读的便车，这次没读到就用上一次读成功的那份：一次定时读失败
    // 不该把刚藏掉的那种付款方式又放出来。版本和平台按更新服务的同一套写法去对。
    const releasePlatforms = resolveReleasePlatforms({
      platform: process.platform,
      arch: process.arch,
      ...(process.platform === 'darwin' ? { macRunsArm64: process.arch === 'arm64' || app.runningUnderARM64Translation } : {}),
    })
    async function hiddenPaymentMethods(): Promise<string[]> {
      if (!serviceStatusMonitor) return []
      await serviceStatusMonitor.settled()
      return resolveHiddenPaymentMethodsFor(serviceStatusMonitor.lastKnown(), app.getVersion(), releasePlatforms)
    }
    // 在线换节点（acceleration-online-nodes.ts）：节点文件跟状态文件放在一起，读法也一样，只有能加速的平台读。
    // 一律读包里那份更新目录：直连那份只放行白名单里的文件。日志里只有发布时间和线路条数，不写节点内容（I13）。
    const accelerationNodes = serviceStatusUrl && platformCapabilitiesFor(process.platform).acceleration
      ? createAccelerationNodesUpdater({
        url: resolveAccelerationNodesUrl(serviceStatusUrl),
        filePath: accelerationOnlineNodesPath(managerDataDirectory),
        fetch: chromiumSessionFetch(autoUpdater.netSession),
        onUpdated: (document) => runtimeLog.log('info', 'network', 'acceleration.nodes.updated', document.profile
          ? '已换上在线发布的加速节点，下一次连接起用'
          : '在线加速节点已撤回，下一次连接起改用安装包自带的节点', {
          issuedAt: document.issuedAt,
          ...(document.profile ? { lines: document.profile.nodes.length } : { withdrawn: true }),
        }),
        onRejected: (reason) => runtimeLog.log('warn', 'network', 'acceleration.nodes.rejected',
          '在线加速节点没有通过校验，继续用记下的那份或安装包自带的', { reason }),
        onStoreFailed: (error) => runtimeLog.exception('network', 'acceleration.nodes.save-failed', error),
      })
      : null
    if (accelerationNodes) {
      // 客服看日志时要知道这台电脑现在连的是哪一份节点。
      void accelerationNodes.stored().then((document) => runtimeLog.log('info', 'network', 'acceleration.nodes.source',
        document?.profile ? '加速用的是在线发布的节点' : '加速用的是安装包自带的节点',
        document ? { issuedAt: document.issuedAt, ...(document.profile ? {} : { withdrawn: true }) } : undefined))
      accelerationNodes.start()
    }
    runtimeLog.log('info', 'updater', 'runtime.selected', '主程序更新运行模式已确定', {
      enabled: updaterService.getState().phase !== 'disabled',
      localBuild,
      unsignedChannel,
      ...(updateInstallMethod ? { installMethod: updateInstallMethod } : {}),
      signatureVerification: unsignedChannel ? 'none' : 'strict',
      requestGuard: updateRequests !== null,
      updateFeedRoute: directUpdateFeed ? updateFeedLine : 'packaged',
      // 开机时有没有上次记下的撤回名单和分批放量：状态文件读不到时，客服靠这一项看出还拦着没有。
      storedReleaseGuard: releaseGuardAtLaunch !== null,
    })
    if (unsignedChannel) {
      runtimeLog.log(
        'warn',
        'updater',
        'channel.unsigned',
        '本机为未签名更新通道，安装包签名未校验；下载后强制校验安装包 SHA-512，是否自动下载与安装跟随「自动更新」开关',
      )
    }
    return { updaterService, serviceStatusMonitor, accelerationNodes, cliModelsAtLaunch, hiddenPaymentMethods }
  }
  return { createUpdater }
}
