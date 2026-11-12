import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, FolderPlus, Headset, Home, RefreshCw, Zap } from 'lucide-react'
import { Button, Card, Confirm, Notice, Pill, Segment, SettingRow, Switch, useBalanceTier } from '../../../ui'
import { dollars, ResultNotice, useOperation, useResource } from '../../../business-common'
import { useSharedAccountBalance } from '../../app/balance-context'
import { isRemoteIdleCloseHours, remoteChannelIds, remoteIdleCloseHours } from '../../../../../electron/codex-remote-channel'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot, RemoteChannelId } from '../../../../../electron/ipc-contract'
import type { V2Bridge, V2Page } from '../../../types'
import { remoteChannelSections, type RemoteChannelSectionDefinition, type RemoteChannelSectionProps } from './channel-sections'
import {
  boundPeerText,
  lastRequestText,
  newerRemoteSnapshot,
  pairingAttemptText,
  pendingApprovalsText,
  remoteAnyEnabled,
  remoteCardMeta,
  remoteChannelCollapsed,
  remoteLowBalanceDollars,
  remoteChannelStateLabel,
  remoteChannelStateTone,
  remoteSwitchHint,
  remoteWorkspaceFolders,
  remoteWorkspaceMax,
} from './remote-view'

/**
 * 卡片最上面那段。只说客户关心的：在哪儿用、花谁的额度、命令要谁点头、什么时候断开。
 * 末尾那句提醒：同意也是在同一个聊天里点的，绑定的飞书或微信账号落到谁手里，谁就能指挥这台电脑（#1407）。
 */
export const codexRemoteIntro = '在手机上私聊你自己的机器人，就能让这台电脑上的 Codex 干活，用的是星芒的线路和额度。只认配对过的那一个人；Codex 要改文件、跑会改东西的命令，都先在聊天里问你，你回「同意」才动手；只是看文件不问。谁能用你绑定的飞书或微信发消息，谁就能指挥这台电脑，账号别借给别人。'

/** 凭据存不到下次打开时卡上那条（Linux 没有系统钥匙串时只记在内存里，见 codex-remote-store.ts）。 */
export const codexRemotePersistenceNotices = {
  'session-only': { tone: 'neutral', title: '凭据只记到这次关掉星芒', body: '这台电脑没有系统钥匙串，下次打开星芒要重新填。' },
  unavailable: { tone: 'warn', title: '凭据存不下', body: '这台电脑没法安全保存凭据，手机遥控暂时用不了。' },
} as const

/**
 * 手机上那条因为电脑上的 Codex 起不来没做时卡上那条黄条（YK-5）。手机上只收到一句「请在电脑上的星芒里看一下」，
 * 坐回电脑前得一眼看出是哪儿坏了、去哪儿修。Codex 下次起来了、或者遥控全关了就收起（主进程清掉 codexStartFailed）。
 */
export const codexStartFailedNotice = {
  title: 'Codex 没能启动',
  body: '手机上刚发来的那条没有做。去首页看一下 Codex，好了以后在手机上再发一次。',
  action: '去首页看 Codex',
} as const

/**
 * 「干活的文件夹」那一行（YF-19）：电脑上能加几个，手机上发「文件夹」看、发「文件夹 2」换。只加了一个时跟以前一样
 * 只写路径；不止一个时一个一行，正在用的标出来，别的能「用这个」「移除」。
 */
export const codexRemoteWorkspaceText = {
  title: '干活的文件夹',
  empty: '还没选。Codex 只在这个文件夹里干活，选一个具体的项目文件夹。',
  choose: '选择文件夹',
  add: '添加一个',
  inUse: '正在用',
  use: '用这个',
  remove: '移除',
  phoneHint: '手机上发「文件夹」也能换。',
  full: (max: number) => `最多 ${max} 个，先移除一个再添加。`,
} as const

/**
 * 「打开星芒时自动打开遥控」那一行（YF-9，yoyo 2026-11-11 亲手打字「遥控自动开，做」）。默认关；说明把风险说在前头：
 * 开机自启的星芒没人在电脑前也会连上。
 */
export const codexRemoteAutoStartText = {
  title: '打开星芒时自动打开遥控',
  description: '开着时，每次打开星芒都会自己连上，不用再回这里点。星芒开机自启的话，没人在电脑前时手机也能指挥它。不放心就别开。',
} as const

/**
 * 「多久没消息就自动关」那一行（YF-10，yoyo 2026-11-11 亲手打字「不自动关」「默认不关」）。缺省是「不自动关」，
 * 选它时下面那句小字说清楚还有哪几种办法关；选了时长不写小字，「打开遥控」那行的说明会带上时长。
 */
export const codexRemoteIdleCloseText = {
  title: '多久没消息就自动关',
  never: '不自动关',
  neverHint: '只有你在电脑上、托盘里关，或者手机上发「关闭遥控」才会关。',
  // Mac 上没有托盘，星芒的图标在屏幕顶部的菜单栏里（#1745，yoyo 2026-11-11「菜单栏改」）。
  neverHintMac: '只有你在电脑上、菜单栏里关，或者手机上发「关闭遥控」才会关。',
} as const

/**
 * 「最近一次」那行（YF-13）：坐回电脑前看得出手机最近让它干了什么。只摆时间和结果，不摆手机上发来的原话；
 * 「停下这一轮」跟手机上发「停止」一样，「都拒绝」跟手机上点「拒绝」一样，手机上都收得到。
 */
export const codexRemoteLastRequestText = {
  title: '最近一次',
  stop: '停下这一轮',
  declineAll: '都拒绝',
  sessions: '在记录里看',
} as const

/**
 * 遥控开着、余额不到 $1 又没有能用的订阅时卡上那条黄条（YF-12）：充值只能在电脑上做，人出门了就充不了。
 * 照样让开，只是提醒。
 */
export const codexRemoteLowBalanceNotice = {
  title: (amount: string) => `余额只剩 ${amount}`,
  body: '人不在电脑前时充不了值，建议先充一点再出门。',
  action: '去充值',
} as const

const idleCloseOptions = [
  ...remoteIdleCloseHours.map((hours) => ({ value: String(hours), label: `${hours} 小时` })),
  { value: 'never', label: codexRemoteIdleCloseText.never },
]

/**
 * 「解绑」「退出登录」点了先问一句（0.2.24 D67）：做完那个人立刻用不了，得重新配对或重新登录。
 * 退出登录那个框的标题带渠道名，跟按钮的读屏名字（退出飞书登录 / 退出微信登录）一样；正文各渠道不同
 * （飞书重新填凭据、微信重新扫码），放在 remoteChannelSections 的 logoutHint。
 */
export const codexRemoteConfirmText = {
  unbind: { title: '解绑？', body: '解绑后，这个人就不能再用手机遥控这台电脑了，要用得重新配对。', ok: '解绑' },
  logout: { title: (channelTitle: string) => `退出${channelTitle}登录？`, ok: '退出登录' },
} as const

function ChannelBlock({ id, definition, snapshot, channel, api, busy, run, navigate, onOpenHelp, isMac }: {
  id: RemoteChannelId
  definition: RemoteChannelSectionDefinition
  snapshot: CodexRemoteSnapshot
  channel: CodexRemoteChannelSnapshot
  onOpenHelp?: () => void
  isMac: boolean
} & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run' | 'navigate'>) {
  // 没登录的渠道收成一行，点标题才摊开（YF-7）。登录、打开以后就不再收。
  const collapsible = remoteChannelCollapsed(snapshot, channel)
  const [expanded, setExpanded] = useState(false)
  const disabled = !snapshot.available || Boolean(busy)
  // 那句话旁边配的按钮（D23）：同一个应用在别处连着、别的原因没连上，给「重新连接」；后一种再给「找客服」。
  // 凭据不对时就是下面「飞书应用」那一行的「重新填写」，不再摆第二颗。只在开着时给：关着的渠道没什么可重连的。
  const problem = channel.status.state === 'connected' ? undefined : channel.status.problem
  const canReconnect = channel.enabled && (problem === 'connection-limit' || problem === 'other')
  const { Section } = definition
  const canEnable = channel.hasCredential && Boolean(snapshot.workspaceDirectory)
  const pairing = channel.pairing
  const pairingNote = channel.hasCredential ? pairingAttemptText(channel, definition.pairingQuietHint) : null
  const [asking, setAsking] = useState<'unbind' | 'logout' | null>(null)
  // 先关框再做：做不成的原因摆在卡上的红条里，框开着会挡住它。
  function confirmAsked() {
    const action = asking
    setAsking(null)
    if (action === 'unbind') void run(`${id}-unbind`, () => api.unbindCodexRemotePeer(id))
    else if (action === 'logout') void run(`${id}-logout`, () => api.clearCodexRemoteCredentials(id))
  }
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
                onClick={() => setAsking('unbind')}
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
  const statePill = <Pill tone={remoteChannelStateTone(channel.status)} dot testId={`settings-remote-${id}-state`}>{remoteChannelStateLabel(channel.status)}</Pill>
  const bodyId = `settings-remote-${id}-body`
  if (collapsible && !expanded) {
    return (
      <section className="v2-remote-channel" data-testid={`settings-remote-${id}`}>
        <div className="v2-remote-channel-head is-collapsed">
          <h3>
            <button type="button" className="v2-remote-channel-toggle" aria-expanded={false} aria-controls={bodyId} onClick={() => setExpanded(true)} data-testid={`settings-remote-${id}-toggle`}>
              <ChevronRight size={16} aria-hidden="true" />{definition.title}
            </button>
          </h3>
          {statePill}
        </div>
      </section>
    )
  }
  return (
    <section className="v2-remote-channel" data-testid={`settings-remote-${id}`}>
      <div className="v2-remote-channel-head">
        {collapsible
          ? (
            <h3>
              <button type="button" className="v2-remote-channel-toggle" aria-expanded aria-controls={bodyId} onClick={() => setExpanded(false)} data-testid={`settings-remote-${id}-toggle`}>
                <ChevronDown size={16} aria-hidden="true" />{definition.title}
              </button>
            </h3>
          )
          : <h3>{definition.title}</h3>}
        {definition.experimental && <Pill tone="warn">实验功能</Pill>}
        {statePill}
        {/* 各渠道共用：飞书清掉 App ID / App Secret，微信清掉扫码拿到的登录；绑定的人一起解掉。 */}
        {channel.hasCredential && (
          <span className="v2-remote-channel-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(busy)}
              loading={busy === `${id}-logout`}
              onClick={() => setAsking('logout')}
              aria-label={`退出${definition.title}登录`}
              testId={`settings-remote-${id}-logout`}
            >
              退出登录
            </Button>
          </span>
        )}
      </div>
      <div id={bodyId}>
        {channel.status.message && channel.status.state !== 'connected' && (
          <p className="v2-remote-status" data-testid={`settings-remote-${id}-status`}>{channel.status.message}</p>
        )}
        {canReconnect && (
          <div className="v2-remote-status-actions" data-testid={`settings-remote-${id}-status-actions`}>
            <Button
              size="sm"
              icon={RefreshCw}
              disabled={disabled}
              loading={busy === `${id}-reconnect`}
              onClick={() => void run(`${id}-reconnect`, () => api.reconnectCodexRemoteChannel(id))}
              testId={`settings-remote-${id}-reconnect`}
            >
              重新连接
            </Button>
            {problem === 'other' && onOpenHelp && (
              <Button size="sm" variant="ghost" icon={Headset} onClick={onOpenHelp} testId={`settings-remote-${id}-support`}>
                找客服
              </Button>
            )}
          </div>
        )}
        <Section snapshot={channel} api={api} disabled={disabled} busy={busy} run={run} navigate={navigate} />
        <SettingRow
          title="打开遥控"
          description={remoteSwitchHint(snapshot, channel, definition.credentialHint, isMac)}
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
        {pairingNote && <p className="v2-remote-pairing-note" data-testid={`settings-remote-${id}-pairing-note`}>{pairingNote}</p>}
      </div>
      <Confirm
        open={asking !== null}
        title={asking === 'logout' ? codexRemoteConfirmText.logout.title(definition.title) : codexRemoteConfirmText.unbind.title}
        body={<p>{asking === 'logout' ? definition.logoutHint : codexRemoteConfirmText.unbind.body}</p>}
        okLabel={asking === 'logout' ? codexRemoteConfirmText.logout.ok : codexRemoteConfirmText.unbind.ok}
        danger
        onOk={confirmAsked}
        onClose={() => setAsking(null)}
        testId={`settings-remote-${id}-confirm`}
      />
    </section>
  )
}

/** 正在处理时「已经 N 分钟」跟着走：半分钟重画一次，做完了就停。 */
function useTicking(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function LastRequestRow({ snapshot, api, busy, run, navigate, now }: {
  snapshot: CodexRemoteSnapshot
  navigate?: (page: V2Page, section?: string) => void
  /** 测试用的钟；缺省跟着真实时间走。 */
  now?: number
} & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const request = snapshot.lastRequest
  const running = request?.state === 'running'
  const ticking = useTicking(running && now === undefined)
  if (!request) return null
  const waiting = pendingApprovalsText(snapshot.pendingApprovals)
  return (
    <SettingRow
      title={codexRemoteLastRequestText.title}
      description={
        <>
          <span data-testid="settings-remote-last-request-text">{lastRequestText(request, now ?? ticking)}</span>
          {waiting && <><br /><span className="v2-remote-waiting" data-testid="settings-remote-last-request-waiting">{waiting}</span></>}
        </>
      }
      control={
        <>
          {running && (
            <Button size="sm" disabled={Boolean(busy)} loading={busy === 'stop-turn'} onClick={() => void run('stop-turn', () => api.stopCodexRemoteTurn())} testId="settings-remote-stop-turn">
              {codexRemoteLastRequestText.stop}
            </Button>
          )}
          {snapshot.pendingApprovals > 0 && (
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} loading={busy === 'decline-approvals'} onClick={() => void run('decline-approvals', () => api.declineCodexRemoteApprovals())} testId="settings-remote-decline-approvals">
              {codexRemoteLastRequestText.declineAll}
            </Button>
          )}
          {navigate && (
            <Button size="sm" variant="ghost" onClick={() => navigate('sessions')} testId="settings-remote-last-request-sessions">
              {codexRemoteLastRequestText.sessions}
            </Button>
          )}
        </>
      }
      testId="settings-remote-last-request"
    />
  )
}

/**
 * 卡片本身：拿到快照以后怎么摆。和取数分开，好用 renderToStaticMarkup 按各种快照直接测。
 */
export function CodexRemotePanel({ snapshot, api, busy, run, error, navigate, onOpenHelp, lowBalance = null, now, isMac = false }: {
  snapshot: CodexRemoteSnapshot
  /** 卡上那条红条；没有失败时是空的。 */
  error: ReactNode
  navigate?: (page: V2Page, section?: string) => void
  /** 渠道没连上时「找客服」打开的帮助框；没给就不摆这颗按钮。 */
  onOpenHelp?: () => void
  /** 余额不到 remoteLowBalanceDollars、又没有能用的订阅时是余额（美元），否则 null（YF-12）。 */
  lowBalance?: number | null
  /** 测试用的钟；缺省跟着真实时间走。 */
  now?: number
  /** Mac 上说「菜单栏」不说「托盘」（「菜单栏改」）；缺省按 Windows、Linux。 */
  isMac?: boolean
} & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const persistenceNotice = snapshot.credentialPersistence === 'durable' ? null : codexRemotePersistenceNotices[snapshot.credentialPersistence]
  const anyEnabled = remoteAnyEnabled(snapshot)
  return (
    <Card title="手机遥控 Codex" meta={remoteCardMeta(snapshot)} padding="none" testId="settings-remote-card">
      <p className="v2-remote-intro">{codexRemoteIntro}</p>
      <div className="v2-remote-notices">
        {!snapshot.available && snapshot.unavailableReason && (
          <Notice tone="warn" title="这台电脑现在不能打开手机遥控" body={snapshot.unavailableReason} testId="settings-remote-unavailable" />
        )}
        {snapshot.codexStartFailed && (
          <Notice
            tone="warn"
            title={codexStartFailedNotice.title}
            body={codexStartFailedNotice.body}
            actions={navigate && <Button size="sm" icon={Home} onClick={() => navigate('home')} testId="settings-remote-codex-failed-home">{codexStartFailedNotice.action}</Button>}
            testId="settings-remote-codex-failed"
          />
        )}
        {anyEnabled && lowBalance !== null && (
          <Notice
            tone="warn"
            title={codexRemoteLowBalanceNotice.title(dollars(lowBalance))}
            body={codexRemoteLowBalanceNotice.body}
            actions={navigate && <Button size="sm" icon={Zap} onClick={() => navigate('account', 'recharge')} testId="settings-remote-low-balance-recharge">{codexRemoteLowBalanceNotice.action}</Button>}
            testId="settings-remote-low-balance"
          />
        )}
        {persistenceNotice && <Notice tone={persistenceNotice.tone} title={persistenceNotice.title} body={persistenceNotice.body} testId="settings-remote-persistence" />}
        {error}
      </div>
      {anyEnabled && <LastRequestRow snapshot={snapshot} api={api} busy={busy} run={run} navigate={navigate} now={now} />}
      <WorkspaceRow snapshot={snapshot} api={api} busy={busy} run={run} />
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
          navigate={navigate}
          onOpenHelp={onOpenHelp}
          isMac={isMac}
        />
      ))}
      <SettingRow
        title={codexRemoteAutoStartText.title}
        description={codexRemoteAutoStartText.description}
        control={
          <Switch
            checked={snapshot.autoStart === true}
            disabled={!snapshot.available || Boolean(busy)}
            onChange={(enabled) => void run('auto-start', () => api.setCodexRemoteAutoStart(enabled))}
            aria-label={codexRemoteAutoStartText.title}
            testId="settings-remote-auto-start-switch"
          />
        }
        testId="settings-remote-auto-start"
      />
      <SettingRow
        title={codexRemoteIdleCloseText.title}
        description={snapshot.idleCloseHours ? null : isMac ? codexRemoteIdleCloseText.neverHintMac : codexRemoteIdleCloseText.neverHint}
        control={
          <Segment
            label={codexRemoteIdleCloseText.title}
            options={idleCloseOptions.map((option) => ({ ...option, disabled: !snapshot.available || Boolean(busy) }))}
            value={snapshot.idleCloseHours ? String(snapshot.idleCloseHours) : 'never'}
            activation="manual"
            onChange={(value) => {
              const hours = Number(value)
              void run('idle-close', () => api.setCodexRemoteIdleClose(isRemoteIdleCloseHours(hours) ? hours : null))
            }}
            testId="settings-remote-idle-close-choice"
          />
        }
        testId="settings-remote-idle-close"
      />
    </Card>
  )
}

function WorkspaceRow({ snapshot, api, busy, run }: { snapshot: CodexRemoteSnapshot } & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const folders = remoteWorkspaceFolders(snapshot)
  const full = folders.length >= remoteWorkspaceMax
  const text = codexRemoteWorkspaceText
  const description = folders.length === 0
    ? text.empty
    : folders.length === 1
      ? <span className="xm-mono">{folders[0]}</span>
      : (
          <span className="v2-remote-folders" data-testid="settings-remote-workspace-list">
            {folders.map((folder) => (
              <span className="v2-remote-folder" key={folder}>
                <span className="xm-mono">{folder}</span>
                {folder === snapshot.workspaceDirectory
                  ? <Pill tone="accent" testId="settings-remote-workspace-in-use">{text.inUse}</Pill>
                  : (
                      <span className="v2-remote-folder-actions">
                        <Button size="sm" variant="ghost" disabled={!snapshot.available || Boolean(busy)} loading={busy === `workspace-use:${folder}`} onClick={() => void run(`workspace-use:${folder}`, () => api.useCodexRemoteWorkspace(folder))} testId="settings-remote-workspace-use">{text.use}</Button>
                        <Button size="sm" variant="ghost" disabled={Boolean(busy)} loading={busy === `workspace-remove:${folder}`} onClick={() => void run(`workspace-remove:${folder}`, () => api.removeCodexRemoteWorkspace(folder))} testId="settings-remote-workspace-remove">{text.remove}</Button>
                      </span>
                    )}
              </span>
            ))}
            <span className="v2-remote-folders-note">{full ? text.full(remoteWorkspaceMax) : text.phoneHint}</span>
          </span>
        )
  return (
    <SettingRow
      title={text.title}
      description={description}
      control={
        <Button
          size="sm"
          icon={folders.length ? FolderPlus : FolderOpen}
          disabled={!snapshot.available || Boolean(busy) || full}
          loading={busy === 'workspace'}
          onClick={() => void run('workspace', () => api.chooseCodexRemoteWorkspace())}
          testId="settings-remote-workspace"
        >
          {folders.length ? text.add : text.choose}
        </Button>
      }
      testId="settings-remote-workspace-row"
    />
  )
}

/**
 * 设置 › 工具管理最下面的「手机遥控 Codex」。v4 原型没有这张卡，照同一组里的整卡（工具配置备份）摆：
 * 卡头、说明、干活的文件夹，再一个渠道一块（填凭据、打开遥控、配对）。
 * 操作的返回值和 state-changed 事件都是整份快照，按 revision 只收新的那份（newerRemoteSnapshot）。
 */
export function CodexRemoteCard({ api, navigate, onOpenHelp, isMac = false }: {
  api: V2Bridge
  navigate?: (page: V2Page, section?: string) => void
  onOpenHelp?: () => void
  /** 设置页从主进程报的平台能力里取的（跟「点关闭按钮时」那一项同一份）。 */
  isMac?: boolean
}) {
  const lowBalance = useRemoteLowBalance()
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
      navigate={navigate}
      onOpenHelp={onOpenHelp}
      lowBalance={lowBalance}
      isMac={isMac}
    />
  )
}

/**
 * 余额不到 $1、又没有能用的订阅时的余额（YF-12），否则 null。订阅、余额读没读到沿用状态栏那份判断（balance tier）：
 * 有能用的订阅是 ok，余额没读到是 neutral，这两种都不提醒。
 */
export function remoteLowBalanceAmount(tier: ReturnType<typeof useBalanceTier>, balance: { quota: number; quotaPerUnit: number } | null): number | null {
  if (tier === 'ok' || tier === 'neutral' || !balance || balance.quotaPerUnit <= 0) return null
  const amount = balance.quota / balance.quotaPerUnit
  return amount < remoteLowBalanceDollars ? amount : null
}

function useRemoteLowBalance(): number | null {
  const tier = useBalanceTier()
  const { snapshot } = useSharedAccountBalance()
  return remoteLowBalanceAmount(tier, snapshot.balance)
}
