import { useEffect, useState } from 'react'
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
function Fixture() {
  const [userId, setUserId] = useState(7)
  const [open, setOpen] = useState(false)
  const identity = { origin: 'https://xm.solov.cc', userId }
  const avatar = useLocalAvatar(identity)
  useEffect(() => {
    const change = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'number')
        setUserId(event.detail)
    }
    window.addEventListener('avatar-switch', change)
    return () => window.removeEventListener('avatar-switch', change)
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
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
