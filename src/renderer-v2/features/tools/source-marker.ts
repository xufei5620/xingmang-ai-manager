import type { ProviderId } from '../../../../electron/ipc-contract'

export type SourceMarkerStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>

const markerPrefix = 'xingmang-v2:provider-source:v1'
const manualMarker = 'manual'

export function getSourceMarkerStorage(): SourceMarkerStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Provider paths and relay-site aliases on one origin intentionally share a marker. */
export function manualSourceMarkerKey(
  relayBaseUrl: string,
  provider: ProviderId,
): string | null {
  try {
    const url = new URL(relayBaseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${markerPrefix}:${encodeURIComponent(url.origin)}:${provider}`
  } catch {
    return null
  }
}

export function readManualSourceMarker(
  storage: SourceMarkerStorage | null,
  relayBaseUrl: string,
  provider: ProviderId,
): boolean {
  const key = manualSourceMarkerKey(relayBaseUrl, provider)
  if (!storage || !key) return false
  try {
    return storage.getItem(key) === manualMarker
  } catch {
    return false
  }
}

export function writeManualSourceMarker(
  storage: SourceMarkerStorage | null,
  relayBaseUrl: string,
  provider: ProviderId,
  manual: boolean,
): boolean {
  const key = manualSourceMarkerKey(relayBaseUrl, provider)
  if (!storage || !key) return false
  try {
    if (manual) storage.setItem(key, manualMarker)
    else storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/**
 * localStorage 被禁用或写满时，配置本身已经写进 CLI，只是这次选的来源没记下来，
 * 工具卡会退回按配置推断，可能显示成另一个来源。所以文案先交代「不影响使用」。
 */
export const sourceMarkerWriteWarning =
  '这次选择的密钥来源没能记在本机，工具卡上显示的来源可能不准确，不影响工具正常使用。'

/**
 * 写入来源标记并把失败折成一句给用户看的话，空字符串表示这次没有需要提醒的事。
 * 保存流程只需一次赋值就能把结果接进提示通道，避免返回值像以前那样被整段丢掉。
 *
 * 清除标记时先确认确实有标记可清：读不到就说明来源推断同样读不到它，展示不受
 * 影响，不该在每次保存时弹一句用户无从处理的警告。写入标记则一旦失败必然错标。
 */
export function applyManualSourceMarker(
  storage: SourceMarkerStorage | null,
  relayBaseUrl: string,
  provider: ProviderId,
  manual: boolean,
): string {
  if (!manual && !readManualSourceMarker(storage, relayBaseUrl, provider)) return ''
  return writeManualSourceMarker(storage, relayBaseUrl, provider, manual)
    ? ''
    : sourceMarkerWriteWarning
}
