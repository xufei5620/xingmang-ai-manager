import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasProjectStore } from './canvas-project-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function workflow(name: string, nodeId = 'audio'): string {
  const assetId = 'A'.repeat(43)
  return JSON.stringify({
    schemaVersion: 2, name, viewport: { x: 12, y: 34, zoom: 0.9 }, mediaGroups: { image: '生图分组', video: 'grok' },
    nodes: [{ id: nodeId, kind: 'audio-input', definitionVersion: 1, position: { x: 742.5, y: -318.25 }, width: 280, height: 340, locked: true, data: { prompt: '', model: '', result: { kind: 'audio', assetId, localUrl: `xingmang-asset://audio/${assetId}`, mimeType: 'audio/wav' } } }],
    edges: [],
  }, null, 2)
}

function createFixture(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xingmang-canvas-projects-${prefix}-`))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `xingmang-canvas-workspace-${prefix}-`))
  roots.push(root, workspace)
  return { root, workspace, store: new CanvasProjectStore(root) }
}

describe('CanvasProjectStore', () => {
  it('creates, saves, lists and reopens a user-owned project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-'))
    roots.push(root)
    const store = new CanvasProjectStore(root)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-'))
    roots.push(workspace)
    const created = await store.create(36, '音视频创作', workspace)
    const saved = await store.save(36, created.project.id, workflow('音视频创作'))
    expect(saved.nodeCount).toBe(1)
    expect(saved).toEqual(expect.objectContaining({
      assetCount: 1,
      workspaceStatus: 'ready',
      previewAsset: expect.objectContaining({ kind: 'audio', assetId: 'A'.repeat(43) }),
    }))
    await expect(store.list(36)).resolves.toEqual([expect.objectContaining({ id: created.project.id, name: '音视频创作', nodeCount: 1, workspaceName: path.basename(workspace), workspaceConfigured: true, workspaceStatus: 'ready' })])
    await expect(store.getWorkspaceDirectory(36, created.project.id)).resolves.toBe(path.resolve(workspace))
    expect(fs.existsSync(path.join(workspace, 'assets'))).toBe(true)
    const reopened = await store.open(36, created.project.id)
    expect(reopened.project).toEqual(expect.objectContaining({ nodeCount: 1 }))
    expect(JSON.parse(reopened.content)).toMatchObject({
      viewport: { x: 12, y: 34, zoom: 0.9 },
      nodes: [{ position: { x: 742.5, y: -318.25 }, width: 280, height: 340, locked: true }],
    })
    await expect(store.open(37, created.project.id)).rejects.toThrow()
  })

  it('rejects invalid project identifiers and malformed workflow updates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-invalid-'))
    roots.push(root)
    const store = new CanvasProjectStore(root)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-invalid-'))
    roots.push(workspace)
    const created = await store.create(36, '项目', workspace)
    await expect(store.open(36, '../escape')).rejects.toThrow('标识无效')
    await expect(store.save(36, created.project.id, '{bad json')).rejects.toThrow('不是有效 JSON')
  })

  it('rejects reusing one work folder for two projects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-duplicate-'))
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-duplicate-'))
    roots.push(root, workspace)
    const store = new CanvasProjectStore(root)
    await store.create(36, '项目一', workspace)
    await expect(store.create(36, '项目二', workspace)).rejects.toThrow('已绑定项目')
  })

  it('keeps legacy projects readable without inventing or exposing a work folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-legacy-'))
    roots.push(root)
    const projectId = '11111111-1111-4111-8111-111111111111'
    const accountRoot = path.join(root, 'user-36')
    fs.mkdirSync(accountRoot, { recursive: true })
    fs.writeFileSync(path.join(accountRoot, `${projectId}.json`), JSON.stringify({
      version: 1,
      id: projectId,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      workflow: JSON.parse(workflow('旧项目')),
    }), 'utf8')
    const store = new CanvasProjectStore(root)

    await expect(store.list(36)).resolves.toEqual([
      expect.objectContaining({ id: projectId, workspaceConfigured: false, workspaceStatus: 'legacy', lastOpenedAt: '2026-08-13T00:00:00.000Z' }),
    ])
    await expect(store.getWorkspaceDirectory(36, projectId)).resolves.toBeNull()
    await expect(store.open(36, projectId)).resolves.toMatchObject({
      project: { id: projectId, workspaceConfigured: false },
    })
  })

  it('renames, archives and restores projects without allowing archived writes', async () => {
    const { root, workspace, store } = createFixture('lifecycle')
    const created = await store.create(36, '原项目', workspace)
    await expect(store.rename(36, created.project.id, '新项目')).resolves.toEqual(expect.objectContaining({ name: '新项目' }))
    const archived = await store.setArchived(36, created.project.id, true)
    expect(archived.archivedAt).toBeTruthy()
    await expect(store.open(36, created.project.id)).rejects.toThrow('已归档')
    await expect(store.save(36, created.project.id, workflow('不应保存'))).rejects.toThrow('已归档')
    await expect(store.open(37, created.project.id)).rejects.toThrow()

    const restored = await store.setArchived(36, created.project.id, false)
    expect(restored.archivedAt).toBeUndefined()
    await expect(store.open(36, created.project.id)).resolves.toMatchObject({ project: { name: '新项目' } })
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'user-36', `${created.project.id}.json`), 'utf8')) as Record<string, unknown>
    expect(persisted.archivedAt).toBeUndefined()
  })

  it('reports a missing work folder and blocks open, save and duplicate', async () => {
    const { workspace, store } = createFixture('missing')
    const created = await store.create(36, '目录会丢失', workspace)
    fs.rmSync(workspace, { recursive: true, force: true })
    await expect(store.list(36)).resolves.toEqual([expect.objectContaining({ workspaceStatus: 'missing' })])
    await expect(store.open(36, created.project.id)).rejects.toThrow('工作文件夹不存在')
    await expect(store.save(36, created.project.id, workflow('目录会丢失'))).rejects.toThrow('工作文件夹不存在')
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-missing-target-'))
    roots.push(target)
    await expect(store.duplicate(36, created.project.id, '副本', target)).rejects.toThrow('工作文件夹不存在')
  })

  it('duplicates project content and local assets into a new empty work folder', async () => {
    const { workspace, store } = createFixture('duplicate')
    const created = await store.create(36, '源项目', workspace)
    await store.save(36, created.project.id, workflow('源项目'))
    const nested = path.join(workspace, 'assets', 'nested')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, 'sample.bin'), 'asset-bytes', 'utf8')
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-duplicate-target-'))
    roots.push(target)

    const copied = await store.duplicate(36, created.project.id, '源项目副本', target)
    expect(copied.project).toEqual(expect.objectContaining({ name: '源项目副本', nodeCount: 1, assetCount: 1, workspaceStatus: 'ready' }))
    expect(JSON.parse(copied.content)).toMatchObject({ name: '源项目副本', nodes: [{ id: 'audio' }] })
    expect(fs.readFileSync(path.join(target, 'assets', 'nested', 'sample.bin'), 'utf8')).toBe('asset-bytes')
    await expect(store.open(36, copied.project.id)).resolves.toMatchObject({ project: { name: '源项目副本' } })
  })

  it('rejects non-empty duplicate targets and legacy project copies without deleting user files', async () => {
    const { root, workspace, store } = createFixture('duplicate-reject')
    const created = await store.create(36, '源项目', workspace)
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-non-empty-'))
    roots.push(target)
    const marker = path.join(target, 'keep.txt')
    fs.writeFileSync(marker, 'keep', 'utf8')
    await expect(store.duplicate(36, created.project.id, '副本', target)).rejects.toThrow('必须为空')
    expect(fs.readFileSync(marker, 'utf8')).toBe('keep')

    const legacyId = '22222222-2222-4222-8222-222222222222'
    fs.writeFileSync(path.join(root, 'user-36', `${legacyId}.json`), JSON.stringify({
      version: 1,
      id: legacyId,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      workflow: JSON.parse(workflow('旧项目')),
    }), 'utf8')
    const emptyTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-legacy-target-'))
    roots.push(emptyTarget)
    await expect(store.duplicate(36, legacyId, '旧项目副本', emptyTarget)).rejects.toThrow('没有独立工作文件夹')
    expect(fs.readdirSync(emptyTarget)).toEqual([])
  })

  it('finds exact asset references without matching prompt substrings or other accounts', async () => {
    const { workspace, store } = createFixture('references')
    const assetId = 'B'.repeat(43)
    const created = await store.create(36, '引用项目', workspace)
    const content = JSON.parse(workflow('引用项目', 'exact')) as { nodes: Array<Record<string, unknown>> }
    content.nodes.push({
      id: 'substring', kind: 'text', definitionVersion: 1, position: { x: 0, y: 0 },
      data: { prompt: `prefix-${assetId}-suffix`, model: '' },
    })
    ;((content.nodes[0].data as { result: { assetId: string; localUrl: string } }).result).assetId = assetId
    ;((content.nodes[0].data as { result: { assetId: string; localUrl: string } }).result).localUrl = `xingmang-asset://audio/${assetId}`
    await store.save(36, created.project.id, JSON.stringify(content))

    await expect(store.findAssetReferences(36, assetId)).resolves.toEqual([{
      projectId: created.project.id,
      projectName: '引用项目',
      nodeIds: ['exact'],
      archived: false,
    }])
    await expect(store.findAssetReferences(37, assetId)).resolves.toEqual([])
  })

  it('serializes archive and auto-save mutations so later saves cannot revive archived data', async () => {
    const { workspace, store } = createFixture('queue')
    const created = await store.create(36, '队列项目', workspace)
    const archive = store.setArchived(36, created.project.id, true)
    const save = store.save(36, created.project.id, workflow('不应复活'))
    await expect(archive).resolves.toEqual(expect.objectContaining({ archivedAt: expect.any(String) }))
    await expect(save).rejects.toThrow('已归档')
    await expect(store.list(36)).resolves.toEqual([expect.objectContaining({ name: '队列项目', archivedAt: expect.any(String) })])
  })
})
