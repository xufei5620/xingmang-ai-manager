import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, LoaderCircle, RefreshCw } from 'lucide-react'
import type { CanvasAssetOriginResult } from '../lib/asset-origin-contract'
import { assetOriginProjectHref, createAssetOriginLookup, type AssetOriginLookupState } from '../editor/asset-origin-navigation'
import './asset-origin.css'

interface AssetOriginNavigationProps {
  assetId: string
  scopeKey: string
  readOrigin?(assetId: string, signal: AbortSignal): Promise<CanvasAssetOriginResult>
  active(): boolean
}

/** The actual browser link appears only after the owned source is verified. */
export function AssetOriginNavigation(props: AssetOriginNavigationProps) {
  const identity = JSON.stringify([props.scopeKey, props.assetId])
  const latest = useRef({ identity, props })
  latest.current = { identity, props }
  const [snapshot, setSnapshot] = useState<{ identity: string; value: AssetOriginLookupState }>({ identity, value: { state: 'loading' } })
  const lookup = useRef<ReturnType<typeof createAssetOriginLookup> | null>(null)
  useEffect(() => {
    const controller = createAssetOriginLookup({ assetId: props.assetId,
      active: () => latest.current.identity === identity && latest.current.props.active(),
      read: (assetId, signal) => {
        const read = latest.current.props.readOrigin
        if (!read) return Promise.reject(new Error('当前宿主暂不支持核对素材来源，请更新后重试。'))
        return read(assetId, signal)
      },
      changed(value) { setSnapshot({ identity, value }) },
    })
    lookup.current = controller
    void controller.load()
    return () => { controller.dispose(); if (lookup.current === controller) lookup.current = null }
  }, [identity, props.assetId])
  const value: AssetOriginLookupState = !props.active() ? { state: 'error', message: '账号或访问状态已变化，请重新进入当前账户核对来源。' } : snapshot.identity === identity ? snapshot.value : { state: 'loading' }
  const result = value.state === 'ready' ? value.result : null
  const href = result && props.active() ? assetOriginProjectHref(result) : null
  return <section className="asset-origin-navigation" aria-label="素材创作来源">
    <strong>创作来源</strong>
    {value.state === 'loading' ? <p role="status"><LoaderCircle size={14} className="xm-spin" />正在核对原工程和这份结果…</p>
      : value.state === 'error' ? <p role="alert">{value.message}</p>
        : result?.state === 'unavailable' ? <p role="status">{result.reason}</p>
          : result?.state === 'available' && <><p>{result.project.name}{result.node.current === 'missing' ? result.run ? ' · 原节点已不在当前保存的画布中，仍可查看原结果。' : ' · 原节点已不在当前保存的画布中，仍可查看原工程结构；没有可核实的原运行。' : result.run ? ' · 查看原工程和生成记录。' : ' · 查看原工程结构；没有可核实的原运行。'}</p>{href && <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (latest.current.identity !== identity || !latest.current.props.active()) event.preventDefault() }}>打开来源工程<ArrowUpRight size={14} /></a>}<small>在新标签页只读查看，保留当前画布与未保存编辑。</small></>}
    {value.state !== 'loading' && <button type="button" onClick={() => void lookup.current?.load()} disabled={!props.active()}><RefreshCw size={13} />重新核对来源</button>}
  </section>
}
