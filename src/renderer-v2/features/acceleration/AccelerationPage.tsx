import type { useAcceleration } from './useAcceleration'
import { AccelerationView } from './AccelerationView'

export function AccelerationPage({ connection, scope, onLogin, onHelp, preview = false }: {
  connection: ReturnType<typeof useAcceleration>
  scope: string | null
  onLogin(): void
  onHelp(): void
  preview?: boolean
}) {
  const { snapshot, refresh, start, stop, setMode, lines, selectedLineId, setSelectedLineId, linesBusy, linesError, refreshLines, pingLine } = connection
  return <AccelerationView state={snapshot.state} busy={snapshot.busy} error={snapshot.error}
    signedIn={scope !== null} mode={snapshot.mode} onModeChange={setMode}
    lines={lines} selectedLineId={selectedLineId} linesBusy={linesBusy} linesError={linesError} onSelectLine={setSelectedLineId} onPingLine={pingLine} onRefreshLines={() => { void refreshLines() }}
    onStart={() => { void start(selectedLineId ?? undefined) }} onStartAnyway={() => { void start(selectedLineId ?? undefined, true) }}
    onStop={() => { void stop() }} onRefresh={() => { void refresh() }}
    onLogin={onLogin} onHelp={onHelp} preview={preview} />
}
