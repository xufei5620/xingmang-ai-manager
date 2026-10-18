import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { AuthMode } from '../auth'
import { chatParametersSection } from '../shell/command-search'
import type { FeedbackRequest } from '../../pages-maintenance'
import { accountTabs, resolveAccountLanding, resolveFeedbackLanding, settingsGroups, settingsItems, type SettingsGroupId } from '../../registry/business'
import { retiredPageAlias, settingsPageAlias, type PageId } from '../../registry/pages'
import { hasPendingSettingsGroup, requestSettingsGroup } from './settings-group-intent'
import { requestRowFocus } from './row-focus'
import type { AppApi, AppToast, Perform } from './runtime-context'

export type AccountTab = typeof accountTabs[number]['value']

interface AppNavigationOptions {
  app: AppApi
  perform: Perform
  toast: AppToast
  accelerationAvailable: boolean
  restoring: boolean
  restoreRetrying: boolean
  authenticated: boolean
  scope: string
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setGuide: Dispatch<SetStateAction<boolean>>
}

/**
 * 现在摆着哪一页、各页要落到哪一格。侧栏、顶部搜索、托盘、系统通知、教程和错误框都走 navigate：
 * 老页面名在这里换成新位置，要登录的页没登录就先开登录框。
 */
export function useAppNavigation({ app, perform, toast, accelerationAvailable, restoring, restoreRetrying, authenticated, scope, setAuth, setGuide }: AppNavigationOptions) {
  const [page, setPage] = useState<PageId>('home')
  const [chatScope, setChatScope] = useState<string | null>(null)
  const [chatParametersPending, setChatParametersPending] = useState(false)
  const [visitedPages, setVisitedPages] = useState<Partial<Record<PageId, string>>>({})
  // 设置页现在摆出来的是哪一组（搜索时为空）：人在「版本更新」那组时，更新气泡不再重复说卡上那件事。
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroupId | null>(null)
  // 带序号：已经停在「我的订单」时再点「充值」，值还是上次那个 'wallet'，
  // 光比值 React 不会重新切过去（全面检测 Q29），同 tutorialTopic。
  // rechargeAmount：从活动卡片点某一档进充值页时带上，充值页直接选好这一档。
  const [accountTab, setAccountTab] = useState<{ sequence: number; value: AccountTab; rechargeAmount?: number }>({ sequence: 0, value: 'overview' })
  // 教程页停在哪一章。页面挂上之后只是 hidden 不会重新挂载，所以每次跳转都换一个
  // sequence，教程页才接得住第二次、第三次跳过来。
  const [tutorialTopic, setTutorialTopic] = useState<{ sequence: number; id: string; query?: string; extra?: string } | null>(null)
  // 设置页只在挂载时取一次要落的分组（settings-group-intent），已经打开过再点名
  // 某一组就换个 key 让它重新挂一次，否则会停在上次看的那组（全面检测 Q48）。
  const [settingsRequest, setSettingsRequest] = useState(0)
  // 搜索里的「开始检查」：人已经在检查页上时换个 key 重挂一次，挂上就重查；不在检查页时跳过去本来就会重查。
  const [healthRequest, setHealthRequest] = useState(0)
  // 反馈与客服要落的页签（「查看日志」落「运行日志」）。页面挂上以后只藏不卸，带序号才接得住第二次，同 accountTab。
  const [feedbackRequest, setFeedbackRequest] = useState<FeedbackRequest | undefined>(undefined)
  // 个人中心实际摆着的分页（没权限的分页会被它自己换掉），顶栏的「个人中心 / 页签」和侧栏亮哪一行都看它。
  const [shownAccountTab, setShownAccountTab] = useState<AccountTab | undefined>(undefined)
  const navigate = useCallback((requested: PageId, requestedSection?: string, rechargeAmount?: number) => {
    if (requested === 'canvas') { void perform('打开画布', app.openCanvas); return }
    if (requested === 'acceleration' && !accelerationAvailable) return
    // 加速、备份、更新并进了设置（v4 批09）：托盘、系统通知、教程、错误框还叫老页面名，这里换成设置里那张卡。
    // 「安装卸载」页拆掉了（第 10 批）：还叫它的跳转落到首页，工具卡片上装、卸、重装。
    const alias = settingsPageAlias(requested)
    const target: PageId = alias ? 'settings' : retiredPageAlias(requested) ?? requested
    const section = alias ?? requestedSection
    if ((target === 'account' || target === 'chat') && restoring) {
      toast.show(restoreRetrying ? '暂时连不上服务，登录还在，连上后会自动恢复，不用重新登录。' : '正在恢复上次的登录，稍等一下再试。')
      return
    }
    if ((target === 'account' || target === 'chat') && !authenticated) { setAuth('login'); return }
    // 个人中心的页签，或页签里的某一节（顶部搜索的「切换账号」「我的订单」、系统通知的「异步任务」…）：
    // 切到那一节所在的页签，再翻到那一节。
    if (target === 'account') {
      const landing = resolveAccountLanding(section)
      if (landing.anchor) requestRowFocus('account', landing.anchor)
      setAccountTab((current) => ({ sequence: current.sequence + 1, value: landing.tab, rechargeAmount }))
    }
    // 教程的 section 可以带「#某条补充说明的标题」：打开那一篇、展开那一条（技能页「看怎么放」）。
    if (target === 'tutorial' && section) {
      const mark = section.indexOf('#')
      const id = mark < 0 ? section : section.slice(0, mark)
      const extra = mark < 0 ? '' : section.slice(mark + 1)
      setTutorialTopic((current) => ({ sequence: (current?.sequence ?? 0) + 1, id, ...(extra ? { extra } : {}) }))
    }
    if (target === 'settings') {
      // section 可以是一组，也可以是某一行（顶部搜索搜到的「自动更新」）：是一行就打开它那一组再翻过去。
      const item = settingsItems.find((entry) => entry.id === section)
      const group = settingsGroups.find((entry) => entry.value === section)?.value ?? item?.group
      if (group) requestSettingsGroup(group)
      if (item) requestRowFocus('settings', item.id)
      if (hasPendingSettingsGroup()) setSettingsRequest((current) => current + 1)
    }
    if (target === 'health' && section) requestRowFocus('health', section)
    if (target === 'feedback') {
      const landing = resolveFeedbackLanding(section)
      if (landing) setFeedbackRequest((current) => ({ sequence: (current?.sequence ?? 0) + 1, ...landing }))
    }
    if (target === 'chat') setChatScope(scope)
    // 只有从顶部搜索点「聊天参数设置」进来才打开参数对话框；去别处就放下，免得下次进聊天页突然弹出来。
    setChatParametersPending(target === 'chat' && section === chatParametersSection)
    if (target !== 'home' && target !== 'chat') setVisitedPages((current) => ({ ...current, [target]: scope }))
    setGuide(false); setPage(target)
  }, [accelerationAvailable, app, perform, restoring, restoreRetrying, authenticated, scope, toast, setAuth, setGuide])
  // 顶部搜索没搜到时的「去教程里搜」：带着输入的字打开教程页。
  const searchTutorial = useCallback((query: string) => {
    setTutorialTopic((current) => ({ sequence: (current?.sequence ?? 0) + 1, id: 'start', query }))
    navigate('tutorial')
  }, [navigate])
  // 顶部搜索的「开始检查」和帮助弹窗的「跑一遍检查」：人已经在检查页上时换个 key 重挂一次，挂上就重查。
  const startCheck = () => { if (page === 'health') setHealthRequest((current) => current + 1); navigate('health') }
  return {
    page, setPage, chatScope, setChatScope, chatParametersPending, setChatParametersPending, visitedPages,
    settingsGroup, setSettingsGroup, accountTab, shownAccountTab, setShownAccountTab, tutorialTopic, settingsRequest, healthRequest, feedbackRequest,
    navigate, searchTutorial, startCheck,
  }
}
