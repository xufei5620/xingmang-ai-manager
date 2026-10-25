import { useCallback, useEffect, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button, Card, Notice, Pill, SettingRow, Switch } from '../../../ui'
import { ResultNotice, useOperation, useResource } from '../../../business-common'
import { remoteChannelIds } from '../../../../../electron/codex-remote-channel'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot, RemoteChannelId } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { remoteChannelSections, type RemoteChannelSectionDefinition, type RemoteChannelSectionProps } from './channel-sections'
import {
  boundPeerText,
  newerRemoteSnapshot,
  remoteCardMeta,
  remoteChannelStateLabel,
  remoteChannelStateTone,
  remoteSwitchHint,
} from './remote-view'

/** 卡片最上面那段。只说客户关心的：在哪儿用、花谁的额度、命令要谁点头、什么时候断开。 */
export const codexRemoteIntro = '在手机上私聊你自己的机器人，就能让这台电脑上的 Codex 干活，用的是星芒的线路和额度。只认配对过的那一个人；Codex 要跑命令、改文件夹外面的文件，都先在聊天里问你，你回「同意」才动手。'

/** 凭据存不到下次打开时卡上那条（Linux 没有系统钥匙串时只记在内存里，见 codex-remote-store.ts）。 */
export const codexRemotePersistenceNotices = {
  'session-only': { tone: 'neutral', title: '凭据只记到这次关掉星芒', body: '这台电脑没有系统钥匙串，下次打开星芒要重新填。' },
  unavailable: { tone: 'warn', title: '凭据存不下', body: '这台电脑没法安全保存凭据，手机遥控暂时用不了。' },
} as const

function ChannelBlock({ id, definition, snapshot, channel, api, busy, run }: {
  id: RemoteChannelId
  definition: RemoteChannelSectionDefinition
  snapshot: CodexRemoteSnapshot
  channel: CodexRemoteChannelSnapshot
} & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const disabled = !snapshot.available || Boolean(busy)
  const { Section } = definition
  const canEnable = channel.hasCredential && Boolean(snapshot.workspaceDirectory)
  const pairing = channel.pairing
  let binding = null
  if (channel.hasCredential && pairing) {
    binding = (
      <SettingRow
        title="配对码"
        description={`${definition.pairingHint}10 分钟内有效。`}
        control={
          <>
            <span className="v2-remote-code xm-mono" data-testid={`settings-remote-${id}-code`}>{pairing.code}</span>
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void run(`${id}-cancel-pairing`, () => api.cancelCodexRemotePairing(id))} testId={`settings-remote-${id}-cancel-pairing`}>取消</Button>
          </>
        }
        testId={`settings-remote-${id}-pairing`}
      />
    )
  } else if (channel.hasCredential) {
    const peer = channel.boundPeer
    binding = (
      <SettingRow
        title="绑定的人"
        description={peer ? boundPeerText(peer) : channel.enabled ? '还没配对。点「开始配对」，把配对码私聊发给机器人。' : '还没配对。打开遥控后才能配对。'}
        control={
          <>
            <Button
              size="sm"
              disabled={disabled || !channel.enabled}
              loading={busy === `${id}-pair`}
              onClick={() => void run(`${id}-pair`, () => api.startCodexRemotePairing(id))}
              testId={`settings-remote-${id}-pair`}
            >
              {peer ? '换人' : '开始配对'}
            </Button>
            {peer && (
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(busy)}
                loading={busy === `${id}-unbind`}
                onClick={() => void run(`${id}-unbind`, () => api.unbindCodexRemotePeer(id))}
                testId={`settings-remote-${id}-unbind`}
              >
                解绑
              </Button>
            )}
          </>
        }
        testId={`settings-remote-${id}-peer`}
      />
    )
  }
  return (
    <section className="v2-remote-channel" data-testid={`settings-remote-${id}`}>
      <div className="v2-remote-channel-head">
        <h3>{definition.title}</h3>
        {definition.experimental && <Pill tone="warn">实验功能</Pill>}
        <Pill tone={remoteChannelStateTone(channel.status)} dot testId={`settings-remote-${id}-state`}>{remoteChannelStateLabel(channel.status)}</Pill>
        {/* 各渠道共用：飞书清掉 App ID / App Secret，微信清掉扫码拿到的登录；绑定的人一起解掉。 */}
        {channel.hasCredential && (
          <span className="v2-remote-channel-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              loading={busy === `${id}-logout`}
              onClick={() => void run(`${id}-logout`, () => api.clearCodexRemoteCredentials(id))}
              aria-label={`退出${definition.title}登录`}
              testId={`settings-remote-${id}-logout`}
            >
              退出登录
            </Button>
          </span>
        )}
      </div>
      {channel.status.message && channel.status.state !== 'connected' && (
        <p className="v2-remote-status" data-testid={`settings-remote-${id}-status`}>{channel.status.message}</p>
      )}
      <Section snapshot={channel} api={api} disabled={disabled} busy={busy} run={run} />
      <SettingRow
        title="打开遥控"
        description={remoteSwitchHint(snapshot, channel, definition.credentialHint)}
        control={
          <Switch
            checked={channel.enabled}
            disabled={disabled || (!channel.enabled && !canEnable)}
            onChange={(enabled) => void run(`${id}-switch`, () => api.setCodexRemoteChannelEnabled(id, enabled))}
            aria-label={`打开${definition.title}遥控`}
            testId={`settings-remote-${id}-switch`}
          />
        }
        testId={`settings-remote-${id}-enable`}
      />
      {binding}
    </section>
  )
}

/**
 * 卡片本身：拿到快照以后怎么摆。和取数分开，好用 renderToStaticMarkup 按各种快照直接测。
 */
export function CodexRemotePanel({ snapshot, api, busy, run, error }: {
  snapshot: CodexRemoteSnapshot
  /** 卡上那条红条；没有失败时是空的。 */
  error: ReactNode
} & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const persistenceNotice = snapshot.credentialPersistence === 'durable' ? null : codexRemotePersistenceNotices[snapshot.credentialPersistence]
  return (
    <Card title="手机遥控 Codex" meta={remoteCardMeta(snapshot)} padding="none" testId="settings-remote-card">
      <p className="v2-remote-intro">{codexRemoteIntro}</p>
      <div className="v2-remote-notices">
        {!snapshot.available && snapshot.unavailableReason && (
          <Notice tone="warn" title="这台电脑现在不能打开手机遥控" body={snapshot.unavailableReason} testId="settings-remote-unavailable" />
        )}
        {persistenceNotice && <Notice tone={persistenceNotice.tone} title={persistenceNotice.title} body={persistenceNotice.body} testId="settings-remote-persistence" />}
        {error}
      </div>
      <SettingRow
        title="干活的文件夹"
        description={snapshot.workspaceDirectory
          ? <span className="xm-mono">{snapshot.workspaceDirectory}</span>
          : '还没选。Codex 只在这个文件夹里干活，选一个具体的项目文件夹。'}
        control={
          <Button
            size="sm"
            icon={FolderOpen}
            disabled={!snapshot.available || Boolean(busy)}
            loading={busy === 'workspace'}
            onClick={() => void run('workspace', () => api.chooseCodexRemoteWorkspace())}
            testId="settings-remote-workspace"
          >
            {snapshot.workspaceDirectory ? '换一个' : '选择文件夹'}
          </Button>
        }
        testId="settings-remote-workspace-row"
      />
      {remoteChannelIds.map((id) => (
        <ChannelBlock
          key={id}
          id={id}
          definition={remoteChannelSections[id]}
          snapshot={snapshot}
          channel={snapshot.channels[id]}
          api={api}
          busy={busy}
          run={run}
        />
      ))}
    </Card>
  )
}

/**
 * 设置 › 工具管理最下面的「手机遥控 Codex」。v4 原型没有这张卡，照同一组里的整卡（工具配置备份）摆：
 * 卡头、说明、干活的文件夹，再一个渠道一块（填凭据、打开遥控、配对）。
 * 操作的返回值和 state-changed 事件都是整份快照，按 revision 只收新的那份（newerRemoteSnapshot）。
 */
export function CodexRemoteCard({ api }: { api: V2Bridge }) {
  const load = useCallback(() => api.getCodexRemoteState(), [api])
  const resource = useResource(load)
  const { setData } = resource
  const accept = useCallback((next: CodexRemoteSnapshot) => setData((current) => newerRemoteSnapshot(current, next)), [setData])
  useEffect(() => api.onCodexRemoteStateChanged(accept), [api, accept])
  const operation = useOperation()
  // 成功不弹提示：卡上的状态自己会变。
  function run(name: string, action: () => Promise<CodexRemoteSnapshot | void>) {
    return operation.execute(
      name,
      async () => {
        const next = await action()
        if (next) accept(next)
      },
      '',
    )
  }
  if (!resource.data) {
    return (
      <Card title="手机遥控 Codex" testId="settings-remote-card">
        {resource.error
          ? <ResultNotice error={resource.error} detail={resource.detail} retry={{ label: '重新读取', onClick: () => void resource.reload() }} />
          : <p role="status">正在读取…</p>}
      </Card>
    )
  }
  return (
    <CodexRemotePanel
      snapshot={resource.data}
      api={api}
      busy={operation.busy}
      run={run}
      error={<ResultNotice error={operation.error} detail={operation.detail} />}
    />
  )
}
