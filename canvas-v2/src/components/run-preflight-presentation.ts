import type { CanvasRunPreflight, CanvasRunPreflightItem } from '../runtime/run-preflight'

export interface PreflightDisplayItem {
  nodeId: string
  title: string
  action: CanvasRunPreflightItem['action']
  detail: string
}

export interface PreflightPresentation {
  headline: string
  summary: string
  confirmLabel: string
  canConfirm: boolean
  canConfigure: boolean
  blockedItems: PreflightDisplayItem[]
  items: PreflightDisplayItem[]
  costNotice: string
  retryNotice?: string
}

const titles: Readonly<Record<string, string>> = {
  text: '文本', prompt: '创作要求', note: '便签',
  image: '生成图片', 'image-generate': '生成图片', 'image-edit': '修改图片',
  video: '生成视频', 'video-generate': '生成视频',
  'image-input': '参考图片', 'video-input': '参考视频', 'audio-input': '参考音频',
  'frame-extract': '视频抽帧', router: '传递素材', gallery: '汇总结果', output: '输出结果',
  group: '创作分组', 'drama-bible': '创作设定', 'drama-script': '剧本文本',
  'drama-parse': '解析剧本', 'drama-character': '角色素材', 'drama-scene': '场景素材',
  'drama-prop': '道具素材', 'drama-shot': '分镜',
}

export function preflightItemTitle(kind: string): string {
  return Object.hasOwn(titles, kind) ? titles[kind] : '其他处理步骤'
}

function displayItem(item: CanvasRunPreflightItem): PreflightDisplayItem {
  return {
    nodeId: item.nodeId,
    title: preflightItemTitle(item.kind),
    action: item.action,
    detail: item.reason || (item.action === 'cached' ? '预计复用已有结果，运行时会再次校验'
      : item.action === 'skip' ? '本次跳过，不执行此步骤'
        : item.action === 'blocked' ? '请返回画布检查此步骤'
          : item.paid ? '需要模型处理，可能产生费用' : '本地整理，不调用生成模型'),
  }
}

export function buildPreflightPresentation(preflight: CanvasRunPreflight): PreflightPresentation {
  const items = preflight.items.map(displayItem)
  const blockedItems = items.filter((item) => item.action === 'blocked')
  const remoteItems = preflight.items.filter((item) => item.paid && item.action === 'execute')
  const parts: string[] = []
  if (preflight.imageRequestCount > 0) parts.push(`图片 ${preflight.imageRequestCount} 项`)
  if (preflight.videoRequestCount > 0) parts.push(`视频 ${preflight.videoRequestCount} 项`)
  const textCount = preflight.textRequestCount ?? preflight.items.filter((item) => item.kind === 'drama-parse' && item.action === 'execute').length
  if (textCount > 0) parts.push(`剧本解析 ${textCount} 项`)
  if (preflight.cacheHitCount > 0) parts.push(`预计复用 ${preflight.cacheHitCount} 项`)
  if (preflight.skippedCount > 0) parts.push(`跳过 ${preflight.skippedCount} 项`)
  const blocked = preflight.blockedCount > 0 || blockedItems.length > 0
  const canConfirm = preflight.canStart && !blocked && items.length > 0
  const usesRemote = preflight.items.some((item) => item.paid && ['execute', 'cached'].includes(item.action))
  return {
    headline: blocked ? '先处理这些问题' : '确认这次创作',
    summary: blocked ? `有 ${Math.max(preflight.blockedCount, blockedItems.length)} 项需要处理，本次尚未提交。`
      : parts.join(' · ') || (items.length ? '本次仅整理本地内容' : '当前没有可执行内容'),
    confirmLabel: blocked ? '请先处理问题' : remoteItems.length ? '确认生成' : '确认执行',
    canConfirm,
    canConfigure: preflight.items.some((item) => item.action === 'blocked'
      && (item.reasonCode === 'missing-group' || item.reasonCode === 'unavailable-model')),
    blockedItems,
    items,
    costNotice: blocked ? '请先返回画布处理问题。修复后需重新检查并确认，当前不会从这里提交本次运行。' : usesRemote
      ? '以上是生成步骤，不是价格或请求次数上限。缓存会再次校验，实际调用和费用以服务端结算为准。停止等待不保证上游已取消；结果不明确时，请先查看生成记录。'
      : '本次计划不调用生成模型。只有确认后才会开始执行，关闭此窗口不会提交。',
    ...(preflight.items.some((item) => item.kind === 'drama-parse' && item.action === 'execute')
      ? { retryNotice: '剧本解析失败时可能再次调用文字模型，实际请求次数可能增加。' } : {}),
  }
}

export type PreflightConfirmationState = 'idle' | 'submitting' | 'submitted' | 'uncertain'

/** One dialog lifetime gets one submission. UI state updates alone cannot stop
 * two clicks in the same event turn. Do not release after an unknown failure:
 * a rejected response is not proof that the provider rejected the request. */
export function createPreflightConfirmation() {
  let state: PreflightConfirmationState = 'idle'
  return {
    state: () => state,
    async submit(allowed: boolean, confirm: () => void | Promise<void>): Promise<PreflightConfirmationState> {
      if (!allowed || state !== 'idle') return state
      state = 'submitting'
      try {
        await confirm()
        state = 'submitted'
      } catch {
        state = 'uncertain'
      }
      return state
    },
  }
}
