import { useState } from 'react'
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
 * 飞书那一块里「填凭据」的部分：还没填时摆两个框和怎么建机器人，填过了只说是哪个应用。
 * 保存时主进程先拿去飞书换一次访问凭证，填错了当场说；App Secret 不回到界面上。
 * 清掉凭据是卡片上各渠道共用的「退出登录」，不在这里。
 */
export function FeishuRemoteSection({ snapshot, api, disabled, busy, run }: RemoteChannelSectionProps) {
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
      <SettingRow
        title="飞书应用"
        description={`App ID：${snapshot.accountLabel ?? '已保存'}`}
        control={<Button size="sm" disabled={disabled} onClick={() => setEditing(true)} testId="settings-remote-feishu-edit">重新填写</Button>}
        testId="settings-remote-feishu-app"
      />
    )
  }
  const saving = busy === 'feishu-save'
  return (
    <div className="v2-remote-form" data-testid="settings-remote-feishu-form">
      <p className="v2-remote-note">先在飞书开放平台建一个企业自建应用（机器人），把它的 App ID 和 App Secret 填在这里。</p>
      <details className="v2-remote-guide">
        <summary>怎么建飞书机器人</summary>
        <ol>
          {feishuSetupSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </details>
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
