import { beginBusinessOperation } from '../../business-common'
import type { V2Bridge } from '../../types'

export function createSettingsQueue(
  save: V2Bridge['saveSettings'],
  onSaved: (settings: Awaited<ReturnType<V2Bridge['getSettings']>>) => void,
) {
  let tail: Promise<unknown> = Promise.resolve()
  return (patch: Parameters<V2Bridge['saveSettings']>[0]) => {
    const finish = beginBusinessOperation('保存设置')
    const task = tail
      .catch(() => undefined)
      .then(() => save(patch))
      .then((value) => {
        onSaved(value)
        return value
      })
      .finally(finish)
    tail = task
    return task
  }
}
