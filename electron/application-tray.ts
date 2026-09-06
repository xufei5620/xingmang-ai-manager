import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'

export interface ApplicationTraySnapshot {
  accountLabel?: string | null
  balanceUsd?: number | null
  installedTools: readonly { id: string; label: string; enabled?: boolean }[]
  updateAvailable?: boolean
  updateVersion?: string | null
}

export type TrayNavigationTarget = 'topup' | 'updates' | 'settings'
type TrayAction = () => unknown | Promise<unknown>

export interface ApplicationTrayOptions {
  iconPath: string
  icon2xPath?: string
  templateIconPath?: string
  templateIcon2xPath?: string
  platform?: NodeJS.Platform
  appName?: string
  getSnapshot(): ApplicationTraySnapshot
  onOpen: TrayAction
  onLaunchTool(id: string): unknown | Promise<unknown>
  onNavigate(target: TrayNavigationTarget): unknown | Promise<unknown>
  onQuit: TrayAction
  onError(error: unknown): void
  onAvailabilityChange?(available: boolean): void
}

export interface ApplicationTrayHandle {
  isDestroyed(): boolean
  setToolTip(label: string): void
  setContextMenu(menu: Menu): void
  on(event: 'click' | 'double-click' | 'right-click', listener: () => void): unknown
  removeAllListeners(): unknown
  destroy(): void
}

export interface ApplicationTrayRuntime {
  createImage(iconPath: string, icon2xPath: string | undefined, template: boolean): NativeImage
  createTray(image: NativeImage): ApplicationTrayHandle
  buildMenu(template: MenuItemConstructorOptions[]): Menu
}

const nativeRuntime: ApplicationTrayRuntime = {
  createImage(iconPath, icon2xPath, template) {
    const image = nativeImage.createFromPath(iconPath)
    if (icon2xPath) {
      const retina = nativeImage.createFromPath(icon2xPath)
      if (!retina.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG() })
    }
    if (template) image.setTemplateImage(true)
    return image
  },
  createTray: (image) => new Tray(image),
  buildMenu: (template) => Menu.buildFromTemplate(template),
}

function menuLabel(value: string | null | undefined, fallback: string): string {
  const text = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100)
  return text || fallback
}

export function trayBalanceLabel(balance: number | null | undefined): string {
  return typeof balance === 'number' && Number.isFinite(balance)
    ? `USD ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '\u2014'
}

function copySnapshot(snapshot: ApplicationTraySnapshot): ApplicationTraySnapshot {
  return { ...snapshot, installedTools: snapshot.installedTools.map((tool) => ({ ...tool })) }
}

export function buildApplicationTrayMenu(
  snapshot: ApplicationTraySnapshot,
  actions: Pick<ApplicationTrayOptions, 'onOpen' | 'onLaunchTool' | 'onNavigate' | 'onQuit'>,
  run: (action: TrayAction) => void,
  appName = '星芒AI管理工具',
): MenuItemConstructorOptions[] {
  const navigate = (target: TrayNavigationTarget) => run(async () => { await actions.onOpen(); await actions.onNavigate(target) })
  return [
    { label: `打开${appName}`, click: () => run(actions.onOpen) },
    { type: 'separator' },
    { label: menuLabel(snapshot.accountLabel, '未登录'), enabled: false },
    { label: `余额：${trayBalanceLabel(snapshot.balanceUsd)}`, enabled: false },
    { type: 'separator' },
    {
      label: '已安装的工具',
      submenu: snapshot.installedTools.length
        ? snapshot.installedTools.map((tool) => ({
          label: menuLabel(tool.label, tool.id),
          enabled: tool.enabled !== false,
          click: () => run(() => actions.onLaunchTool(tool.id)),
        }))
        : [{ label: '尚未安装工具', enabled: false }],
    },
    { label: '充值', click: () => navigate('topup') },
    {
      label: snapshot.updateAvailable
        ? `软件更新：${menuLabel(snapshot.updateVersion, '有可用更新')}`
        : '软件更新',
      click: () => navigate('updates'),
    },
    { label: '设置', click: () => navigate('settings') },
    { type: 'separator' },
    { label: '退出', click: () => run(actions.onQuit) },
  ]
}

export interface ApplicationTrayController {
  readonly available: boolean
  getSnapshot(): ApplicationTraySnapshot
  updateSnapshot(snapshot?: ApplicationTraySnapshot): void
  dispose(): void
}

export function createApplicationTray(
  options: ApplicationTrayOptions,
  runtime: ApplicationTrayRuntime = nativeRuntime,
): ApplicationTrayController {
  const platform = options.platform ?? process.platform
  const appName = options.appName ?? '星芒AI管理工具'
  let tray: ApplicationTrayHandle | null = null
  let disposed = false
  let available = false
  let snapshot: ApplicationTraySnapshot = { installedTools: [] }

  const report = (error: unknown) => {
    try { options.onError(error) } catch { /* Tray callbacks cannot report through a rejected event handler. */ }
  }
  const run = (action: TrayAction) => {
    if (disposed) return
    try { void Promise.resolve(action()).catch(report) } catch (error) { report(error) }
  }
  const setAvailable = (next: boolean) => {
    if (available === next) return
    available = next
    try { options.onAvailabilityChange?.(next) } catch (error) { report(error) }
  }
  const destroy = () => {
    const current = tray
    tray = null
    if (!current) return
    try {
      current.removeAllListeners()
      if (!current.isDestroyed()) current.destroy()
    } catch (error) { report(error) }
  }
  const unavailable = (error: unknown) => {
    destroy()
    setAvailable(false)
    report(error)
    run(options.onOpen)
  }
  const checkAvailable = () => {
    if (disposed || !tray) return false
    try {
      if (tray.isDestroyed()) unavailable(new Error('系统托盘已不可用'))
    } catch (error) { unavailable(error) }
    return available
  }
  const updateSnapshot = (next?: ApplicationTraySnapshot) => {
    if (disposed) return
    try {
      snapshot = copySnapshot(next ?? options.getSnapshot())
      if (!checkAvailable() || !tray) return
      tray.setToolTip(`${appName}\n余额：${trayBalanceLabel(snapshot.balanceUsd)}`)
      tray.setContextMenu(runtime.buildMenu(buildApplicationTrayMenu(snapshot, options, run, appName)))
    } catch (error) { unavailable(error) }
  }

  try {
    const useTemplate = platform === 'darwin'
    const iconPath = useTemplate ? options.templateIconPath ?? options.iconPath : options.iconPath
    const icon2xPath = useTemplate ? options.templateIcon2xPath ?? options.icon2xPath : options.icon2xPath
    const image = runtime.createImage(iconPath, icon2xPath, useTemplate)
    if (image.isEmpty()) throw new Error('托盘图标无法读取')
    tray = runtime.createTray(image)
    if (tray.isDestroyed()) throw new Error('系统未能创建托盘入口')
    setAvailable(true)
    tray.on('double-click', () => run(options.onOpen))
    tray.on('click', () => { if (platform !== 'darwin') run(options.onOpen) })
    tray.on('right-click', () => updateSnapshot())
    updateSnapshot()
  } catch (error) { unavailable(error) }

  return {
    get available() { return checkAvailable() },
    getSnapshot: () => copySnapshot(snapshot),
    updateSnapshot,
    dispose() {
      if (disposed) return
      disposed = true
      destroy()
      setAvailable(false)
    },
  }
}
