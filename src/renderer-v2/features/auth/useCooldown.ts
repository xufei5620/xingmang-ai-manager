import { useEffect, useState } from 'react'
import { remainingCooldown } from './state'

export function useCooldown() {
  const [deadline, setDeadline] = useState(0)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const update = () => setSeconds(remainingCooldown(deadline))
    update()
    if (!deadline) return
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [deadline])
  return { seconds, start: () => { setSeconds(60); setDeadline(Date.now() + 60_000) } }
}
