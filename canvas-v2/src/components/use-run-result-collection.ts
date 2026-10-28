import { useEffect, useRef, useState } from 'react'
import { applyRunCollectionMutation, legacyRunCollectionScopeKey, readRunCollection, RunCollectionStorageConflict, runCollectionReferenceKey, runCollectionScopeKey, verifyRunCollection, writeRunCollection, type RunCollectionMutation, type RunCollectionReader, type RunCollectionReference, type RunCollectionScope, type RunCollectionSnapshot, type RunCollectionStorage, type RunCollectionVerified } from './run-result-collection'

export interface RunCollectionAccess extends RunCollectionReader {
  scope: RunCollectionScope
  runtimeScope: string
  onAddMany?(ids: readonly string[]): Promise<void>
  onDownloadMany?(ids: readonly string[]): Promise<void>
}
function browserStorage(): RunCollectionStorage { return window.localStorage }
export function useRunCollectionVerification(references: readonly RunCollectionReference[], key: string, reader: RunCollectionReader) {
  const latest = useRef({ key, reader }); latest.current = { key, reader }
  const identity = JSON.stringify(references.map(runCollectionReferenceKey).sort())
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ key: string; identity: string; entries: RunCollectionVerified[]; loading: boolean }>({ key, identity: '', entries: [], loading: false })
  useEffect(() => {
    const controller = new AbortController()
    setResult({ key, identity, entries: [], loading: Boolean(references.length) })
    if (references.length) void verifyRunCollection(references, readerProject(key), latest.current.reader, controller.signal).then((entries) => {
      if (!controller.signal.aborted && latest.current.key === key) setResult({ key, identity, entries, loading: false })
    }).catch((cause) => {
      if (!controller.signal.aborted && latest.current.key === key) setResult({ key, identity, entries: references.map((reference) => ({ reference, error: cause instanceof Error ? cause.message : '素材核对失败' })), loading: false })
    })
    return () => controller.abort()
  }, [key, identity, revision])
  return { entries: result.key === key && result.identity === identity ? result.entries : [], loading: result.key !== key || result.identity !== identity ? Boolean(references.length) : result.loading, refresh() { setRevision((value) => value + 1) } }
}
export function runCollectionRuntimeKey(access: Pick<RunCollectionAccess, 'scope' | 'runtimeScope'>): string { return JSON.stringify([runCollectionScopeKey(access.scope), access.scope.projectId, access.runtimeScope]) }
function readerProject(key: string): string { return (JSON.parse(key) as string[])[1] }

export interface RunCollectionLock {
  run<T>(name: string, signal: AbortSignal, work: () => T): Promise<T>
}
export interface RunCollectionEnvironment {
  lock: RunCollectionLock | null
  subscribe?(scope: RunCollectionScope, listener: () => void): () => void
}
interface CollectionState {
  key: string
  references: RunCollectionReference[]
  snapshot: RunCollectionSnapshot
  mutations: RunCollectionMutation[]
  storageError: string
  corrupt: boolean
  saving: boolean
  temporary: boolean
  conflict?: RunCollectionSnapshot
}
interface RunCollectionWriteLease { controller: AbortController; epoch: number; timeout?: ReturnType<typeof setTimeout> }
const temporaryNotice = '当前浏览器无法安全同步多页收集篮，本页修改仅临时保留，不会覆盖其他页面；关闭或刷新会丢失。'
const unavailableStorageNotice = '浏览器存储不可用，本页修改仅临时保留，不会覆盖其他页面；关闭或刷新会丢失。'
function browserLock(): RunCollectionLock | null {
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return null
  return { async run<T>(name: string, signal: AbortSignal, work: () => T): Promise<T> { return await navigator.locks.request(name, { mode: 'exclusive', signal }, work) } }
}
function subscribeBrowser(scope: RunCollectionScope, listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  function storageChanged(event: StorageEvent) {
    if (event.key !== null && event.key !== runCollectionScopeKey(scope) && event.key !== legacyRunCollectionScopeKey(scope)) return
    try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
    listener()
  }
  window.addEventListener('storage', storageChanged)
  window.addEventListener('focus', listener)
  window.addEventListener('pageshow', listener)
  return () => { window.removeEventListener('storage', storageChanged); window.removeEventListener('focus', listener); window.removeEventListener('pageshow', listener) }
}
function mutationDescription(mutations: readonly RunCollectionMutation[]): string {
  const labels = mutations.map((mutation) => mutation.kind === 'clear' ? '清空收集篮' : mutation.kind === 'add' ? `加入 ${mutation.references.length} 项` : mutation.kind === 'remove' ? '移除素材' : mutation.direction === -1 ? '前移素材' : '后移素材')
  return [...new Set(labels)].join('、')
}

export function useRunResultCollection(access: RunCollectionAccess, storage?: RunCollectionStorage, environment?: RunCollectionEnvironment) {
  const key = runCollectionRuntimeKey(access), latest = useRef({ access, key }); latest.current = { access, key }
  const lock = environment ? environment.lock : browserLock()
  const [state, setState] = useState<CollectionState>({ key: '', references: [], snapshot: { references: [], revision: 0, source: 'empty' }, mutations: [], storageError: '', corrupt: false, saving: false, temporary: !lock })
  const currentState = useRef(state); currentState.current = state
  const mounted = useRef(true), epoch = useRef(0), scopeEpoch = useRef(0), pending = useRef(false), hostPhase = useRef<'checking' | 'accepted' | null>(null), controller = useRef<AbortController | null>(null)
  const writing = useRef<RunCollectionWriteLease | null>(null)
  const [action, setAction] = useState<{ key: string; phase: 'checking-add' | 'checking-download' | 'accepted-add' | 'accepted-download' | null; error: string; notice: string }>({ key, phase: null, error: '', notice: '' })
  function active() { return mounted.current && latest.current.key === key && currentState.current.key === key }
  function update(next: CollectionState) { currentState.current = next; setState(next) }
  function read() {
    try { return readRunCollection(access.scope, storage ?? browserStorage()) }
    catch { return { references: [], revision: 0, source: 'empty' as const, error: '浏览器存储不可用，无法恢复收集篮；明确清空后可临时收集，关闭或刷新可能丢失。', corrupt: true } }
  }
  function loaded(snapshot: RunCollectionSnapshot): CollectionState {
    const temporary = !lock || snapshot.versionToken === undefined
    return { key, references: snapshot.references, snapshot, mutations: [], storageError: [snapshot.error, !lock ? temporaryNotice : temporary ? unavailableStorageNotice : ''].filter(Boolean).join('；'), corrupt: Boolean(snapshot.corrupt), saving: false, temporary }
  }
  function stopChecking(notice: string) {
    if (hostPhase.current !== 'checking') return
    epoch.current++; controller.current?.abort(); pending.current = false; hostPhase.current = null
    setAction({ key, phase: null, error: '', notice })
  }
  function syncExternal() {
    if (!active()) return
    const before = currentState.current, snapshot = read()
    if (snapshot.versionToken === before.snapshot.versionToken) return
    stopChecking('其他页面已更新收集篮，只读核对已停止；请确认最新选择后重新操作。')
    if (before.mutations.length || writing.current) {
      update({ ...before, conflict: snapshot, saving: false })
    } else {
      update(loaded(snapshot))
      if (!pending.current) setAction({ key, phase: null, error: '', notice: '已同步其他页面的最新收集篮，请确认后继续。' })
    }
  }
  function abortWriting() { if (writing.current?.timeout) clearTimeout(writing.current.timeout); writing.current?.controller.abort(); writing.current = null }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; scopeEpoch.current++; controller.current?.abort(); abortWriting() } }, [])
  useEffect(() => {
    epoch.current++; scopeEpoch.current++; controller.current?.abort(); abortWriting(); pending.current = false; hostPhase.current = null
    setAction({ key, phase: null, error: '', notice: '' }); update(loaded(read()))
    const unsubscribe = environment?.subscribe ? environment.subscribe(access.scope, syncExternal) : subscribeBrowser(access.scope, syncExternal)
    return () => { unsubscribe(); scopeEpoch.current++; abortWriting() }
  }, [key])
  const references = state.key === key ? state.references : []
  const verification = useRunCollectionVerification(references, key, access)
  function save(retryChanges = false) {
    if (!active() || !lock || currentState.current.temporary || writing.current || !currentState.current.mutations.length || currentState.current.conflict && !retryChanges) return
    const lease: RunCollectionWriteLease = { controller: new AbortController(), epoch: scopeEpoch.current }; writing.current = lease
    update({ ...currentState.current, saving: true })
    function ownsLease() { return active() && writing.current === lease && lease.epoch === scopeEpoch.current }
    function current() { return ownsLease() && !lease.controller.signal.aborted }
    const timeout = setTimeout(() => {
      if (!ownsLease()) return
      lease.controller.abort(); writing.current = null
      update({ ...currentState.current, saving: false, storageError: '等待其他页面保存超时，本页修改尚未保存；请稍后重试，关闭或刷新可能丢失。' })
    }, 8_000)
    lease.timeout = timeout
    let succeeded = false
    void lock.run(runCollectionScopeKey(access.scope), lease.controller.signal, () => {
      if (!current()) return
      const draft = currentState.current
      if (draft.conflict && !retryChanges) return
      let snapshot = draft.snapshot, next = draft.references
      if (retryChanges) {
        snapshot = read()
        if (snapshot.corrupt) throw new Error('最新存档无法读取，请采用最新状态后明确处理损坏存档；本页修改仍保留。')
        next = draft.mutations.reduce(applyRunCollectionMutation, snapshot.references)
      }
      if (snapshot.versionToken === undefined) throw new RunCollectionStorageConflict(read())
      const saved = writeRunCollection(access.scope, next, storage ?? browserStorage(), snapshot.versionToken, draft.mutations[0]?.kind === 'clear')
      if (!current()) return
      update({ key, references: saved.references, snapshot: saved, mutations: [], storageError: '', corrupt: false, saving: false, temporary: false })
      succeeded = true
      if (!pending.current && retryChanges) setAction({ key, phase: null, error: '', notice: '已按最新收集篮重试本页修改，最新顺序和首次来源已保留。' })
      else if (!pending.current && snapshot.source === 'legacy') setAction({ key, phase: null, error: '', notice: '已接续原收集篮；其他旧版本页面需刷新后再继续。' })
    }).catch((cause) => {
      if (!current()) return
      if (cause instanceof RunCollectionStorageConflict) update({ ...currentState.current, conflict: cause.snapshot, saving: false })
      else update({ ...currentState.current, saving: false, storageError: `${cause instanceof Error ? cause.message : '浏览器存储不可用'}；本页修改仍临时保留，关闭或刷新可能丢失。` })
    }).finally(() => {
      clearTimeout(timeout)
      if (!current()) return
      writing.current = null
      if (currentState.current.saving) update({ ...currentState.current, saving: false })
      if (succeeded && currentState.current.mutations.length && !currentState.current.conflict) save()
    })
  }
  function mutate(mutation: RunCollectionMutation) {
    if (!active() || pending.current) return
    const before = currentState.current
    if (before.conflict) { setAction({ key, phase: null, error: '请先采用最新收集篮，或明确重试本页未保存的修改。', notice: '' }); return }
    if (before.corrupt && mutation.kind !== 'clear') { setAction({ key, phase: null, error: '原存档未确认，请先重试读取或明确清空损坏收集篮', notice: '' }); return }
    try {
      const next = applyRunCollectionMutation(before.references, mutation)
      if (!before.corrupt && JSON.stringify(next) === JSON.stringify(before.references)) return
      update({ ...before, references: next, mutations: [...before.mutations, mutation], corrupt: false, saving: Boolean(lock) && !before.temporary, storageError: before.temporary ? !lock ? temporaryNotice : unavailableStorageNotice : before.storageError })
      setAction({ key, phase: null, error: '', notice: mutation.kind === 'add' ? `已收集 ${next.length - before.references.length} 项来源，正在核对本人素材；重复素材保留最早来源。` : '' })
      save()
    } catch (cause) { if (active()) setAction({ key, phase: null, error: cause instanceof Error ? cause.message : '本批未加入', notice: '' }) }
  }
  function adoptLatest() {
    if (!active() || writing.current) return
    stopChecking('收集篮已重新读取，请确认后重新操作。')
    update(loaded(read()))
    if (!pending.current) setAction({ key, phase: null, error: '', notice: '已采用最新收集篮，本页未保存的修改已放弃。' })
  }
  function cancelCheck() {
    if (!active() || hostPhase.current !== 'checking') return
    stopChecking('已停止只读核对，收集篮保持原样，未提交加入或下载。')
  }
  async function run(kind: 'add' | 'download') {
    if (pending.current || !active() || currentState.current.corrupt || currentState.current.conflict || currentState.current.saving || !currentState.current.references.length) return
    if (!currentState.current.temporary) {
      const fresh = read()
      if (fresh.versionToken !== currentState.current.snapshot.versionToken) { syncExternal(); return }
    }
    const callback = kind === 'add' ? access.onAddMany : access.onDownloadMany
    if (!callback) return
    const frozen = currentState.current.references.map((reference) => Object.freeze({ ...reference })), ticket = ++epoch.current, check = new AbortController()
    controller.current?.abort(); controller.current = check; pending.current = true; hostPhase.current = 'checking'
    function current() { return active() && ticket === epoch.current && !check.signal.aborted }
    setAction({ key, phase: kind === 'add' ? 'checking-add' : 'checking-download', error: '', notice: '' })
    try {
      const checked = await verifyRunCollection(frozen, access.scope.projectId, access, check.signal)
      if (!current()) return
      if (!currentState.current.temporary && read().versionToken !== currentState.current.snapshot.versionToken) { syncExternal(); return }
      const errors = checked.filter((entry) => entry.error)
      if (errors.length) { verification.refresh(); throw new Error(`${errors.length} 项素材无法核对，整批未提交：${errors.map((entry) => entry.error).slice(0, 3).join('；')}`) }
      hostPhase.current = 'accepted'
      setAction({ key, phase: kind === 'add' ? 'accepted-add' : 'accepted-download', error: '', notice: '操作已交给宿主处理；关闭面板不会撤销已接受的事务。' })
      await callback(Object.freeze(frozen.map((reference) => reference.assetId)))
      if (current()) setAction({ key, phase: null, error: '', notice: kind === 'add' ? `已加入 ${frozen.length} 项素材，可一次撤销；收集篮仍保留。` : '打包窗口已结束，收集篮仍保留；下载结果请查看打包提示和浏览器下载记录。' })
    } catch (cause) { if (current()) setAction({ key, phase: null, error: cause instanceof Error ? cause.message : '操作结果未确认，请检查画布或下载记录；不会自动重试', notice: '' }) }
    finally { if (current()) { pending.current = false; hostPhase.current = null } }
  }
  return { references, verification, storageError: state.key === key ? state.storageError : '', corrupt: state.key === key && state.corrupt, saving: state.key === key && state.saving, temporary: state.key === key && state.temporary,
    conflict: state.key === key && state.conflict ? { latestCount: state.conflict.references.length, corrupt: Boolean(state.conflict.corrupt), changes: mutationDescription(state.mutations), clearsLatest: state.mutations.some((mutation) => mutation.kind === 'clear') } : null,
    action: action.key === key ? action : { key, phase: null, error: '', notice: '' }, add(additions: readonly RunCollectionReference[]) { mutate({ kind: 'add', references: additions.map((reference) => ({ ...reference })) }) }, run, cancelCheck, adoptLatest,
    retryChanges() { if (!pending.current) save(true) },
    reload() { if (!pending.current) { if (currentState.current.mutations.length && !currentState.current.conflict) save(); else adoptLatest() } }, clear() { mutate({ kind: 'clear' }) },
    remove(assetId: string) { mutate({ kind: 'remove', assetId }) },
    move(assetId: string, direction: -1 | 1) { mutate({ kind: 'move', assetId, direction }) },
  }
}
