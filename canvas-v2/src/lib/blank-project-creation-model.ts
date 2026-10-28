import { createEmptyWorkflow, serializeWorkflow } from '../model'
import { createWorkflowImportCreationDigest } from './project-creation-digest'
import { isProjectCreationResponse, type WorkspaceProjectSummary } from './workspace-project-summary'
import { parseQuickProjectCreationReceipt as parseBlankProjectCreationReceipt, type QuickProjectCreationReceipt } from './quick-project-creation-receipt'

export { parseBlankProjectCreationReceipt }

export interface BlankProjectConfiguration {
  name: string
}

export interface SavedBlankProjectSubmission {
  version: 1
  ownerId: string
  operationId: string
  content: string
  creationDigest: string
  createdAt: number
  summary: BlankProjectConfiguration
}

export interface BlankProjectSubmissionStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type BlankProjectCreationPhase = 'idle' | 'preparing' | 'submitting' | 'unknown' | 'checking' | 'missing' | 'confirmed' | 'opening'

export interface BlankProjectCreationState {
  phase: BlankProjectCreationPhase
  pending: SavedBlankProjectSubmission | null
  confirmedProject: WorkspaceProjectSummary | null
  error: string | null
  busy: boolean
}

export type BlankProjectCreationReceipt = QuickProjectCreationReceipt

export interface BlankProjectCreationDependencies {
  ownerId: string
  storage: BlankProjectSubmissionStorage
  createOperationId(): string
  submit(submission: SavedBlankProjectSubmission): Promise<unknown>
  inspect(submission: SavedBlankProjectSubmission): Promise<unknown>
  open(project: WorkspaceProjectSummary): void | Promise<void>
  isActive(): boolean
  now?(): number
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maximumContentBytes = 16 * 1024
const maximumRecordBytes = 64 * 1024
const maximumOwnerBytes = 512 * 1024
const maximumOwnerRecords = 8
const maximumStorageKeys = 10_000
const maximumDraftBytes = 8 * 1024
const readError = '原空白画布创建恢复记录无法读取，请保留浏览器数据并核对原工程；当前不会重新创建。'
const writeError = '原空白画布创建配置未能可靠保存在浏览器中，请导出原工作流并检查存储权限；当前尚未提交创建。'
const existingError = '原空白画布创建结果尚未确认，请先核对原工程；新输入不会替换原操作。'

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength }
function assertOwner(ownerId: string): void { if (typeof ownerId !== 'string' || !uuidPattern.test(ownerId)) throw new Error(readError) }
function prefix(ownerId: string): string { assertOwner(ownerId); return `xingmang:blank-project-submission:v1:${ownerId}:` }
function submissionKey(ownerId: string, operationId: string): string {
  if (typeof operationId !== 'string' || !uuidPattern.test(operationId)) throw new Error(readError)
  return `${prefix(ownerId)}${operationId}`
}
function draftKey(ownerId: string): string { assertOwner(ownerId); return `xingmang:blank-project-draft:v1:${ownerId}` }

function parseConfiguration(value: unknown, allowEmpty = false): BlankProjectConfiguration {
  if (!object(value) || Object.keys(value).length !== 1 || typeof value.name !== 'string' || value.name.length > 256
    || value.name.includes('\0') || (!allowEmpty && !value.name.trim())) throw new Error('画布名称格式不正确，请保留原输入并核对。')
  return { name: allowEmpty ? value.name : value.name.trim() }
}

function validateContent(content: unknown, summary: BlankProjectConfiguration): string {
  if (typeof content !== 'string' || content.length > maximumContentBytes || bytes(content) > maximumContentBytes) throw new Error('空白工作流超过恢复记录上限，当前尚未提交创建。')
  // Only the exact empty document is allowed here. Runtime outputs, assets,
  // provider choices and imported metadata must never enter a blank operation.
  if (content !== serializeWorkflow(createEmptyWorkflow(summary.name))) throw new Error('原空白画布摘要与工作流不一致，请保留原记录并核对。')
  return content
}

function parseSubmission(value: unknown): SavedBlankProjectSubmission {
  if (!object(value) || Object.keys(value).length !== 7 || Object.keys(value).some((key) => !['version', 'ownerId', 'operationId', 'content', 'creationDigest', 'createdAt', 'summary'].includes(key))) throw new Error(readError)
  if (value.version !== 1 || typeof value.ownerId !== 'string' || typeof value.operationId !== 'string'
    || typeof value.creationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.creationDigest)
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error(readError)
  submissionKey(value.ownerId, value.operationId)
  const summary = parseConfiguration(value.summary)
  if (!object(value.summary) || value.summary.name !== summary.name) throw new Error(readError)
  const content = validateContent(value.content, summary)
  return { version: 1, ownerId: value.ownerId, operationId: value.operationId, creationDigest: value.creationDigest, createdAt: value.createdAt, content, summary }
}

function encodedSubmission(value: SavedBlankProjectSubmission): string {
  const encoded = JSON.stringify(parseSubmission(value))
  if (encoded.length > maximumRecordBytes || bytes(encoded) > maximumRecordBytes) throw new Error(writeError)
  return encoded
}

function readEncoded(storage: BlankProjectSubmissionStorage, key: string): string | null {
  try {
    const value = storage.getItem(key)
    if (value !== null && (typeof value !== 'string' || value.length > maximumRecordBytes || bytes(value) > maximumRecordBytes)) throw new Error(readError)
    return value
  } catch { throw new Error(readError) }
}

async function validateDigest(record: SavedBlankProjectSubmission): Promise<void> {
  if (await createWorkflowImportCreationDigest(record.content, 'reject') !== record.creationDigest) throw new Error(readError)
}

export async function readSavedBlankProjectSubmission(storage: BlankProjectSubmissionStorage, ownerId: string, operationId: string): Promise<SavedBlankProjectSubmission | null> {
  const key = submissionKey(ownerId, operationId)
  const encoded = readEncoded(storage, key)
  if (encoded === null) return null
  let record: SavedBlankProjectSubmission
  try { record = parseSubmission(JSON.parse(encoded)) } catch { throw new Error(readError) }
  if (record.ownerId !== ownerId || record.operationId !== operationId) throw new Error(readError)
  await validateDigest(record)
  if (readEncoded(storage, key) !== encoded) throw new Error(readError)
  return record
}

function ownerSubmissionKeys(storage: BlankProjectSubmissionStorage, ownerId: string): Set<string> {
  const ownerPrefix = prefix(ownerId)
  const keys = new Set<string>()
  try {
    const length = storage.length
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumStorageKeys) throw new Error(readError)
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(ownerPrefix)) {
        if (!uuidPattern.test(key.slice(ownerPrefix.length))) throw new Error(readError)
        keys.add(key)
      }
    }
  } catch { throw new Error(readError) }
  if (keys.size > maximumOwnerRecords) throw new Error('本账户未核对的空白画布创建记录过多，请先逐个核对原工程；当前不会创建新工程。')
  return keys
}

export async function listSavedBlankProjectSubmissions(storage: BlankProjectSubmissionStorage, ownerId: string): Promise<SavedBlankProjectSubmission[]> {
  const ownerPrefix = prefix(ownerId)
  const keys = ownerSubmissionKeys(storage, ownerId)
  const records: SavedBlankProjectSubmission[] = []
  let total = 0
  for (const key of keys) {
    const record = await readSavedBlankProjectSubmission(storage, ownerId, key.slice(ownerPrefix.length))
    if (!record) continue
    total += bytes(encodedSubmission(record))
    if (total > maximumOwnerBytes) throw new Error('本账户空白画布创建恢复记录超过容量上限，请先核对或导出原工作流。')
    records.push(record)
  }
  return records.sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
}

export async function writeSavedBlankProjectSubmission(storage: BlankProjectSubmissionStorage, input: SavedBlankProjectSubmission, assertCurrent?: () => void): Promise<void> {
  const record = parseSubmission(input)
  const encoded = encodedSubmission(record)
  await validateDigest(record)
  const key = submissionKey(record.ownerId, record.operationId)
  const existing = readEncoded(storage, key)
  if (existing !== null) {
    const saved = await readSavedBlankProjectSubmission(storage, record.ownerId, record.operationId)
    if (!saved || encodedSubmission(saved) !== encoded) throw new Error(existingError)
    return
  }
  const other = await listSavedBlankProjectSubmissions(storage, record.ownerId)
  if (other.length) throw new Error(existingError)
  // Each operation has an immutable key. Another tab cannot overwrite an old
  // unknown operation by creating a new pointer for the same account.
  assertCurrent?.()
  if (readEncoded(storage, key) !== null) throw new Error(existingError)
  if (ownerSubmissionKeys(storage, record.ownerId).size) throw new Error(existingError)
  assertCurrent?.()
  try { storage.setItem(key, encoded) } catch { throw new Error(writeError) }
  const confirmed = await readSavedBlankProjectSubmission(storage, record.ownerId, record.operationId)
  if (!confirmed || encodedSubmission(confirmed) !== encoded) throw new Error(writeError)
}

export async function clearSavedBlankProjectSubmission(storage: BlankProjectSubmissionStorage, input: SavedBlankProjectSubmission, assertCurrent?: () => void): Promise<void> {
  const record = parseSubmission(input)
  const key = submissionKey(record.ownerId, record.operationId)
  const saved = await readSavedBlankProjectSubmission(storage, record.ownerId, record.operationId)
  if (!saved) return
  if (encodedSubmission(saved) !== encodedSubmission(record)) throw new Error('原空白画布创建恢复记录已变化，未清理其他记录。')
  // No helper may replace this operation's bytes. Recheck after asynchronous
  // digest verification so an altered record is never removed by a late ACK.
  assertCurrent?.()
  if (readEncoded(storage, key) !== encodedSubmission(saved)) throw new Error(readError)
  assertCurrent?.()
  try { storage.removeItem(key) } catch { throw new Error('原工程已确认，但恢复记录暂未清理，请保留原记录并重试。') }
  if (readEncoded(storage, key) !== null) throw new Error('原工程已确认，但恢复记录暂未清理，请保留原记录并重试。')
}

export function readSavedBlankProjectDraft(storage: BlankProjectSubmissionStorage, ownerId: string): BlankProjectConfiguration | null {
  let encoded: string | null
  try { encoded = storage.getItem(draftKey(ownerId)) } catch { throw new Error('空白画布创建输入草稿无法读取，请保留当前输入并检查浏览器存储。') }
  if (encoded === null) return null
  try {
    if (typeof encoded !== 'string' || encoded.length > maximumDraftBytes || bytes(encoded) > maximumDraftBytes) throw new Error(readError)
    const value: unknown = JSON.parse(encoded)
    if (!object(value) || Object.keys(value).length !== 3 || value.version !== 1 || value.ownerId !== ownerId || !('configuration' in value)) throw new Error(readError)
    return parseConfiguration(value.configuration, true)
  } catch { throw new Error('空白画布创建输入草稿无法读取，请保留当前输入并检查浏览器存储。') }
}

export function writeSavedBlankProjectDraft(storage: BlankProjectSubmissionStorage, ownerId: string, input: BlankProjectConfiguration): void {
  const configuration = parseConfiguration(input, true)
  const encoded = JSON.stringify({ version: 1, ownerId, configuration })
  if (bytes(encoded) > maximumDraftBytes) throw new Error('空白画布创建输入草稿超过容量上限，请导出原工作流。')
  try { storage.setItem(draftKey(ownerId), encoded) } catch { throw new Error('空白画布创建输入草稿保存失败，请保留当前输入并检查浏览器存储。') }
  if (JSON.stringify(readSavedBlankProjectDraft(storage, ownerId)) !== JSON.stringify(configuration)) throw new Error('空白画布创建输入草稿保存未能确认，请保留当前输入。')
}

/** The form is separate from this immutable operation. No method retries a POST implicitly. */
export function createBlankProjectCreation(dependencies: BlankProjectCreationDependencies) {
  const ownerId = dependencies.ownerId
  assertOwner(ownerId)
  let state: BlankProjectCreationState = { phase: 'idle', pending: null, confirmedProject: null, error: null, busy: false }
  let revision = 0
  let disposed = false
  const listeners = new Set<(state: BlankProjectCreationState) => void>()

  function snapshot(): BlankProjectCreationState { return structuredClone(state) }
  function notify(): void { for (const listener of [...listeners]) { try { listener(snapshot()) } catch { /* View errors do not change operation ownership. */ } } }
  function active(): boolean { return !disposed && dependencies.isActive() }
  function current(ticket: number): boolean {
    if (disposed || ticket !== revision) return false
    if (!dependencies.isActive()) {
      revision += 1
      state = { ...state, phase: state.confirmedProject ? 'confirmed' : state.pending ? 'unknown' : 'idle', busy: false }
      return false
    }
    return true
  }
  function begin(phase: BlankProjectCreationPhase): number {
    if (!active()) throw new Error('当前账户尚未核对完成，请保留原空白画布创建记录。')
    if (state.busy) throw new Error('原空白画布创建仍在处理中，请等待当前结果。')
    const ticket = ++revision
    state = { ...state, phase, busy: true, error: null }
    notify()
    return ticket
  }
  function failure(ticket: number, error: unknown): void {
    if (!current(ticket)) return
    state = { ...state, phase: state.confirmedProject ? 'confirmed' : state.pending ? 'unknown' : 'idle', error: error instanceof Error ? error.message : '原空白画布创建结果尚未确认，请保留原工作流并继续核对。', busy: false }
    notify()
  }
  function finish(ticket: number): void { if (current(ticket)) { state = { ...state, busy: false }; notify() } }

  async function submitOriginal(ticket: number, record: SavedBlankProjectSubmission): Promise<BlankProjectCreationState> {
    if (!current(ticket)) return snapshot()
    await writeSavedBlankProjectSubmission(dependencies.storage, record, () => { if (!current(ticket)) throw new Error('原空白画布创建等待已失效，请保留原工作流并核对。') })
    if (!current(ticket)) return snapshot()
    state = { ...state, phase: 'submitting' }
    notify()
    if (!current(ticket)) return snapshot()
    const result = await dependencies.submit(structuredClone(record))
    if (!current(ticket)) return snapshot()
    if (!isProjectCreationResponse(result)) throw new Error('原工程创建回执不完整，请只核对原操作；当前不会重复创建。')
    const receipt = parseBlankProjectCreationReceipt({ state: 'confirmed', project: result.project }, record.operationId)
    if (receipt.state !== 'confirmed') throw new Error('原空白画布回执无法确认，请核对原操作。')
    const project = receipt.project
    state = { ...state, phase: 'confirmed', confirmedProject: project, error: null }
    return snapshot()
  }

  return {
    state: snapshot,
    subscribe(listener: (state: BlankProjectCreationState) => void) { listeners.add(listener); try { listener(snapshot()) } catch { /* The operation remains usable when a view fails. */ }; return () => { listeners.delete(listener) } },
    async restore(operationId?: string): Promise<BlankProjectCreationState> {
      const ticket = begin('checking')
      try {
        const records = await listSavedBlankProjectSubmissions(dependencies.storage, ownerId)
        if (!current(ticket)) return snapshot()
        const record = operationId ? records.find((entry) => entry.operationId === operationId) : records[0]
        if (operationId && !record) throw new Error('所选原空白画布创建恢复记录不存在，请保留当前记录并重新读取。')
        if (state.pending && !record) throw new Error('当前原空白画布创建恢复记录尚未确认，不会因缺失记录而清空。')
        if (record) state = { ...state, pending: record, confirmedProject: null, phase: 'unknown', error: null }
        else state = { ...state, phase: 'idle', error: null }
      } catch (error) { failure(ticket, error) } finally { finish(ticket) }
      return snapshot()
    },
    async start(configuration: BlankProjectConfiguration): Promise<BlankProjectCreationState> {
      if (state.pending) throw new Error(existingError)
      const ticket = begin('preparing')
      try {
        const summary = parseConfiguration(configuration)
        const saved = await listSavedBlankProjectSubmissions(dependencies.storage, ownerId)
        if (!current(ticket)) return snapshot()
        if (saved.length) { state = { ...state, pending: saved[0], phase: 'unknown' }; throw new Error(existingError) }
        const operationId = dependencies.createOperationId()
        submissionKey(ownerId, operationId)
        const content = validateContent(serializeWorkflow(createEmptyWorkflow(summary.name)), summary)
        if (!current(ticket)) return snapshot()
        const creationDigest = await createWorkflowImportCreationDigest(content, 'reject')
        if (!current(ticket)) return snapshot()
        const record = parseSubmission({ version: 1, ownerId, operationId, content, creationDigest, createdAt: dependencies.now?.() ?? Date.now(), summary })
        state = { ...state, pending: record }
        notify()
        if (!current(ticket)) return snapshot()
        await submitOriginal(ticket, record)
      } catch (error) { failure(ticket, error) } finally { finish(ticket) }
      return snapshot()
    },
    async inspectOriginal(): Promise<BlankProjectCreationState> {
      if (!state.pending) throw new Error('没有待核对的原空白画布创建记录。')
      const record = structuredClone(state.pending)
      const ticket = begin('checking')
      try {
        if (!current(ticket)) return snapshot()
        const response = await dependencies.inspect(structuredClone(record))
        if (!current(ticket)) return snapshot()
        const result = parseBlankProjectCreationReceipt(response, record.operationId)
        if (result.state === 'missing') state = { ...state, phase: 'missing', confirmedProject: null }
        else state = { ...state, phase: 'confirmed', confirmedProject: result.project }
      } catch (error) { failure(ticket, error) } finally { finish(ticket) }
      return snapshot()
    },
    async continueOriginal(): Promise<BlankProjectCreationState> {
      if (!state.pending || state.phase !== 'missing') throw new Error('请先核对原工程；只有当前未查到时，才能明确继续同一次创建。')
      const record = structuredClone(state.pending)
      const ticket = begin('preparing')
      try { await submitOriginal(ticket, record) } catch (error) { failure(ticket, error) } finally { finish(ticket) }
      return snapshot()
    },
    async openConfirmed(options: { finish?: boolean } = {}): Promise<BlankProjectCreationState> {
      if (!state.pending || !state.confirmedProject || state.phase !== 'confirmed') throw new Error('原工程尚未确认，请先核对原操作。')
      const project = structuredClone(state.confirmedProject)
      const record = structuredClone(state.pending)
      // Verify the route before clearing a known result. Archived projects must
      // retain their recovery entry until the user restores or acknowledges them.
      if (options.finish && project.archivedAt) throw new Error('原工程已归档，请到我的画布核对和恢复；原创建记录仍保留。')
      const ticket = begin('opening')
      let cleared = false
      try {
        if (!current(ticket)) return snapshot()
        if (options.finish) {
          // A full-page navigation can unload this controller immediately. The
          // confirmed record must therefore be cleared before opening the page.
          await clearSavedBlankProjectSubmission(dependencies.storage, record, () => { if (!current(ticket)) throw new Error('原恢复记录清理已停止，账户尚未核对完成。') })
          cleared = true
          if (!current(ticket)) return snapshot()
        }
        await dependencies.open(project)
        if (current(ticket)) state = options.finish
          ? { phase: 'idle', pending: null, confirmedProject: null, error: null, busy: true }
          : { ...state, phase: 'confirmed', error: null }
      } catch (error) {
        if (cleared && current(ticket)) {
          try { await writeSavedBlankProjectSubmission(dependencies.storage, record, () => { if (!current(ticket)) throw new Error('当前账户等待已停止，请保留原工程编号。') }) }
          catch (restoreError) { error = new Error(`原工程已创建，但打开或恢复记录保存未完成：${restoreError instanceof Error ? restoreError.message : '请核对工程库'}；原工程编号：${project.id}`) }
        }
        failure(ticket, error)
      } finally { finish(ticket) }
      return snapshot()
    },
    async finishConfirmed(): Promise<BlankProjectCreationState> {
      if (!state.pending || !state.confirmedProject || state.phase !== 'confirmed') throw new Error('原工程尚未确认，不能清理原空白画布创建恢复记录。')
      const record = structuredClone(state.pending)
      const ticket = begin('checking')
      try {
        if (!current(ticket)) return snapshot()
        await clearSavedBlankProjectSubmission(dependencies.storage, record, () => { if (!current(ticket)) throw new Error('原恢复记录清理已停止，账户尚未核对完成。') })
        if (!current(ticket)) return snapshot()
        const remaining = await listSavedBlankProjectSubmissions(dependencies.storage, ownerId)
        if (!current(ticket)) return snapshot()
        state = { phase: remaining.length ? 'unknown' : 'idle', pending: remaining[0] ?? null, confirmedProject: null, error: null, busy: true }
      } catch (error) { failure(ticket, error) } finally { finish(ticket) }
      return snapshot()
    },
    invalidate() {
      revision += 1
      state = { ...state, phase: state.confirmedProject ? 'confirmed' : state.pending ? 'unknown' : 'idle', busy: false }
      notify()
    },
    dispose() { disposed = true; revision += 1; state = { ...state, phase: state.confirmedProject ? 'confirmed' : state.pending ? 'unknown' : 'idle', busy: false }; listeners.clear() },
  }
}
