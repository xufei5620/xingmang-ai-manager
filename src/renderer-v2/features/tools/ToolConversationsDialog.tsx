import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { MultiProviderSessionPage, ProviderId } from '../../../../electron/ipc-contract'
import { Button, Dialog, Pill } from '../../ui'
import { errorMessage } from '../../business-common'
import type { ToolsApi } from './api'
import { formatRecentTime, recentReplacedHint, recentResumeHint } from './recent-display'
import { folderConversations, resumeNeedsRecheck, resumeStillLatest, workspaceName } from './recent-workspaces'

type SessionSummary = MultiProviderSessionPage['items'][number]

/** 窗口标题：「接着 Codex CLI 之前的对话」。 */
export function conversationsDialogTitle(toolName: string): string {
  return `接着 ${toolName} 之前的对话`
}

export interface ToolConversationsDialogProps {
  api: Pick<ToolsApi, 'toolSessions'>
  provider: ProviderId
  toolName: string
  /** 「接着聊」这会儿按不动：还在检测、在换密钥、别的工具正在打开（同首页「接着上次」那几行）。 */
  resumeDisabled: boolean
  /** 「开新对话」按不动：同卡片上的「打开」。 */
  newDisabled: boolean
  /** 核对过、点下去接上的就是它的那一条。窗口由外层关。 */
  onResume(session: SessionSummary): void
  onNew(): void
  onAllRecords(): void
  onClose(): void
}

/**
 * 卡片「…」里「接着之前的对话…」打开的窗口：这个工具每个文件夹一行（见 folderConversations），
 * 每次打开现读这一个工具的记录，不用首页那份一分钟的缓存，刚在终端里聊的那条也在。
 */
export function ToolConversationsDialog(props: ToolConversationsDialogProps) {
  const { api, provider } = props
  const [page, setPage] = useState<MultiProviderSessionPage | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  // 「接着聊」点下去以后正在核对的那一条（见 resume）；null = 没在核对。
  const [checking, setChecking] = useState<string | null>(null)
  // 上一次「接着聊」换成了同一文件夹更新的那条、没打开时说的那句；再点「接着聊」就清掉。
  const [replaced, setReplaced] = useState('')
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    let current = true
    setError('')
    void api.toolSessions(provider).then((value) => { if (current) setPage(value) }).catch((cause) => {
      if (current) setError(errorMessage(cause, '记录暂时没有读到'))
    })
    return () => { current = false }
  }, [api, provider, attempt])
  /**
   * 窗口开着时客户可能又在终端里聊了一条：Claude Code、Grok CLI 按文件夹接最近一条，
   * 点同一文件夹里旧的那行，接上的却是刚聊的那条。所以先再读一次（同首页 resumeRecent，已知4）：
   * 点的这条已经不是它那个文件夹最近的了，就换上新列表、这次不打开。读不到就照旧打开。
   */
  async function resume(session: SessionSummary) {
    setReplaced('')
    if (resumeNeedsRecheck(session)) {
      setChecking(session.id)
      const fresh = await api.toolSessions(provider).catch(() => null)
      if (!active.current) return
      setChecking(null)
      if (fresh) setPage(fresh)
      if (fresh && !resumeStillLatest(session, fresh.items)) {
        setReplaced(recentReplacedHint(session))
        return
      }
    }
    props.onResume(session)
  }
  const rows = page ? folderConversations(page.items, provider) : []
  return <Dialog open title={conversationsDialogTitle(props.toolName)} width={640} onClose={props.onClose} testId="tool-conversations-dialog"
    footer={<>
      <span className="v2-dialog-footer-start"><Button variant="ghost" onClick={props.onAllRecords} testId="tool-conversations-all">全部记录</Button></span>
      <Button disabled={props.newDisabled} onClick={props.onNew} testId="tool-conversations-new">开新对话</Button>
    </>}>
    {error ? <div className="v2-home-recent-empty" role="status">{error}<Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>重新加载</Button></div>
      : !page ? <div className="v2-home-recent-empty" role="status">正在读取最近记录</div>
        : rows.length ? <>{replaced && <div className="v2-home-recent-note" role="status" data-testid="tool-conversations-replaced">{replaced}</div>}<div className="v2-tool-conversations">{rows.map((session) => <div className="v2-home-recent-row" key={session.id} data-testid={`tool-conversation-row-${session.id}`}>
          <span className="v2-recent-title" title={session.title}>{session.title}</span>
          <span className="v2-home-recent-dir" title={session.cwd}>{workspaceName(session.cwd)}</span>
          {session.cwdExists === false ? <Pill tone="warn">文件夹已不存在</Pill> : <span className="v2-home-recent-time">{formatRecentTime(session.updatedAt, Date.now())}</span>}
          <span className="v2-home-recent-actions">
            <Button size="xs" variant="ghost" icon={Play} loading={checking === session.id} disabled={props.resumeDisabled || checking !== null || session.cwdExists === false}
              title={recentResumeHint(session)} onClick={() => void resume(session)} testId={`tool-conversation-resume-${session.id}`}>接着聊</Button>
          </span>
        </div>)}</div></>
          : <div className="v2-home-recent-empty">还没有对话记录。打开工具聊过之后，最近的会话会出现在这里。</div>}
  </Dialog>
}
