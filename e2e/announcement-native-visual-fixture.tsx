import { useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnouncementContent } from '../src/renderer-v2/features/shell/Announcement'
import { Button, Dialog } from '../src/renderer-v2/ui'
import '../src/renderer-v2/styles/tokens.css'
import '../src/renderer-v2/styles/components.css'
import '../src/renderer-v2/app.css'

type Theme = 'light' | 'dark'

declare global {
  interface Window {
    announcementVisualHarness: {
      errors: string[]
      opened: string[]
      render(text: string, theme: Theme): void
    }
  }
}

function Fixture() {
  const [notice, setNotice] = useState<{ text: string; theme: Theme } | null>(null)

  useEffect(() => {
    window.announcementVisualHarness.render = (text, theme) => {
      setNotice({ text, theme })
    }
  }, [])

  useLayoutEffect(() => {
    const theme = notice?.theme ?? 'light'
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.skin = 'mist'
    document.documentElement.style.colorScheme = theme
  }, [notice?.theme])

  if (!notice) return <p role="status">等待公告测试数据</p>
  return (
    <Dialog
      open
      title="公告"
      width={640}
      onClose={() => undefined}
      footer={
        <>
          <Button>重新读取</Button>
          <Button variant="primary">标为已读</Button>
        </>
      }
      testId="announcement-visual-dialog"
    >
      <AnnouncementContent
        text={notice.text}
        noticeUrl="https://xm.solov.cc"
        openExternal={async (url) => {
          window.announcementVisualHarness.opened.push(url)
        }}
        onError={(cause) => {
          window.announcementVisualHarness.errors.push(
            cause instanceof Error ? cause.message : String(cause),
          )
        }}
      />
    </Dialog>
  )
}

window.announcementVisualHarness = {
  errors: [],
  opened: [],
  render: () => undefined,
}
window.addEventListener('error', (event) => {
  window.announcementVisualHarness.errors.push(event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  window.announcementVisualHarness.errors.push(String(event.reason))
})

document.body.style.margin = '0'
document.body.style.background = 'var(--bg)'
document.body.style.color = 'var(--text)'
createRoot(document.getElementById('root')!).render(<Fixture />)
