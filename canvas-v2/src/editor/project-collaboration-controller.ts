import { ProjectCollaborationRequestError, type ProjectCollaborationClient } from '../lib/project-collaboration-client-port'
import { projectCollaborationLimits, type ProjectCollaborationJoinInput, type ProjectCollaborationMutationInput, type ProjectCollaborationReceipt, type ProjectCollaborationSnapshot } from '../lib/project-collaboration-contract'
import { parseProjectCollaborationJoinInput, parseProjectCollaborationMutationInput, projectCollaborationRequestDigest } from '../lib/project-collaboration-values'
import { buildProjectCollaborationChanges, applyProjectCollaborationChanges } from '../lib/project-collaboration-document'
import { parseWorkflowFile, serializeWorkflow } from '../model'
import { createProjectCollaborationJournal, type CollaborationJournalRecord, type CollaborationJournalStorage } from '../persistence/project-collaboration-journal'

export type CollaborationPhase = 'loading' | 'available' | 'viewing' | 'live' | 'busy' | 'unknown' | 'missing' | 'conflict' | 'ended' | 'error'
export interface CanvasCollaborationState {
  phase: CollaborationPhase
  snapshot: ProjectCollaborationSnapshot | null
  pending: CollaborationJournalRecord | null
  pendingCount: number
  pendingRecords?: readonly CollaborationJournalRecord[]
  abandonAllowed?: boolean
  buffering?: boolean
  message: string
  joined: boolean
}
interface ControllerDependencies {
  ownerId: string
  projectId: string
  clientId: string
  client: ProjectCollaborationClient
  storage: CollaborationJournalStorage
  active(): boolean
  getContent(): string
  selectedNodeIds(): string[]
  createOperationId(): string
  onSnapshot(snapshot: ProjectCollaborationSnapshot, projectedContent: string, graphChanged: boolean): void
  changed(state: CanvasCollaborationState): void
}

function meaningful(content: string): string {
  const workflow = parseWorkflowFile(content)
  if (!workflow) throw new Error('协作工作流格式无法核对，当前编辑仍保留。')
  return serializeWorkflow({ ...workflow, viewport: { x: 0, y: 0, zoom: 1 } })
}
function message(error: unknown): string { return error instanceof Error ? error.message : '协作操作暂未确认，请保留当前编辑并核对。' }
const precommitCodes = new Set(['COLLABORATION_FIELD_CONFLICT', 'COLLABORATION_ACTOR_CONFLICT', 'COLLABORATION_UNDO_EXPIRED', 'COLLABORATION_EPOCH_CHANGED', 'COLLABORATION_LEASE_EXPIRED', 'COLLABORATION_EXTERNAL_CHANGE', 'COLLABORATION_ACTIVE', 'COLLABORATION_VERSION_REQUIRED'])

/** This controller is mounted only by the editable workspace, never a source viewer. */
export function createCanvasProjectCollaboration(dependencies: ControllerDependencies) {
  let state: CanvasCollaborationState = { phase: 'loading', snapshot: null, pending: null, pendingRecords: [], pendingCount: 0, message: '', joined: false }
  let clientId = dependencies.clientId
  let retired = false
  let sequence = 0
  let busy = false
  let polling = false
  let heartbeating = false
  let ordinaryAdopted = false
  let editPending = false
  let nextHeadReadAt = 0
  let suppressedSelectionSnapshot: string | null = null
  const rejected = new Map<string, string>()
  const checkedMissing = new Map<string, string>()
  const controller = new AbortController()
  const journal = createProjectCollaborationJournal({
    ownerId: dependencies.ownerId, projectId: dependencies.projectId, storage: dependencies.storage,
    active: () => !retired && dependencies.active(),
    parseRequest: (method, value) => method === 'join' ? parseProjectCollaborationJoinInput(value) : parseProjectCollaborationMutationInput(value),
  })
  function active(): void {
    if (retired || controller.signal.aborted || !dependencies.active()) throw new Error('账号、工程或协作范围已变化，原操作保留，当前等待已停止。')
  }
  function publish(patch: Partial<CanvasCollaborationState>): void {
    active()
    state = { ...state, ...patch }
    dependencies.changed(state)
  }
  function finishBusy(): void { busy = false; editPending = false; if (!retired && dependencies.active()) publish({ buffering: false }) }
  function pendingRecord(): CollaborationJournalRecord | null { return state.pending }
  function readOptions() { return { version: 1 as const, clientId, ...(state.snapshot ? { expectedAccessVersion: state.snapshot.project.access.accessVersion } : {}) } }
  function snapshotReady(): ProjectCollaborationSnapshot {
    const snapshot = state.snapshot
    if (!snapshot || snapshot.projectId !== dependencies.projectId || snapshot.actor.accountId !== dependencies.ownerId) throw new Error('当前协作账号与工程尚未核对。')
    return snapshot
  }
  function adopt(snapshot: ProjectCollaborationSnapshot, submittedContent?: string): void {
    active()
    if (snapshot.projectId !== dependencies.projectId || snapshot.actor.accountId !== dependencies.ownerId) throw new Error('协作快照所属账号或工程不一致。')
    const current = dependencies.getContent()
    let projected = snapshot.content
    if (submittedContent && meaningful(current) !== meaningful(submittedContent)) {
      projected = applyProjectCollaborationChanges(snapshot.content, buildProjectCollaborationChanges(submittedContent, current))
    }
    const changed = meaningful(projected) !== meaningful(current)
    state = { ...state, snapshot }
    dependencies.onSnapshot(snapshot, projected, changed)
  }
  async function assertReceipt(record: CollaborationJournalRecord, receipt: ProjectCollaborationReceipt): Promise<void> {
    journal.assertStored(record)
    const request = journal.request(record)
    const digest = await projectCollaborationRequestDigest(dependencies.projectId, request)
    active(); journal.assertStored(record)
    if (receipt.projectId !== dependencies.projectId || receipt.operationId !== record.operationId || receipt.action !== request.action || receipt.requestDigest !== digest
      || receipt.accessVersion !== request.expectedAccessVersion || receipt.baseProjectVersion !== ('baseProjectVersion' in request ? request.baseProjectVersion : request.expectedProjectVersion)
      || 'epoch' in request && request.epoch !== undefined && request.action !== 'resync' && request.action !== 'join' && request.epoch !== receipt.epoch
      || 'targetOperationId' in request && request.targetOperationId !== receipt.targetOperationId) throw new Error('协作回执与原记录不一致；记录仍保留，未重新提交。')
  }
  function phase(snapshot: ProjectCollaborationSnapshot, joined = state.joined): CollaborationPhase {
    if (snapshot.state === 'ended') return 'ended'
    if (snapshot.state === 'resync-required') return 'conflict'
    return joined && snapshot.state === 'ready' ? 'live' : snapshot.state === 'ready' ? 'viewing' : 'available'
  }
  async function original(): Promise<{ found: boolean; missing: CollaborationJournalRecord[] }> {
    checkedMissing.clear()
    const records = await journal.read()
    const missing: CollaborationJournalRecord[] = []
    const options = readOptions()
    const results = await Promise.all(records.map(async (record) => {
      const result = await dependencies.client.inspect(dependencies.projectId, record.operationId, options, controller.signal)
      active(); journal.assertStored(record)
      return { record, result }
    }))
    const confirmed: CollaborationJournalRecord[] = []
    for (const { record, result } of results) {
      if (result.state === 'missing') missing.push(record)
      else { await assertReceipt(record, result.receipt); confirmed.push(record) }
    }
    if (confirmed.length) {
      const snapshot = await dependencies.client.snapshot(dependencies.projectId, readOptions(), controller.signal)
      active()
      // Recovery never reacquires a lease or adopts old whole-workflow content.
      state = { ...state, snapshot, joined: false }
      for (const record of confirmed) { journal.confirm(record); rejected.delete(record.operationId) }
    }
    if (missing.length) {
      for (const record of missing) { journal.assertStored(record); checkedMissing.set(record.operationId, record.payloadDigest) }
      const selected = missing.find((record) => record.operationId === state.pending?.operationId) ?? missing[0]
      publish({ pending: selected, pendingRecords: missing, pendingCount: missing.length, abandonAllowed: rejected.has(selected.operationId), phase: 'missing', message: missing.length > 1 ? '全部原记录已核对，均未找到回执。可明确选定一条按原编号重试，其余原档继续保留；不会自动发送。' : '服务端未找到原操作。不会自动重发或丢弃原记录；已明确拒绝提交的修改可保留原档后放弃本页重试。' })
    } else {
      const snapshot = snapshotReady()
      publish({ pending: null, pendingRecords: [], pendingCount: 0, abandonAllowed: false, phase: phase(snapshot), message: '已找到原操作。当前保留本地编辑；请明确核对服务器版本后加入协作。' })
    }
    return { found: confirmed.length > 0, missing }
  }
  async function perform(record: CollaborationJournalRecord, submittedContent: string, recovering = false): Promise<ProjectCollaborationSnapshot> {
    const request = journal.request(record)
    journal.assertStored(record)
    // localStorage has no cross-tab compare-and-swap. Keep every competing
    // original, stop locally, and rely on the server actor CAS as final authority.
    const others = (await journal.read()).filter((other) => other.operationId !== record.operationId)
    if (others.some((other) => !recovering || checkedMissing.get(other.operationId) !== other.payloadDigest)) throw new Error('另一个页面仍有原协作操作待核对；已停止发送并保留全部原记录。')
    active(); journal.assertStored(record)
    if (record.method === 'join') {
      if (request.action !== 'join' && request.action !== 'resync') throw new Error('原协作加入记录格式不一致。')
      const result = await dependencies.client.join(dependencies.projectId, request, controller.signal)
      await assertReceipt(record, result.receipt)
      if (recovering) {
        journal.confirm(record)
        state = { ...state, snapshot: result.snapshot, joined: false }
        publish({ pending: null, pendingRecords: [], pendingCount: 0, phase: phase(result.snapshot), message: '原加入操作已确认。本地编辑仍保留，请明确核对服务器版本后加入。' })
        return result.snapshot
      }
      adopt(result.snapshot, submittedContent)
      journal.confirm(record)
      const joined = result.leaseState === 'active'
      publish({ pending: null, pendingRecords: [], pendingCount: 0, joined, phase: joined ? 'live' : phase(result.snapshot, false), message: joined ? '已加入实时协作。' : '原加入操作已确认，但会话已结束；请明确重新加入。' })
      return result.snapshot
    }
    if (request.action === 'join' || request.action === 'resync') throw new Error('原协作修改记录格式不一致。')
    const mutation = parseProjectCollaborationMutationInput(request)
    if (!recovering && state.joined && mutation.action === 'edit') publish({ buffering: true })
    const result = await dependencies.client.mutate(dependencies.projectId, mutation, controller.signal)
    await assertReceipt(record, result.receipt)
    if (recovering) {
      journal.confirm(record)
      state = { ...state, snapshot: result.snapshot, joined: false }
      publish({ pending: null, pendingRecords: [], pendingCount: 0, phase: phase(result.snapshot), message: '原操作已确认。本地编辑仍保留，请明确核对服务器版本后加入。' })
      return result.snapshot
    }
    try { adopt(result.snapshot, submittedContent) }
    catch (error) {
      state = { ...state, snapshot: result.snapshot }
      journal.confirm(record)
      publish({ pending: null, pendingRecords: [], pendingCount: 0, phase: 'conflict', message: `原操作已保存，后续本地编辑仍保留，请核对后继续：${message(error)}` })
      throw error
    }
    journal.confirm(record)
    const joined = request.action !== 'end-epoch' && state.joined && result.snapshot.state === 'ready' && result.snapshot.head?.epoch === request.epoch
    publish({ pending: null, pendingRecords: [], pendingCount: 0, joined, phase: joined ? 'live' : phase(result.snapshot, false), message: request.action === 'end-epoch' ? '本轮协作已结束；各页面保留自己的待处理编辑。' : joined ? '' : '原操作已确认，但当前协作轮次已变化；请保留本地编辑并明确重新核对加入。' })
    return result.snapshot
  }
  async function send(method: 'join' | 'mutate', request: ProjectCollaborationJoinInput | ProjectCollaborationMutationInput, content: string): Promise<ProjectCollaborationSnapshot> {
    active()
    if (busy || state.pending) throw new Error('原协作操作尚未确认，请先核对。')
    const immutable = method === 'join' ? parseProjectCollaborationJoinInput(structuredClone(request)) : parseProjectCollaborationMutationInput(structuredClone(request))
    busy = true
    sequence++
    // Keep the editor mounted while the captured edit's local digest is being
    // calculated. Later input changes the next delta, never this request.
    editPending = method === 'mutate' && immutable.action === 'edit' && state.joined
    publish({ phase: 'busy', buffering: editPending, abandonAllowed: false, message: '正在可靠记录并同步本次修改…' })
    try {
      const record = await journal.prepare(method, immutable)
      active(); publish({ pending: record, pendingRecords: [record], pendingCount: 1 })
      return await perform(record, content)
    } catch (error) {
      const pending = pendingRecord()
      if (pending && error instanceof ProjectCollaborationRequestError && error.outcomeKnown && error.status !== undefined && error.status >= 400 && error.status < 500 && error.code && precommitCodes.has(error.code)) rejected.set(pending.operationId, error.code)
      if (!retired && dependencies.active() && state.phase !== 'conflict') publish({ phase: state.pending ? 'unknown' : 'error', message: message(error) })
      throw error
    } finally { finishBusy() }
  }
  return {
    state: () => state,
    canEdit: () => busy && editPending && state.phase === 'busy' && state.buffering === true && state.joined
      || !busy && !state.pending && (state.phase === 'live' && state.joined || state.phase === 'available' && (ordinaryAdopted || !state.snapshot?.head)),
    needsOperationSave: () => !ordinaryAdopted && (state.phase !== 'available' || Boolean(state.snapshot?.head) || state.joined || Boolean(state.pending)),
    async initialize(): Promise<void> {
      const ticket = ++sequence
      ordinaryAdopted = false
      publish({ phase: 'loading', abandonAllowed: false })
      try {
        const records = await journal.read()
        const snapshot = await dependencies.client.snapshot(dependencies.projectId, { version: 1 }, controller.signal)
        active(); if (ticket !== sequence) return
        state = { ...state, snapshot, pending: records[0] ?? null, pendingRecords: records, pendingCount: records.length, joined: false }
        if (records[0]) { clientId = journal.request(records[0]).clientId; publish({ phase: 'unknown' }); await original() }
        else publish({ phase: phase(snapshot), message: snapshot.state === 'ready' ? '此项目正在实时协作，请明确加入后编辑；当前没有自动保存或运行。' : '' })
      } catch (error) { if (!retired && dependencies.active()) publish({ phase: 'error', message: message(error) }) }
    },
    async join(resync = false): Promise<ProjectCollaborationSnapshot> {
      if (busy || state.pending || state.joined) throw new Error('当前协作仍有原操作或已加入，请先核对当前状态。')
      snapshotReady()
      const visible = dependencies.getContent()
      let snapshot: ProjectCollaborationSnapshot
      let waitingForOwner = false
      busy = true; sequence++; publish({ phase: 'busy', buffering: false, message: '正在核对当前协作轮次…' })
      try {
        snapshot = await dependencies.client.snapshot(dependencies.projectId, readOptions(), controller.signal)
        active()
        state = { ...state, snapshot, joined: false }
        if (meaningful(dependencies.getContent()) !== meaningful(visible) || meaningful(visible) !== meaningful(snapshot.content)) {
          publish({ phase: 'conflict', message: '服务器图或当前编辑已变化，当前可见稿仍保留；请先导出保留并明确采用服务器版本，再加入。' })
          throw new Error('当前可见内容与服务器不同，未提交加入操作；不会整图覆盖队友。')
        }
        if (!snapshot.canJoin) {
          publish({ phase: 'conflict', message: '当前共享编辑权限不可用，请保留本地稿并核对共享设置。' })
          throw new Error('当前共享编辑权限不可用，未提交加入操作。')
        }
        if (snapshot.project.access.mode !== 'owner' && snapshot.state !== 'ready') {
          waitingForOwner = true
          publish({ phase: phase(snapshot, false), message: '请等待项目所有者开启新的协作轮次；本页只核对状态，不会自动加入。' })
          throw new Error('请等待项目所有者开启协作，尚未提交加入操作。')
        }
        adopt(snapshot, visible)
        publish({ phase: phase(snapshot, false), message: '' })
      } catch (error) {
        if (!waitingForOwner && !retired && dependencies.active() && state.phase !== 'conflict') publish({ phase: 'error', message: message(error) })
        throw error
      } finally { finishBusy() }
      ordinaryAdopted = false
      // A new explicit join must not revive an issued, expired or left lease.
      // Recovery retries keep the clientId frozen in their original record.
      clientId = dependencies.createOperationId()
      suppressedSelectionSnapshot = null
      return send('join', { version: 1, action: resync ? 'resync' : 'join', operationId: dependencies.createOperationId(), clientId, expectedAccessVersion: snapshot.project.access.accessVersion,
        expectedProjectVersion: snapshot.project.version, contentDigest: snapshot.contentDigest, ...(snapshot.head ? { epoch: snapshot.head.epoch } : {}) }, dependencies.getContent())
    },
    async flush(content: string): Promise<ProjectCollaborationSnapshot> {
      const snapshot = snapshotReady()
      if (!state.joined || state.phase !== 'live' || !snapshot.head || snapshot.state !== 'ready') throw new Error('当前未加入可写协作，原编辑保留；不会改用整图保存。')
      if (meaningful(content) !== meaningful(dependencies.getContent())) throw new Error('保存内容已变化，请核对当前编辑后重试。')
      const changes = buildProjectCollaborationChanges(snapshot.content, content)
      if (!changes.length) {
        busy = true; sequence++; publish({ phase: 'busy', message: '正在核对服务器实际保存版本…' })
        try {
          const actual = await dependencies.client.snapshot(dependencies.projectId, readOptions(), controller.signal)
          active(); adopt(actual, content)
          publish({ phase: phase(actual), message: '' })
          return actual
        } catch (error) { if (!retired && dependencies.active()) publish({ phase: 'conflict', message: message(error) }); throw error }
        finally { finishBusy() }
      }
      return send('mutate', { version: 1, action: 'edit', operationId: dependencies.createOperationId(), clientId, epoch: snapshot.head.epoch, expectedAccessVersion: snapshot.project.access.accessVersion,
        baseProjectVersion: snapshot.project.version, expectedActorSequence: snapshot.history.actorSequence, changes }, content)
    },
    async history(action: 'undo' | 'redo'): Promise<void> {
      const snapshot = snapshotReady(), tip = snapshot.history[action]
      if (!state.joined || state.phase !== 'live' || !snapshot.head || !tip) throw new Error('当前没有可安全执行的本人协作撤销或重做。')
      if (buildProjectCollaborationChanges(snapshot.content, dependencies.getContent()).length) throw new Error('请先同步当前修改，再撤销本人操作。')
      await send('mutate', { version: 1, action, operationId: dependencies.createOperationId(), clientId, epoch: snapshot.head.epoch, expectedAccessVersion: snapshot.project.access.accessVersion,
        baseProjectVersion: snapshot.project.version, expectedActorSequence: snapshot.history.actorSequence, targetOperationId: tip.operationId }, dependencies.getContent())
    },
    async rename(name: string): Promise<ProjectCollaborationSnapshot> {
      const snapshot = snapshotReady()
      if (!state.joined || state.phase !== 'live' || snapshot.project.access.mode !== 'owner' || !snapshot.head) throw new Error('请由项目所有者在已加入的协作中修改名称。')
      if (buildProjectCollaborationChanges(snapshot.content, dependencies.getContent()).length) throw new Error('请先同步当前编辑，再修改工程名称。')
      const workflow = parseWorkflowFile(snapshot.content)
      if (!workflow) throw new Error('当前协作工程格式暂不可核对。')
      const content = serializeWorkflow({ ...workflow, name })
      const changes = buildProjectCollaborationChanges(snapshot.content, content)
      if (!changes.length) return snapshot
      return send('mutate', { version: 1, action: 'edit', operationId: dependencies.createOperationId(), clientId, epoch: snapshot.head.epoch, expectedAccessVersion: snapshot.project.access.accessVersion,
        baseProjectVersion: snapshot.project.version, expectedActorSequence: snapshot.history.actorSequence, changes }, snapshot.content)
    },
    async inspectOriginal(): Promise<void> {
      if (busy) return
      busy = true
      try { await original() }
      catch (error) { if (!retired && dependencies.active()) publish({ phase: 'unknown', message: message(error) }); throw error }
      finally { finishBusy() }
    },
    async retryOriginal(operationId = state.pending?.operationId): Promise<void> {
      if (busy || state.phase !== 'missing' || !state.pending) throw new Error('请先核对原操作确实不存在。')
      busy = true
      const selected = state.pendingRecords?.find((record) => record.operationId === operationId) ?? (state.pending.operationId === operationId ? state.pending : null)
      if (!selected) { finishBusy(); throw new Error('请明确选择一条已核对的原操作。') }
      let record = selected
      try {
        publish({ phase: 'busy', buffering: false, abandonAllowed: false })
        const checked = await original()
        if (checked.found) return
        const verified = checked.missing.find((item) => item.operationId === selected.operationId && item.payloadDigest === selected.payloadDigest && item.requestJson === selected.requestJson)
        if (!verified) throw new Error('所选原操作已变化或已有回执，请按当前核对结果继续。')
        record = verified
        publish({ phase: 'busy', pending: record, message: '仅发送明确选定的这条原操作，其余原记录保持冻结。' })
        await perform(record, dependencies.getContent(), true)
        publish({ phase: 'busy', message: '所选原操作已确认，正在核对其余原记录…' })
        await original()
      }
      catch (error) {
        if (error instanceof ProjectCollaborationRequestError && error.outcomeKnown && error.status !== undefined && error.status >= 400 && error.status < 500 && error.code && precommitCodes.has(error.code)) rejected.set(record.operationId, error.code)
        if (!retired && dependencies.active()) publish({ phase: 'unknown', abandonAllowed: false, message: message(error) }); throw error
      }
      finally { finishBusy() }
    },
    async abandonRejected(): Promise<void> {
      const record = state.pending
      if (busy || !record || state.phase !== 'missing' || !state.abandonAllowed || !rejected.has(record.operationId)) throw new Error('原操作尚不能确认未提交，不能放弃或清除记录。')
      busy = true
      try {
        const result = await dependencies.client.inspect(dependencies.projectId, record.operationId, readOptions(), controller.signal)
        active(); journal.assertStored(record)
        if (result.state === 'found') { await original(); return }
        journal.archiveRejected(record)
        if ((await journal.read()).length) {
          publish({ phase: 'busy', buffering: false, abandonAllowed: false, message: '已保留所选被拒绝操作的原档，正在核对其余原记录…' })
          await original()
        } else publish({ pending: null, pendingRecords: [], pendingCount: 0, abandonAllowed: false, joined: false, phase: 'conflict', message: '已保留这条被拒绝操作的完整原档并停止本页重试。本地稿未丢弃；请导出保留后明确采用服务器版本，再加入协作。' })
      } finally { finishBusy() }
    },
    async useServerVersion(): Promise<void> {
      if (busy || state.pending) throw new Error('原操作仍待核对，当前不会替换本地编辑。')
      const snapshot = await dependencies.client.snapshot(dependencies.projectId, { version: 1 }, controller.signal)
      active(); adopt(snapshot, dependencies.getContent())
      ordinaryAdopted = snapshot.state === 'ended' || !snapshot.canJoin && snapshot.project.access.mode === 'owner'
      publish({ joined: false, phase: ordinaryAdopted ? 'available' : phase(snapshot, false), message: ordinaryAdopted ? '已明确采用服务器版本，当前按普通保存编辑；如有人重新开启协作，保存会停止并重新核对。' : '已明确采用服务器版本；编辑协作仍需明确加入。' })
    },
    async tick(): Promise<void> {
      if (ordinaryAdopted || busy || polling || state.pending || !state.snapshot || !['ready', 'not-started', 'ended'].includes(state.snapshot.state) || ['conflict', 'error'].includes(state.phase)) return
      const before = state.snapshot
      const ticket = sequence
      polling = true
      try {
        if (buildProjectCollaborationChanges(before.content, dependencies.getContent()).length) return
        if (!before.head || before.state !== 'ready') {
          if (Date.now() < nextHeadReadAt) return
          nextHeadReadAt = Date.now() + 4_000
          const snapshot = await dependencies.client.snapshot(dependencies.projectId, readOptions(), controller.signal)
          active()
          if (busy || ticket !== sequence || state.snapshot !== before || buildProjectCollaborationChanges(before.content, dependencies.getContent()).length) return
          if (snapshot.state !== before.state || snapshot.contentDigest !== before.contentDigest || snapshot.project.version !== before.project.version || snapshot.canJoin !== before.canJoin || snapshot.head?.epoch !== before.head?.epoch) {
            adopt(snapshot)
            publish({ phase: phase(snapshot) })
          }
          return
        }
        const feed = await dependencies.client.feed(dependencies.projectId, { version: 1, ...(state.joined ? { clientId } : {}), epoch: before.head!.epoch,
          expectedAccessVersion: before.project.access.accessVersion, afterSequence: before.head!.sequence, afterProjectVersion: before.project.version }, controller.signal)
        active(); if (busy || ticket !== sequence || state.snapshot !== before) return
        if (feed.state === 'resync-required') { publish({ joined: false, phase: 'conflict', message: '协作版本或权限范围已变化，请保留本地编辑并明确重新核对；不会自动重放。' }); return }
        if (!feed.events.length) {
          if (JSON.stringify([before.history, before.presence]) !== JSON.stringify([feed.history, feed.presence])) publish({ snapshot: { ...before, history: feed.history, presence: feed.presence } })
          return
        }
        const snapshot = await dependencies.client.snapshot(dependencies.projectId, readOptions(), controller.signal)
        active(); if (busy || ticket !== sequence || state.snapshot !== before || buildProjectCollaborationChanges(before.content, dependencies.getContent()).length) return
        adopt(snapshot)
        publish({ phase: phase(snapshot) })
      } catch (error) { if (!retired && dependencies.active()) publish({ joined: false, phase: 'error', message: message(error) }) }
      finally { polling = false }
    },
    async heartbeat(): Promise<void> {
      if (busy || heartbeating || !state.joined || !state.snapshot?.head || state.phase !== 'live') return
      const snapshot = state.snapshot, head = state.snapshot.head, heartbeatClient = clientId, ticket = sequence
      const selectionSnapshot = `${head.epoch}:${snapshot.contentDigest}`
      heartbeating = true
      try {
        const workflow = parseWorkflowFile(snapshot.content)
        if (!workflow) throw new Error('已确认协作图无法读取，当前在线选择未发送。')
        const confirmedIds = new Set(workflow.nodes.map(node => node.id))
        const selectedNodeIds = suppressedSelectionSnapshot === selectionSnapshot ? [] : [...new Set(dependencies.selectedNodeIds())].filter(id => confirmedIds.has(id)).slice(0, projectCollaborationLimits.selectedNodes)
        await dependencies.client.presence(dependencies.projectId, { version: 1, action: 'heartbeat', clientId: heartbeatClient, epoch: head.epoch,
          expectedAccessVersion: snapshot.project.access.accessVersion, selectedNodeIds }, controller.signal)
        active()
      } catch (error) {
        if (!retired && dependencies.active()) {
          if (error instanceof ProjectCollaborationRequestError && error.outcomeKnown && error.status === 400 && error.code === 'COLLABORATION_SELECTION_STALE') {
            // Teammates may delete a confirmed node before this advisory POST.
            // Keep the lease scope strict; omit selection until a new graph is
            // confirmed, and never resend the rejected presence immediately.
            if (ticket === sequence && clientId === heartbeatClient && state.snapshot?.head?.epoch === head.epoch && state.snapshot.contentDigest === snapshot.contentDigest) suppressedSelectionSnapshot = selectionSnapshot
          } else publish({ joined: false, phase: 'error', message: message(error) })
        }
      }
      finally { heartbeating = false }
    },
    async leave(): Promise<void> {
      const snapshot = snapshotReady()
      if (busy || state.pending || !snapshot.head) throw new Error('请先核对原协作操作，再离开。')
      await dependencies.client.presence(dependencies.projectId, { version: 1, action: 'leave', clientId, epoch: snapshot.head.epoch, expectedAccessVersion: snapshot.project.access.accessVersion, selectedNodeIds: [] }, controller.signal)
      active(); publish({ joined: false, phase: 'viewing', message: '已离开本次编辑会话，当前本地编辑仍保留。' })
    },
    async endEpoch(): Promise<void> {
      const snapshot = snapshotReady()
      if (snapshot.project.access.mode !== 'owner' || !snapshot.head) throw new Error('只有项目所有者可以明确结束协作。')
      await send('mutate', { version: 1, action: 'end-epoch', operationId: dependencies.createOperationId(), clientId, epoch: snapshot.head.epoch,
        expectedAccessVersion: snapshot.project.access.accessVersion, baseProjectVersion: snapshot.project.version, expectedActorSequence: snapshot.history.actorSequence }, snapshot.content)
    },
    dispose(): void { retired = true; sequence++; controller.abort() },
  }
}
export type CanvasProjectCollaboration = ReturnType<typeof createCanvasProjectCollaboration>
