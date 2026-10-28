import { describe, expect, it, vi } from 'vitest'
import { ProjectCollaborationRequestError, type ProjectCollaborationClient } from '../lib/project-collaboration-client-port'
import type { ProjectCollaborationJoinInput, ProjectCollaborationMutationInput, ProjectCollaborationReceipt, ProjectCollaborationSnapshot } from '../lib/project-collaboration-contract'
import { applyProjectCollaborationChanges, buildProjectCollaborationChanges } from '../lib/project-collaboration-document'
import { projectCollaborationContentDigest, projectCollaborationRequestDigest } from '../lib/project-collaboration-values'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { createCanvasProjectCollaboration } from './project-collaboration-controller'
import { createProjectCollaborationJournal } from '../persistence/project-collaboration-journal'
import { parseProjectCollaborationMutationInput } from '../lib/project-collaboration-values'

const ownerId = '11111111-1111-4111-8111-111111111111', projectId = '22222222-2222-4222-8222-222222222222'
const clientId = '33333333-3333-4333-8333-333333333333', epoch = '44444444-4444-4444-8444-444444444444'
const at = '2026-10-24T00:00:00.000Z'
class Storage {
  data = new Map<string, string>()
  writes = 0
  removes = 0
  get length() { return this.data.size }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.writes++; this.data.set(key, value) }
  removeItem(key: string) { this.removes++; this.data.delete(key) }
}
function workflow() {
  const value = createEmptyWorkflow('Shared project')
  value.nodes = ['a', 'b'].map((id) => ({ id, kind: id === 'b' ? 'text-generate' : 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: id, model: '', status: 'idle' } }))
  return value
}
async function fixture(storage = new Storage()) {
  let content = serializeWorkflow(workflow()), local = content, active = true, id = 0, selected = ['a']
  let snapshot: ProjectCollaborationSnapshot = {
    version: 1, projectId, state: 'ready', canJoin: true, content, contentDigest: await projectCollaborationContentDigest(content),
    project: { id: projectId, name: 'Shared project', version: 3, createdAt: at, updatedAt: at, lastOpenedAt: at, nodeCount: 2, assetCount: 0, workspaceConfigured: false, workspaceStatus: 'missing', access: { projectId, projectVersion: 3, mode: 'owner', accessVersion: 2, canEdit: true, canRun: true, canExport: true, canManageShare: true, canRestore: true, teamId: '77777777-7777-4777-8777-777777777777' } },
    actor: { accountId: ownerId, displayName: 'Synthetic owner' }, head: { version: 1, epoch, sequence: 0, baselineProjectVersion: 3, projectVersion: 3 }, history: { actorSequence: 0 }, presence: [],
  }
  const receipts = new Map<string, ProjectCollaborationReceipt>()
  async function receipt(input: ProjectCollaborationJoinInput | ProjectCollaborationMutationInput): Promise<ProjectCollaborationReceipt> {
    return { version: 1, projectId, operationId: input.operationId, requestDigest: await projectCollaborationRequestDigest(projectId, input), action: input.action,
      epoch, sequence: snapshot.head!.sequence, accessVersion: 2, baseProjectVersion: 'baseProjectVersion' in input ? input.baseProjectVersion : input.expectedProjectVersion,
      previousProjectVersion: snapshot.project.version, projectVersion: snapshot.project.version, contentDigest: snapshot.contentDigest,
      ...('targetOperationId' in input ? { targetOperationId: input.targetOperationId } : {}) }
  }
  const client: ProjectCollaborationClient = {
    snapshot: vi.fn<ProjectCollaborationClient['snapshot']>(async () => structuredClone(snapshot)),
    join: vi.fn<ProjectCollaborationClient['join']>(async (_id, input) => {
      const value = await receipt(input); receipts.set(input.operationId, value)
      return { version: 1, receipt: value, snapshot: structuredClone(snapshot), clientId: input.clientId, leaseState: 'active', expiresAt: '2099-01-01T00:00:00.000Z' }
    }),
    mutate: vi.fn<ProjectCollaborationClient['mutate']>(async (_id, input) => {
      const previous = snapshot.project.version
      if (input.action === 'edit') content = applyProjectCollaborationChanges(snapshot.content, input.changes)
      const version = input.action === 'end-epoch' ? previous : previous + 1
      snapshot = { ...snapshot, state: input.action === 'end-epoch' ? 'ended' : snapshot.state, content, contentDigest: await projectCollaborationContentDigest(content), project: { ...snapshot.project, version }, head: { ...snapshot.head!, sequence: snapshot.head!.sequence + 1, projectVersion: version, ...(input.action === 'end-epoch' ? { endedAt: at } : {}) }, history: { actorSequence: snapshot.history.actorSequence + 1, undo: { operationId: input.operationId, projectVersion: version } } }
      const value = { ...await receipt(input), previousProjectVersion: previous }; receipts.set(input.operationId, value)
      return { version: 1, receipt: value, snapshot: structuredClone(snapshot) }
    }),
    inspect: vi.fn<ProjectCollaborationClient['inspect']>(async (_id, operationId) => {
      const value = receipts.get(operationId)
      return value ? { version: 1, state: 'found', receipt: value, payloadState: 'compacted' } : { version: 1, state: 'missing' }
    }),
    feed: vi.fn<ProjectCollaborationClient['feed']>(async () => ({ version: 1, state: 'events', projectId, epoch, events: [], sequence: snapshot.head!.sequence, projectVersion: snapshot.project.version, hasMore: false, history: snapshot.history, presence: snapshot.presence })),
    presence: vi.fn<ProjectCollaborationClient['presence']>(async () => ({ version: 1, state: 'active', expiresAt: '2099-01-01T00:00:00.000Z' })),
  }
  const changed = vi.fn(), projected = vi.fn((_snapshot: ProjectCollaborationSnapshot, next: string, _graphChanged: boolean) => { local = next })
  function create() {
    return createCanvasProjectCollaboration({ ownerId, projectId, clientId, client, storage, active: () => active, getContent: () => local, selectedNodeIds: () => selected,
      createOperationId: () => `55555555-5555-4555-8555-${String(++id).padStart(12, '0')}`, onSnapshot: projected, changed })
  }
  return { client, storage, create, projected, changed, receipts, get local() { return local }, set local(value: string) { local = value }, get selected() { return selected }, set selected(value: string[]) { selected = value }, get snapshot() { return snapshot }, set snapshot(value: ProjectCollaborationSnapshot) { snapshot = value; content = value.content }, invalidate() { active = false } }
}

async function competingOriginals() {
  const first = new Storage(), second = new Storage(), base = serializeWorkflow(workflow())
  const ids = ['88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999']
  for (const [index, storage] of [first, second].entries()) {
    const next = parseWorkflowFile(base)!; next.nodes[0].data.prompt = `Original ${index + 1}`
    const journal = createProjectCollaborationJournal({ ownerId, projectId, storage, active: () => true, now: () => index + 1,
      parseRequest: (_method, raw) => parseProjectCollaborationMutationInput(raw) })
    await journal.prepare('mutate', { version: 1, operationId: ids[index], clientId, epoch, expectedAccessVersion: 2, baseProjectVersion: 3, expectedActorSequence: 0,
      action: 'edit', changes: buildProjectCollaborationChanges(base, serializeWorkflow(next)) })
  }
  // Two tabs can both pass a read-before-write check. Distinct original keys
  // survive; this fixture never pretends localStorage supplies a global CAS.
  for (const [key, raw] of second.data) first.data.set(key, raw)
  return { storage: first, ids }
}

describe('explicit collaboration controller protocol', () => {
  it('advertises a newly selected node only after its typed addition has been acknowledged', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    vi.mocked(f.client.presence).mockImplementation(async (_id, input) => {
      const confirmed = new Set(parseWorkflowFile(f.snapshot.content)!.nodes.map(node => node.id))
      if (input.selectedNodeIds.some(id => !confirmed.has(id))) throw new ProjectCollaborationRequestError('在线选择包含已不存在的节点', 400, true, 'COLLABORATION_INVALID')
      return { version: 1, state: 'active', expiresAt: '2099-01-01T00:00:00.000Z' }
    })
    const next = parseWorkflowFile(f.local)!
    next.nodes.push({ id: 'new-local-node', kind: 'text-generate', position: { x: 50, y: 100 }, data: { prompt: 'Not yet saved', model: '', status: 'idle' } })
    f.local = serializeWorkflow(next); f.selected = ['new-local-node']
    await target.heartbeat()
    expect(vi.mocked(f.client.presence).mock.calls[0][1].selectedNodeIds).toEqual([])
    expect(target.state().joined).toBe(true)
    expect(target.state().phase).toBe('live')
    expect(f.client.mutate).not.toHaveBeenCalled()
    await target.flush(f.local); await target.heartbeat()
    expect(vi.mocked(f.client.presence).mock.calls[1][1].selectedNodeIds).toEqual(['new-local-node'])
    expect(f.client.mutate).toHaveBeenCalledOnce()
  })
  it('omits stale advisory selection after a teammate deletion race without freezing editing or immediately retrying', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    f.selected = ['b']
    vi.mocked(f.client.presence).mockRejectedValueOnce(new ProjectCollaborationRequestError('在线选择包含已不存在的节点', 400, true, 'COLLABORATION_SELECTION_STALE'))
    await target.heartbeat()
    expect(f.client.presence).toHaveBeenCalledOnce()
    expect(target.state().phase).toBe('live'); expect(target.state().joined).toBe(true); expect(target.canEdit()).toBe(true)
    await target.heartbeat()
    expect(vi.mocked(f.client.presence).mock.calls[1][1].selectedNodeIds).toEqual([])
    const before = f.snapshot.content, next = parseWorkflowFile(before)!
    next.nodes = next.nodes.filter(node => node.id !== 'b')
    f.snapshot = { ...f.snapshot, content: serializeWorkflow(next), contentDigest: await projectCollaborationContentDigest(serializeWorkflow(next)), project: { ...f.snapshot.project, version: 4 }, head: { ...f.snapshot.head!, sequence: 1, projectVersion: 4 } }
    vi.mocked(f.client.feed).mockResolvedValueOnce({ version: 1, state: 'events', projectId, epoch, sequence: 1, projectVersion: 4, hasMore: false, history: { actorSequence: 0 }, presence: [], events: [{ version: 1, actor: { accountId: clientId }, changes: buildProjectCollaborationChanges(before, f.snapshot.content), createdAt: at, receipt: { version: 1, projectId, operationId: clientId, requestDigest: 'a'.repeat(64), action: 'edit', epoch, sequence: 1, accessVersion: 2, previousProjectVersion: 3, projectVersion: 4, baseProjectVersion: 3, contentDigest: f.snapshot.contentDigest } }] })
    await target.tick(); f.selected = ['b', 'a']; await target.heartbeat()
    expect(vi.mocked(f.client.presence).mock.calls[2][1].selectedNodeIds).toEqual(['a'])
    expect(target.state().joined).toBe(true)
    expect(f.client.mutate).not.toHaveBeenCalled()
  })
  it('discards an old advisory reply after leaving and explicitly joining with a fresh client', async () => {
    const f = await fixture(), target = f.create(); await target.initialize(); await target.join()
    let reject: (error: unknown) => void = () => undefined
    vi.mocked(f.client.presence).mockImplementationOnce(async () => new Promise((_resolve, failed) => { reject = failed }))
    const oldHeartbeat = target.heartbeat(), oldClient = vi.mocked(f.client.presence).mock.calls[0][1].clientId
    await target.leave(); await target.join()
    const newClient = vi.mocked(f.client.join).mock.calls.at(-1)![1].clientId
    expect(newClient).not.toBe(oldClient)
    reject(new ProjectCollaborationRequestError('在线选择已过期', 400, true, 'COLLABORATION_SELECTION_STALE'))
    await oldHeartbeat; await target.heartbeat()
    expect(target.state().phase).toBe('live'); expect(target.state().joined).toBe(true)
    expect(vi.mocked(f.client.presence).mock.calls.at(-1)![1]).toMatchObject({ clientId: newClient, selectedNodeIds: ['a'] })
  })
  it.each([
    [400, 'COLLABORATION_INVALID_CONTEXT'], [409, 'COLLABORATION_LEASE_EXPIRED'], [403, 'COLLABORATION_ACCESS_DENIED'], [409, 'COLLABORATION_AUTHORITY_CHANGED'],
  ])('keeps non-advisory heartbeat refusal %s %s blocking instead of reopening authority', async (status, code) => {
    const f = await fixture(), target = f.create(); await target.initialize(); await target.join()
    vi.mocked(f.client.presence).mockRejectedValueOnce(new ProjectCollaborationRequestError('原权限或页面会话不可继续', Number(status), true, String(code)))
    await target.heartbeat()
    expect(target.state().joined).toBe(false); expect(target.state().phase).toBe('error'); expect(target.canEdit()).toBe(false)
    await target.heartbeat(); expect(f.client.presence).toHaveBeenCalledOnce()
  })
  it('GET-polls a waiting shared page until the owner creates a head without automatically joining', async () => {
    const f = await fixture()
    f.snapshot = { ...f.snapshot, state: 'not-started', head: undefined }
    const target = f.create(); await target.initialize()
    expect(target.state().phase).toBe('available')
    f.snapshot = { ...f.snapshot, state: 'ready', head: { version: 1, epoch, sequence: 0, baselineProjectVersion: 3, projectVersion: 3 } }
    await target.tick()
    expect(target.state().phase).toBe('viewing')
    expect(target.state().snapshot?.head?.epoch).toBe(epoch)
    expect(f.client.join).not.toHaveBeenCalled(); expect(f.client.mutate).not.toHaveBeenCalled(); expect(f.client.presence).not.toHaveBeenCalled()
    expect(f.projected.mock.calls[0][2]).toBe(false)
  })

  it('refreshes a stale head immediately before explicit join and sends the actual existing epoch', async () => {
    const f = await fixture()
    f.snapshot = { ...f.snapshot, state: 'not-started', head: undefined }
    const target = f.create(); await target.initialize()
    f.snapshot = { ...f.snapshot, state: 'ready', head: { version: 1, epoch, sequence: 0, baselineProjectVersion: 3, projectVersion: 3 } }
    await target.join()
    expect(f.client.snapshot).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.client.join).mock.calls[0][1].epoch).toBe(epoch)
    expect(target.state().joined).toBe(true)
  })

  it('keeps a member waiting for the owner without creating a rejected join journal', async () => {
    const f = await fixture()
    f.snapshot = { ...f.snapshot, state: 'not-started', head: undefined, project: { ...f.snapshot.project, access: { ...f.snapshot.project.access, mode: 'edit', canRun: false } } }
    const target = f.create(); await target.initialize()
    await expect(target.join()).rejects.toThrow('等待项目所有者')
    expect(target.state().phase).toBe('available')
    expect(f.storage.writes).toBe(0)
    expect(f.client.join).not.toHaveBeenCalled()
  })

  it('keeps a visibly stale graph and creates no join journal when the fresh join snapshot differs', async () => {
    const f = await fixture(), target = f.create(); await target.initialize()
    const visible = f.local, remote = parseWorkflowFile(f.snapshot.content)!
    remote.nodes[0].data.prompt = 'Owner changed before join'
    const content = serializeWorkflow(remote)
    f.snapshot = { ...f.snapshot, content, contentDigest: await projectCollaborationContentDigest(content), project: { ...f.snapshot.project, version: 4 }, head: { ...f.snapshot.head!, projectVersion: 4, sequence: 1 } }
    await expect(target.join()).rejects.toThrow('当前可见内容与服务器不同')
    expect(target.state().phase).toBe('conflict')
    expect(f.local).toBe(visible)
    expect(f.storage.writes).toBe(0)
    expect(f.client.join).not.toHaveBeenCalled()
  })
  it('GET-recovers every competing original and sends only the one explicitly selected after a fresh all-missing check', async () => {
    const { storage, ids } = await competingOriginals(), before = [...storage.data]
    const f = await fixture(storage), target = f.create()
    await target.initialize()
    expect(f.client.inspect).toHaveBeenCalledTimes(2)
    expect(f.client.mutate).not.toHaveBeenCalled()
    expect(target.state().pendingCount).toBe(2)
    expect([...storage.data]).toEqual(before)
    await target.retryOriginal(ids[1])
    expect(f.client.mutate).toHaveBeenCalledOnce()
    expect(vi.mocked(f.client.mutate).mock.calls[0][1].operationId).toBe(ids[1])
    expect(f.client.join).not.toHaveBeenCalled(); expect(f.client.presence).not.toHaveBeenCalled()
    expect([...storage.data]).toEqual([before[0]])
    expect(target.state().pending?.operationId).toBe(ids[0])
    expect(target.state().phase).toBe('missing')
  })

  it('recovers a found competing receipt and does not send the selected missing request on that click', async () => {
    const { storage, ids } = await competingOriginals(), f = await fixture(storage), target = f.create()
    await target.initialize()
    const first = JSON.parse([...storage.data.values()][0])
    await vi.mocked(f.client.mutate).getMockImplementation()!(projectId, JSON.parse(first.requestJson))
    await target.retryOriginal(ids[1])
    expect(f.client.mutate).not.toHaveBeenCalled()
    expect(target.state().pending?.operationId).toBe(ids[1])
    expect(storage.length).toBe(1)
  })
  it('refreshes using only GET and does not join, heartbeat, mutate or project on an empty feed', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize()
    expect(target.state().phase).toBe('viewing')
    await target.tick(); await target.heartbeat()
    expect(f.client.snapshot).toHaveBeenCalledOnce()
    expect(f.client.join).not.toHaveBeenCalled(); expect(f.client.mutate).not.toHaveBeenCalled(); expect(f.client.presence).not.toHaveBeenCalled()
    expect(f.projected).not.toHaveBeenCalled()
    await target.join()
    f.projected.mockClear()
    await target.tick()
    expect(f.projected).not.toHaveBeenCalled()
    expect(target.state().joined).toBe(true)
  })

  it('flushes typed differences and returns the real canonical acknowledged project', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const next = parseWorkflowFile(f.local)!
    next.nodes[0].data.prompt = 'Owner edit'; f.local = serializeWorkflow(next)
    const confirmed = await target.flush(f.local)
    const input = vi.mocked(f.client.mutate).mock.calls[0][1]
    expect(input.action).toBe('edit')
    expect('changes' in input && input.changes).toEqual(buildProjectCollaborationChanges(serializeWorkflow(workflow()), f.local))
    expect(confirmed.project.version).toBe(4)
    expect(confirmed.content).toBe(f.snapshot.content)
    expect(f.storage.length).toBe(0)
  })

  it('confirms an old mutation receipt without acquiring the newer current epoch lease', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const real = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => {
      const result = await real(...args)
      const current = { ...result.snapshot, head: { ...result.snapshot.head!, epoch: '66666666-6666-4666-8666-666666666666', baselineProjectVersion: result.snapshot.project.version } }
      f.snapshot = current
      return { ...result, snapshot: current }
    })
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Original epoch edit'; f.local = serializeWorkflow(next)
    await target.flush(f.local)
    expect(target.state().phase).toBe('viewing')
    expect(target.state().joined).toBe(false)
    expect(target.canEdit()).toBe(false)
    expect(f.storage.length).toBe(0)
    await target.heartbeat()
    expect(f.client.presence).not.toHaveBeenCalled()
    await expect(target.flush(f.local)).rejects.toThrow('未加入可写协作')
    expect(f.client.mutate).toHaveBeenCalledOnce()
  })

  it('accepts a server-created new epoch for an explicitly requested ended-epoch join', async () => {
    const f = await fixture()
    f.snapshot = { ...f.snapshot, state: 'ended', head: { ...f.snapshot.head!, endedAt: at } }
    const target = f.create(); await target.initialize()
    const real = vi.mocked(f.client.join).getMockImplementation()!
    vi.mocked(f.client.join).mockImplementationOnce(async (...args) => {
      const result = await real(...args), newEpoch = '66666666-6666-4666-8666-666666666666'
      const head = { ...result.snapshot.head!, epoch: newEpoch }; delete head.endedAt
      f.snapshot = { ...result.snapshot, state: 'ready', head }
      return { ...result, receipt: { ...result.receipt, epoch: newEpoch }, snapshot: f.snapshot }
    })
    await target.join()
    expect(vi.mocked(f.client.join).mock.calls[0][1].epoch).toBe(epoch)
    expect(target.state().joined).toBe(true)
    expect(target.state().snapshot?.head?.epoch).not.toBe(epoch)
    expect(f.storage.length).toBe(0)
  })

  it('keeps an unknown original through refresh and recovers its compacted receipt without rejoining or reposting', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const real = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => { await real(...args); throw new Error('Synthetic lost reply') })
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Original edit'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow()
    expect(target.state().pending).not.toBeNull()
    const pending = target.state().pending!, bytes = [...f.storage.data]
    expect(pending.operationId).toMatch(/^55555555/)
    target.dispose()
    const posts = vi.mocked(f.client.mutate).mock.calls.length, joins = vi.mocked(f.client.join).mock.calls.length
    const restored = f.create(); await restored.initialize()
    expect(vi.mocked(f.client.mutate).mock.calls.length).toBe(posts)
    expect(vi.mocked(f.client.join).mock.calls.length).toBe(joins)
    expect(f.client.presence).not.toHaveBeenCalled()
    expect(restored.state().joined).toBe(false)
    expect(f.storage.length).toBe(0)
    expect(bytes).toHaveLength(1)
  })

  it('uses a fresh client for an explicit join after GET-only recovery of an expired original client', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const oldClient = vi.mocked(f.client.join).mock.calls[0][1].clientId
    const mutate = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => { await mutate(...args); throw new Error('Synthetic lost reply') })
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Recover the original'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow()
    expect(JSON.parse(target.state().pending!.requestJson).clientId).toBe(oldClient)
    target.dispose()
    const posts = vi.mocked(f.client.mutate).mock.calls.length, joins = vi.mocked(f.client.join).mock.calls.length
    const restored = f.create(); await restored.initialize()
    expect(restored.state().pending).toBeNull()
    expect(f.client.mutate).toHaveBeenCalledTimes(posts)
    expect(f.client.join).toHaveBeenCalledTimes(joins)
    expect(f.client.presence).not.toHaveBeenCalled()
    const join = vi.mocked(f.client.join).getMockImplementation()!
    vi.mocked(f.client.join).mockImplementationOnce(async (...args) => {
      if (args[1].clientId === oldClient) throw new ProjectCollaborationRequestError('原页面会话已过期', 409, true, 'COLLABORATION_LEASE_EXPIRED')
      return join(...args)
    })
    await restored.join()
    expect(vi.mocked(f.client.join).mock.calls.at(-1)![1].clientId).not.toBe(oldClient)
    expect(restored.state().joined).toBe(true)
    expect(f.storage.length).toBe(0)
  })

  it('uses a fresh client after explicit leave while keeping a retry bound to its stored client', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const oldClient = vi.mocked(f.client.join).mock.calls[0][1].clientId
    await target.leave()
    expect(vi.mocked(f.client.presence).mock.calls[0][1]).toMatchObject({ action: 'leave', clientId: oldClient })
    expect(f.client.join).toHaveBeenCalledOnce()
    const join = vi.mocked(f.client.join).getMockImplementation()!
    vi.mocked(f.client.join).mockImplementationOnce(async (...args) => {
      if (args[1].clientId === oldClient) throw new ProjectCollaborationRequestError('原页面已离开协作', 409, true, 'COLLABORATION_LEASE_EXPIRED')
      return join(...args)
    })
    await target.join()
    const currentClient = vi.mocked(f.client.join).mock.calls.at(-1)![1].clientId
    expect(currentClient).not.toBe(oldClient)
    vi.mocked(f.client.mutate).mockRejectedValueOnce(new Error('Synthetic lost reply'))
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Keep this original client'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow()
    const stored = target.state().pending!.requestJson
    await target.inspectOriginal(); await target.retryOriginal()
    expect(vi.mocked(f.client.mutate).mock.calls.at(-1)![1].clientId).toBe(currentClient)
    expect(JSON.parse(stored)).toEqual(vi.mocked(f.client.mutate).mock.calls.at(-1)![1])
  })

  it('does not fall back to a whole save or mint another operation after a missing reply', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    vi.mocked(f.client.mutate).mockRejectedValueOnce(new Error('Unknown reply'))
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Original edit'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow('Unknown reply')
    expect(target.canEdit()).toBe(false)
    const original = target.state().pending!, bytes = [...f.storage.data]
    await target.inspectOriginal()
    expect(target.state().phase).toBe('missing')
    expect(target.state().pending).toEqual(original)
    expect([...f.storage.data]).toEqual(bytes)
    await expect(target.flush(f.local)).rejects.toThrow('不会改用整图保存')
    expect(f.client.mutate).toHaveBeenCalledOnce()
    expect(f.client.join).toHaveBeenCalledOnce()
  })

  it('checks the actual server snapshot even when there are no local changes before a run barrier', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const remote = parseWorkflowFile(f.snapshot.content)!; remote.nodes[1].data.prompt = 'Teammate edit'
    const content = serializeWorkflow(remote)
    f.snapshot = { ...f.snapshot, content, contentDigest: await projectCollaborationContentDigest(content), project: { ...f.snapshot.project, version: 7 }, head: { ...f.snapshot.head!, sequence: 3, projectVersion: 7 } }
    const actual = await target.flush(f.local)
    expect(actual.project.version).toBe(7)
    expect(f.local).toBe(content)
    expect(f.client.mutate).not.toHaveBeenCalled()
  })

  it('rebases a later local output against the actual ACK and leaves it for the next typed flush', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const real = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => {
      const result = await real(...args)
      const latest = parseWorkflowFile(f.local)!; latest.nodes[1].data.outputText = 'Late local output'; f.local = serializeWorkflow(latest)
      return result
    })
    const edit = parseWorkflowFile(f.local)!; edit.nodes[0].data.prompt = 'First edit'; f.local = serializeWorkflow(edit)
    await target.flush(f.local)
    expect(parseWorkflowFile(f.local)?.nodes[0].data.prompt).toBe('First edit')
    expect(parseWorkflowFile(f.local)?.nodes[1].data.outputText).toBe('Late local output')
    expect(parseWorkflowFile(target.state().snapshot!.content)?.nodes[1].data.outputText).toBeUndefined()
    await target.flush(f.local)
    const second = vi.mocked(f.client.mutate).mock.calls[1][1]
    expect(second.action).toBe('edit')
    expect('changes' in second && second.changes).toMatchObject([{ kind: 'node-set', nodeId: 'b', slot: 'data' }])
    expect(parseWorkflowFile(f.snapshot.content)?.nodes[1].data.outputText).toBe('Late local output')
  })

  it('keeps the captured edit buffer open during journal hashing without dispatching before storage confirmation', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const edit = parseWorkflowFile(f.local)!; edit.nodes[0].data.prompt = 'Captured original'; f.local = serializeWorkflow(edit)
    const pending = target.flush(f.local)
    expect(target.state().phase).toBe('busy')
    expect(target.state().pending).toBeNull()
    expect(target.canEdit()).toBe(true)
    expect(f.client.mutate).not.toHaveBeenCalled()
    const buffered = parseWorkflowFile(f.local)!; buffered.nodes[1].data.prompt = 'During local hashing'; f.local = serializeWorkflow(buffered)
    await pending
    const request = vi.mocked(f.client.mutate).mock.calls[0][1]
    expect('changes' in request && request.changes).toMatchObject([{ kind: 'node-set', nodeId: 'a', slot: 'data' }])
    expect(parseWorkflowFile(f.local)?.nodes[1].data.prompt).toBe('During local hashing')
  })

  it.each(['add', 'delete', 'edge-order'] as const)('buffers a late %s only during an immutable edit dispatch and sends it after the ACK', async (kind) => {
    const f = await fixture()
    if (kind === 'edge-order') {
      const base = parseWorkflowFile(f.snapshot.content)!
      base.nodes.push({ id: 'c', kind: 'text-generate', definitionVersion: 1, position: { x: 600, y: 0 }, data: { prompt: 'c', model: '', status: 'idle' } })
      base.edges = [{ id: 'first', source: 'a', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }, { id: 'second', source: 'c', sourceHandle: 'out:text', target: 'b', targetHandle: 'in:text' }]
      const content = serializeWorkflow(base); f.local = content; f.snapshot = { ...f.snapshot, content, contentDigest: await projectCollaborationContentDigest(content) }
    }
    const target = f.create(); await target.initialize(); await target.join()
    const real = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => {
      expect(target.canEdit()).toBe(true)
      const pending = target.state().pending!, originalBytes = [...f.storage.data]
      const result = await real(...args)
      const late = parseWorkflowFile(f.local)!
      if (kind === 'add') {
        late.nodes.push({ id: 'c', kind: 'text-generate', definitionVersion: 1, position: { x: 600, y: 0 }, data: { prompt: 'c', model: '', status: 'idle' } })
        late.edges.push({ id: 'late-edge', source: 'a', sourceHandle: 'out:text', target: 'c', targetHandle: 'in:text' })
      } else if (kind === 'delete') { late.nodes = late.nodes.filter((node) => node.id !== 'b'); late.edges = [] }
      else late.edges.reverse()
      f.local = serializeWorkflow(late)
      expect(target.state().pending).toBe(pending)
      expect([...f.storage.data]).toEqual(originalBytes)
      return result
    })
    const edited = parseWorkflowFile(f.local)!; edited.nodes[0].data.prompt = 'Original immutable edit'; f.local = serializeWorkflow(edited)
    await target.flush(f.local)
    const late = parseWorkflowFile(f.local)!
    expect(late.nodes[0].data.prompt).toBe('Original immutable edit')
    if (kind === 'add') { expect(late.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']); expect(late.edges[0].id).toBe('late-edge') }
    if (kind === 'delete') expect(late.nodes.map((node) => node.id)).toEqual(['a'])
    if (kind === 'edge-order') expect(late.edges.map((edge) => edge.id)).toEqual(['second', 'first'])
    await target.flush(f.local)
    expect(f.snapshot.content).toBe(f.local)
    expect(f.client.mutate).toHaveBeenCalledTimes(2)
  })

  it('ends without sending an unsent local draft and restores ordinary saving only after explicit server adoption', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const dirty = parseWorkflowFile(f.local)!; dirty.nodes[0].data.prompt = 'Unsent draft at end'; f.local = serializeWorkflow(dirty)
    const real = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => { expect(target.canEdit()).toBe(false); return real(...args) })
    await target.endEpoch()
    expect(vi.mocked(f.client.mutate).mock.calls[0][1].action).toBe('end-epoch')
    expect(parseWorkflowFile(f.snapshot.content)?.nodes[0].data.prompt).toBe('a')
    expect(parseWorkflowFile(f.local)?.nodes[0].data.prompt).toBe('Unsent draft at end')
    expect(target.state().phase).toBe('ended')
    expect(target.needsOperationSave()).toBe(true)
    expect(target.canEdit()).toBe(false)
    await target.useServerVersion()
    expect(target.state().phase).toBe('available')
    expect(target.needsOperationSave()).toBe(false)
    expect(target.canEdit()).toBe(true)
    expect(f.snapshot.project.version).toBe(3)
  })

  it('keeps joining and actor undo blocked while only edit dispatches allow local buffering', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize()
    const join = vi.mocked(f.client.join).getMockImplementation()!
    vi.mocked(f.client.join).mockImplementationOnce(async (...args) => { expect(target.canEdit()).toBe(false); return join(...args) })
    await target.join()
    const edit = parseWorkflowFile(f.local)!; edit.nodes[0].data.prompt = 'Owner edit'; f.local = serializeWorkflow(edit)
    await target.flush(f.local)
    const mutate = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => { expect(target.canEdit()).toBe(false); return mutate(...args) })
    const tip = target.state().snapshot!.history.undo!.operationId
    await target.history('undo')
    expect(vi.mocked(f.client.mutate).mock.calls[1][1]).toMatchObject({ action: 'undo', targetOperationId: tip })
    expect(vi.mocked(f.client.mutate).mock.calls[1][1]).not.toHaveProperty('changes')
  })

  it('does not lock an owner out of personal editing after explicit adoption when sharing is unavailable', async () => {
    const f = await fixture()
    f.snapshot = { ...f.snapshot, canJoin: false, state: 'resync-required' }
    const target = f.create(); await target.initialize()
    await expect(target.join()).rejects.toThrow('共享编辑权限不可用')
    expect(f.storage.writes).toBe(0)
    expect(target.needsOperationSave()).toBe(true)
    await target.useServerVersion()
    expect(target.canEdit()).toBe(true)
    expect(target.needsOperationSave()).toBe(false)
    expect(f.client.join).not.toHaveBeenCalled()
    expect(f.client.mutate).not.toHaveBeenCalled()
  })

  it('lets a known rejected field conflict recover by explicit inspect, archived abandonment and server adoption', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    vi.mocked(f.client.mutate).mockRejectedValueOnce(new ProjectCollaborationRequestError('Teammate field conflict', 409, true, 'COLLABORATION_FIELD_CONFLICT'))
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Preserved local conflict'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow('field conflict')
    expect(target.state().abandonAllowed).toBe(false)
    await target.inspectOriginal()
    expect(target.state().abandonAllowed).toBe(true)
    const original = target.state().pending!, originalBytes = [...f.storage.data.values()][0]
    await target.abandonRejected()
    expect(target.state().phase).toBe('conflict')
    expect(target.state().pending).toBeNull()
    expect(parseWorkflowFile(f.local)?.nodes[0].data.prompt).toBe('Preserved local conflict')
    expect([...f.storage.data.values()]).toEqual([originalBytes])
    expect([...f.storage.data.keys()][0]).toContain(original.operationId)
    await target.useServerVersion(); await target.join()
    expect(target.state().phase).toBe('live')
    expect(f.local).toBe(f.snapshot.content)
  })

  it('never abandons a missing timeout operation without a known precommit rejection', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    vi.mocked(f.client.mutate).mockRejectedValueOnce(new ProjectCollaborationRequestError('Timeout', undefined, false))
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Uncertain local edit'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow('Timeout')
    await target.inspectOriginal()
    expect(target.state().phase).toBe('missing')
    expect(target.state().abandonAllowed).toBe(false)
    const original = [...f.storage.data]
    await expect(target.abandonRejected()).rejects.toThrow('不能放弃')
    expect([...f.storage.data]).toEqual(original)
  })

  it('recovers a concurrently found receipt instead of archiving when abandonment rechecks the original', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    const real = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockRejectedValueOnce(new ProjectCollaborationRequestError('Conflict', 409, true, 'COLLABORATION_ACTOR_CONFLICT'))
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Original'; f.local = serializeWorkflow(next)
    await expect(target.flush(f.local)).rejects.toThrow('Conflict')
    await target.inspectOriginal()
    const record = target.state().pending!
    await real(projectId, JSON.parse(record.requestJson))
    await target.abandonRejected()
    expect(target.state().pending).toBeNull()
    expect(f.storage.length).toBe(0)
    expect(target.state().joined).toBe(false)
  })

  it('invalidates late replies after owner scope changes while retaining the original journal', async () => {
    const f = await fixture(), target = f.create()
    await target.initialize(); await target.join()
    let reply: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { reply = resolve })
    const originalImplementation = vi.mocked(f.client.mutate).getMockImplementation()!
    vi.mocked(f.client.mutate).mockImplementationOnce(async (...args) => { const result = await originalImplementation(...args); await gate; return result })
    const next = parseWorkflowFile(f.local)!; next.nodes[0].data.prompt = 'Before account switch'; f.local = serializeWorkflow(next)
    const pending = target.flush(f.local)
    for (let index = 0; index < 15 && !vi.mocked(f.client.mutate).mock.calls.length; index++) await new Promise((resolve) => setTimeout(resolve, 1))
    f.projected.mockClear(); f.invalidate(); reply!()
    await expect(pending).rejects.toThrow('账号')
    expect(f.projected).not.toHaveBeenCalled()
    expect(f.storage.length).toBe(1)
  })
})
