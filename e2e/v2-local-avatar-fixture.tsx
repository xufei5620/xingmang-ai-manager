import { Suspense, startTransition, use, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  LocalAvatar,
  LocalAvatarDialog,
  useLocalAvatar,
} from '../src/renderer-v2/LocalAvatar'
import { Button } from '../src/renderer-v2/ui'
import '../src/renderer-v2/business.css'

document.documentElement.dataset.theme = 'light'
document.body.style.fontFamily = 'var(--font)'
document.body.style.background = 'var(--bg)'
// A transition whose render suspends is never committed, so the account on
// screen stays the previous one even though every component below already ran
// with the new identity. That is the cheapest deterministic stand-in for any
// interrupted concurrent render. React calls then() the moment it suspends on
// this thenable and never receives a callback back, which both pins the
// transition open and tells the test that the abandoned render really ran.
const neverSettles = new Promise<never>(() => {})
const abandonedRender: PromiseLike<void> = {
  then() {
    document.documentElement.dataset.avatarRenderAbandoned = 'true'
    return neverSettles
  },
}
function SuspendWhilePending({ pending }: { pending: boolean }) {
  if (pending) use(abandonedRender)
  return null
}
function Fixture() {
  const [userId, setUserId] = useState(7)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const identity = { origin: 'https://xm.solov.cc', userId }
  const avatar = useLocalAvatar(identity)
  useEffect(() => {
    const change = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'number')
        setUserId(event.detail)
    }
    const abandon = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const next = Number(event.detail)
      startTransition(() => {
        setPending(true)
        setUserId(next)
      })
    }
    window.addEventListener('avatar-switch', change)
    window.addEventListener('avatar-switch-abandoned', abandon)
    return () => {
      window.removeEventListener('avatar-switch', change)
      window.removeEventListener('avatar-switch-abandoned', abandon)
    }
  }, [])
  return (
    <main style={{ padding: 32 }}>
      <LocalAvatar
        identity={identity}
        name={userId === 7 ? '神风呀' : '另一账号'}
        size={72}
        testId="avatar-current"
      />
      <p data-testid="avatar-user">{userId}</p>
      <p data-testid="avatar-key">{avatar.key}</p>
      <Button onClick={() => setOpen(true)}>更换头像</Button>
      {avatar.error && <p>{avatar.error}</p>}
      {open && (
        <LocalAvatarDialog
          identity={identity}
          name="神风呀"
          onClose={() => setOpen(false)}
        />
      )}
      <Suspense fallback={<p data-testid="avatar-pending">切换中</p>}>
        <SuspendWhilePending pending={pending} />
      </Suspense>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
