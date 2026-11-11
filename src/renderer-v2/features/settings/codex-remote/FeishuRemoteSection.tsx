import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { BookOpen, ExternalLink } from 'lucide-react'
import { feishuDeveloperConsoleUrl } from '../../../../../electron/codex-remote-channel'
import { phoneRemoteTutorialTopic } from '../../../registry/business'
import { Button, Input, SettingRow } from '../../../ui'
import type { RemoteChannelSectionProps } from './channel-sections'

/** 怎么在飞书开放平台建一个能私聊的机器人。只写字，不放链接：外链要过白名单（I12）。 */
export const feishuSetupSteps = [
  '打开飞书开放平台（open.feishu.cn），进「开发者后台」，创建一个「企业自建应用」。',
  '在「添加应用能力」里加上「机器人」。',
  '在「权限管理」里开通「读取用户发给机器人的单聊消息」和「以应用的身份发消息」。',
  '在「凭证与基础信息」里复制 App ID 和 App Secret，填到下面保存。',
  '在这里打开遥控后，回到开放平台的「事件与回调」：事件订阅方式选「使用长连接接收事件」，添加事件「接收消息」；回调订阅方式也选长连接，添加「卡片回传交互」。',
  '在「版本管理与发布」里发布一个版本。发布后在飞书里搜这个机器人的名字，私聊它。',
] as const

/**
 * 保存凭据以后、配对成功以前留着的「还差这几步」（YF-1）。上面那 6 步的后两步要在保存、打开遥控以后才做，
 * 原来保存一下说明就收走了。4 步固定摆着，不按做没做完增减：小字里按编号说「第 2 步」。
 */
export const feishuNextSteps = {
  title: '保存好了。再做下面几步，手机上才收得到',
  steps: [
    '先打开下面的「打开遥控」，等它显示「已连上」。',
    '回飞书开放平台的「事件与回调」：事件订阅方式选「使用长连接接收事件」，添加事件「接收消息」；回调订阅方式也选长连接，添加「卡片回传交互」。',
    '在「版本管理与发布」里发布一个版本。',
    '在飞书里搜这个机器人的名字，私聊它。回这里点「开始配对」，把 6 位数字发给它。',
  ],
  note: '第 2 步要先把遥控打开，飞书后台才存得上。',
} as const

/**
 * 「还差这几步」下面那个二维码底下的字（YF-3）：手机飞书一扫直接打开和这个机器人的对话，不用搜名字。
 * 用的是飞书官方 AppLink「打开机器人会话」（飞书 3.40.0 起支持；用不了这个机器人的人，飞书自己会给引导）。
 */
export const feishuBotQrText = '用手机飞书扫一扫，直接打开和机器人的对话'

/** 「打开机器人会话」的链接；App ID 跟保存时的检查不一样（不是 cli_ 开头的字母数字）就不给，不往二维码里塞看不懂的东西。 */
export function feishuBotChatLink(appId: string | null): string | null {
  return appId && /^cli_[A-Za-z0-9]{4,64}$/.test(appId) ? `https://applink.feishu.cn/client/bot/open?appId=${appId}` : null
}

/** 只画成二维码给手机扫，不是能点的外链（I12 的白名单不用动）。画不出来就整块不显示，照旧靠搜名字。 */
function FeishuBotQr({ appId }: { appId: string | null }) {
  const link = feishuBotChatLink(appId)
  const [image, setImage] = useState<{ link: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!link) return
    let current = true
    QRCode.toDataURL(link, { width: 192, margin: 1, errorCorrectionLevel: 'M' }).then(
      (url) => { if (current) setImage({ link, url }) },
      () => { if (current) setImage({ link, url: null }) },
    )
    return () => { current = false }
  }, [link])
  if (!link) return null
  const drawn = image?.link === link ? image.url : undefined
  if (drawn === null) return null
  return (
    <div className="v2-remote-bot-qr" data-testid="settings-remote-feishu-bot-qr">
      {drawn ? <img src={drawn} alt="" /> : <span className="v2-remote-bot-qr-pending" aria-hidden="true" />}
      <p>{feishuBotQrText}</p>
    </div>
  )
}

/** 六步下面那两颗（YF-4）：飞书开发者后台交给浏览器，教程是星芒自己的那一章、不出星芒。 */
export const feishuGuideActions = {
  console: '打开飞书开放平台',
  tutorial: '看教程',
} as const

function FeishuSetupGuide({ api, run, navigate }: Pick<RemoteChannelSectionProps, 'api' | 'run' | 'navigate'>) {
  return (
    <details className="v2-remote-guide">
      <summary>怎么建飞书机器人</summary>
      <ol>
        {feishuSetupSteps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <div className="v2-remote-guide-actions">
        <Button size="sm" icon={ExternalLink} onClick={() => void run('feishu-console', async () => { await api.openExternal(feishuDeveloperConsoleUrl) })} testId="settings-remote-feishu-console">
          {feishuGuideActions.console}
        </Button>
        {navigate && (
          <Button size="sm" variant="ghost" icon={BookOpen} onClick={() => navigate('tutorial', phoneRemoteTutorialTopic)} testId="settings-remote-feishu-tutorial">
            {feishuGuideActions.tutorial}
          </Button>
        )}
      </div>
    </details>
  )
}

/**
 * 飞书那一块里「填凭据」的部分：还没填时摆两个框和怎么建机器人；填过了说是哪个应用，配对成功前下面跟着
 * 还差的几步，配对成功后收成一行「怎么建飞书机器人」。
 * 保存时主进程先拿去飞书换一次访问凭证，填错了当场说；App Secret 不回到界面上。
 * 清掉凭据是卡片上各渠道共用的「退出登录」，不在这里。
 */
export function FeishuRemoteSection({ snapshot, api, disabled, busy, run, navigate }: RemoteChannelSectionProps) {
  const [editing, setEditing] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const showForm = editing || !snapshot.hasCredential
  async function save() {
    const saved = await run('feishu-save', () => api.saveCodexRemoteFeishuCredentials({ appId, appSecret }))
    if (!saved) return
    setAppSecret('')
    setEditing(false)
  }
  if (!showForm) {
    return (
      <>
        <SettingRow
          title="飞书应用"
          description={`App ID：${snapshot.accountLabel ?? '已保存'}`}
          control={(
            <Button
              size="sm"
              // 凭据不对（D23）时上面那句叫人重新填，这颗就是它配的按钮，换成主色免得找。
              variant={snapshot.status.problem === 'credential' ? 'primary' : undefined}
              disabled={disabled}
              onClick={() => setEditing(true)}
              testId="settings-remote-feishu-edit"
            >
              重新填写
            </Button>
          )}
          testId="settings-remote-feishu-app"
        />
        {snapshot.boundPeer
          ? <div className="v2-remote-guide-row" data-testid="settings-remote-feishu-guide"><FeishuSetupGuide api={api} run={run} navigate={navigate} /></div>
          : (
            <div className="v2-remote-next" data-testid="settings-remote-feishu-next">
              <p className="v2-remote-next-title">{feishuNextSteps.title}</p>
              <ol>
                {feishuNextSteps.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <FeishuBotQr appId={snapshot.accountLabel} />
              <p className="v2-remote-next-note">{feishuNextSteps.note}</p>
            </div>
          )}
      </>
    )
  }
  const saving = busy === 'feishu-save'
  return (
    <div className="v2-remote-form" data-testid="settings-remote-feishu-form">
      <p className="v2-remote-note">先在飞书开放平台建一个企业自建应用（机器人），把它的 App ID 和 App Secret 填在这里。</p>
      <FeishuSetupGuide api={api} run={run} navigate={navigate} />
      <div className="v2-remote-fields">
        <Input label="App ID" mono value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_ 开头" autoComplete="off" spellCheck={false} testId="settings-remote-feishu-app-id" />
        <Input label="App Secret" mono password value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="off" spellCheck={false} testId="settings-remote-feishu-app-secret" />
      </div>
      <div className="v2-remote-actions">
        {snapshot.hasCredential && <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)} testId="settings-remote-feishu-cancel">取消</Button>}
        <Button
          size="sm"
          variant="primary"
          loading={saving}
          disabled={disabled || !appId.trim() || !appSecret.trim()}
          onClick={() => void save()}
          testId="settings-remote-feishu-save"
        >
          {saving ? '正在核对' : '保存'}
        </Button>
      </div>
    </div>
  )
}
