// 设置页（#1070 第 11 步，从 pages-maintenance.tsx 原样搬来）：外观显示、启动关闭、工具管理、网络加速、消息通知、
// 备份迁移、隐私数据、版本更新八组，左栏搜索设置和快捷键弹窗。pages-maintenance.tsx 照旧转出这里的导出名；
// 各业务页共用的参数类型在 business-actions.ts。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  Compass,
  Download,
  FileText,
  FolderOpen,
  HeartPulse,
  RefreshCw,
  RotateCcw,
  Zap,
} from 'lucide-react'
import {
  Button,
  Card,
  Dialog,
  ListRow,
  Notice,
  PageHead,
  Pill,
  SearchInput,
  Segment,
  SettingRow,
  Switch,
  useToast,
} from '../../ui'
import { errorMessage, ResultNotice, useOperation, useResource } from '../../business-common'
import {
  autoUpdateSettingDescription,
  buildSettingsBlocks,
  notificationOptions,
  notificationSettingsItemId,
  searchSettingsItems,
  settingsGroupIcons,
  settingsGroups,
  settingsItemLabel,
  settingsItems,
  type SettingsGroupId,
  type SettingsItem,
  type SettingsSectionId,
} from '../../registry/business'
import { shortcutTools } from '../../registry/tools'
import { AppUninstallRow } from '../app/AppUninstall'
import { BackupCard } from './BackupCard'
import { VersionCard } from './VersionCard'
import { RelayRouteRestartNotice, RelayRouteRow } from '../app/RelayRouteSettings'
import { ThemeCards, type ThemeCardValue } from '../app/ThemeCards'
import { connectionRouteSettings } from '../../registry/connection-routes'
import { createSettingsQueue } from '../app/settings-queue'
import { certificateDiagnosticCode } from '../app/certificate-trust'
import { takeSettingsGroup } from '../app/settings-group-intent'
import { useRowFocus } from '../app/row-focus'
import { currentWindowOs, type WindowOs } from '../app/window-os'
import { parseImportedConversations } from '../chat/storage'
import type { Conversation } from '../chat/state'
import { dataTransferExportMessage, dataTransferImportMessage, settingsPatchFrom } from '../app/data-transfer'
import type { V2Bridge } from '../../types'
import type { DataTransferImportPreview } from '../../../../electron/ipc-contract'
import type { PlatformSystemState } from '../../../../electron/platform/contract'
import { platformApi } from '../../platform-api'
import type { BusinessActions } from '../../business-actions'

type AppSettings = Awaited<ReturnType<V2Bridge['getSettings']>>
type SettingsUpdate = Parameters<V2Bridge['saveSettings']>[0]
/** 检查结果里「星芒 AI 网络」那一项的代号；设置里「网络检查」的「去检查页」直接翻到这一项。 */
const networkDiagnosticCode = 'XINGMANG_NETWORK'
/** 主进程说的「代理路由」是技术词，界面上换成「连接路径」「通过转发连接」，不出现「代理」。 */
function proxySummaryText(summary: string): string {
  return summary.replaceAll('使用代理路由', '通过转发连接').replaceAll('代理路由', '连接路径')
}

/**
 * 快捷键弹窗里的键（v4 字表批09）：按这台电脑只写一种，Mac 写 ⌘，别的写 Ctrl。打开工具那一行
 * 按这台电脑上看得到的个数写（和 App 里快捷键本身读同一张表，registry/tools.ts 的 shortcutTools）。
 */
export function launchShortcutMeta(os: WindowOs): string {
  return `${os === 'mac' ? '⌘' : 'Ctrl'} 1–${shortcutTools(os).length}`
}
export function shortcutRows(os: WindowOs): Array<{ keys: string; label: string }> {
  const mod = os === 'mac' ? '⌘' : 'Ctrl'
  return [
    { keys: `${mod} K`, label: '搜索或跳转' },
    { keys: `${mod} ,`, label: '打开设置' },
    { keys: launchShortcutMeta(os), label: '打开工具' },
    { keys: `${mod} + / ${mod} -`, label: '放大 / 缩小界面' },
    { keys: `${mod} 0`, label: '恢复自动缩放' },
    { keys: 'Esc', label: '关闭弹窗或菜单' },
  ]
}

/** 设置页顶上那句。找设置用左栏的「搜索设置」，这里不再教按 Ctrl K。 */
export const settingsPageLead = '改动会立即保存。'

/**
 * 设置页「版本更新」里的两个重来入口。两件事名字很像、做的事不一样：「新手引导」重走
 * 安装配置的四步引导，「界面导览」只是把首页上那几条操作提示再放一遍。
 */
export function OnboardingGuideRow({ openGuide }: { openGuide: () => void }) {
  return (
    <SettingRow
      title={settingsItemLabel('guide')}
      anchor="guide"
      description={null}
      control={
        <Button
          size="sm"
          icon={BookOpen}
          onClick={openGuide}
          testId="settings-start-guide"
        >
          再看一遍
        </Button>
      }
    />
  )
}

export function OnboardingTourRow({ replayTour }: { replayTour: () => void }) {
  return (
    <SettingRow
      title={settingsItemLabel('tour')}
      anchor="tour"
      description={null}
      control={
        <Button
          size="sm"
          icon={Compass}
          onClick={replayTour}
          testId="settings-replay-tour"
        >
          重看导览
        </Button>
      }
    />
  )
}

export function SettingsPage({
  api,
  navigate,
  onSettingsChanged,
  openGuide,
  replayTour,
  uiScale,
  chatTransfer,
  appSettings,
  updateAvailable,
  accelerating,
  active,
  accelerationCard,
  onSettingsGroupChange,
  onBackupRestored,
  installedProviders,
}: { api: V2Bridge } & BusinessActions & Pick<Parameters<typeof BackupCard>[0], 'installedProviders'> & {
  /** 备份卡恢复成功后回调，用来让首页重读配置。 */
  onBackupRestored?: Parameters<typeof BackupCard>[0]['onRestored']
}) {
  const load = useCallback(async () => {
    const [settings, capabilities, update] = await Promise.all([
      api.getSettings(),
      api.getWindowCapabilities(),
      // 「自动更新」显不显示、「当前版本」写哪一版：读不到就当这台电脑不支持、版本暂未读到，不挡设置页。
      api.getUpdateState().catch(() => null),
    ])
    return { settings, capabilities, update }
  }, [api])
  const resource = useResource(load)
  const setResourceData = resource.setData
  useEffect(() => {
    if (uiScale === undefined) return
    const persisted = uiScale === 'auto' ? undefined : uiScale
    setResourceData((previous) => {
      if (!previous || previous.settings.uiScale === persisted) return previous
      const { uiScale: _stale, ...rest } = previous.settings
      return { ...previous, settings: persisted === undefined ? rest : { ...rest, uiScale: persisted } }
    })
  }, [uiScale, setResourceData])
  // 更新气泡里也能改「自动下载更新」，改完 App 拿到的是最新的；这一页开着时跟着变。
  const checkUpdatesOnStartup = appSettings?.checkUpdatesOnStartup
  const autoUpdate = appSettings?.autoUpdate
  useEffect(() => {
    if (checkUpdatesOnStartup === undefined) return
    setResourceData((previous) => {
      if (!previous || (previous.settings.checkUpdatesOnStartup === checkUpdatesOnStartup && previous.settings.autoUpdate === autoUpdate)) return previous
      return { ...previous, settings: { ...previous.settings, checkUpdatesOnStartup, autoUpdate } }
    })
  }, [checkUpdatesOnStartup, autoUpdate, setResourceData])
  // 「要输入管理员密码才能装」这句现在只在「自动下载更新」那一行说（原来更新页顶上那段跟着推送变），
  // 这一页开着时也跟着主进程推来的更新状态走，别停在打开时读到的那一份。
  useEffect(() => api.onUpdateState((update) => {
    setResourceData((previous) => (previous ? { ...previous, update } : previous))
  }), [api, setResourceData])
  const operation = useOperation()
  const showToast = useToast().show
  const systemApi = platformApi()
  const [systemState, setSystemState] = useState<PlatformSystemState | null>(
    null,
  )
  const [systemError, setSystemError] = useState('')
  // 「重新读取」一次就加一，系统状态那一块从头再读一遍。
  const [systemAttempt, setSystemAttempt] = useState(0)
  const [isMac, setIsMac] = useState(false)
  const [isLinux, setIsLinux] = useState(false)
  const [accelerationAvailable, setAccelerationAvailable] = useState(true)
  useEffect(() => {
    let current = true
    // 读不到平台就照旧显示工具的安装卸载，不出「卸载星芒」。
    void api.getPlatformCapabilities()
      .then((capability) => {
        if (!current) return
        setIsMac(capability.platform === 'macos')
        setIsLinux(capability.platform === 'linux')
        setAccelerationAvailable(capability.acceleration !== false)
      })
      .catch(() => undefined)
    return () => { current = false }
  }, [api])
  useEffect(() => {
    if (!systemApi) return
    let active = true
    let revision = 0
    const accept = (state: PlatformSystemState) => {
      if (active) {
        setSystemState(state)
        setSystemError('')
        document.documentElement.dataset.contrast = state.appearance
          .highContrast
          ? 'high'
          : 'normal'
        document.documentElement.classList.toggle(
          'hc',
          state.appearance.highContrast,
        )
      }
    }
    const unsubscribe = systemApi.onStateChanged((state) => {
      revision++
      accept(state)
    })
    void systemApi
      .getState()
      .then((state) => {
        if (revision === 0) accept(state)
      })
      .catch((error) => {
        if (active) setSystemError(errorMessage(error))
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [systemApi, systemAttempt])
  // 做成了的结果改成会自己消失的小提示，页面不再往下跳；没做成的照旧在页顶出红条。
  const toasted = (text: string) => () => {
    showToast(text, 'ok')
    return null
  }
  // 「连接方式」点「查看」：查到的那一句用小提示说，不在这一行里多占一行字。
  const readProxy = () => {
    if (systemApi)
      void operation.execute(
        'proxy',
        () => systemApi.getProxyStatus(),
        (status) => `当前：${proxySummaryText(status.summary)}`,
      )
  }
  const [group, setGroup] = useState<SettingsGroupId>('appearance')
  // 左栏「搜索设置」里输的字；有字时右边换成搜到的那几行，可以直接在那儿改。
  const [search, setSearch] = useState('')
  // 从检查页「去处理」跳进来时直接落在要去的那一组。放在副作用里取，严格模式下
  // 初始化函数会跑两遍，第二遍会把已经取走的那一组读成空的。
  useEffect(() => {
    const requested = takeSettingsGroup()
    if (requested) setGroup(requested)
  }, [])
  const pageRef = useRef<HTMLElement>(null)
  // 顶部搜索搜到某一项：打开那一组以后翻到那一行、亮一下。
  useRowFocus('settings', pageRef, Boolean(resource.data))
  const [pending, setPending] = useState(0)
  const pendingRef = useRef(0)
  pendingRef.current = pending
  // 关闭询问框里勾了「记住我的选择」是主进程直接写的设置。窗口缩到托盘再点开时，
  // 这一页可能还开着旧的「每次询问」，想改回来点它也没反应，所以回到窗口时重读这一项。
  useEffect(() => {
    function refreshCloseBehavior() {
      if (document.visibilityState !== 'visible') return
      void api
        .getSettings()
        .then((latest) => {
          if (pendingRef.current > 0) return
          resource.setData((previous) =>
            previous &&
            previous.settings.closeBehavior !== latest.closeBehavior
              ? {
                  ...previous,
                  settings: {
                    ...previous.settings,
                    closeBehavior: latest.closeBehavior,
                  },
                }
              : previous,
          )
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refreshCloseBehavior)
    document.addEventListener('visibilitychange', refreshCloseBehavior)
    return () => {
      window.removeEventListener('focus', refreshCloseBehavior)
      document.removeEventListener('visibilitychange', refreshCloseBehavior)
    }
  }, [api, resource.setData])
  const [saveError, setSaveError] = useState('')
  const [legal, setLegal] = useState<Awaited<
    ReturnType<V2Bridge['getLegalDocument']>
  > | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  // 显示方式要重开软件才生效：改完就在这一行下面给「现在重开」「稍后」。
  const [displayRelaunch, setDisplayRelaunch] = useState(false)
  const onSaved = useRef((settings: AppSettings) => {
    resource.setData((previous) =>
      previous ? { ...previous, settings } : previous,
    )
    onSettingsChanged?.(settings)
  })
  onSaved.current = (settings) => {
    resource.setData((previous) =>
      previous ? { ...previous, settings } : previous,
    )
    onSettingsChanged?.(settings)
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.reducedMotion = String(
      Boolean(settings.reducedMotion),
    )
    document.documentElement.dataset.largeText = String(
      Boolean(settings.largeText),
    )
  }
  const writer = useMemo(
    () =>
      createSettingsQueue(
        (patch) => api.saveSettings(patch),
        (settings) => onSaved.current(settings),
      ),
    [api],
  )
  // quiet：导入时设置只是其中一半，存好了由导入那句一起说，不另弹「已保存」。
  const update = async (patch: Omit<SettingsUpdate, 'version'>, options?: { quiet?: boolean }) => {
    setPending((value) => value + 1)
    setSaveError('')
    try {
      await writer({ version: 2, ...patch })
      if (!options?.quiet) showToast('已保存', 'ok')
      return true
    } catch (error) {
      setSaveError(errorMessage(error))
      return false
    } finally {
      setPending((value) => value - 1)
    }
  }
  // 「搬到新电脑」导入：先整份校验，再在这台电脑上改过的设置要被换掉时问一句。
  const [importAsk, setImportAsk] = useState<{
    preview: DataTransferImportPreview
    conversations: Conversation[]
  } | null>(null)
  // 对话先导入：它更可能出错，出错时设置还没动。
  const applyImport = async (
    preview: DataTransferImportPreview,
    conversations: Conversation[],
    overwrite: boolean,
  ) => {
    const added = chatTransfer
      ? await chatTransfer.importConversations(conversations)
      : 0
    const patch = overwrite
      ? settingsPatchFrom(preview.settings, preview.conflictingSettings)
      : settingsPatchFrom(preview.settings)
    if (patch && !(await update(patch, { quiet: true }))) {
      throw new Error(
        added
          ? `导入了 ${added} 个对话，设置没有保存成功，可以再点一次「导入」`
          : '设置没有保存成功，可以再点一次「导入」',
      )
    }
    return dataTransferImportMessage({
      fileConversations: conversations.length,
      added,
      signedIn: Boolean(chatTransfer),
      settingsChanged: Boolean(patch),
    })
  }
  const importDone = (message: string | null) => {
    if (message) showToast(message, 'ok')
    return null
  }
  const startImport = () =>
    void operation.execute(
      'transfer-import',
      async () => {
        const preview = await api.importAppData()
        if (!preview) return null
        const conversations = parseImportedConversations(preview.conversations)
        if (preview.conflictLabels.length) {
          setImportAsk({ preview, conversations })
          return null
        }
        return applyImport(preview, conversations, false)
      },
      importDone,
    )
  const finishImport = (overwrite: boolean) => {
    const ask = importAsk
    setImportAsk(null)
    if (!ask) return
    void operation.execute(
      'transfer-import',
      () => applyImport(ask.preview, ask.conversations, overwrite),
      importDone,
    )
  }
  // 导出的结果带「打开所在位置」，要给人点，照旧留在页顶。
  const startExport = () =>
    void operation.execute(
      'transfer-export',
      async () =>
        api.exportAppData({
          conversations: chatTransfer
            ? await chatTransfer.exportConversations()
            : [],
        }),
      (result) =>
        result
          ? {
              text: dataTransferExportMessage(result),
              revealPath: result.outputPath,
            }
          : null,
    )
  const settings = resource.data?.settings
  // 行标题从注册表取（settingsItems），顶部搜索、页内搜索和这里说的是同一个名字。
  const row = (
    id: string,
    description: ReactNode,
    control: ReactNode,
    extra?: { badge?: ReactNode; wide?: boolean; testId?: string },
  ) => (
    <SettingRow
      key={id}
      anchor={id}
      title={settingsItemLabel(id)}
      description={description}
      control={control}
      badge={extra?.badge}
      wide={extra?.wide}
      testId={extra?.testId}
    />
  )
  // 要先读一次系统状态的那几项：读的那一下照常画开关、灰着点不了，不写字；没读到写
  // 「暂未读到」，页顶红条给「重新读取」；只有这台电脑真的没有这一项，才写「此版本暂不支持」。
  const systemPending = (label: string) =>
    !systemApi ? (
      <Pill tone="neutral">此版本暂不支持</Pill>
    ) : systemError ? (
      <Pill tone="neutral">暂未读到</Pill>
    ) : (
      <Switch
        checked={false}
        disabled
        aria-label={label}
        onChange={() => undefined}
      />
    )
  const relaunch = () =>
    void operation.execute(
      'relaunch',
      () => api.relaunchApp(),
      (started) => {
        if (!started) showToast('已取消重开', 'neutral')
        return null
      },
    )
  // 恢复默认外观：主题回到跟随系统、关掉高对比度，缩放、大字、减少动画回到装好时的样子。
  // 显卡加速不算外观，改了要重开软件，这里不动它。
  const restoreAppearance = () =>
    void operation.execute(
      'restore-appearance',
      async () => {
        if (systemApi) {
          setSystemState(await systemApi.setThemePreference('system'))
          setSystemState(await systemApi.setHighContrast(false))
        }
        return update(
          {
            uiScale: 'auto',
            largeText: false,
            reducedMotion: false,
            ...(systemApi ? {} : { theme: 'light' as const }),
          },
          { quiet: true },
        )
      },
      (saved) => (saved ? '已恢复默认外观' : null),
    )
  // 每一行按 settingsItems 的 id 放在这里，分组页和页内搜索取的是同一份；这台电脑没有的行不放。
  // 三张卡（批09，原来是三个独立页面）各读各的，不等设置读回来：设置读不到时更新、备份、加速照样有地方点，
  // 托盘、通知、错误框跳过来也不会落空。
  const views: Partial<Record<string, ReactNode>> = {
    // 原来的游戏加速页；没有加速的电脑（Linux）没有这张卡。
    acceleration: accelerationAvailable && accelerationCard ? accelerationCard(active !== false) : undefined,
    // 原来的备份页：切到这一组时新挂上、读一次；设置页从别的页回来时再读一次。
    backups: (
      <BackupCard
        key="backups"
        api={api}
        active={active}
        navigate={navigate}
        onRestored={onBackupRestored}
        installedProviders={installedProviders}
      />
    ),
    // 原来的更新页。两个开关不在卡上再摆一份，就是下面那两行。
    version: (
      <VersionCard
        key="version"
        api={api}
        navigate={navigate}
        autoUpdate={(settings ?? appSettings)?.autoUpdate !== false}
      />
    ),
  }
  if (settings) {
    const themeOptions: Array<{ value: ThemeCardValue; disabled?: boolean }> = [
      { value: 'light' },
      { value: 'dark' },
    ]
    if (systemApi) themeOptions.unshift({ value: 'system', disabled: !systemState })
    const notificationsOff = settings.desktopNotifications === false
    Object.assign(views, {
      theme: row(
        'theme',
        null,
        <ThemeCards
          testId="settings-theme"
          options={themeOptions}
          value={systemState?.preferences.themePreference ?? settings.theme}
          onChange={(theme) => {
            if (systemApi)
              void operation.execute(
                'platform-theme',
                async () =>
                  setSystemState(await systemApi.setThemePreference(theme)),
                toasted('主题偏好已保存'),
              )
            else if (theme !== 'system') void update({ theme })
          }}
        />,
        { wide: true },
      ),
      'ui-scale': row(
        'ui-scale',
        null,
        <Segment
          options={[
            { value: 'auto', label: '自动' },
            { value: '90', label: '90%' },
            { value: '100', label: '100%' },
            { value: '110', label: '110%' },
          ]}
          value={settings.uiScale ?? 'auto'}
          onChange={(uiScale) => {
            if (
              uiScale === 'auto' ||
              uiScale === '90' ||
              uiScale === '100' ||
              uiScale === '110'
            )
              void update({ uiScale })
          }}
        />,
      ),
      'large-text': row(
        'large-text',
        '把说明文字和小字放大一号',
        <Switch
          checked={Boolean(settings.largeText)}
          onChange={(largeText) => void update({ largeText })}
          aria-label="大字"
          testId="settings-large-text"
        />,
      ),
      language: row(
        'language',
        null,
        <span className="v2-settings-value">简体中文</span>,
      ),
      'high-contrast': row(
        'high-contrast',
        systemState?.appearance.systemHighContrast
          ? '系统高对比度已开启；手动偏好会单独保留'
          : null,
        systemApi && systemState ? (
          <Switch
            aria-label="高对比度"
            checked={systemState.preferences.highContrast}
            disabled={Boolean(operation.busy)}
            onChange={(enabled) =>
              void operation.execute(
                'contrast',
                async () =>
                  setSystemState(await systemApi.setHighContrast(enabled)),
                toasted('高对比度偏好已保存'),
              )
            }
          />
        ) : (
          systemPending('高对比度')
        ),
      ),
      'reduced-motion': row(
        'reduced-motion',
        null,
        <Switch
          checked={Boolean(settings.reducedMotion)}
          onChange={(reducedMotion) => void update({ reducedMotion })}
          aria-label="减少动画"
        />,
      ),
      'hardware-acceleration': (
        <Fragment key="hardware-acceleration">
          {row(
            'hardware-acceleration',
            resource.data?.capabilities.displayCompat === 'auto'
              ? '显卡驱动刚才接连出了几次问题，这次已临时改用兼容方式显示。界面出现黑屏、花屏、闪烁或打开就闪退时，关掉它'
              : '界面出现黑屏、花屏、闪烁或打开就闪退时，关掉它',
            <Switch
              checked={settings.hardwareAcceleration !== false}
              onChange={(hardwareAcceleration) =>
                void update({ hardwareAcceleration }).then((saved) => {
                  if (saved) setDisplayRelaunch(true)
                })
              }
              aria-label="用显卡加速显示"
              testId="settings-hardware-acceleration"
            />,
            { badge: '重启后生效' },
          )}
          {displayRelaunch && (
            <Notice
              tone="neutral"
              title="显示方式已改好"
              body="重启软件后生效。"
              testId="settings-display-relaunch"
              actions={
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    testId="settings-display-relaunch-now"
                    disabled={Boolean(operation.busy)}
                    onClick={relaunch}
                  >
                    现在重开
                  </Button>
                  <Button
                    size="sm"
                    testId="settings-display-relaunch-later"
                    onClick={() => setDisplayRelaunch(false)}
                  >
                    稍后
                  </Button>
                </>
              }
            />
          )}
        </Fragment>
      ),
      'restore-appearance': row(
        'restore-appearance',
        null,
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          disabled={Boolean(operation.busy)}
          loading={operation.busy === 'restore-appearance'}
          onClick={restoreAppearance}
          testId="settings-restore-appearance"
        >
          恢复默认
        </Button>,
      ),
      'launch-at-login': row(
        'launch-at-login',
        systemState?.startup.note ?? '开机后在托盘里待命，不弹窗口',
        systemApi && systemState?.startup.supported ? (
          <Switch
            aria-label="开机自动启动"
            checked={systemState.startup.requested}
            disabled={Boolean(operation.busy)}
            onChange={(enabled) =>
              void operation.execute(
                'startup',
                async () =>
                  setSystemState(await systemApi.setStartup(enabled)),
                '',
              )
            }
          />
        ) : systemState ? (
          <Pill tone="neutral">此版本暂不支持</Pill>
        ) : (
          systemPending('开机自动启动')
        ),
      ),
      'close-behavior': row(
        'close-behavior',
        // Linux 的任务栏不一定有放托盘图标的地方（主进程先问过），没有就只能退出。
        // 没有游戏加速的电脑（Linux）不说加速。
        isLinux && resource.data && !resource.data.capabilities.tray
          ? '这台电脑的任务栏上没有放星芒图标的地方，点关闭会直接退出软件'
          : accelerationAvailable
            ? '缩到托盘后，加速和正在进行的安装会继续在后台运行'
            : '缩到托盘后，正在进行的安装会继续在后台运行',
        <Segment
          options={[
            { value: 'ask', label: '每次询问' },
            {
              value: 'tray',
              label: '缩到托盘',
              disabled: !resource.data?.capabilities.tray,
            },
            { value: 'quit', label: '直接退出' },
          ]}
          value={settings.closeBehavior ?? 'ask'}
          onChange={(closeBehavior) => {
            if (
              closeBehavior === 'ask' ||
              closeBehavior === 'tray' ||
              closeBehavior === 'quit'
            )
              void update({ closeBehavior })
          }}
        />,
      ),
      'startup-diagnostics': row(
        'startup-diagnostics',
        null,
        <Switch
          checked={settings.runDiagnosticsOnStartup}
          aria-label="启动时检查环境"
          onChange={(runDiagnosticsOnStartup) =>
            void update({ runDiagnosticsOnStartup })
          }
        />,
      ),
      workspace: row(
        'workspace',
        '工具会读写里面的文件，请选你信任的文件夹',
        <div className="v2-business-control">
          <span className="v2-business-path">{settings.workspace}</span>
          <Button
            size="sm"
            icon={FolderOpen}
            onClick={() =>
              void operation.execute(
                'workspace',
                async () => {
                  const workspace = await api.chooseWorkspace()
                  if (workspace) await update({ workspace })
                },
                '',
              )
            }
          >
            更换
          </Button>
        </div>,
      ),
      'latest-cli': row(
        'latest-cli',
        '默认装星芒验证过的推荐版本；打开后跟随官方最新版，可能遇到还没验证过的问题',
        <Switch
          checked={settings.alwaysInstallLatestCli === true}
          aria-label="命令行工具总是装最新版"
          onChange={(alwaysInstallLatestCli) =>
            void update({ alwaysInstallLatestCli })
          }
        />,
      ),
      'install-location': row(
        'install-location',
        null,
        <span className="v2-settings-value">跟随系统</span>,
      ),
      // 不写死 Windows Terminal：没装它的 Windows 会退回别的窗口。
      terminal: row(
        'terminal',
        null,
        <span className="v2-settings-value">{isMac ? '终端' : '系统默认'}</span>,
      ),
      ...Object.fromEntries(
        connectionRouteSettings.map((route) => [
          route.id,
          <RelayRouteRow
            key={route.id}
            route={route}
            settings={settings}
            disabled={pending > 0 || Boolean(operation.busy)}
            onChange={(patch) => void update(patch)}
          />,
        ]),
      ),
      'tool-route-restart-hints': row(
        'tool-route-restart-hints',
        '连接线路因为连不上换了以后，开着的工具要重开才会走新线路。关掉以后只在首页标「需重开生效」。',
        <Switch
          checked={settings.toolRouteRestartHints !== false}
          aria-label="换线路后提醒我重开工具"
          testId="settings-tool-route-restart-hints"
          onChange={(toolRouteRestartHints) =>
            void update({ toolRouteRestartHints })
          }
        />,
      ),
      mirror: row(
        'mirror',
        '下载失败时可以换一个再试',
        <Segment
          options={[
            { value: 'auto', label: '自动判断' },
            { value: 'mirror-first', label: '国内镜像' },
            { value: 'official-first', label: '官方源' },
          ]}
          value={settings.mirrorPolicy ?? 'auto'}
          onChange={(mirrorPolicy) => {
            if (
              mirrorPolicy === 'auto' ||
              mirrorPolicy === 'mirror-first' ||
              mirrorPolicy === 'official-first'
            )
              void update({ mirrorPolicy })
          }}
        />,
      ),
      proxy: row(
        'proxy',
        null,
        systemApi ? (
          <Button
            size="sm"
            icon={RefreshCw}
            loading={operation.busy === 'proxy'}
            onClick={readProxy}
          >
            查看
          </Button>
        ) : (
          <Pill tone="neutral">此版本暂不支持</Pill>
        ),
      ),
      'network-check': row(
        'network-check',
        null,
        <Button
          size="sm"
          icon={HeartPulse}
          onClick={() => navigate?.('health', networkDiagnosticCode)}
          testId="settings-network-health"
        >
          去检查
        </Button>,
      ),
      certificate: row(
        'certificate',
        '公司网络要求装证书才能上网、装工具报证书错误时，到检查页看「安全证书」那一项',
        <Button
          size="sm"
          icon={HeartPulse}
          onClick={() => navigate?.('health', certificateDiagnosticCode)}
          testId="settings-certificate-health"
        >
          去检查
        </Button>,
      ),
      // 「发测试通知」并进了桌面通知这一行：总开关关着时发不出去，按钮跟着灰。
      'desktop-notifications': row(
        'desktop-notifications',
        '新版本下载好的提醒也归它管',
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={Zap}
            disabled={
              !systemApi ||
              notificationsOff ||
              !resource.data?.capabilities.notifications
            }
            loading={operation.busy === 'test-notification'}
            onClick={() =>
              systemApi &&
              void operation.execute(
                'test-notification',
                async () => {
                  const result = await systemApi.testNotification()
                  if (result === 'disabled')
                    throw new Error('请先开启桌面通知。')
                  if (result === 'unsupported')
                    throw new Error('这台电脑当前无法显示系统通知。')
                },
                toasted('已发送一条测试通知'),
              )
            }
          >
            发测试通知
          </Button>
          <Switch
            checked={!notificationsOff}
            disabled={!resource.data?.capabilities.notifications}
            aria-label="桌面通知"
            onChange={(desktopNotifications) =>
              void update({ desktopNotifications })
            }
          />
        </>,
      ),
      ...Object.fromEntries(
        notificationOptions
          .filter((option) => option.value !== 'acceleration' || accelerationAvailable)
          .map((option) => [
            notificationSettingsItemId(option.value),
            row(
              notificationSettingsItemId(option.value),
              option.description,
              systemApi && systemState ? (
                <Switch
                  aria-label={`${option.label}通知`}
                  checked={
                    systemState.preferences.notifications?.[option.value] ??
                    true
                  }
                  disabled={notificationsOff || Boolean(operation.busy)}
                  onChange={(enabled) =>
                    void operation.execute(
                      'notification-preference',
                      async () =>
                        setSystemState(
                          await systemApi.setNotificationPreference(
                            option.value,
                            enabled,
                          ),
                        ),
                      toasted('通知偏好已保存'),
                    )
                  }
                />
              ) : (
                systemPending(`${option.label}通知`)
              ),
            ),
          ]),
      ),
      // 没登录时聊天记录带不走（按账号分开存），标题只说「导出设置」。
      transfer: (
        <SettingRow
          key="transfer"
          anchor="transfer"
          title={chatTransfer ? settingsItemLabel('transfer') : '导出设置'}
          description={chatTransfer ? '文件里没有密码和密钥，在新电脑上登录一下就行' : '登录后再导出，会连聊天记录一起带上'}
          control={
            <Button
              size="sm"
              icon={Download}
              disabled={Boolean(operation.busy)}
              onClick={startExport}
              testId="settings-transfer-export"
            >
              导出
            </Button>
          }
        />
      ),
      'transfer-import': row(
        'transfer-import',
        null,
        <Button
          size="sm"
          icon={FolderOpen}
          disabled={Boolean(operation.busy)}
          onClick={startImport}
          testId="settings-transfer-import"
        >
          导入
        </Button>,
      ),
      'crash-reporting': row(
        'crash-reporting',
        '出错时把错误信息、版本和系统信息发到海外的错误收集服务；不含账号、密钥、文件路径和对话内容',
        <Switch
          aria-label="崩溃自动上报"
          checked={settings.crashReporting !== false}
          onChange={(enabled) => void update({ crashReporting: enabled })}
        />,
      ),
      'usage-stats': row(
        'usage-stats',
        '只记下你的选择；目前软件不会收集或上传使用记录',
        systemApi && systemState ? (
          <Switch
            aria-label="匿名使用统计偏好"
            checked={systemState.preferences.privacy?.anonymousUsage ?? false}
            disabled={Boolean(operation.busy)}
            onChange={(enabled) =>
              void operation.execute(
                'privacy',
                async () =>
                  setSystemState(
                    await systemApi.setPrivacyPreference(
                      'anonymousUsage',
                      enabled,
                    ),
                  ),
                toasted('偏好已保存在本机，没有上传使用记录'),
              )
            }
          />
        ) : (
          systemPending('匿名使用统计偏好')
        ),
      ),
      logs: row(
        'logs',
        null,
        <>
          <Button
            size="sm"
            icon={FolderOpen}
            onClick={() =>
              void operation.execute(
                'directory',
                () => api.openRuntimeLogDirectory(),
                '',
              )
            }
          >
            打开日志文件夹
          </Button>
          <Button
            size="sm"
            icon={FileText}
            onClick={() => navigate?.('feedback', 'log')}
          >
            去反馈
          </Button>
        </>,
      ),
      legal: row(
        'legal',
        null,
        <>
          <Button
            size="sm"
            onClick={() =>
              void operation.execute(
                'legal',
                async () =>
                  setLegal(await api.getLegalDocument('user-agreement')),
                '',
              )
            }
          >
            用户协议
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void operation.execute(
                'legal',
                async () =>
                  setLegal(await api.getLegalDocument('privacy-policy')),
                '',
              )
            }
          >
            隐私政策
          </Button>
        </>,
      ),
      'update-check': row(
        'update-check',
        null,
        <Switch
          checked={settings.checkUpdatesOnStartup}
          aria-label="启动时检查新版本"
          onChange={(checkUpdatesOnStartup) =>
            void update({ checkUpdatesOnStartup })
          }
        />,
        { testId: 'updates-check-on-startup' },
      ),
      'auto-update': resource.data?.update?.autoUpdateSupported
        ? row(
            'auto-update',
            autoUpdateSettingDescription(resource.data.update.installMethod, resource.data.update.installNeedsAdminPassword),
            <Switch
              testId="settings-auto-update"
              checked={settings.autoUpdate !== false}
              aria-label="自动下载更新"
              onChange={(autoUpdate) => void update({ autoUpdate })}
            />,
            { testId: 'updates-auto-update' },
          )
        : undefined,
      shortcuts: row(
        'shortcuts',
        null,
        <Button
          size="sm"
          icon={BookOpen}
          onClick={() => setShortcuts(true)}
        >
          查看
        </Button>,
      ),
      guide: (
        <OnboardingGuideRow
          key="guide"
          openGuide={openGuide ?? (() => navigate?.('tutorial'))}
        />
      ),
      tour: replayTour ? <OnboardingTourRow key="tour" replayTour={replayTour} /> : undefined,
      [isMac ? 'uninstall-app' : 'uninstall']: (
        <AppUninstallRow
          key="uninstall"
          api={api}
          isMac={isMac}
          isLinux={isLinux}
        />
      ),
    })
  }
  const shown = (item: SettingsItem) => views[item.id] !== undefined
  const searching = search.trim().length > 0
  // App 要知道人是不是就在「版本更新」：在的话更新气泡不再说版本卡上写着的同一件事。
  useEffect(() => { onSettingsGroupChange?.(searching ? null : group) }, [group, searching, onSettingsGroupChange])
  // 整张卡的那几项（游戏加速、工具配置备份、版本卡）单独摆，外面包一层带 data-anchor 的，顶部搜索翻得过去。
  const cardSlot = (item: SettingsItem) => (
    <div key={item.id} className="v2-settings-card-slot" data-anchor={item.id}>{views[item.id]}</div>
  )
  const hits = settings && searching ? searchSettingsItems(search).filter(shown) : []
  // 小标题右边的那句、卡片上面的那条：桌面通知关着时提醒项都不会响；线路存好了要重开才用上。
  const sectionNotes: Partial<Record<SettingsSectionId, ReactNode>> = {
    reminders: settings?.desktopNotifications === false ? '桌面通知关着，下面这些都不会提醒' : undefined,
  }
  const sectionLeads: Partial<Record<SettingsSectionId, ReactNode>> = settings
    ? {
        routes: (
          <RelayRouteRestartNotice
            settings={settings}
            disabled={pending > 0 || Boolean(operation.busy)}
            onRestart={relaunch}
          />
        ),
      }
    : {}
  function openGroup(value: SettingsGroupId) {
    setSearch('')
    setGroup(value)
  }
  let content: ReactNode = (
    <Card padding="none">
      <p role="status">{resource.error ? '设置暂时没有读到' : '正在读取设置…'}</p>
    </Card>
  )
  if (settings && searching) {
    // 搜出来的行就地能改，小标题那一句和卡片上面那条也得跟着：线路改完要在这儿就能「现在重开」，
    // 桌面通知关着时提醒项为什么是灰的也要说。同一个小标题下搜出好几行时只在第一行上面放一次。
    const shownSections = new Set<SettingsSectionId>()
    const groupLink = (item: SettingsItem) => (
      <button type="button" className="v2-link-button" onClick={() => openGroup(item.group)}>
        {settingsGroups.find((entry) => entry.value === item.group)?.label}
      </button>
    )
    const hit = (item: SettingsItem) => {
      const section = item.section && !shownSections.has(item.section) ? item.section : undefined
      if (section) shownSections.add(section)
      const note = section ? sectionNotes[section] : undefined
      const lead = section ? sectionLeads[section] : undefined
      return (
        <Fragment key={item.id}>
          <div className="v2-settings-hit">
            {groupLink(item)}
            {note && <span>{note}</span>}
          </div>
          {lead && <div className="v2-settings-hit-lead">{lead}</div>}
          {views[item.id]}
        </Fragment>
      )
    }
    // 挨着的几行照旧装进同一张卡；整张卡的那一项自己摆，组名写在卡上面。
    const segments: SettingsItem[][] = []
    for (const item of hits) {
      const last = segments[segments.length - 1]
      if (last && !item.card && !last[0].card) last.push(item)
      else segments.push([item])
    }
    content = hits.length ? (
      <div className="v2-settings-results" data-testid="settings-search-results">
        {segments.map((segment) =>
          segment[0].card ? (
            <section key={segment[0].id} className="v2-settings-block">
              <div className="v2-settings-section">{groupLink(segment[0])}</div>
              {cardSlot(segment[0])}
            </section>
          ) : (
            <Card key={segment[0].id} padding="none">{segment.map(hit)}</Card>
          ),
        )}
      </div>
    ) : (
      <div className="v2-settings-empty" data-testid="settings-search-empty">
        <h3>没有找到相关设置</h3>
        <p>换个说法试试，比如「托盘」「镜像」「快捷键」。</p>
      </div>
    )
  } else if (settings || resource.error) {
    // 设置没读到时只摆这一组里的那张卡（如果有），上面照旧写「设置暂时没有读到」、给「重新读取」。
    const blocks = buildSettingsBlocks(group, settingsItems.filter((item) => shown(item) && (Boolean(settings) || item.card === true)))
    const groupContent = blocks.map((block, index) => (
      <section key={block.section?.value ?? `rows-${index}`} className="v2-settings-block">
        {block.section && (
          <div
            className="v2-settings-section"
            data-testid={block.section.value === 'reminders' ? 'settings-notification-kinds' : undefined}
          >
            <h3>{block.section.label}</h3>
            {sectionNotes[block.section.value] && <span>{sectionNotes[block.section.value]}</span>}
          </div>
        )}
        {block.section && sectionLeads[block.section.value]}
        {block.items[0].card ? cardSlot(block.items[0]) : <Card padding="none">{block.items.map((item) => views[item.id])}</Card>}
      </section>
    ))
    content = settings ? groupContent : <>{content}{groupContent}</>
  }
  // 读不到的是设置本身或系统状态时，红条右边给「重新读取」；保存失败不给，那是另一回事。
  const readFailed = Boolean(resource.error) || (!saveError && Boolean(systemError))
  function reread() {
    if (resource.error) void resource.reload()
    if (systemError) {
      setSystemError('')
      setSystemAttempt((value) => value + 1)
    }
  }
  return (
    <section
      ref={pageRef}
      className="v2-page"
      data-page-id="settings"
      data-testid="page-settings"
    >
      <PageHead title="设置" lead={settingsPageLead} />
      <ResultNotice
        error={resource.error || saveError || systemError || operation.error}
        detail={resource.error ? resource.detail : saveError || systemError ? undefined : operation.detail}
        message={operation.revealPath ? operation.message : undefined}
        revealPath={operation.revealPath || undefined}
        onReveal={(path) => api.revealExportedFile(path)}
        retry={readFailed ? { label: '重新读取', onClick: reread } : undefined}
      />
      <div className="v2-business-settings-grid">
        <div className="v2-settings-side">
          <SearchInput
            value={search}
            onChange={setSearch}
            label="搜索设置"
            placeholder="搜索设置"
            testId="settings-search"
          />
          <nav
            className="v2-business-subnav"
            role="tablist"
            aria-label="设置分组"
            aria-orientation="vertical"
          >
            {settingsGroups.map((item, index) => {
              const Icon = settingsGroupIcons[item.value]
              const selected = !searching && group === item.value
              // 左栏的点：版本更新有新版本、网络加速正在加速。提示挂在整个组名上，鼠标停哪儿都看得到。
              const dot = item.value === 'about' && updateAvailable
                ? '有新版本'
                : item.value === 'network' && accelerating
                  ? '加速中'
                  : ''
              return (
                <button
                  key={item.value}
                  id={`v2-settings-${item.value}`}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  aria-controls="v2-settings-panel"
                  tabIndex={group === item.value ? 0 : -1}
                  className={selected ? 'is-active' : ''}
                  title={dot || undefined}
                  onClick={() => openGroup(item.value)}
                  onKeyDown={(event) => {
                    let target = index
                    if (event.key === 'ArrowDown')
                      target = (index + 1) % settingsGroups.length
                    else if (event.key === 'ArrowUp')
                      target =
                        (index + settingsGroups.length - 1) % settingsGroups.length
                    else if (event.key === 'Home') target = 0
                    else if (event.key === 'End') target = settingsGroups.length - 1
                    else return
                    event.preventDefault()
                    openGroup(settingsGroups[target].value)
                    document
                      .getElementById(`v2-settings-${settingsGroups[target].value}`)
                      ?.focus()
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span>{item.label}</span>
                  {dot && <i className={item.value === 'network' ? 'v2-settings-nav-dot is-ok' : 'v2-settings-nav-dot'} aria-hidden="true" />}
                </button>
              )
            })}
          </nav>
        </div>
        <div
          role={searching ? undefined : 'tabpanel'}
          id="v2-settings-panel"
          aria-labelledby={searching ? undefined : `v2-settings-${group}`}
          className="v2-settings-panel"
        >
          {/* 「正在保存更改…」挂在组名右边，不单独占一行，存的时候页面不往下跳。 */}
          <div className="v2-settings-panel-head">
            <h2>{searching ? `搜索「${search.trim()}」` : settingsGroups.find((item) => item.value === group)?.label}</h2>
            {pending > 0 && <span role="status">正在保存更改…</span>}
          </div>
          {settings && searching && <p className="v2-settings-panel-lead">找到 {hits.length} 项，可以直接在这里修改</p>}
          {content}
        </div>
      </div>
      <Dialog
        open={Boolean(importAsk)}
        title="要换成文件里的设置吗？"
        onClose={() => setImportAsk(null)}
        footer={
          <>
            <Button onClick={() => setImportAsk(null)}>取消导入</Button>
            <Button
              onClick={() => finishImport(false)}
              testId="settings-transfer-keep"
            >
              保留这台电脑的
            </Button>
            <Button
              variant="primary"
              onClick={() => finishImport(true)}
              testId="settings-transfer-overwrite"
            >
              换成文件里的
            </Button>
          </>
        }
      >
        <p>
          这台电脑上你已经改过这几项，和文件里的不一样：
          {importAsk?.preview.conflictLabels.join('、')}。
        </p>
        <p>其他设置和聊天记录照常导入，不受这个选择影响。</p>
      </Dialog>
      <Dialog
        open={Boolean(legal)}
        title={legal?.kind === 'privacy-policy' ? '隐私政策' : '用户协议'}
        width={640}
        onClose={() => setLegal(null)}
      >
        <pre className="v2-business-legal">{legal?.markdown}</pre>
      </Dialog>
      <Dialog
        open={shortcuts}
        title="快捷键"
        onClose={() => setShortcuts(false)}
        testId="settings-shortcuts-dialog"
        footer={<Button variant="primary" onClick={() => setShortcuts(false)}>知道了</Button>}
      >
        {shortcutRows(currentWindowOs()).map((entry) => (
          <ListRow key={entry.label} title={entry.label} meta={<kbd className="v2-shortcut-keys">{entry.keys}</kbd>} />
        ))}
      </Dialog>
    </section>
  )
}
