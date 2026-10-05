import {
  buildConnectionRoutePatch,
  connectionRouteNeedsRestart,
  connectionRouteOptions,
  connectionRouteSelection,
  connectionRouteSettings,
  type ConnectionRoutePreferences,
} from '../../registry/connection-routes'
import { settingsItemLabel } from '../../registry/business'
import { Button, Notice, Select, SettingRow } from '../../ui'

export function RelayRouteSettings({
  settings,
  saving,
  restarting,
  onChange,
  onRestart,
}: {
  settings: ConnectionRoutePreferences
  saving: boolean
  restarting: boolean
  onChange: (patch: NonNullable<ReturnType<typeof buildConnectionRoutePatch>>) => void
  onRestart: () => void
}) {
  return (
    <>
      {connectionRouteSettings.map((route) => {
        const options = connectionRouteOptions(route.siteId)
        return <SettingRow
          key={route.id}
          anchor={route.id}
          title={settingsItemLabel(route.id)}
          description={route.description}
          control={<Select
            aria-label={route.label}
            testId={`settings-${route.id}`}
            value={connectionRouteSelection(settings, route.siteId)}
            options={options}
            disabled={saving || restarting || options.length < 2}
            onChange={(event) => {
              const patch = buildConnectionRoutePatch(settings, route.siteId, event.target.value)
              if (patch) onChange(patch)
            }}
          />}
        />
      })}
      {connectionRouteNeedsRestart(settings) && <Notice
        tone="neutral"
        title="线路已保存，等待重启"
        body="重启星芒后使用新线路。请先保存工具里正在进行的工作，重启星芒后再重新打开工具。"
        testId="settings-relay-relaunch"
        actions={<Button
          size="sm"
          variant="primary"
          testId="settings-relay-relaunch-now"
          disabled={saving || restarting}
          onClick={onRestart}
        >现在重开</Button>}
      />}
    </>
  )
}
