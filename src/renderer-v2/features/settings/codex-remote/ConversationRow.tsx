import { useEffect, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { Button, Dialog, SettingRow } from '../../../ui'
import { errorMessage } from '../../../business-common'
import { useLatestRequest } from '../../../latest-request'
import { remoteConversationErrors, remoteConversationTime } from '../../../../../electron/codex-remote-channel'
import type { CodexRemoteConversationItem, CodexRemoteConversationList, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import { RadioCards, type RadioCardOption } from '../../tools/dialog-parts'
import type { RemoteChannelSectionProps } from './channel-sections'

/**
 * 「通用设置」里「手机端的对话」那一行和「选择对话」弹出的列表（yoyo 2026-11-22 北京 13:15「接对话字改」，原文第 1~16 句逐字）。
 * 第 10 句的「默认」在手机遥控设成「只读」时写「只读」，跟手机上第 21 句同一个口径：降到的就是这一档。
 */
export const codexRemoteConversationText = {
  title: '手机端的对话',
  newHint: '新对话，将在上方文件夹中开始。',
  chosenHint: (title: string, folder: string, time: string) => `继续「${title}」（${folder}，${time}）`,
  choose: '选择对话',
  busy: remoteConversationErrors.busy,
  dialogTitle: '选择手机端的对话',
  dialogLead: '以下为本机 Codex 最近的对话，包括 Codex 桌面端和 Codex CLI 中的对话。选定后，手机端发送的消息将进入该对话，工作文件夹也将切换为该对话所在的文件夹。',
  newOption: '新对话',
  newOptionHint: '在上方选择的文件夹中开始新对话。',
  itemHint: (folder: string, time: string) => `${folder} · ${time}`,
  note: (level: '默认' | '只读') => `继续已有对话时，如对话原有权限超出遥控允许的范围，将调整为「${level}」，在电脑端继续时也将保持。遥控的规则（不发送密钥和密码、回复简洁等）也将保留在该对话中。请勿在电脑端和手机端同时向同一对话发送消息。`,
  ok: '确定',
  cancel: '取消',
  loading: '正在读取对话…',
  unreadable: remoteConversationErrors.unreadable,
  empty: '本机暂无 Codex 对话。',
  unsupported: remoteConversationErrors.unsupported,
} as const

const newConversation = 'new'

type ListState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'loaded'; list: CodexRemoteConversationList }

/** 列表里的几格：第一格永远是「新对话」；正在用的那段不在最近这几段里时补在它后面，免得一打开就像没选。 */
export function conversationOptions(state: ListState, chosen: CodexRemoteConversationItem | undefined): RadioCardOption[] {
  const text = codexRemoteConversationText
  const items = state.kind === 'loaded' && state.list.supported ? [...state.list.items] : []
  if (chosen && state.kind === 'loaded' && state.list.supported && !items.some((item) => item.id === chosen.id)) items.unshift(chosen)
  return [
    { value: newConversation, label: text.newOption, description: text.newOptionHint, testId: 'settings-remote-conversation-new' },
    ...items.map((item) => ({
      value: item.id,
      label: item.title,
      description: text.itemHint(item.folder, remoteConversationTime(item.updatedAt)),
      testId: 'settings-remote-conversation-option',
    })),
  ]
}

/** 列表下面那一行：读取中、读不出来、Codex 版本不支持、一段都没有；正常列出来的时候没有。 */
export function conversationListStatus(state: ListState): string | null {
  const text = codexRemoteConversationText
  if (state.kind === 'loading') return text.loading
  if (state.kind === 'failed') return text.unreadable
  if (!state.list.supported) return text.unsupported
  return state.list.items.length === 0 ? text.empty : null
}

export function ConversationRow({ snapshot, api, busy, run }: { snapshot: CodexRemoteSnapshot } & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const text = codexRemoteConversationText
  const [open, setOpen] = useState(false)
  const working = snapshot.task !== 'idle'
  const chosen = snapshot.conversation
  const description = working
    ? text.busy
    : chosen
      ? text.chosenHint(chosen.title, chosen.folder, remoteConversationTime(chosen.updatedAt))
      : text.newHint
  return (
    <>
      <SettingRow
        title={text.title}
        description={description}
        control={
          <Button
            size="sm"
            icon={MessagesSquare}
            disabled={!snapshot.available || Boolean(busy) || working}
            onClick={() => setOpen(true)}
            testId="settings-remote-conversation"
          >
            {text.choose}
          </Button>
        }
        testId="settings-remote-conversation-row"
      />
      {open ? <ConversationDialog snapshot={snapshot} api={api} busy={busy} run={run} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ConversationDialog({ snapshot, api, busy, run, onClose }: { snapshot: CodexRemoteSnapshot; onClose(): void } & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const text = codexRemoteConversationText
  const latest = useLatestRequest()
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  useEffect(() => {
    const current = latest.begin()
    void api.listCodexRemoteConversations()
      .then((list) => { if (current()) setState({ kind: 'loaded', list }) })
      .catch(() => { if (current()) setState({ kind: 'failed' }) })
  }, [api, latest])
  const [selected, setSelected] = useState(snapshot.conversation?.id ?? newConversation)
  const [failure, setFailure] = useState('')
  const choosing = busy === 'conversation'
  const status = conversationListStatus(state)
  function confirm() {
    const target = selected === newConversation ? null : selected
    if (target === (snapshot.conversation?.id ?? null)) {
      onClose()
      return
    }
    setFailure('')
    void run('conversation', async () => {
      try {
        const next = await api.chooseCodexRemoteConversation(target)
        onClose()
        return next
      } catch (error) {
        setFailure(errorMessage(error))
        return undefined
      }
    })
  }
  const footer = (
    <>
      <Button onClick={onClose} disabled={choosing} testId="settings-remote-conversation-cancel">{text.cancel}</Button>
      <Button variant="primary" loading={choosing} disabled={Boolean(busy) && !choosing} onClick={confirm} testId="settings-remote-conversation-ok">{text.ok}</Button>
    </>
  )
  return (
    <Dialog open title={text.dialogTitle} onClose={onClose} busy={choosing} footer={footer} testId="settings-remote-conversation-dialog">
      <p className="v2-remote-conversation-lead">{text.dialogLead}</p>
      <div className="v2-remote-conversation-list">
        <RadioCards label={text.dialogTitle} value={selected} options={conversationOptions(state, snapshot.conversation)} onChange={setSelected} layout="stack" testId="settings-remote-conversation-list" />
      </div>
      {status ? <p className="v2-remote-conversation-status" role="status" data-testid="settings-remote-conversation-status">{status}</p> : null}
      {failure ? <p className="v2-remote-conversation-error" role="alert" data-testid="settings-remote-conversation-error">{failure}</p> : null}
      <p className="v2-remote-conversation-note">{text.note(snapshot.permission === 'readOnly' ? '只读' : '默认')}</p>
    </Dialog>
  )
}
