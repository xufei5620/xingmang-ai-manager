import { useCallback, useMemo, useRef, useState } from 'react'
import { ImageUpscale } from 'lucide-react'
import type { AiChatAsset, AiChatUpscaleInput } from '../../../../electron/ipc-contract'
import { AI_CHAT_LIMITS } from '../../../../electron/ai-chat-protocol'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { speaksChinese, userFacingErrorMessage } from '../../business-common'
import { useLatestRequest } from '../../latest-request'
import { Button, Menu, useToast } from '../../ui'

// 「变清晰」（全面方案第 26 件，yoyo 2026-11-27 回「本机变清晰」）：对话里的图、作品库里点开的图都有这个菜单，
// 在本机把图放大 2 倍或 4 倍、另存一张进作品库，原图不动。界面上的字照方案第 26 节逐字用；
// 出错时的那几句由主进程给（electron/image-upscale-service.ts 的 imageUpscaleMessages）。

export const imageUpscaleWording = {
  menu: '变清晰',
  twice: '放大 2 倍',
  fourTimes: '放大 4 倍',
  working: '正在提升清晰度…',
  done: '已另存为清晰版，原图保持不变。',
  note: '小字或标识放大后可能变形，用于商品页面前请核对。',
} as const

export type ImageUpscaleScale = AiChatUpscaleInput['scale']

// 主进程不该说英文；万一说了（IPC 自己的错），换成主进程那句「提升清晰度失败」，不把英文原话摆给客户看。
const failedFallback = '提升清晰度失败，请稍后重试；如持续失败，请联系客服。'

export function imageUpscaleErrorMessage(error: unknown): string {
  const message = userFacingErrorMessage(error)
  return speaksChinese(message) ? redactSecretPatterns(message) : failedFallback
}

/** 清晰版在作品库里的标题和搜索用原图那句描述；太长的截到通道收得下的长度。 */
export function imageUpscalePrompt(prompt: string | undefined): string | undefined {
  const text = prompt?.trim().slice(0, AI_CHAT_LIMITS.promptLength)
  return text || undefined
}

export interface ImageUpscaleControl {
  /** 正在变清晰的那几张（按作品编号）。主进程一次只跑一张，后点的排着队，也算在这里。 */
  busy: ReadonlySet<string>
  run: (assetId: string, scale: ImageUpscaleScale, prompt?: string) => void
}

/**
 * 点了「放大 2 倍」「放大 4 倍」以后的事：说一声正在做，做完说已另存、再数一遍作品库；没成把原因说出来。
 * 交出去的对象只在「正在变清晰的那几张」变了时才换，对话里一行行 memo 过的消息不会因为打一个字全部重画。
 * 换账号时这一页整个换掉（按账号挂的 key），上一个账号那张的结果不再上屏。
 */
export function useImageUpscale(upscale: (input: AiChatUpscaleInput) => Promise<AiChatAsset>, onSaved: () => void): ImageUpscaleControl {
  const toast = useToast()
  const owner = useLatestRequest()
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const latest = useRef({ upscale, onSaved, toast, busy })
  latest.current = { upscale, onSaved, toast, busy }
  const run = useCallback((assetId: string, scale: ImageUpscaleScale, prompt?: string) => {
    if (latest.current.busy.has(assetId)) return
    const ticket = owner.capture()
    setBusy((current) => new Set(current).add(assetId))
    latest.current.toast.show(imageUpscaleWording.working, 'neutral')
    const description = imageUpscalePrompt(prompt)
    latest.current.upscale({ assetId, scale, ...(description ? { prompt: description } : {}) }).then(() => {
      if (!ticket()) return
      latest.current.toast.show(imageUpscaleWording.done, 'ok')
      latest.current.onSaved()
    }, (reason: unknown) => {
      if (ticket()) latest.current.toast.show(imageUpscaleErrorMessage(reason), 'bad')
    }).finally(() => setBusy((current) => {
      const next = new Set(current)
      next.delete(assetId)
      return next
    }))
  }, [owner])
  return useMemo(() => ({ busy, run }), [busy, run])
}

export interface ImageUpscaleMenuProps {
  assetId: string
  /** 原图那句描述，清晰版在作品库里沿用。 */
  prompt?: string
  control: ImageUpscaleControl
  /** 对话里那一排小按钮用小号、不带底色的。 */
  compact?: boolean
  testId: string
}

/** 「变清晰」按钮和它的菜单：放大 2 倍、放大 4 倍，下面一句提醒。正在做的那张按钮转着圈、点不了。 */
export function ImageUpscaleMenu({ assetId, prompt, control, compact = false, testId }: ImageUpscaleMenuProps) {
  const working = control.busy.has(assetId)
  const size = compact ? { size: 'xs' as const, variant: 'ghost' as const } : {}
  return <Menu label={imageUpscaleWording.menu} align="start" testId={testId}
    anchor={<Button icon={ImageUpscale} {...size} loading={working} title={working ? imageUpscaleWording.working : imageUpscaleWording.menu} testId={`${testId}-button`}>{working ? imageUpscaleWording.working : imageUpscaleWording.menu}</Button>}
    items={[
      { label: imageUpscaleWording.twice, testId: `${testId}-2x`, onSelect: () => control.run(assetId, 2, prompt) },
      { label: imageUpscaleWording.fourTimes, testId: `${testId}-4x`, onSelect: () => control.run(assetId, 4, prompt) },
      { note: imageUpscaleWording.note },
    ]} />
}
