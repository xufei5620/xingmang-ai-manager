import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { FolderOpen, FolderPlus, Headset, Home, RefreshCw, TriangleAlert, Zap } from 'lucide-react'
import { Button, Card, Confirm, Notice, PageHead, Pill, Segment, Select, SettingRow, Switch, useBalanceTier } from '../../../ui'
import { dollars, ResultNotice, useOperation, useResource } from '../../../business-common'
import { useSharedBalanceSelector } from '../../app/balance-context'
import { isRemoteIdleCloseHours, isRemotePermission, remoteChannelIds, remoteIdleCloseHours } from '../../../../../electron/codex-remote-channel'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot, RemoteChannelId, RemotePermission } from '../../../../../electron/ipc-contract'
import type { V2Bridge, V2Page } from '../../../types'
import { codexModelChoices, isHiddenCodexModel } from '../../tools/model-filter'
import { remoteChannelSections, type RemoteChannelSectionDefinition, type RemoteChannelSectionProps } from './channel-sections'
import {
  boundPeerText,
  lastRequestText,
  newerRemoteSnapshot,
  pairingAttemptText,
  pendingApprovalsText,
  remoteAnyEnabled,
  remoteCardMeta,
  remoteLowBalanceDollars,
  remoteChannelStateLabel,
  remoteChannelStateTone,
  remoteSwitchHint,
  remoteWorkspaceFolders,
  remoteWorkspaceMax,
} from './remote-view'

/**
 * 左侧栏「手机遥控」那一页的字（0.2.25，yoyo 2026-11-19「改」批了版面；11-21 起新字按正式书面口吻写）。原来是设置 › 工具管理
 * 最下面一张卡，挪出来单独一页，两种连接方式并排摆、点哪个下面摆哪个的设置，两种都要的设置另起一块。
 * 最底下那句提醒：同意也是在同一个聊天里点的，绑定的飞书或微信账号落到谁手里，谁就能指挥这台电脑（#1407）；
 * 用的是原来卡片说明末尾那两句（第五批已定的正式说法）。
 */
export const codexRemotePageText = {
  title: '手机遥控',
  lead: '不在电脑前时，在手机上私聊您的机器人，即可远程操作本机的 Codex，使用当前账号的额度。',
  methodsTitle: '连接方式',
  methodsMeta: '开启一种即可，也可同时开启两种',
  methods: {
    feishu: { tag: '推荐长期使用', body: '需先在飞书开放平台创建您的机器人，步骤稍多；使用飞书官方接口，连接稳定。' },
    weixin: { tag: '实验功能', body: '使用手机微信扫码登录即可，设置最简便；该通道为借用通道，可能随时中断。' },
  } satisfies Record<RemoteChannelId, { tag: string; body: string }>,
  channelSettings: (title: string) => `${title}设置`,
  sharedTitle: '通用设置',
  safety: '仅响应已配对的用户。任何能使用您绑定的飞书或微信发送消息的人，均可操作本机，请勿将账号借予他人。',
} as const

/**
 * 登录的 Windows 账号本身就带管理员权限（自带 Administrator、关了授权弹窗）时说明下面那句（yoyo 2026-11-20 亲手打字同意放宽，
 * 这句是同意的一部分）。这种电脑上怎么打开星芒都是管理员身份，遥控照常能开，但 Codex 改文件、跑命令也都带着管理员权限，
 * 手机上点头前要多看一眼。只在主进程判定是这种账号（快照 alwaysElevated）时摆出来。
 */
export const codexRemoteAdminAccountNotice = '本机登录的 Windows 账号自带管理员权限，Codex 在此修改文件、执行命令时同样具有管理员权限。在手机上回复「同意」前，请确认其将执行的操作。'

/** 凭据存不到下次打开时卡上那条（Linux 没有系统钥匙串时只记在内存里，见 codex-remote-store.ts）。 */
export const codexRemotePersistenceNotices = {
  'session-only': { tone: 'neutral', title: '凭据仅在本次运行期间保存', body: '本机没有系统钥匙串，下次打开星芒时需重新填写。' },
  unavailable: { tone: 'warn', title: '凭据无法保存', body: '本机无法安全保存凭据，手机遥控暂不可用。' },
} as const

/**
 * 手机上那条因为电脑上的 Codex 起不来没做时卡上那条黄条（YK-5）。手机上只收到一句「请在电脑上的星芒里看一下」，
 * 坐回电脑前得一眼看出是哪儿坏了、去哪儿修。Codex 下次起来了、或者遥控全关了就收起（主进程清掉 codexStartFailed）。
 */
export const codexStartFailedNotice = {
  title: 'Codex 启动失败',
  body: '手机刚发送的指令未执行。请前往首页检查 Codex，恢复后在手机上重新发送。',
  action: '去首页看 Codex',
} as const

/**
 * 「干活的文件夹」那一行（YF-19）：电脑上能加几个，手机上发「文件夹」看、发「文件夹 2」换。只加了一个时跟以前一样
 * 只写路径；不止一个时一个一行，正在用的标出来，别的能「使用此文件夹」「移除」。
 */
export const codexRemoteWorkspaceText = {
  title: '干活的文件夹',
  empty: '尚未选择。Codex 仅在此文件夹中运行，请选择具体的项目文件夹。',
  choose: '选择文件夹',
  add: '添加一个',
  inUse: '正在用',
  use: '使用此文件夹',
  remove: '移除',
  phoneHint: '手机上发「文件夹」也能换。',
  full: (max: number) => `最多 ${max} 个，先移除一个再添加。`,
} as const

/**
 * 「打开星芒时自动打开遥控」那一行（YF-9，yoyo 2026-11-11 亲手打字「遥控自动开，做」）。默认关；说明把风险说在前头：
 * 开机自启的星芒没人在电脑前也会连上。
 * 这次打开星芒没能自动打开时，说明下面多一句黄字说原因（YR-7，yoyo 2026-11-18 批），原因是在这里点开打不开时那句原话。
 */
export const codexRemoteAutoStartText = {
  title: '打开星芒时自动打开遥控',
  description: '开启后，每次打开星芒将自动连接，无需在此手动开启。如星芒设为开机自启，即使无人在电脑前，也可通过手机操作。如有顾虑，请勿开启。',
  failed: (reason: string) => `上次打开星芒时未能自动开启：${reason}`,
} as const

/**
 * 「无消息自动关闭时间」那一行（YF-10，yoyo 2026-11-11 亲手打字「不自动关」「默认不关」）。缺省是「不自动关」，
 * 选它时下面那句小字说清楚还有哪几种办法关；选了时长不写小字，「打开遥控」那行的说明会带上时长。
 */
export const codexRemoteIdleCloseText = {
  title: '无消息自动关闭时间',
  never: '不自动关',
  neverHint: '仅在电脑端、托盘中关闭，或在手机上发送「关闭遥控」时才会关闭。',
  // Mac 上没有托盘，星芒的图标在屏幕顶部的菜单栏里（#1745，yoyo 2026-11-11「菜单栏改」）。
  neverHintMac: '仅在电脑端、菜单栏中关闭，或在手机上发送「关闭遥控」时才会关闭。',
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
  action: '前往充值',
} as const

/**
 * 「手机端使用的模型」那一行（yoyo 2026-11-19「改」）。选项跟首页 Codex「配置」里「默认模型」是同一张单，
 * 第一项「与电脑端相同」是缺省，括号里写电脑上现在用的那个；读不到电脑上的就不写括号。
 */
export const codexRemoteModelText = {
  title: '手机端使用的模型',
  follow: (model?: string) => model ? `与电脑端相同（${model}）` : '与电脑端相同',
  followHint: '如需更换，请前往首页 Codex 的「配置」修改，电脑端与手机端同时生效。',
  ownHint: '仅手机端使用此模型，电脑端的 Codex 不受影响。',
} as const

/**
 * 「权限」那一行（yoyo 2026-11-22 亲手打字同意放宽：「默认在干活的文件夹里看、改、跑命令都不问我，连网和改文件夹外面的才问」）。
 * 两档照 Codex 自己的「默认」「只读」，缺省「默认」；没有「完全访问」。说明跟着选中的那一档换。
 */
export const codexRemotePermissionText = {
  title: '权限',
  options: { default: '默认', readOnly: '只读' },
  hints: {
    default: '与电脑端 Codex 一致：在所选文件夹内查看、修改文件和执行命令无需确认；联网或修改该文件夹以外的内容前，将先在手机上征求您的同意。',
    readOnly: '仅查看：查看文件、获取本机信息无需确认；修改文件、执行会产生改动的命令或联网前，均将先在手机上征求您的同意。',
  },
} as const satisfies { title: string; options: Record<RemotePermission, string>; hints: Record<RemotePermission, string> }

const permissionOptions = (['default', 'readOnly'] as const).map((value) => ({ value, label: codexRemotePermissionText.options[value] }))

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
  unbind: { title: '解绑？', body: '解绑后，该用户将无法通过手机遥控本机，如需使用需重新配对。', ok: '解绑' },
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
  const disabled = !snapshot.available || Boolean(busy)
  // 那句话旁边配的按钮（D23）：同一个应用在别处连着、别的原因没连上，给「重新连接」；后一种再给「联系客服」。
  // 凭据不对时就是下面「飞书应用」那一行的「重新填写」，不再摆第二颗。只在开着时给：关着的渠道没什么可重连的。
  const problem = channel.status.state === 'connected' ? undefined : channel.status.problem
  const canReconnect = channel.enabled && (problem === 'connection-limit' || problem === 'other')
  const { Section } = definition
  const canEnable = channel.hasCredential && Boolean(snapshot.workspaceDirectory)
  const pairing = channel.pairing
  const pairingNote = channel.hasCredential ? pairingAttemptText(channel, definition.pairingQuietHint) : null
  const [asking, setAsking] = useState<'unbind' | 'logout' | null>(null)
  // 先关框再做：做不成的原因摆在页上的红条里，框开着会挡住它。
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
        description={peer ? boundPeerText(peer) : channel.enabled ? '尚未配对。请点击「开始配对」，将配对码私聊发送给机器人。' : '尚未配对。开启遥控后方可配对。'}
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
  return (
    <section className="v2-remote-channel" data-testid={`settings-remote-${id}`}>
      <div className="v2-remote-channel-head">
        <h3>{codexRemotePageText.channelSettings(definition.title)}</h3>
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
              联系客服
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
 * 打开页面先摆哪一种：开着的那个；都没开摆填过凭据的；都没有摆飞书（排在第一个，长期用推荐它）。
 */
export function initialRemoteMethod(snapshot: Pick<CodexRemoteSnapshot, 'channels'>): RemoteChannelId {
  return remoteChannelIds.find((id) => snapshot.channels[id].enabled)
    ?? remoteChannelIds.find((id) => snapshot.channels[id].hasCredential)
    ?? remoteChannelIds[0]
}

/** 连接方式两张卡是一组页签：左右方向键、Home、End 换着选，跟系统页签一样。 */
function nextRemoteMethod(current: RemoteChannelId, key: string): RemoteChannelId | null {
  const index = remoteChannelIds.indexOf(current)
  if (key === 'ArrowRight' || key === 'ArrowDown') return remoteChannelIds[(index + 1) % remoteChannelIds.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return remoteChannelIds[(index - 1 + remoteChannelIds.length) % remoteChannelIds.length]
  if (key === 'Home') return remoteChannelIds[0]
  if (key === 'End') return remoteChannelIds[remoteChannelIds.length - 1]
  return null
}

function MethodPicker({ snapshot, method, onSelect }: { snapshot: CodexRemoteSnapshot; method: RemoteChannelId; onSelect(id: RemoteChannelId): void }) {
  const text = codexRemotePageText
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next = nextRemoteMethod(method, event.key)
    if (!next) return
    event.preventDefault()
    onSelect(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-method="${next}"]`)?.focus()
  }
  return (
    <div className="v2-remote-methods" role="tablist" aria-label={text.methodsTitle}>
      {remoteChannelIds.map((id) => {
        const channel = snapshot.channels[id]
        const definition = remoteChannelSections[id]
        const selected = id === method
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`remote-method-${id}`}
            aria-selected={selected}
            aria-controls="remote-method-panel"
            tabIndex={selected ? 0 : -1}
            className={selected ? 'v2-remote-method is-selected' : 'v2-remote-method'}
            onClick={() => onSelect(id)}
            onKeyDown={onKeyDown}
            data-method={id}
            data-testid={`remote-method-${id}`}
          >
            <span className="v2-remote-method-head">
              <strong>{definition.title}</strong>
              <Pill tone={definition.experimental ? 'warn' : 'accent'}>{text.methods[id].tag}</Pill>
              <span className="v2-remote-method-state">
                <Pill tone={remoteChannelStateTone(channel.status)} dot testId={`settings-remote-${id}-state`}>{remoteChannelStateLabel(channel.status)}</Pill>
              </span>
            </span>
            <span className="v2-remote-method-body">{text.methods[id].body}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 「手机端使用的模型」要列的东西：电脑上的 Codex 现在用哪个、这个账号能选哪些（首页 Codex「配置」里那张单）。 */
export interface RemoteModelChoices {
  /** 电脑上 Codex 配置里的模型；读不到是空串。 */
  computerModel: string
  models: readonly string[]
}

function PermissionRow({ snapshot, api, busy, run }: { snapshot: CodexRemoteSnapshot } & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const text = codexRemotePermissionText
  const permission: RemotePermission = snapshot.permission ?? 'default'
  return (
    <SettingRow
      title={text.title}
      description={text.hints[permission]}
      control={
        <Segment
          label={text.title}
          options={permissionOptions.map((option) => ({ ...option, disabled: !snapshot.available || Boolean(busy) }))}
          value={permission}
          activation="manual"
          onChange={(value) => {
            if (isRemotePermission(value)) void run('permission', () => api.setCodexRemotePermission(value))
          }}
          testId="settings-remote-permission-choice"
        />
      }
      testId="settings-remote-permission"
    />
  )
}

function ModelRow({ snapshot, choices, api, busy, run }: { snapshot: CodexRemoteSnapshot; choices: RemoteModelChoices } & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const text = codexRemoteModelText
  const selected = snapshot.model ?? ''
  // 单独选过、这次没读到的型号也照样列着（codexModelChoices 补在最前），不然下拉框显示的跟实际用的对不上。
  const listed = codexModelChoices(choices.models, 'all', selected).options.map(({ value, label }) => ({ value, label }))
  return (
    <SettingRow
      title={text.title}
      description={snapshot.model ? text.ownHint : text.followHint}
      control={
        <Select
          aria-label={text.title}
          value={selected}
          options={[{ value: '', label: text.follow(choices.computerModel || undefined) }, ...listed]}
          disabled={!snapshot.available || Boolean(busy)}
          onChange={(event) => {
            const model = event.target.value
            void run('model', () => api.setCodexRemoteModel(model || null))
          }}
          testId="settings-remote-model-choice"
        />
      }
      testId="settings-remote-model"
    />
  )
}

/**
 * 页面本身：拿到快照以后怎么摆。和取数分开，好用 renderToStaticMarkup 按各种快照直接测。
 * 旧的 data-testid（settings-remote-*）照留，自动化脚本和客服说的位置都还认得。
 */
export function CodexRemotePageView({ snapshot, api, busy, run, error, navigate, onOpenHelp, lowBalance = null, now, isMac = false, modelChoices = { computerModel: '', models: [] }, initialMethod }: {
  snapshot: CodexRemoteSnapshot
  /** 页上那条红条；没有失败时是空的。 */
  error: ReactNode
  navigate?: (page: V2Page, section?: string) => void
  /** 渠道没连上时「联系客服」打开的帮助框；没给就不摆这颗按钮。 */
  onOpenHelp?: () => void
  /** 余额不到 remoteLowBalanceDollars、又没有能用的订阅时是余额（美元），否则 null（YF-12）。 */
  lowBalance?: number | null
  /** 测试用的钟；缺省跟着真实时间走。 */
  now?: number
  /** Mac 上说「菜单栏」不说「托盘」（「菜单栏改」）；缺省按 Windows、Linux。 */
  isMac?: boolean
  modelChoices?: RemoteModelChoices
  /** 先摆哪一种连接方式；缺省按 initialRemoteMethod。 */
  initialMethod?: RemoteChannelId
} & Pick<RemoteChannelSectionProps, 'api' | 'busy' | 'run'>) {
  const [method, setMethod] = useState<RemoteChannelId>(() => initialMethod ?? initialRemoteMethod(snapshot))
  const persistenceNotice = snapshot.credentialPersistence === 'durable' ? null : codexRemotePersistenceNotices[snapshot.credentialPersistence]
  const anyEnabled = remoteAnyEnabled(snapshot)
  const meta = remoteCardMeta(snapshot)
  const text = codexRemotePageText
  return (
    <section className="v2-page v2-remote-page" data-page-id="remote" data-testid="page-remote">
      <PageHead title={text.title} lead={text.lead} actions={meta && <Pill dot tone="ok" testId="settings-remote-meta">{meta}</Pill>} />
      <div className="v2-remote-body" data-testid="settings-remote-card">
        {snapshot.alwaysElevated && (
          <p className="v2-remote-admin-account" data-testid="settings-remote-admin-account">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>{codexRemoteAdminAccountNotice}</span>
          </p>
        )}
        <div className="v2-remote-notices">
          {!snapshot.available && snapshot.unavailableReason && (
            <Notice tone="warn" title="本机当前无法开启手机遥控" body={snapshot.unavailableReason} testId="settings-remote-unavailable" />
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
        {anyEnabled && snapshot.lastRequest && (
          <Card padding="none">
            <LastRequestRow snapshot={snapshot} api={api} busy={busy} run={run} navigate={navigate} now={now} />
          </Card>
        )}
        <Card title={text.methodsTitle} meta={text.methodsMeta} padding="none" testId="remote-methods">
          <MethodPicker snapshot={snapshot} method={method} onSelect={setMethod} />
          <div role="tabpanel" id="remote-method-panel" aria-labelledby={`remote-method-${method}`}>
            <ChannelBlock
              key={method}
              id={method}
              definition={remoteChannelSections[method]}
              snapshot={snapshot}
              channel={snapshot.channels[method]}
              api={api}
              busy={busy}
              run={run}
              navigate={navigate}
              onOpenHelp={onOpenHelp}
              isMac={isMac}
            />
          </div>
        </Card>
        <Card title={text.sharedTitle} padding="none" testId="remote-shared">
          <WorkspaceRow snapshot={snapshot} api={api} busy={busy} run={run} />
          <PermissionRow snapshot={snapshot} api={api} busy={busy} run={run} />
          <ModelRow snapshot={snapshot} choices={modelChoices} api={api} busy={busy} run={run} />
          <SettingRow
            title={codexRemoteAutoStartText.title}
            description={
              snapshot.autoStart && snapshot.autoStartFailure
                ? (
                    <>
                      {codexRemoteAutoStartText.description}
                      <br />
                      <span className="v2-remote-auto-start-failed" data-testid="settings-remote-auto-start-failed">{codexRemoteAutoStartText.failed(snapshot.autoStartFailure)}</span>
                    </>
                  )
                : codexRemoteAutoStartText.description
            }
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
        <p className="v2-remote-safety" data-testid="settings-remote-safety">{text.safety}</p>
      </div>
    </section>
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
 * 「手机端使用的模型」那张单：电脑上 Codex 配置里的模型，和首页 Codex「配置」里「默认模型」一样读当前账号能用的
 * （不列 isHiddenCodexModel 挡掉的）。读不到就只剩「与电脑端相同」，不报错：这一行不是非选不可。
 */
function useRemoteModelChoices(api: V2Bridge): RemoteModelChoices {
  const [choices, setChoices] = useState<RemoteModelChoices>({ computerModel: '', models: [] })
  useEffect(() => {
    let current = true
    void api.getConfig()
      .then((config) => { if (current) setChoices((state) => ({ ...state, computerModel: config.providers.codex.model })) })
      .catch(() => undefined)
    void api.listConfiguredModels('codex')
      .then((models) => { if (current) setChoices((state) => ({ ...state, models: models.filter((model) => !isHiddenCodexModel(model)) })) })
      .catch(() => undefined)
    return () => { current = false }
  }, [api])
  return choices
}

/** Mac 上说「菜单栏」：跟设置页一样从主进程报的平台能力里取；读不到按 Windows、Linux 说「托盘」。 */
function useIsMac(api: V2Bridge): boolean {
  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    let current = true
    void api.getPlatformCapabilities()
      .then((capability) => { if (current) setIsMac(capability.platform === 'macos') })
      .catch(() => undefined)
    return () => { current = false }
  }, [api])
  return isMac
}

/**
 * 左侧栏「手机遥控」（0.2.25）。操作的返回值和 state-changed 事件都是整份快照，按 revision 只收新的那份
 * （newerRemoteSnapshot）。
 */
export function CodexRemotePage({ api, navigate, onOpenHelp }: {
  api: V2Bridge
  navigate?: (page: V2Page, section?: string) => void
  onOpenHelp?: () => void
}) {
  const lowBalance = useRemoteLowBalance()
  const isMac = useIsMac(api)
  const modelChoices = useRemoteModelChoices(api)
  const load = useCallback(() => api.getCodexRemoteState(), [api])
  const resource = useResource(load)
  const { setData } = resource
  const accept = useCallback((next: CodexRemoteSnapshot) => setData((current) => newerRemoteSnapshot(current, next)), [setData])
  useEffect(() => api.onCodexRemoteStateChanged(accept), [api, accept])
  const operation = useOperation()
  // 成功不弹提示：页上的状态自己会变。
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
      <section className="v2-page v2-remote-page" data-page-id="remote" data-testid="page-remote">
        <PageHead title={codexRemotePageText.title} lead={codexRemotePageText.lead} />
        <Card testId="settings-remote-card">
          {resource.error
            ? <ResultNotice error={resource.error} detail={resource.detail} retry={{ label: '重新读取', onClick: () => void resource.reload() }} />
            : <p role="status">正在读取…</p>}
        </Card>
      </section>
    )
  }
  return (
    <CodexRemotePageView
      snapshot={resource.data}
      api={api}
      busy={operation.busy}
      run={run}
      error={<ResultNotice error={operation.error} detail={operation.detail} />}
      navigate={navigate}
      onOpenHelp={onOpenHelp}
      lowBalance={lowBalance}
      isMac={isMac}
      modelChoices={modelChoices}
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
  // 只挑余额本身，页面藏着时不跟着每次刷新重画（R8）。
  const balance = useSharedBalanceSelector((state) => state.balance)
  return remoteLowBalanceAmount(tier, balance)
}
