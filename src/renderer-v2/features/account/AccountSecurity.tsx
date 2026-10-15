import { useCallback, useState } from 'react'
import { KeyRound, LogOut, Monitor, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button, Card, Dialog, Input, ListRow, Pill, SettingRow } from '../../ui'
import { ListState, ResultNotice, useOperation, useRefreshRequest, useResource } from '../../business-common'
import { accountSiteId, accountSupports } from '../../account-context'
import type { V2Bridge } from '../../types'
import type { AccountSessionState } from '../../../../electron/ipc-contract'
import { rememberedLoginAction, rememberedLoginForgottenMessage, sessionOnlyLoginNotice } from '../app/remembered-login'
import { describeLoginDevice } from './login-device-label'
import { deviceActivityText, passwordRules, validatePasswordChange } from './account-center'

export interface PasswordFormState {
  busy: string
  originalPassword: string
  password: string
  confirmPassword: string
}

// Esc and the backdrop must raise the discard confirmation while any password
// field still holds a secret, not only while the request is in flight: a
// silent close used to leave the plaintext in React state, where reopening the
// dialog refilled both boxes and the eye toggle revealed them.
export function passwordFormDirty(form: PasswordFormState): boolean {
  return Boolean(
    form.busy || form.originalPassword || form.password || form.confirmPassword,
  )
}

/** 改密码之后这台电脑还登不登着，两种账号不一样（T12）。 */
function passwordCopy(historical: boolean) {
  return historical
    ? { row: '改完后当前登录会失效，要用新密码重新登录', dialog: '修改密码后当前登录会失效，请使用新密码重新登录。', done: '密码已修改，请用新密码重新登录' }
    : { row: '改完后这台电脑会保持登录，其他设备需要重新登录', dialog: '改完后这台电脑会保持登录，其他设备需要重新登录', done: '密码已修改，这台电脑保持登录' }
}

function PasswordDialog({ api, historical, onClose, onChanged }: { api: V2Bridge; historical: boolean; onClose: () => void; onChanged: () => void }) {
  const operation = useOperation()
  const [originalPassword, setOriginal] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirm] = useState('')
  const rules = passwordRules(historical ? 'solov-api' : 'solov')
  const copy = passwordCopy(historical)
  const busy = operation.busy === 'password'
  return (
    <Dialog
      open
      title="修改密码"
      onClose={onClose}
      busy={busy}
      dirty={passwordFormDirty({ busy: operation.busy, originalPassword, password, confirmPassword })}
      testId="account-security-password-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant="primary"
            icon={ShieldCheck}
            loading={busy}
            onClick={() =>
              void operation.execute(
                'password',
                async () => {
                  validatePasswordChange({ originalPassword, password, confirmPassword }, rules)
                  await api.changeAccountPassword({ originalPassword, newPassword: password })
                  onClose()
                  onChanged()
                },
                copy.done,
              )
            }
          >
            保存新密码
          </Button>
        </>
      }
    >
      <ResultNotice error={operation.error} detail={operation.detail} />
      <p>{copy.dialog}</p>
      <Input label="原密码" password value={originalPassword} placeholder="现在用的密码" onChange={(event) => setOriginal(event.target.value)} autoComplete="current-password" />
      <Input label="新密码" password value={password} placeholder={`${rules.minimum} 至 ${rules.maximum} 位`} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
      <Input label="再输一次" password value={confirmPassword} placeholder="和上面一样" onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
    </Dialog>
  )
}

function Devices({ api, onChanged, refreshRequest }: { api: V2Bridge; onChanged: () => void; refreshRequest?: number }) {
  const load = useCallback(() => api.getAccountLoginSessions(), [api])
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const operation = useOperation()
  const [revoke, setRevoke] = useState<{ sid: string; name: string } | 'others' | null>(null)
  const now = Date.now()
  const others = resource.data?.some((session) => !session.current) ?? false
  return (
    <>
      <div className="v2-acct-section-head">
        <h2>登录设备</h2>
        {others && <Button size="sm" variant="ghost" icon={LogOut} onClick={() => setRevoke('others')} testId="account-security-devices-others">下线其他设备</Button>}
      </div>
      <ResultNotice {...operation} />
      <Card padding="none" testId="account-security-devices">
        <ListState
          page="devices"
          noun="登录设备"
          loading={resource.loading}
          error={resource.error}
          count={resource.data?.length ?? 0}
          retry={() => void resource.reload()}
          emptyTitle="没有读到登录设备"
          emptyDescription="点「重新加载」再读一次。"
          action={<Button size="sm" icon={RefreshCw} onClick={() => void resource.reload()} testId="devices-empty-retry">重新加载</Button>}
        >
          {resource.data?.map((session) => {
            const name = describeLoginDevice(session.userAgent)
            return (
              <ListRow
                key={session.sid}
                icon={Monitor}
                title={name}
                desc={deviceActivityText(session, now)}
                actions={session.current
                  ? <Pill tone="accent">当前设备</Pill>
                  : <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRevoke({ sid: session.sid, name })}>让它下线</Button>}
              />
            )
          })}
        </ListState>
      </Card>
      <Dialog
        open={Boolean(revoke)}
        title={revoke === 'others' ? '让其他设备都下线？' : revoke ? `让「${revoke.name}」下线？` : ''}
        onClose={() => setRevoke(null)}
        busy={operation.busy === 'revoke'}
        footer={
          <>
            <Button onClick={() => setRevoke(null)} disabled={operation.busy === 'revoke'}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'revoke'}
              onClick={() => {
                const target = revoke
                if (!target) return
                void operation.execute(
                  'revoke',
                  async () => {
                    if (target === 'others') await api.revokeOtherAccountLoginSessions()
                    else await api.revokeAccountLoginSession(target.sid)
                    setRevoke(null)
                    onChanged()
                    await resource.reload()
                  },
                  target === 'others' ? '其他设备已下线' : `${target.name}已下线`,
                )
              }}
            >
              {revoke === 'others' ? '全部下线' : '下线'}
            </Button>
          </>
        }
      >
        <p>{revoke === 'others' ? '除了这台电脑，其他设备要重新登录才能看账号信息，上面配好的工具照常能用。' : '它要重新登录才能看账号信息，那台电脑上配好的工具照常能用。'}</p>
        <p>担心密钥泄露的话，去「密钥管理」撤销对应的密钥。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </>
  )
}

/** 账号安全：登录与密码、登录设备、密钥。两步验证这次不放（v4 方案问 3）。 */
export function AccountSecurity({
  api,
  session,
  refreshRequest,
  onChanged,
  onDevicesChanged,
  onOpenKeys,
}: {
  api: V2Bridge
  session: AccountSessionState
  refreshRequest?: number
  /** 改了密码：重读登录状态（历史账号改完就退出了）。 */
  onChanged: () => void
  /** 让设备下线了：账号概览那张卡上的台数跟着重读。 */
  onDevicesChanged: () => void
  /** 「去密钥管理」；缺省 = 这个账号没有密钥管理，不出这一节。 */
  onOpenKeys?: () => void
}) {
  const historical = accountSiteId(session) === 'solov-api'
  const devicesSupported = accountSupports(session, 'supportsSessionManagement')
  const operation = useOperation()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const remembered = rememberedLoginAction(session)
  const keysLoad = useCallback(async () => onOpenKeys ? (await api.getAccountKeys({ page: 1, pageSize: 1 })).total : null, [api, Boolean(onOpenKeys)])
  const keys = useResource(keysLoad)
  useRefreshRequest(refreshRequest, () => void keys.reload())
  return (
    <>
      <div className="v2-acct-section-head"><h2>登录与密码</h2></div>
      <ResultNotice {...operation} />
      <Card padding="none">
        <SettingRow
          anchor="change-password"
          title="修改密码"
          description={passwordCopy(historical).row}
          control={<Button size="sm" icon={ShieldCheck} onClick={() => setPasswordOpen(true)} testId="account-security-password">修改</Button>}
        />
        <SettingRow
          anchor="remember-password"
          title="记住密码"
          description={session.sessionOnly ? sessionOnlyLoginNotice : '清掉后下次登录要重新输入'}
          control={!session.sessionOnly && remembered.kind === 'forget' && (
            <Button
              size="sm"
              icon={Trash2}
              loading={operation.busy === 'forget-remembered-login'}
              onClick={() => void operation.execute('forget-remembered-login', () => api.setRememberedAccountLogin(null, remembered.siteId), rememberedLoginForgottenMessage)}
              testId="account-security-remember"
            >
              清掉
            </Button>
          )}
        />
      </Card>
      <div data-anchor="devices" className="v2-acct-section">
        {devicesSupported ? (
          <Devices api={api} onChanged={onDevicesChanged} refreshRequest={refreshRequest} />
        ) : (
          <>
            <div className="v2-acct-section-head"><h2>登录设备</h2></div>
            <Card padding="none" testId="account-security-devices">
              <ListRow icon={Monitor} title={<span className="v2-acct-muted">当前账号暂不提供登录设备管理。</span>} />
            </Card>
          </>
        )}
      </div>
      {onOpenKeys && (
        <>
          <div className="v2-acct-section-head"><h2>密钥</h2></div>
          <Card padding="none">
            <SettingRow
              title={keys.data !== null ? `你有 ${keys.data} 把密钥` : '密钥'}
              description="觉得哪把泄露了，就撤销它"
              control={<Button size="sm" icon={KeyRound} onClick={onOpenKeys} testId="account-security-keys">去密钥管理</Button>}
            />
          </Card>
        </>
      )}
      {passwordOpen && <PasswordDialog api={api} historical={historical} onClose={() => setPasswordOpen(false)} onChanged={onChanged} />}
    </>
  )
}
