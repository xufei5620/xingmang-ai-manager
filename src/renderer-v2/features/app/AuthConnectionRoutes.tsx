import { useMemo, useRef, useState } from 'react'
import type { AppSettingsV2 } from '../../../../electron/ipc-contract'
import { errorMessage, ResultNotice } from '../../business-common'
import { useToast } from '../../ui'
import { RelayRouteSettings } from './RelayRouteSettings'
import { createSettingsQueue } from './settings-queue'
import type { createAppApi } from './api'

/** The auth form owns its draft while this panel changes only local route preferences. */
export function AuthConnectionRoutes({ api, settings, onSettingsChanged, onBusyChange }: {
  api: ReturnType<typeof createAppApi>
  settings: AppSettingsV2
  onSettingsChanged: (settings: AppSettingsV2) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const saved = useRef(onSettingsChanged)
  saved.current = onSettingsChanged
  const writer = useMemo(() => createSettingsQueue(api.savePreferences, (value) => saved.current(value)), [api])
  const toast = useToast()
  const run = async (work: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setPending(true)
    onBusyChange(true)
    setError('')
    try { await work() }
    catch (reason) { setError(errorMessage(reason)) }
    finally { locked.current = false; setPending(false); onBusyChange(false) }
  }
  return <>
    <ResultNotice error={error} />
    <RelayRouteSettings
      settings={settings}
      saving={pending}
      restarting={pending}
      onChange={(patch) => void run(async () => {
        await writer({ version: 2, ...patch })
        toast.show('已保存', 'ok')
      })}
      onRestart={() => void run(async () => {
        if (!await api.relaunch()) toast.show('已取消重开', 'neutral')
      })}
    />
  </>
}
