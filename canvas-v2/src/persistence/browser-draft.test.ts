import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow } from '../model'
import {
  assertCanvasBrowserDraftStored,
  buildCanvasBrowserDraftWriterRotation,
  clearCanvasBrowserDraft,
  confirmRemoveCanvasBrowserDraft,
  createCanvasBrowserDraft,
  listCanvasBrowserDrafts,
  isSameCanvasBrowserDraftIdentity,
  isCanvasBrowserDraftSelected,
  selectCanvasBrowserDraft,
  writeCanvasBrowserDraft,
  type CanvasBrowserDraft,
  type CanvasDraftStorage,
} from './browser-draft'

function memoryStorage(initial: Record<string, string> = {}): CanvasDraftStorage {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function keyOf(draft: Pick<CanvasBrowserDraft, 'ownerId' | 'projectId' | 'writerId' | 'revision'>): string {
  return `xingmang:canvas-draft:v1:${draft.ownerId}:${draft.projectId}:${draft.writerId}:${draft.revision}`
}

function legacyKeyOf(draft: Pick<CanvasBrowserDraft, 'ownerId' | 'projectId' | 'writerId'>): string {
  return `xingmang:canvas-draft:v1:${draft.ownerId}:${draft.projectId}:${draft.writerId}`
}

function draft(overrides: Partial<CanvasBrowserDraft> = {}): CanvasBrowserDraft {
  return createCanvasBrowserDraft({
    ownerId: 1, projectId: 'project-a', writerId: 'tab-a', revision: 'tab-a-1',
    cloudVersion: 1, updatedAt: '2026-10-10T12:00:00.000Z',
    content: serializeWorkflow(createEmptyWorkflow('未保存画布')),
    ...overrides,
  })
}

function contentAtBytes(targetBytes: number, fill = 'a'): string {
  const workflow = createEmptyWorkflow('草稿边界')
  workflow.nodes = Array.from({ length: 24 }, (_, index) => ({
    id: `prompt-${index}`, kind: 'prompt', definitionVersion: 1,
    position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' },
  }))
  let remaining = targetBytes - new TextEncoder().encode(serializeWorkflow(workflow)).byteLength
  const fillBytes = new TextEncoder().encode(fill).byteLength
  for (const node of workflow.nodes) {
    const count = Math.min(90_000, Math.floor(remaining / fillBytes))
    node.data.prompt = fill.repeat(count)
    remaining -= count * fillBytes
    if (remaining > 0 && remaining < fillBytes) {
      node.data.prompt += 'a'.repeat(remaining)
      remaining = 0
    }
  }
  if (remaining !== 0) throw new Error('Fixture exceeds the supported prompt capacity')
  const content = serializeWorkflow(workflow)
  if (new TextEncoder().encode(content).byteLength !== targetBytes) throw new Error('Fixture has the wrong byte length')
  return content
}

describe('canvas browser drafts', () => {
  it('selects the exact writer and revision without treating a revision as a global identity', () => {
    const first = draft({ revision: 'shared-revision' })
    const otherWriter = draft({ writerId: 'tab-b', revision: 'shared-revision' })
    const otherRevision = draft({ revision: 'next-revision' })
    expect(isSameCanvasBrowserDraftIdentity(first, { ...first })).toBe(true)
    for (const different of [otherWriter, otherRevision, { ...first, ownerId: 2 }, { ...first, projectId: 'project-b' }, null, undefined]) {
      expect(isSameCanvasBrowserDraftIdentity(first, different)).toBe(false)
    }
    expect(isSameCanvasBrowserDraftIdentity(null, null)).toBe(false)
    const selection = { writerId: otherWriter.writerId, revision: otherWriter.revision }
    expect(isCanvasBrowserDraftSelected(first, selection)).toBe(false)
    expect(isCanvasBrowserDraftSelected(otherWriter, selection)).toBe(true)
    expect(selectCanvasBrowserDraft([first, otherRevision, otherWriter], selection)).toBe(otherWriter)
    expect(selectCanvasBrowserDraft([first, otherWriter], { writerId: first.writerId, revision: 'missing' })).toBeNull()
    expect(selectCanvasBrowserDraft([first], null)).toBeNull()
  })

  it('requires confirmation without touching storage and frees only the chosen snapshot for a fifth writer', () => {
    const target = memoryStorage()
    const existing = Array.from({ length: 4 }, (_, index) => draft({ writerId: `retained-${index}`, revision: 'shared-revision' }))
    const foreignOwner = draft({ ownerId: 2 })
    const foreignProject = draft({ projectId: 'project-b' })
    for (const item of [...existing, foreignOwner, foreignProject]) writeCanvasBrowserDraft(target, item)
    const next = draft({ writerId: 'fifth-tab', revision: 'fifth-tab-1', content: serializeWorkflow(createEmptyWorkflow('最新未保存编辑')) })
    expect(() => writeCanvasBrowserDraft(target, next)).toThrow('4')
    const read = vi.fn(target.getItem)
    const remove = vi.fn(target.removeItem)
    target.getItem = read
    target.removeItem = remove
    expect(confirmRemoveCanvasBrowserDraft(target, existing[1], false)).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(confirmRemoveCanvasBrowserDraft(target, existing[1], true)).toBe(true)
    expect(remove.mock.calls).toEqual([[keyOf(existing[1])]])
    expect(writeCanvasBrowserDraft(target, next)).toEqual(next)
    expect(target.getItem(keyOf(existing[1]))).toBeNull()
    for (const item of [existing[0], existing[2], existing[3], foreignOwner, foreignProject]) {
      expect(target.getItem(keyOf(item))).toBe(JSON.stringify(item))
    }
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toHaveLength(4)
  })

  it('keeps every stored snapshot available to management even when it matches the cloud content', () => {
    const target = memoryStorage()
    const sharedContent = serializeWorkflow(createEmptyWorkflow('已保存的云端内容'))
    const snapshots = [draft({ content: sharedContent }), draft({ writerId: 'tab-b', revision: 'tab-b-1', content: sharedContent })]
    for (const item of snapshots) writeCanvasBrowserDraft(target, item)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual(snapshots)
  })

  it('never deletes a new revision written between reading and removing an acknowledged snapshot', () => {
    const older = draft()
    const newer = draft({ revision: 'tab-a-2', content: serializeWorkflow(createEmptyWorkflow('另一个标签页的最新编辑')) })
    const target = memoryStorage({ [keyOf(older)]: JSON.stringify(older) })
    const get = target.getItem
    let inject = true
    target.getItem = (key) => {
      const result = get(key)
      if (inject && key === keyOf(older)) {
        inject = false
        writeCanvasBrowserDraft(target, newer)
      }
      return result
    }
    expect(confirmRemoveCanvasBrowserDraft(target, older, true)).toBe(true)
    expect(get(keyOf(newer))).toBe(JSON.stringify(newer))
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([newer])
  })

  it('refuses confirmation when the selected snapshot has changed and keeps the stored value intact', () => {
    const original = draft()
    for (const change of [
      { cloudVersion: 2 }, { updatedAt: '2026-10-10T13:00:00.000Z' },
      { content: serializeWorkflow(createEmptyWorkflow('更新内容')) },
      { ownerId: 2 }, { projectId: 'project-b' }, { writerId: 'tab-b' }, { revision: 'newer' },
    ]) {
      const raw = JSON.stringify({ ...original, ...change })
      const target = memoryStorage({ [keyOf(original)]: raw })
      expect(confirmRemoveCanvasBrowserDraft(target, original, true)).toBe(false)
      expect(target.getItem(keyOf(original))).toBe(raw)
    }
    expect(confirmRemoveCanvasBrowserDraft(memoryStorage(), original, true)).toBe(false)
  })

  it('reads and verifies legacy writer keys but never claims their unsafe deletion succeeded', () => {
    const original = draft()
    const target = memoryStorage({ [legacyKeyOf(original)]: JSON.stringify(original) })
    const remove = vi.fn(target.removeItem)
    target.removeItem = remove
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([original])
    expect(() => assertCanvasBrowserDraftStored(target, original)).not.toThrow()
    expect(confirmRemoveCanvasBrowserDraft(target, original, true)).toBe(false)
    expect(clearCanvasBrowserDraft(target, original)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(target.getItem(legacyKeyOf(original))).toBe(JSON.stringify(original))
  })

  it('deduplicates a legacy and immutable copy while preserving both if legacy cleanup cannot be confirmed', () => {
    const original = draft()
    const target = memoryStorage({ [legacyKeyOf(original)]: JSON.stringify(original), [keyOf(original)]: JSON.stringify(original) })
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([original])
    expect(confirmRemoveCanvasBrowserDraft(target, original, true)).toBe(false)
    expect(clearCanvasBrowserDraft(target, original)).toBe(false)
    expect(target.length).toBe(2)
    target.setItem(legacyKeyOf(original), JSON.stringify({ ...original, content: serializeWorkflow(createEmptyWorkflow('冲突旧格式')) }))
    expect(() => listCanvasBrowserDrafts(target, 1, 'project-a')).toThrow('同一版本存在不同内容')
  })

  it('counts legacy copies by writer without mistaking retained legacy storage for a freed slot', () => {
    const snapshots = Array.from({ length: 4 }, (_, index) => draft({ writerId: `legacy-${index}`, revision: `legacy-${index}-1` }))
    const target = memoryStorage(Object.fromEntries(snapshots.map((item) => [legacyKeyOf(item), JSON.stringify(item)])))
    const next = draft({ writerId: 'new-writer', revision: 'new-writer-1' })
    expect(confirmRemoveCanvasBrowserDraft(target, snapshots[0], true)).toBe(false)
    expect(() => writeCanvasBrowserDraft(target, next)).toThrow('4')
    const updated = draft({ ...snapshots[0], revision: 'legacy-0-2' })
    expect(writeCanvasBrowserDraft(target, updated)).toEqual(updated)
    expect(target.length).toBe(5)
    const newer = draft({ ...updated, revision: 'legacy-0-3' })
    expect(writeCanvasBrowserDraft(target, newer)).toEqual(newer)
    expect(target.length).toBe(5)
    expect(target.getItem(legacyKeyOf(snapshots[0]))).toBe(JSON.stringify(snapshots[0]))
    expect(() => writeCanvasBrowserDraft(target, next)).toThrow('4')
  })

  it('continues budgeting the bytes of a legacy copy when writing a new revision', () => {
    const legacy = draft({ content: contentAtBytes(1_700_000) })
    const otherProject = draft({ projectId: 'project-b', content: contentAtBytes(1_700_000) })
    const target = memoryStorage({ [legacyKeyOf(legacy)]: JSON.stringify(legacy), [keyOf(otherProject)]: JSON.stringify(otherProject) })
    expect(() => writeCanvasBrowserDraft(target, draft({ revision: 'tab-a-2', content: contentAtBytes(1_000_000) }))).toThrow('4 MB')
    expect(target.length).toBe(2)
    expect(target.getItem(legacyKeyOf(legacy))).toBe(JSON.stringify(legacy))
  })

  it('does not overwrite an immutable revision with different content', () => {
    const original = draft()
    const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original) })
    expect(() => writeCanvasBrowserDraft(target, draft({ content: serializeWorkflow(createEmptyWorkflow('另一份内容')) }))).toThrow('新的版本标识')
    expect(target.getItem(keyOf(original))).toBe(JSON.stringify(original))
    expect(writeCanvasBrowserDraft(target, original)).toEqual(original)
  })

  it('retains the previous revision when a new write fails or silently does not persist', () => {
    const original = draft()
    const replacement = draft({ revision: 'tab-a-2' })
    for (const setItem of [() => { throw new Error('QuotaExceededError') }, () => undefined]) {
      const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original) })
      const remove = vi.fn(target.removeItem)
      target.removeItem = remove
      target.setItem = setItem
      expect(() => writeCanvasBrowserDraft(target, replacement)).toThrow('草稿')
      expect(remove).not.toHaveBeenCalled()
      expect(target.getItem(keyOf(original))).toBe(JSON.stringify(original))
      expect(target.getItem(keyOf(replacement))).toBeNull()
    }
  })

  it('retains old and new copies when verifying the new write is unavailable', () => {
    const original = draft()
    const replacement = draft({ revision: 'tab-a-2' })
    const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original) })
    const set = target.setItem
    const get = target.getItem
    let written = false
    target.setItem = (key, value) => { set(key, value); written = true }
    target.getItem = (key) => {
      if (written && key === keyOf(replacement)) throw new Error('SecurityError')
      return get(key)
    }
    expect(() => writeCanvasBrowserDraft(target, replacement)).toThrow('检查浏览器存储权限')
    expect(get(keyOf(original))).toBe(JSON.stringify(original))
    expect(get(keyOf(replacement))).toBe(JSON.stringify(replacement))
  })

  it('retains held revisions and reports failure when own-writer replacement cleanup fails', () => {
    const original = draft()
    const replacement = draft({ revision: 'tab-a-2' })
    const other = draft({ writerId: 'tab-b', revision: 'tab-b-1' })
    const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original), [keyOf(other)]: JSON.stringify(other) })
    target.removeItem = () => { throw new Error('SecurityError') }
    expect(() => writeCanvasBrowserDraft(target, replacement)).toThrow('新草稿已持有')
    expect(target.getItem(keyOf(original))).toBe(JSON.stringify(original))
    expect(target.getItem(keyOf(replacement))).toBe(JSON.stringify(replacement))
    expect(target.getItem(keyOf(other))).toBe(JSON.stringify(other))
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toHaveLength(3)
  })

  it('does not count two held revisions of one writer as two independent capacity slots', () => {
    const original = draft()
    const next = draft({ revision: 'tab-a-2' })
    const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original), [keyOf(next)]: JSON.stringify(next) })
    for (const writer of ['tab-b', 'tab-c', 'tab-d']) {
      expect(writeCanvasBrowserDraft(target, draft({ writerId: writer, revision: `${writer}-1` })).writerId).toBe(writer)
    }
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toHaveLength(5)
    expect(() => writeCanvasBrowserDraft(target, draft({ writerId: 'tab-e', revision: 'tab-e-1' }))).toThrow('4')
    expect(target.getItem(keyOf(original))).toBe(JSON.stringify(original))
    expect(target.getItem(keyOf(next))).toBe(JSON.stringify(next))
  })

  it('reports an unconfirmed replacement if cleanup silently leaves the old immutable key in storage', () => {
    const original = draft()
    const next = draft({ revision: 'tab-a-2' })
    const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original) })
    target.removeItem = () => undefined
    expect(() => writeCanvasBrowserDraft(target, next)).toThrow('旧草稿清理尚未确认')
    expect(target.getItem(keyOf(original))).toBe(JSON.stringify(original))
    expect(target.getItem(keyOf(next))).toBe(JSON.stringify(next))
  })

  it('does not report successful confirmation when removal is rejected or cannot be verified', () => {
    const original = draft()
    const target = memoryStorage({ [keyOf(original)]: JSON.stringify(original) })
    target.removeItem = () => undefined
    expect(confirmRemoveCanvasBrowserDraft(target, original, true)).toBe(false)
    expect(target.getItem(keyOf(original))).toBe(JSON.stringify(original))
    target.removeItem = () => { throw new Error('SecurityError') }
    expect(() => confirmRemoveCanvasBrowserDraft(target, original, true)).toThrow('本地草稿清理失败')
    const removed = memoryStorage({ [keyOf(original)]: JSON.stringify(original) })
    const remove = removed.removeItem
    const get = removed.getItem
    let didRemove = false
    removed.removeItem = (key) => { remove(key); didRemove = true }
    removed.getItem = (key) => {
      if (didRemove) throw new Error('SecurityError')
      return get(key)
    }
    expect(() => confirmRemoveCanvasBrowserDraft(removed, original, true)).toThrow('检查浏览器存储权限')
  })

  it('keeps the pre-reload snapshot after editing and saving the newly read cloud document', () => {
    const target = memoryStorage()
    const originalContent = serializeWorkflow(createEmptyWorkflow('读取云端前的冲突图'))
    const original = writeCanvasBrowserDraft(target, draft({ content: originalContent, cloudVersion: 4 }))
    assertCanvasBrowserDraftStored(target, original)
    const rotated = buildCanvasBrowserDraftWriterRotation(original.writerId, 'tab-after-cloud')
    expect(rotated).toEqual({ writerId: 'tab-after-cloud', revisionSequence: 0 })
    const editedCloud = writeCanvasBrowserDraft(target, draft({
      writerId: rotated.writerId, revision: `${rotated.writerId}-1`, cloudVersion: 5,
      content: serializeWorkflow(createEmptyWorkflow('读取云端后的新编辑')),
    }))
    expect(clearCanvasBrowserDraft(target, editedCloud)).toBe(true)
    const reopened = listCanvasBrowserDrafts(target, original.ownerId, original.projectId)
    expect(reopened).toEqual([original])
    expect(reopened[0].content).toBe(originalContent)
    expect(reopened[0].cloudVersion).toBe(4)
  })

  it('protects the retained revision and the new writer from a late acknowledgement', () => {
    const target = memoryStorage()
    const acknowledged = writeCanvasBrowserDraft(target, draft())
    const retained = writeCanvasBrowserDraft(target, draft({ revision: 'tab-a-2', content: serializeWorkflow(createEmptyWorkflow('新的冲突编辑')) }))
    const rotated = buildCanvasBrowserDraftWriterRotation(retained.writerId, 'tab-cloud')
    const next = writeCanvasBrowserDraft(target, draft({ writerId: rotated.writerId, revision: 'tab-cloud-1', cloudVersion: 2 }))
    expect(clearCanvasBrowserDraft(target, acknowledged)).toBe(false)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toHaveLength(2)
    expect(clearCanvasBrowserDraft(target, next)).toBe(true)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([retained])
  })

  it('allows an explicitly restored and saved snapshot to be cleared without touching other snapshots', () => {
    const target = memoryStorage()
    const retained = writeCanvasBrowserDraft(target, draft())
    const another = writeCanvasBrowserDraft(target, draft({ writerId: 'another-tab', revision: 'another-tab-1', content: serializeWorkflow(createEmptyWorkflow('另一页原图')) }))
    const recovered = listCanvasBrowserDrafts(target, 1, 'project-a').find((item) => item.writerId === retained.writerId)
    expect(recovered).toBeDefined()
    const active = writeCanvasBrowserDraft(target, draft({ writerId: 'restoring-tab', revision: 'restoring-tab-1', content: recovered!.content }))
    expect(clearCanvasBrowserDraft(target, active)).toBe(true)
    expect(clearCanvasBrowserDraft(target, recovered!)).toBe(true)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([another])
  })

  it('does not silently evict retained snapshots when a rotated writer reaches the project limit', () => {
    const target = memoryStorage()
    const retained = Array.from({ length: 4 }, (_, index) => draft({ writerId: `retained-${index}`, revision: `retained-${index}-1`, content: serializeWorkflow(createEmptyWorkflow(`冲突图${index}`)) }))
    for (const item of retained) writeCanvasBrowserDraft(target, item)
    const rotated = buildCanvasBrowserDraftWriterRotation(retained[3].writerId, 'cloud-fifth-writer')
    expect(() => writeCanvasBrowserDraft(target, draft({ writerId: rotated.writerId, revision: `${rotated.writerId}-1` }))).toThrow('4')
    expect(target.length).toBe(4)
    for (const item of retained) assertCanvasBrowserDraftStored(target, item)
  })

  it('does not remove the old snapshot when a rotated writer exceeds the account byte limit', () => {
    const target = memoryStorage()
    const original = writeCanvasBrowserDraft(target, draft({ content: contentAtBytes(1_700_000) }))
    const other = writeCanvasBrowserDraft(target, draft({ projectId: 'project-b', content: contentAtBytes(1_700_000) }))
    const rotated = buildCanvasBrowserDraftWriterRotation(original.writerId, 'cloud-next')
    expect(() => writeCanvasBrowserDraft(target, draft({ writerId: rotated.writerId, revision: 'cloud-next-1', content: contentAtBytes(1_000_000) }))).toThrow('4 MB')
    assertCanvasBrowserDraftStored(target, original)
    assertCanvasBrowserDraftStored(target, other)
    expect(target.length).toBe(2)
  })

  it('confirms storage rather than accepting an in-memory draft after a missing or changed write', () => {
    const source = draft()
    expect(() => assertCanvasBrowserDraftStored(memoryStorage(), source)).toThrow('当前画布')
    for (const change of [{ revision: 'tab-a-2' }, { cloudVersion: 2 }, { content: serializeWorkflow(createEmptyWorkflow('其它内容')) }]) {
      const target = memoryStorage({ [keyOf(source)]: JSON.stringify({ ...source, ...change }) })
      expect(() => assertCanvasBrowserDraftStored(target, source)).toThrow('当前画布')
      expect(target.length).toBe(1)
    }
  })

  it('does not permit retaining a draft whose storage cannot be read', () => {
    const source = draft()
    const target = memoryStorage({ [keyOf(source)]: JSON.stringify(source) })
    target.getItem = () => { throw new Error('SecurityError') }
    expect(() => assertCanvasBrowserDraftStored(target, source)).toThrow('检查浏览器存储权限')
  })

  it.each(['tab-a', '', 'bad writer', 'bad/owner', 'a'.repeat(129)])('rejects reusing or corrupting a retained writer identity %s', (nextWriterId) => {
    expect(() => buildCanvasBrowserDraftWriterRotation('tab-a', nextWriterId)).toThrow('草稿')
  })

  it('stores only the normalized draft and returns the stored value', () => {
    const target = memoryStorage()
    const source = draft()
    const stored = writeCanvasBrowserDraft(target, source)
    expect(JSON.parse(target.getItem(keyOf(source)) ?? '')).toEqual(stored)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([stored])
    expect(stored).not.toBe(source)
  })

  it('isolates accounts, projects, and writers and lists newest first', () => {
    const target = memoryStorage()
    const older = draft()
    const newer = draft({ writerId: 'tab-b', revision: 'tab-b-1', updatedAt: '2026-10-10T13:00:00.000Z' })
    const otherProject = draft({ projectId: 'project-b' })
    const otherOwner = draft({ ownerId: 2 })
    for (const item of [older, newer, otherProject, otherOwner]) writeCanvasBrowserDraft(target, item)
    expect(target.length).toBe(4)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([newer, older])
    expect(listCanvasBrowserDrafts(target, 1, 'project-b')).toEqual([otherProject])
    expect(listCanvasBrowserDrafts(target, 2, 'project-a')).toEqual([otherOwner])
  })

  it('never reads values belonging to another account or project while listing', () => {
    const current = draft()
    const foreignOwner = keyOf({ ...current, ownerId: 2 })
    const foreignProject = keyOf({ ...current, projectId: 'project-aa' })
    const target = memoryStorage({
      [keyOf(current)]: JSON.stringify(current), [foreignOwner]: 'invalid foreign content',
      [foreignProject]: 'invalid foreign content', unrelated: 'not a draft',
    })
    const originalGet = target.getItem
    const getItem = vi.fn((key: string) => {
      if (key !== keyOf(current)) throw new Error('Read another owner or project')
      return originalGet(key)
    })
    target.getItem = getItem
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([current])
    expect(getItem.mock.calls).toEqual([[keyOf(current)]])
  })

  it('does not read another account while budgeting a write', () => {
    const source = draft()
    const foreignKey = keyOf({ ...source, ownerId: 2 })
    const target = memoryStorage({ [foreignKey]: 'foreign draft content' })
    const originalGet = target.getItem
    target.getItem = (key) => {
      if (key === foreignKey) throw new Error('Read another owner')
      return originalGet(key)
    }
    expect(writeCanvasBrowserDraft(target, source)).toEqual(source)
    expect(target.length).toBe(2)
  })

  it('keeps a newer revision when an older cloud save finishes', () => {
    const target = memoryStorage()
    const older = draft()
    const newer = draft({ revision: 'tab-a-2', content: serializeWorkflow(createEmptyWorkflow('更新内容')) })
    writeCanvasBrowserDraft(target, older)
    writeCanvasBrowserDraft(target, newer)
    expect(clearCanvasBrowserDraft(target, older)).toBe(false)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([newer])
  })

  it('clears the original recovered revision without deleting the recovering writer', () => {
    const target = memoryStorage()
    const original = draft()
    const recovering = draft({ writerId: 'tab-b', revision: 'tab-b-1' })
    writeCanvasBrowserDraft(target, original)
    writeCanvasBrowserDraft(target, recovering)
    const recovered = listCanvasBrowserDrafts(target, 1, 'project-a').find((item) => item.writerId === original.writerId)
    expect(recovered).toEqual(original)
    expect(clearCanvasBrowserDraft(target, recovered ?? original)).toBe(true)
    expect(clearCanvasBrowserDraft(target, original)).toBe(false)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([recovering])
  })

  it('keeps a newer originating revision after another tab recovered an older one', () => {
    const target = memoryStorage()
    const original = draft()
    writeCanvasBrowserDraft(target, original)
    const recovered = listCanvasBrowserDrafts(target, 1, 'project-a')[0]
    const newer = draft({ revision: 'tab-a-2' })
    writeCanvasBrowserDraft(target, newer)
    expect(clearCanvasBrowserDraft(target, recovered)).toBe(false)
    expect(target.getItem(keyOf(newer))).toBe(JSON.stringify(newer))
  })

  it('requires the stored format and owner, project, writer, and revision to match before clearing', () => {
    const source = draft()
    for (const changed of [{ format: 2 }, { ownerId: 2 }, { projectId: 'project-b' }, { writerId: 'tab-b' }, { revision: 'tab-a-2' }]) {
      const value = JSON.stringify({ ...source, ...changed })
      const target = memoryStorage({ [keyOf(source)]: value })
      expect(clearCanvasBrowserDraft(target, source)).toBe(false)
      expect(target.getItem(keyOf(source))).toBe(value)
    }
  })

  it('permits clearing a confirmed revision after its cloud base version changes', () => {
    const source = draft()
    const target = memoryStorage()
    writeCanvasBrowserDraft(target, { ...source, cloudVersion: 2 })
    expect(clearCanvasBrowserDraft(target, source)).toBe(true)
  })

  it('sanitizes credential fields at every settings depth before writing', () => {
    const content = JSON.stringify({
      schemaVersion: 2, name: '安全草稿', password: 'top-password', token: 'top-token',
      nodes: [{
        id: 'prompt-1', kind: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 },
        data: {
          prompt: '保留提示词', model: '', apiKey: 'node-api-key',
          settings: {
            key: 'generic-key', token: 'generic-token', password: 'settings-password',
            nested: { privateKey: 'private-key', authToken: 'nested-token', useful: '保留设置' },
            useful: true,
          },
        },
      }], edges: [],
    })
    const target = memoryStorage()
    const created = createCanvasBrowserDraft({ ...draft(), content })
    const stored = writeCanvasBrowserDraft(target, { ...created, content })
    const raw = target.getItem(keyOf(stored)) ?? ''
    for (const secret of ['top-password', 'top-token', 'node-api-key', 'generic-key', 'generic-token', 'settings-password', 'private-key', 'nested-token']) {
      expect(raw).not.toContain(secret)
    }
    expect(JSON.parse(stored.content).nodes[0].data.settings).toEqual({ nested: { useful: '保留设置' }, useful: true })
    expect(stored.content).toContain('保留提示词')
  })

  it('sanitizes stored drafts before returning their contents', () => {
    const source = draft()
    const content = JSON.stringify({ schemaVersion: 2, name: '草稿', nodes: [], edges: [], apiKey: 'untrusted-secret' })
    const target = memoryStorage({ [keyOf(source)]: JSON.stringify({ ...source, content, token: 'extra-secret' }) })
    expect(JSON.stringify(listCanvasBrowserDrafts(target, 1, 'project-a'))).not.toContain('secret')
  })

  it('allows four writers and refuses a fifth without evicting any draft', () => {
    const target = memoryStorage()
    const existing = Array.from({ length: 4 }, (_, index) => draft({ writerId: `tab-${index}`, revision: `tab-${index}-1` }))
    for (const item of existing) writeCanvasBrowserDraft(target, item)
    expect(() => writeCanvasBrowserDraft(target, draft({ writerId: 'tab-5' }))).toThrow('请先管理已有草稿')
    expect(target.length).toBe(4)
    for (const item of existing) expect(target.getItem(keyOf(item))).toBe(JSON.stringify(item))
    const updated = { ...existing[0], revision: 'tab-0-2' }
    expect(writeCanvasBrowserDraft(target, updated)).toEqual(updated)
    expect(target.length).toBe(4)
  })

  it('budgets all projects for the current account and keeps other drafts on overflow', () => {
    const target = memoryStorage()
    const content = contentAtBytes(1_600_000)
    const first = draft({ content })
    const second = draft({ projectId: 'project-b', content })
    writeCanvasBrowserDraft(target, first)
    writeCanvasBrowserDraft(target, second)
    expect(() => writeCanvasBrowserDraft(target, draft({ projectId: 'project-c', content: contentAtBytes(1_000_000) }))).toThrow('本账户的本地草稿超过 4 MB 上限')
    expect(target.length).toBe(2)
    expect(target.getItem(keyOf(first))).toBe(JSON.stringify(first))
    expect(target.getItem(keyOf(second))).toBe(JSON.stringify(second))
  })

  it('subtracts the previous writer value when replacing a large draft', () => {
    const target = memoryStorage()
    const source = draft({ content: contentAtBytes(1_700_000) })
    writeCanvasBrowserDraft(target, source)
    writeCanvasBrowserDraft(target, draft({ projectId: 'project-b', content: contentAtBytes(1_700_000) }))
    const replacement = { ...source, revision: 'tab-a-2' }
    expect(writeCanvasBrowserDraft(target, replacement)).toEqual(replacement)
    expect(target.length).toBe(2)
  })

  it('accepts exactly two MiB and rejects one extra UTF-8 byte', () => {
    const content = contentAtBytes(2 * 1024 * 1024, '画')
    expect(draft({ content }).content).toBe(content)
    expect(() => draft({ content: `${content} ` })).toThrow('超过本地草稿的 2 MB 上限')
  })

  it('counts UTF-8 bytes rather than JavaScript string length', () => {
    const content = contentAtBytes(2 * 1024 * 1024 + 1, '画')
    expect(content.length).toBeLessThan(2 * 1024 * 1024)
    expect(() => draft({ content })).toThrow('超过本地草稿的 2 MB 上限')
  })

  it('rejects serialization that expands beyond the content limit', () => {
    const content = contentAtBytes(2 * 1024 * 1024 + 1)
    const compact = JSON.stringify(JSON.parse(content))
    expect(new TextEncoder().encode(compact).byteLength).toBeLessThan(2 * 1024 * 1024)
    expect(() => draft({ content: compact })).toThrow('超过本地草稿的 2 MB 上限')
  })

  it('reports browser quota errors in Chinese without removing other writers', () => {
    const target = memoryStorage()
    const existing = draft({ writerId: 'tab-b', revision: 'tab-b-1' })
    writeCanvasBrowserDraft(target, existing)
    const removeItem = vi.fn(target.removeItem)
    target.removeItem = removeItem
    target.setItem = () => { throw new Error('QuotaExceededError with internal details') }
    expect(() => writeCanvasBrowserDraft(target, draft())).toThrow('请立即导出工作流')
    expect(() => writeCanvasBrowserDraft(target, draft())).not.toThrow('QuotaExceededError')
    expect(removeItem).not.toHaveBeenCalled()
    expect(target.getItem(keyOf(existing))).toBe(JSON.stringify(existing))
  })

  it('reports inaccessible enumeration and reads in Chinese without an empty success', () => {
    const source = draft()
    const lengthFailure = memoryStorage()
    Object.defineProperty(lengthFailure, 'length', { get: () => { throw new Error('SecurityError') } })
    const keyFailure = memoryStorage({ [keyOf(source)]: JSON.stringify(source) })
    keyFailure.key = () => { throw new Error('SecurityError') }
    const getFailure = memoryStorage({ [keyOf({ ...source, writerId: 'tab-b' })]: JSON.stringify(source) })
    getFailure.getItem = () => { throw new Error('SecurityError') }
    for (const target of [lengthFailure, keyFailure, getFailure]) {
      expect(() => listCanvasBrowserDrafts(target, 1, 'project-a')).toThrow('请检查浏览器存储权限')
      expect(() => writeCanvasBrowserDraft(target, source)).toThrow('请检查浏览器存储权限')
    }
    expect(() => clearCanvasBrowserDraft(getFailure, source)).toThrow('请检查浏览器存储权限')
  })

  it('reports cleanup failures in Chinese and retains the existing draft', () => {
    const source = draft()
    const target = memoryStorage({ [keyOf(source)]: JSON.stringify(source) })
    target.removeItem = () => { throw new Error('SecurityError') }
    expect(() => clearCanvasBrowserDraft(target, source)).toThrow('本地草稿清理失败')
    expect(target.getItem(keyOf(source))).toBe(JSON.stringify(source))
  })

  it('rejects malformed stored values and metadata that disagrees with the storage key', () => {
    const source = draft()
    for (const value of ['{', JSON.stringify({ ...source, ownerId: 2 }), JSON.stringify({ ...source, format: 2 }), JSON.stringify({ ...source, content: '{}' })]) {
      const target = memoryStorage({ [keyOf(source)]: value })
      expect(() => listCanvasBrowserDrafts(target, 1, 'project-a')).toThrow('本地草稿无法读取')
      expect(target.getItem(keyOf(source))).toBe(value)
    }
  })

  it('rejects invalid identities, versions, timestamps, and workflows', () => {
    for (const change of [
      { ownerId: 0 }, { ownerId: 1.5 }, { ownerId: Number.MAX_SAFE_INTEGER + 1 },
      { projectId: '../project' }, { projectId: 'a'.repeat(129) },
      { writerId: 'tab:unsafe' }, { writerId: '' }, { writerId: 'a'.repeat(129) },
      { revision: 'a'.repeat(181) }, { revision: '' },
      { cloudVersion: -1 }, { cloudVersion: 1.5 }, { updatedAt: 'not-a-time' }, { content: '{}' },
    ]) expect(() => draft(change)).toThrow(/本地草稿/)
    expect(draft({ cloudVersion: 0 }).cloudVersion).toBe(0)
    expect(draft({ writerId: 'a'.repeat(128), projectId: 'b'.repeat(128), revision: 'c'.repeat(180) }).revision).toHaveLength(180)
  })
})
