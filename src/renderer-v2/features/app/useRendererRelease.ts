import { useEffect, useState } from 'react'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { backgroundWorkActive, subscribeBackgroundWork } from '../../background-work'
import { pages, type PageId } from '../../registry/pages'
import { readWindowSession, writeWindowSession } from '../../window-session'

/**
 * 窗口缩到托盘久了，主进程会关掉界面进程省内存，再叫出来时重新加载（electron/renderer-release.ts）。
 * 界面这边要做三件事：
 *
 * - 告诉主进程手上有没有事（background-work.ts 登记的那些，加上开着的对话框：关了里面填的东西就没了）。
 *   第一次报告也是「准备好了」：重新加载那一会儿托盘、系统通知要的跳页先存在主进程，收到它才发过来。
 * - 记下现在停在哪一页（sessionStorage，同一个窗口重新加载还在），重新加载以后回到那一页。
 * - 重新加载的这一次，开机那几句提示、开机检查不再来一遍（useAppBoot、useStartupChecks 看 restoredBoot）。
 */

const pageKey = 'xingmang-v2-release-page'
// 画布在单独的窗口里开，不是主窗口的一页。
const restorablePages: ReadonlySet<string> = new Set(pages.map((page) => page.id).filter((id) => id !== 'canvas'))

export interface ReleasedPage {
  page: PageId
  section?: string
}

function isRestorablePage(value: unknown): value is PageId {
  return typeof value === 'string' && restorablePages.has(value)
}

/** 读回上次停的那一页；没有、被改坏了都当没有。 */
export function parseReleasedPage(raw: string | null): ReleasedPage | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const { page, section } = parsed as Record<string, unknown>
    if (!isRestorablePage(page)) return null
    return typeof section === 'string' && section.length > 0 && section.length <= 64 ? { page, section } : { page }
  } catch {
    return null
  }
}

/** 要登录才能看的页：重新加载时账号还没恢复过来就不回去，免得弹出登录框。 */
export function pageNeedsAccount(page: PageId): boolean {
  return page === 'account' || page === 'chat' || page === 'video'
}

interface PageRestoreOptions {
  boot: 'loading' | 'ready' | 'failed'
  restoredBoot: boolean
  authenticated: boolean
  /** 工作区（首页、侧栏那些页）摆出来了：没登录、还在欢迎页时不记也不回。 */
  workspaceVisible: boolean
  page: PageId
  section: string | undefined
  navigate(page: PageId, section?: string): void
}

/** 记下停在哪一页；重新加载的那一次回到那一页。返回 true = 这件事办完了（或者不用办）。 */
export function usePageRestore({ boot, restoredBoot, authenticated, workspaceVisible, page, section, navigate }: PageRestoreOptions): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (settled || boot === 'loading') return
    const saved = boot === 'ready' && restoredBoot && workspaceVisible ? parseReleasedPage(readWindowSession(pageKey)) : null
    if (saved && saved.page !== 'home' && (authenticated || !pageNeedsAccount(saved.page))) navigate(saved.page, saved.section)
    setSettled(true)
  }, [authenticated, boot, navigate, restoredBoot, settled, workspaceVisible])
  useEffect(() => {
    // 回去之前别拿首页盖掉记下的那一页。
    if (!settled || !workspaceVisible) return
    writeWindowSession(pageKey, JSON.stringify(section ? { page, section } : { page }))
  }, [page, section, settled, workspaceVisible])
  return settled
}

/** 手上有没有事：登记的那些，或者开着对话框。 */
export function rendererBusy(): boolean {
  return backgroundWorkActive() || (typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null)
}

// 事情做完到界面画好（例如装失败弹出的错误框）要等一下，再看一眼才准。
const settleDelayMs = 1_000

/** 准备好了就报告一次，之后有变化再报。对话框一开一关也算变化：开着就别关。 */
export function useRendererActivityReport(native: XingmangApi, ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    let last: boolean | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    function report() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const busy = rendererBusy()
      if (busy === last) return
      last = busy
      void native.reportWindowActivity({ busy }).catch(() => undefined)
    }
    // 有事了马上说；没事了等界面画好再说。
    function changed() {
      if (rendererBusy()) { report(); return }
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(report, settleDelayMs)
    }
    report()
    const unsubscribe = subscribeBackgroundWork(changed)
    // 窗口藏到托盘时 visibilitychange 不一定来（Linux 上实测没来），对话框要在打开的那一刻就报上去。
    // 只看 open 属性：对话框开关、关掉的对话框被卸下前都会改它，平常画界面不会。
    const dialogs = new MutationObserver(changed)
    dialogs.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] })
    document.addEventListener('visibilitychange', report)
    return () => {
      unsubscribe()
      dialogs.disconnect()
      document.removeEventListener('visibilitychange', report)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [native, ready])
}
