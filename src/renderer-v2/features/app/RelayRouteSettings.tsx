import { useState } from 'react'
import { Info } from 'lucide-react'
import {
  buildConnectionRoutePatch,
  connectionRouteNeedsRestart,
  connectionRouteOptions,
  connectionRouteSelection,
  connectionRouteSettings,
  type ConnectionRoutePreferences,
} from '../../registry/connection-routes'
import { settingsItemLabel } from '../../registry/business'
import { Button, Card, Confirm, Segment, SettingRow } from '../../ui'

/** 设置 › 网络加速 › 连接线路里的一行：一种账号一行，三个选项排成一排。 */
export function RelayRouteRow({
  route,
  settings,
  disabled,
  onChange,
}: {
  route: (typeof connectionRouteSettings)[number]
  settings: ConnectionRoutePreferences
  /** 正在保存或正在重开时整排点不了。 */
  disabled: boolean
  onChange: (patch: NonNullable<ReturnType<typeof buildConnectionRoutePatch>>) => void
}) {
  const options = connectionRouteOptions(route.siteId)
  return <SettingRow
    anchor={route.id}
    title={settingsItemLabel(route.id)}
    description={route.description}
    control={<Segment
      label={route.label}
      testId={`settings-${route.id}`}
      value={connectionRouteSelection(settings, route.siteId)}
      options={options.map((option) => ({ ...option, disabled: disabled || options.length < 2 }))}
      onChange={(value) => {
        const patch = buildConnectionRoutePatch(settings, route.siteId, value)
        if (patch) onChange(patch)
      }}
    />}
  />
}

/**
 * 线路存好了、这次启动还在用旧的那条时，连接线路那张卡上面的一条。「现在重开」先问一句：
 * 重开会关掉工具里正在跑的东西，要让人先存好。
 */
export function RelayRouteRestartNotice({
  settings,
  disabled,
  duringLogin = false,
  onRestart,
}: {
  settings: ConnectionRoutePreferences
  disabled: boolean
  /** 登录框里「切换连接线路」打开的：还没登录，要提醒的是填了一半的登录信息。缺省 = 设置页。 */
  duringLogin?: boolean
  onRestart: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!connectionRouteNeedsRestart(settings)) return null
  return (
    <>
      <div className="v2-settings-route-wait" role="status" data-testid="settings-relay-relaunch">
        <Info size={15} aria-hidden="true" />
        <strong>线路已保存，等待重启</strong>
        <Button
          size="sm"
          testId="settings-relay-relaunch-now"
          disabled={disabled}
          onClick={() => setAsking(true)}
        >现在重开</Button>
      </div>
      <Confirm
        open={asking}
        title="现在重开星芒？"
        body={<p>{duringLogin ? '重开后按新线路连接。没填完的登录信息要重新填。请先保存工具里正在进行的工作。' : '重开后按新线路连接。登录状态和配好的工具都不变。请先保存工具里正在进行的工作。'}</p>}
        cancelLabel="稍后"
        okLabel="现在重开"
        testId="settings-relay-relaunch-confirm"
        onClose={() => setAsking(false)}
        // 先关掉这个框再重开：开着的对话框会被关窗前的检查当成「还有没保存的东西」。
        onOk={() => {
          setAsking(false)
          onRestart()
        }}
      />
    </>
  )
}

/** 登录框里的「切换连接线路」：等重开的那一条在上，两种账号的线路一张卡。 */
export function RelayRouteSettings({
  settings,
  disabled,
  onChange,
  onRestart,
}: {
  settings: ConnectionRoutePreferences
  disabled: boolean
  onChange: (patch: NonNullable<ReturnType<typeof buildConnectionRoutePatch>>) => void
  onRestart: () => void
}) {
  return (
    <>
      <RelayRouteRestartNotice settings={settings} disabled={disabled} duringLogin onRestart={onRestart} />
      <Card padding="none">
        {connectionRouteSettings.map((route) => (
          <RelayRouteRow key={route.id} route={route} settings={settings} disabled={disabled} onChange={onChange} />
        ))}
      </Card>
    </>
  )
}
