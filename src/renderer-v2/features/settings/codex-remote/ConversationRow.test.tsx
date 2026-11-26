import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { ConversationRow, codexRemoteConversationText, conversationListStatus, conversationOptions } from './ConversationRow'

function snapshot(patch: Partial<CodexRemoteSnapshot> = {}): CodexRemoteSnapshot {
  const stopped = { hasCredential: false, accountLabel: null, enabled: false, status: { state: 'stopped' as const }, boundPeer: null, pairing: null }
  return {
    revision: 1,
    available: true,
    credentialPersistence: 'durable',
    workspaceDirectory: '~/projects/demo',
    task: 'idle',
    pendingApprovals: 0,
    channels: { feishu: { channel: 'feishu', ...stopped }, weixin: { channel: 'weixin', ...stopped } },
    ...patch,
  }
}

function row(state: CodexRemoteSnapshot, busy = ''): string {
  return renderToStaticMarkup(<ConversationRow snapshot={state} api={{} as V2Bridge} busy={busy} run={async () => true} />)
}

function chooseButton(markup: string): string {
  return markup.match(/<button[^>]*data-testid="settings-remote-conversation"[^>]*>/)?.[0] ?? ''
}

const at = new Date(2026, 10, 21, 18, 30).getTime()
const chosen = { id: '01a20102-19e8-7b23-968d-694964b4899f', title: '修复登录页报错', folder: '~/projects/demo', updatedAt: at }
const other = { id: '01a20101-8c39-7c23-a0e8-2036f142d454', title: '整理接口文档', folder: '~/projects/demo', updatedAt: new Date(2026, 10, 20, 9, 12).getTime() }

describe('codex remote conversation row', () => {
  // 接对话（yoyo 2026-11-22 北京 13:15「接对话字改」）：第 1~16 句逐字。
  it('uses the confirmed words', () => {
    const text = codexRemoteConversationText
    expect(text.title).toBe('手机端的对话')
    expect(text.newHint).toBe('新对话，将在上方文件夹中开始。')
    expect(text.chosenHint('修复登录页报错', '~/projects/demo', '11-21 18:30')).toBe('继续「修复登录页报错」（~/projects/demo，11-21 18:30）')
    expect(text.choose).toBe('选择对话')
    expect(text.busy).toBe('Codex 正在处理消息，请待其完成后再切换对话。')
    expect(text.dialogTitle).toBe('选择手机端的对话')
    expect(text.dialogLead).toBe('以下为本机 Codex 最近的对话，包括 Codex 桌面端和 Codex CLI 中的对话。选定后，手机端发送的消息将进入该对话，工作文件夹也将切换为该对话所在的文件夹。')
    expect(text.newOption).toBe('新对话')
    expect(text.newOptionHint).toBe('在上方选择的文件夹中开始新对话。')
    expect(text.itemHint('~/projects/demo', '11-21 18:30')).toBe('~/projects/demo · 11-21 18:30')
    expect(text.note('默认')).toBe('继续已有对话时，如对话原有权限超出遥控允许的范围，将调整为「默认」，在电脑端继续时也将保持。遥控的规则（不发送密钥和密码、回复简洁等）也将保留在该对话中。请勿在电脑端和手机端同时向同一对话发送消息。')
    expect([text.ok, text.cancel, text.loading, text.unreadable, text.empty]).toEqual(['确定', '取消', '正在读取对话…', '无法读取对话列表，请稍后重试。', '本机暂无 Codex 对话。'])
    expect(text.unsupported).toBe('当前 Codex 版本暂不支持继续已有对话，请选择新对话。')
  })

  it('says a new conversation starts in the folder above until one is chosen, then names the chosen one', () => {
    expect(row(snapshot())).toContain('<strong>手机端的对话</strong><p>新对话，将在上方文件夹中开始。</p>')
    expect(row(snapshot({ conversation: chosen }))).toContain('<p>继续「修复登录页报错」（~/projects/demo，11-21 18:30）</p>')
    expect(chooseButton(row(snapshot()))).not.toContain('disabled')
  })

  it('holds the choice while Codex is working on a phone message', () => {
    for (const task of ['starting', 'running', 'waiting-approval'] as const) {
      const markup = row(snapshot({ task, conversation: chosen }))
      expect(markup).toContain('<p>Codex 正在处理消息，请待其完成后再切换对话。</p>')
      expect(chooseButton(markup)).toContain('disabled')
    }
    expect(chooseButton(row(snapshot({ available: false })))).toContain('disabled')
  })

  it('always offers a new conversation first and keeps the chosen one on the list', () => {
    const loaded = { kind: 'loaded' as const, list: { supported: true as const, items: [other] } }
    expect(conversationOptions(loaded, chosen).map((option) => [option.value, option.label, option.description])).toEqual([
      ['new', '新对话', '在上方选择的文件夹中开始新对话。'],
      [chosen.id, '修复登录页报错', '~/projects/demo · 11-21 18:30'],
      [other.id, '整理接口文档', '~/projects/demo · 11-20 09:12'],
    ])
    expect(conversationOptions(loaded, other).map((option) => option.value)).toEqual(['new', other.id])
    expect(conversationOptions({ kind: 'loading' }, chosen).map((option) => option.value)).toEqual(['new'])
    expect(conversationOptions({ kind: 'loaded', list: { supported: false } }, chosen).map((option) => option.value)).toEqual(['new'])
  })

  it('says why the list is short while reading, after a failed read, on an unchecked Codex and when there is none', () => {
    expect(conversationListStatus({ kind: 'loading' })).toBe('正在读取对话…')
    expect(conversationListStatus({ kind: 'failed' })).toBe('无法读取对话列表，请稍后重试。')
    expect(conversationListStatus({ kind: 'loaded', list: { supported: false } })).toBe('当前 Codex 版本暂不支持继续已有对话，请选择新对话。')
    expect(conversationListStatus({ kind: 'loaded', list: { supported: true, items: [] } })).toBe('本机暂无 Codex 对话。')
    expect(conversationListStatus({ kind: 'loaded', list: { supported: true, items: [other] } })).toBeNull()
  })
})
