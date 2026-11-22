// 设置 › 工具管理里「给 AI 的长期嘱咐」那一格（总单 Q4 C5）：一段话写进 Claude Code、Codex、Grok 各自的全局说明，
// 主进程只动文件里星芒那一段（electron/standing-instructions.ts），客户自己写的一个字不碰。
// 三家各写各的：哪家没写上就在框下面说是哪家、为什么，写上的照样生效。
import { useEffect, useState } from 'react'
import { Button, Notice, Textarea } from '../../ui'
import { tools } from '../../registry/tools'
import type { V2Bridge } from '../../types'

type SaveResult = Awaited<ReturnType<V2Bridge['saveStandingInstructions']>>
type ToolResult = SaveResult['tools'][number]

/** 跟主进程 STANDING_INSTRUCTIONS_MAX_LENGTH 一样；主进程那边照样再查一遍（I5）。 */
export const standingInstructionsMaxLength = 2000

export const standingInstructionsSavedText = '已保存，下次打开工具时生效。'
export const standingInstructionsClearedText = '已清空，下次打开工具时生效。'

function toolName(provider: ToolResult['provider']): string {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

/** 没写上的那几家，一家一句：「Grok CLI 未能写入：……」。 */
export function standingInstructionsMissedLines(result: SaveResult): string[] {
  return result.tools
    .filter((tool) => tool.outcome === 'skipped' || tool.outcome === 'failed')
    .map((tool) => `${toolName(tool.provider)} 未能写入：${tool.reason ?? '写入失败，请重试。'}`)
}

/** 框里的字跟上次存下的比：首尾空白、换行写法不算改动，跟主进程收到以后的整理一样。 */
function normalized(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

export function StandingInstructionsField({
  api,
  saved,
  busy,
  save,
}: {
  api: V2Bridge
  /** 上次存下的那段话（设置里的 standingInstructions），没有给空字符串。 */
  saved: string
  /** 设置页别的动作正在跑：保存按钮先灰着，跟这一页别的开关一样。 */
  busy: boolean
  /** 交给设置页的 operation.execute 跑，失败照这一页的红条报；成功回来的结果在这里画。 */
  save: (run: () => Promise<SaveResult>, done: (result: SaveResult) => string | null) => void
}) {
  const [draft, setDraft] = useState(saved)
  const [missed, setMissed] = useState<string[]>([])
  // 设置读回来或者别处改了以后跟上；客户正在改的不覆盖。
  const [base, setBase] = useState(saved)
  useEffect(() => {
    if (saved === base) return
    setDraft((current) => (normalized(current) === normalized(base) ? saved : current))
    setBase(saved)
  }, [saved, base])
  const length = [...draft.replace(/\r\n?/g, '\n').trim()].length
  const tooLong = length > standingInstructionsMaxLength
  const unchanged = normalized(draft) === normalized(saved)
  return (
    <div className="v2-standing-instructions">
      <Textarea
        aria-label="给 AI 的长期嘱咐"
        testId="settings-standing-instructions-text"
        rows={4}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setMissed([])
        }}
        error={tooLong ? `最多 ${standingInstructionsMaxLength} 字` : undefined}
      />
      <div className="v2-standing-instructions-foot">
        <span className="v2-standing-instructions-count" aria-live="polite">{`${length}/${standingInstructionsMaxLength}`}</span>
        <Button
          size="sm"
          variant="primary"
          testId="settings-standing-instructions-save"
          disabled={busy || unchanged || tooLong}
          onClick={() =>
            save(
              () => api.saveStandingInstructions(draft),
              (result) => {
                const lines = standingInstructionsMissedLines(result)
                setMissed(lines)
                const wrote = result.tools.some((tool) => tool.outcome !== 'skipped' && tool.outcome !== 'failed')
                if (wrote) setDraft(result.text)
                if (!wrote) return null
                return result.text ? standingInstructionsSavedText : standingInstructionsClearedText
              },
            )
          }
        >
          保存
        </Button>
      </div>
      {missed.length ? (
        <Notice
          tone="warn"
          title="部分工具未能写入"
          body={missed.map((line) => <div key={line}>{line}</div>)}
          testId="settings-standing-instructions-missed"
        />
      ) : null}
    </div>
  )
}
