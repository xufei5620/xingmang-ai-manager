import { useEffect, useRef, useState } from 'react'
import type { AiLibraryEntry, AiLibraryPage, XingmangApi } from '../../../../electron/ipc-contract'
import { useLatestRequest } from '../../latest-request'
import { cleanLibrarySearch, libraryPageSize, maxLibraryMatchedIds, type LibraryKind } from './library'

export type CreateLibraryBridge = Pick<XingmangApi, 'listAiLibrary'>

export interface CreateLibrary {
  /** unreadable：这一次没读出来，页面上说一句、给「重试」。 */
  status: 'loading' | 'ready' | 'unreadable'
  /** 整个作品库各类有多少（不随搜索变）；还没读到是 null。 */
  counts: AiLibraryPage['counts'] | null
  kind: LibraryKind
  /** 现在按它搜着的那几个字（洗过的）。 */
  search: string
  items: readonly AiLibraryEntry[]
  /** 现在这一类、这次搜索一共有多少。 */
  total: number
  hasMore: boolean
  loadingMore: boolean
  setKind(kind: LibraryKind): void
  /** matchedAssetIds：页面这边对得上这几个字的作品（当时写的那句话、对话和视频的名字），主进程再加上它自己记着的。 */
  setSearch(search: string, matchedAssetIds: readonly string[]): void
  loadMore(): void
  /** 再读一遍第一页：有新作品、删过东西就换成新的，没变就原样不动（已经点开的「加载更多」不收回去）。 */
  refresh(): void
}

interface Query { kind: LibraryKind, search: string, matched: readonly string[] }
interface Listed { items: readonly AiLibraryEntry[], total: number, hasMore: boolean }

const nothingListed: Listed = { items: [], total: 0, hasMore: false }
const noMatches: readonly string[] = []

/**
 * 当前账号的作品库（融合第 3 步）：主进程只列编号和时间，不读文件，所以这一页露面、窗口回到前台、
 * 对话里刚出完一张图时都可以再读一遍。filmAssetIds 是每条视频上一次拼好的成片，主进程拿它分出「成片」。
 * initialKind：只让挑图片、只让挑视频的选择框从那一类开始。
 * canvasProjectId：只列这一个画布项目里做出来的（融合第 5 步，点开一个画布项目时用）；用它的那一块按项目编号做 key，
 * 换一个项目就是换一份新的，这里不用管中途换编号。
 */
export function useCreateLibrary(bridge: CreateLibraryBridge, active: boolean, filmAssetIds: readonly string[], initialKind: LibraryKind = 'all', canvasProjectId?: string): CreateLibrary {
  const latest = useLatestRequest()
  const [query, setQuery] = useState<Query>({ kind: initialKind, search: '', matched: noMatches })
  const [status, setStatus] = useState<CreateLibrary['status']>('loading')
  const [counts, setCounts] = useState<AiLibraryPage['counts'] | null>(null)
  const [listed, setListed] = useState<Listed>(nothingListed)
  const [loadingMore, setLoadingMore] = useState(false)
  const listedRef = useRef(listed)
  listedRef.current = listed
  const queryRef = useRef(query)
  queryRef.current = query
  const filmsRef = useRef(filmAssetIds)
  filmsRef.current = filmAssetIds
  const filmKey = filmAssetIds.join(',')

  const input = (offset: number) => ({
    offset, limit: libraryPageSize, kind: queryRef.current.kind,
    ...(queryRef.current.search ? { search: queryRef.current.search, matchedAssetIds: queryRef.current.matched.slice(0, maxLibraryMatchedIds) } : {}),
    ...(filmsRef.current.length ? { filmAssetIds: [...filmsRef.current] } : {}),
    ...(canvasProjectId ? { canvasProjectId } : {}),
  })
  // replace：换了筛选或搜索，列表整个换掉；不是的话（再读一遍）只在第一页真的变了时才换。
  const load = (replace: boolean) => {
    const current = latest.begin()
    setLoadingMore(false)
    bridge.listAiLibrary(input(0)).then(
      (page) => {
        if (!current()) return
        setCounts(page.counts)
        setStatus('ready')
        const shown = listedRef.current
        const unchanged = !replace && shown.total === page.total && shown.items.length >= page.items.length && page.items.every((item, index) => shown.items[index]?.assetId === item.assetId)
        if (!unchanged) setListed({ items: page.items, total: page.total, hasMore: page.hasMore })
      },
      () => {
        if (!current()) return
        // 换了筛选没读出来：不能拿上一类的东西充数。再读一遍没读出来：留着已经列出来的。
        if (replace) setListed(nothingListed)
        setStatus((previous) => replace || previous !== 'ready' ? 'unreadable' : previous)
      },
    )
  }
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!active) return
    loadRef.current(true)
  }, [active, bridge, query])
  useEffect(() => {
    if (!active) return
    const onFocus = () => loadRef.current(false)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, bridge])
  // 又拼好了一条成片：各类的数要重新数。
  const firstFilmKey = useRef(filmKey)
  useEffect(() => {
    if (firstFilmKey.current === filmKey) return
    firstFilmKey.current = filmKey
    if (active) loadRef.current(false)
  }, [active, filmKey])

  const loadMore = () => {
    const shown = listedRef.current
    if (loadingMore || !shown.hasMore || status !== 'ready') return
    // 跟「再读一遍」共用一个先后：中途换了筛选、列表换过，这一页就不接上去。
    const current = latest.begin()
    setLoadingMore(true)
    bridge.listAiLibrary(input(shown.items.length)).then(
      (page) => {
        if (!current()) return
        const known = new Set(shown.items.map((item) => item.assetId))
        setCounts(page.counts)
        setListed({ items: [...shown.items, ...page.items.filter((item) => !known.has(item.assetId))], total: page.total, hasMore: page.hasMore })
        setLoadingMore(false)
      },
      () => { if (current()) setLoadingMore(false) },
    )
  }

  return {
    status, counts, kind: query.kind, search: query.search, items: listed.items, total: listed.total, hasMore: listed.hasMore, loadingMore,
    setKind: (kind) => setQuery((previous) => previous.kind === kind ? previous : { ...previous, kind }),
    setSearch: (search, matchedAssetIds) => {
      const text = cleanLibrarySearch(search)
      setQuery((previous) => previous.search === text && sameIds(previous.matched, text ? matchedAssetIds : noMatches) ? previous : { ...previous, search: text, matched: text ? matchedAssetIds : noMatches })
    },
    loadMore,
    refresh: () => loadRef.current(false),
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
