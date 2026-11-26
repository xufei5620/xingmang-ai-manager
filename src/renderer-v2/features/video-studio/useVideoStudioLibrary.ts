import { useEffect, useRef, useState } from 'react'
import { registerHistoryFlusher } from '../chat/storage'
import {
  maxVideoStudioProjects,
  cleanVideoStudioItemName,
  loadVideoStudioLibrary,
  serializeVideoStudioItem,
  sortVideoStudioItems,
  videoStudioProjectContent,
  type VideoStudioItem,
  type VideoStudioLibraryBridge,
} from './library'
import { createVideoStudioId, createVideoStudioProject, isVideoStudioProjectEmpty, restoreVideoStudioProject, type VideoStudioProject } from './project'

/** 视频工作台从哪读这一条、改了存到哪。 */
export interface VideoStudioSource {
  /** 这一条存着的样子（照重开软件那样读：没等到结果的片段算「生成中」，由工作台拿请求号去接回）。 */
  read(): VideoStudioProject
  /**
   * touch：客户动了它，时间记成现在（列表里排到前面）；模型表读完自动换默认模型这类不算。
   * urgent：马上交给主进程，不等攒一会儿。付费请求发出去之前记请求号用它，主进程等这一笔写完才提交（video:generate）。
   */
  write(project: VideoStudioProject, options: { touch: boolean, urgent: boolean }): void
  /** 没存下来时页面上那句提醒；存得下是空的。 */
  warning: string
}

export interface VideoStudioLibrary {
  /** unreadable：这一次没读出来（文件原样没动），列表里先不列视频。 */
  status: 'loading' | 'ready' | 'unreadable'
  /** 列在左边那一列里的视频，新的在前。刚新建、什么都还没写的那一条不在里面。 */
  items: VideoStudioItem[]
  warning: string
  /** 这一次没读出来时，客户点「重新读取」再读一遍。 */
  reload(): void
  /** 开一条空的，画面比例、模型这些设置照最近那一条；已经有一条空的就还是它。存满了是 null。 */
  create(): string | null
  /** 这一条的名字、时间和工程；没有这一条是 null。 */
  get(id: string): VideoStudioItem | null
  source(id: string): VideoStudioSource
  /**
   * 工作台外面往这一条里写（对话里的「拿去拼成片」）。写完这一条换一个版本号（revision）：开着它的那个工作台
   * 手上还是旧的，外面按版本号给 key 让它照新的重新读；旧工作台之后再交来的一律不收，不会把刚写的盖回去。
   * 没有这一条是 false。
   */
  replace(id: string, project: VideoStudioProject): boolean
  /** 这一条被 replace 写过几次。 */
  revision(id: string): number
  rename(id: string, name: string): void
  remove(id: string): void
  /** 手上没交出去的马上交，连同还在路上的都落定了才交回；不抛错。 */
  flush(): Promise<void>
}

interface Entry {
  item: VideoStudioItem
  /** 上一次记下的那份工程（JSON 文本）：没变就不用再存。 */
  content: string
  /** 写过东西、要列出来也要存的；刚新建的空白那一条是 false，一直空着就不落盘。 */
  listed: boolean
}

// 攒这么久交一次：打字时一个字一次改动，不必每个字都过一次主进程。付费请求之前那一笔不等（urgent）。
const saveDelayMs = 400
const storageWarning = '本机无法保存此分镜，关闭软件后需重新编写。已生成的片段仍保留在作品库中。'

function defaultStorage(): Pick<Storage, 'getItem'> | null {
  try { return window.localStorage } catch { return null }
}

/**
 * 这个账号做过的视频。打开时读一遍文件（头一次顺带把老版本的草稿抄过来，见 loadVideoStudioLibrary）；
 * 之后每条视频改了就攒一会儿交给主进程存，一条一个文件，互不相干。
 */
export function useVideoStudioLibrary(bridge: VideoStudioLibraryBridge, scope: string, legacyStorage: Pick<Storage, 'getItem'> | null | undefined = undefined): VideoStudioLibrary {
  const [storage] = useState(() => legacyStorage === undefined ? defaultStorage() : legacyStorage)
  const entries = useRef(new Map<string, Entry>())
  const [status, setStatus] = useState<VideoStudioLibrary['status']>('loading')
  const [warning, setWarning] = useState('')
  const [, setRevision] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const dirty = useRef(new Set<string>())
  const removed = useRef(new Set<string>())
  const versions = useRef(new Map<string, number>())
  const revisions = useRef(new Map<string, number>())
  const timer = useRef<number | null>(null)
  const inFlight = useRef(new Set<Promise<void>>())
  const mounted = useRef(true)
  const redraw = () => { if (mounted.current) setRevision((current) => current + 1) }

  // 主进程按收到的先后一笔一笔写（同一个账号排队），所以这里不等上一笔回来就能发下一笔，先后不会乱。
  const send = (): Promise<void> => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
    const put = [...dirty.current].flatMap((id) => {
      const entry = entries.current.get(id)
      return entry ? [{ id, version: versions.current.get(id) ?? 0, file: serializeVideoStudioItem(entry.item) }] : []
    })
    const remove = [...removed.current]
    dirty.current.clear(); removed.current.clear()
    if (!put.length && !remove.length) return Promise.resolve()
    const request = bridge.writeVideoStudioProjects({ scope, put: put.map(({ file }) => file), remove }).then(
      () => { if (mounted.current && !dirty.current.size) setWarning('') },
      () => {
        // 没存下：这几条还算没存，下一次改动、或者退出前那一次再试。之后又改过的那一条不用补，新的那一笔自己会管。
        for (const { id, version } of put) if (entries.current.has(id) && (versions.current.get(id) ?? 0) === version) dirty.current.add(id)
        for (const id of remove) removed.current.add(id)
        if (mounted.current) setWarning(storageWarning)
      },
    )
    inFlight.current.add(request)
    void request.then(() => { inFlight.current.delete(request) })
    return request
  }
  const sendRef = useRef(send)
  sendRef.current = send
  const flush = async () => { void sendRef.current(); await Promise.allSettled([...inFlight.current]) }
  const schedule = () => { if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; void sendRef.current() }, saveDelayMs) }
  const mark = (id: string, urgent: boolean) => {
    versions.current.set(id, (versions.current.get(id) ?? 0) + 1)
    dirty.current.add(id)
    if (urgent) void send(); else schedule()
  }

  useEffect(() => {
    let current = true
    mounted.current = true
    if (attempt) setStatus('loading')
    void loadVideoStudioLibrary(bridge, scope, storage).then((loaded) => {
      if (!current) return
      // 读回来之前已经在这一页里新建、改过的那几条照留，读回来的不盖它们。
      for (const item of loaded.items) {
        if (!entries.current.has(item.id)) entries.current.set(item.id, { item, content: videoStudioProjectContent(item.project), listed: true })
      }
      setStatus(loaded.status)
      redraw()
    })
    return () => { current = false }
  }, [bridge, scope, storage, attempt])

  useEffect(() => {
    // 关窗、刷新时页面先收到 pagehide：手上攒着的那一笔这时交出去。退出软件走主进程问的那一声（同聊天记录）。
    const onHide = () => { void sendRef.current() }
    mounted.current = true
    window.addEventListener('pagehide', onHide)
    const unregister = registerHistoryFlusher(flush)
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', onHide)
      unregister()
      void sendRef.current()
    }
  }, [])

  const listed = sortVideoStudioItems([...entries.current.values()].filter((entry) => entry.listed).map((entry) => entry.item))
  const create = (): string | null => {
    for (const [id, entry] of entries.current) if (!entry.listed) return id
    if (listed.length >= maxVideoStudioProjects) return null
    const project = createVideoStudioProject(listed[0] ? { ...listed[0].project.settings, idea: '' } : undefined)
    const id = createVideoStudioId()
    entries.current.set(id, { item: { id, updatedAt: Date.now(), project }, content: videoStudioProjectContent(project), listed: false })
    return id
  }
  const write = (id: string, project: VideoStudioProject, options: { touch: boolean, urgent: boolean }) => {
    const entry = entries.current.get(id)
    if (!entry) return
    const content = videoStudioProjectContent(project)
    if (content === entry.content) return
    entry.content = content
    entry.item = { ...entry.item, project, ...(options.touch ? { updatedAt: Date.now() } : {}) }
    // 空白的那一条写了第一个字才算数；之后清空了也照留，删不删由客户自己定。
    if (!entry.listed && !isVideoStudioProjectEmpty(project)) entry.listed = true
    if (entry.listed) mark(id, options.urgent)
    redraw()
  }
  const revision = (id: string) => revisions.current.get(id) ?? 0
  const source = (id: string): VideoStudioSource => {
    const issued = revision(id)
    return {
      read: () => {
        const entry = entries.current.get(id)
        if (!entry) return createVideoStudioProject()
        try { return restoreVideoStudioProject(JSON.parse(entry.content)) ?? entry.item.project } catch { return entry.item.project }
      },
      // 发出去以后这一条被外面换过（replace），拿着它的是照旧内容开的工作台：它再交来的不收。
      write: (project, options) => { if (revision(id) === issued) write(id, project, options) },
      warning,
    }
  }
  const replace = (id: string, project: VideoStudioProject): boolean => {
    if (!entries.current.has(id)) return false
    revisions.current.set(id, revision(id) + 1)
    write(id, project, { touch: true, urgent: true })
    return true
  }
  const rename = (id: string, name: string) => {
    const entry = entries.current.get(id)
    const next = cleanVideoStudioItemName(name)
    if (!entry || !next || next === entry.item.name) return
    // 改名不动时间，同对话：一条旧视频改个名不该跑到「今天」里去。
    entry.item = { ...entry.item, name: next }
    if (entry.listed) mark(id, false)
    redraw()
  }
  const remove = (id: string) => {
    const entry = entries.current.get(id)
    if (!entry) return
    entries.current.delete(id)
    dirty.current.delete(id)
    versions.current.delete(id)
    revisions.current.delete(id)
    if (entry.listed) { removed.current.add(id); void send() }
    redraw()
  }

  return { status, items: listed, warning, reload: () => setAttempt((value) => value + 1), create, get: (id: string) => entries.current.get(id)?.item ?? null, source, replace, revision, rename, remove, flush }
}

/**
 * 右边现在开着哪一条视频。只有一条开着：出着的片段、画着的图、拼着的片都挂在开着的那一条上，
 * 所以它手上有事时不换别的、也不删它（busy 由工作台报上来）。
 */
export function useVideoStudioSession(library: Pick<VideoStudioLibrary, 'create' | 'get' | 'remove'>) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const blocked = (id: string | null) => openId !== null && openId !== id && busy
  return {
    openId,
    busy,
    setBusy,
    /** 打开这一条。开着的另一条还有事在做就不换（busy），没有这一条是 missing。 */
    open: (id: string): 'opened' | 'busy' | 'missing' => {
      if (!library.get(id)) return 'missing'
      if (blocked(id)) return 'busy'
      if (openId !== id) { setBusy(false); setOpenId(id) }
      return 'opened'
    },
    /** 新开一条空的并打开它。存满了是 full。 */
    start: (): { id: string } | 'busy' | 'full' => {
      const id = library.create()
      if (!id) return 'full'
      if (blocked(id)) return 'busy'
      if (openId !== id) { setBusy(false); setOpenId(id) }
      return { id }
    },
    /** 删掉这一条。开着的正是它、而且手上有事时不删。 */
    remove: (id: string): boolean => {
      if (openId === id && busy) return false
      if (openId === id) { setBusy(false); setOpenId(null) }
      library.remove(id)
      return true
    },
  }
}

export type VideoStudioSession = ReturnType<typeof useVideoStudioSession>
