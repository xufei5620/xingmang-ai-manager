import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../error-message'

export interface Announcement { id: string; text: string }

export function useAnnouncements(load: (() => Promise<Announcement | null>) | undefined, scope: string) {
  const loader = useRef(load)
  loader.current = load
  const generation = useRef(0)
  const [notice, setNotice] = useState<Announcement | null>(null)
  const [readId, setReadId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const storageKey = `xingmang-announcement-read:${scope}`
  const refresh = useCallback(async () => {
    if (!loader.current) return
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const value = await loader.current()
      if (generation.current === request) setNotice(value)
    } catch (cause) {
      if (generation.current === request) setError(errorMessage(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    setNotice(null)
    try { setReadId(window.localStorage.getItem(storageKey)) } catch { setReadId(null) }
    void refresh()
    return () => { generation.current += 1 }
  }, [refresh, storageKey])

  const markRead = () => {
    if (!notice) return
    setReadId(notice.id)
    try { window.localStorage.setItem(storageKey, notice.id) } catch { /* Reading remains effective for this window. */ }
  }
  return { notice, loading, error, unread: Boolean(notice && notice.id !== readId), refresh, markRead }
}
