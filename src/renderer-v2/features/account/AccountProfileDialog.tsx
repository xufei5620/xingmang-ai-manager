import { useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button, Dialog, Input } from '../../ui'
import { ResultNotice, useOperation } from '../../business-common'
import { LocalAvatar, LocalAvatarDialog } from '../../LocalAvatar'
import type { AvatarIdentity } from '../../local-avatar'
import type { V2Bridge } from '../../types'

type Profile = Awaited<ReturnType<V2Bridge['getAccountProfile']>>

/**
 * 个人中心页头铅笔那颗「编辑资料」：头像、显示名称，用户名和邮箱只读。打开时按读到的资料
 * 填好，改过显示名称没保存就关会先问一句（底部那条）。
 */
export function AccountProfileDialog({
  api,
  profile,
  identity,
  editable,
  onClose,
  onSaved,
}: {
  api: V2Bridge
  profile: Profile
  identity: AvatarIdentity
  /** 当前账号能不能改显示名称（supportsProfileUpdate）；不能时输入框灰着。 */
  editable: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const operation = useOperation()
  const [name, setName] = useState(profile.displayName ?? '')
  const [avatarOpen, setAvatarOpen] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  // 只差前后空格不算改过，存的时候本来就会去掉。
  const changed = name.trim() !== (profile.displayName ?? '').trim()
  const busy = operation.busy === 'profile'
  const shownName = name.trim() || profile.displayName || profile.username
  function save() {
    void operation.execute(
      'profile',
      async () => {
        if (!name.trim()) throw new Error('请填写显示名称')
        await api.updateAccountDisplayName({ displayName: name.trim() })
        onSaved()
        onClose()
      },
      '资料已保存',
    )
  }
  return (
    <>
      <Dialog
        open
        title="编辑资料"
        onClose={onClose}
        dirty={changed}
        busy={busy}
        initialFocus={field}
        testId="account-profile-dialog"
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>取消</Button>
            <Button variant="primary" loading={busy} disabled={!changed || !editable} onClick={save} testId="account-display-save">保存</Button>
          </>
        }
      >
        <ResultNotice error={operation.error} detail={operation.detail} />
        <div className="v2-acct-profile-avatar">
          <LocalAvatar identity={identity} name={shownName} size={48} />
          <div>
            <strong>头像</strong>
            <p>只存在这台电脑上，支持 JPG、PNG、WebP，选好后可以裁剪</p>
          </div>
          <Button size="sm" icon={Pencil} onClick={() => setAvatarOpen(true)} disabled={busy} testId="account-avatar-change">更换头像</Button>
        </div>
        <div className="v2-acct-profile-fields" data-unsaved={changed ? 'true' : undefined}>
          <Input
            ref={field}
            label="显示名称"
            value={name}
            maxLength={20}
            placeholder="别人看到的名字"
            hint="最多 20 个字"
            disabled={!editable || busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && changed && editable && !busy) {
                event.preventDefault()
                save()
              }
            }}
            testId="account-display"
          />
          <div className="v2-acct-profile-row">
            <span>用户名</span>
            <strong>{profile.username}</strong>
            <small>登录时使用，暂不支持修改。</small>
          </div>
          <div className="v2-acct-profile-row">
            <span>邮箱</span>
            <strong>{profile.email || '—'}</strong>
            <small>用于找回密码和接收通知。</small>
          </div>
        </div>
      </Dialog>
      {avatarOpen && (
        <LocalAvatarDialog
          key={`${identity.origin}:${identity.userId}`}
          identity={identity}
          name={shownName}
          onClose={() => setAvatarOpen(false)}
        />
      )}
    </>
  )
}
