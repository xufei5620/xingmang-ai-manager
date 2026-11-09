import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasProjectStore } from './canvas-project-store'
import { setRelocatedFolderPolicy } from './relocated-folders'

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

/** Writes project records straight into the store, so limits can be reached without a hundred folders. */
function seedProjects(root: string, userId: number, count: number, archived: boolean): void {
  const directory = path.join(root, `user-${userId}`)
  fs.mkdirSync(directory, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID()
    const now = new Date(Date.UTC(2026, 10, 9, 0, 0, index % 60)).toISOString()
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
      version: 3, id, createdAt: now, updatedAt: now, lastOpenedAt: now, ...(archived ? { archivedAt: now } : {}),
      workflow: { schemaVersion: 2, name: `${archived ? '归档' : '项目'} ${index}`, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    }))
  }
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

  it('binds a project whose folder was moved to the folder the user picks, with its assets', async () => {
    const { workspace, store } = createFixture('relink')
    const created = await store.create(36, '搬走的项目', workspace)
    await store.save(36, created.project.id, workflow('搬走的项目'))
    const moved = `${workspace}-moved`
    roots.push(moved)
    fs.renameSync(workspace, moved)
    const relinked = await store.relinkWorkspace(36, created.project.id, moved)
    expect(relinked).toMatchObject({ id: created.project.id, workspaceStatus: 'ready', workspaceName: path.basename(moved), assetCount: 1 })
    await expect(store.getWorkspaceDirectory(36, created.project.id)).resolves.toBe(path.resolve(moved))
    await expect(store.open(36, created.project.id)).resolves.toMatchObject({ project: { workspaceStatus: 'ready' } })
  })

  it('refuses to relink a project whose folder is still there, archived or legacy projects, and another account', async () => {
    const { workspace, store } = createFixture('relink-ready')
    const created = await store.create(36, '好好的项目', workspace)
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-relink-elsewhere-'))
    roots.push(elsewhere)
    await expect(store.relinkWorkspace(36, created.project.id, elsewhere)).rejects.toThrow('项目的工作文件夹还在')
    await expect(store.relinkWorkspace(37, created.project.id, elsewhere)).rejects.toThrow()
    fs.rmSync(workspace, { recursive: true, force: true })
    await store.setArchived(36, created.project.id, true)
    await expect(store.relinkWorkspace(36, created.project.id, elsewhere)).rejects.toThrow('请先恢复已归档项目')
    await expect(store.getWorkspaceDirectory(36, created.project.id)).resolves.toBe(path.resolve(workspace))
  })

  it('refuses a folder bound to another project and a folder without the assets a project uses', async () => {
    const { workspace, store } = createFixture('relink-checks')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-relink-other-'))
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-relink-empty-'))
    roots.push(other, empty)
    const created = await store.create(36, '有素材的项目', workspace)
    await store.save(36, created.project.id, workflow('有素材的项目'))
    await store.create(36, '另一个项目', other)
    fs.rmSync(workspace, { recursive: true, force: true })
    await expect(store.relinkWorkspace(36, created.project.id, other)).rejects.toThrow('该工作文件夹已绑定项目「另一个项目」')
    await expect(store.relinkWorkspace(36, created.project.id, empty)).rejects.toThrow('所选文件夹里没有这个项目的素材')
    expect(fs.readdirSync(empty)).toEqual([])
    await expect(store.relinkWorkspace(36, created.project.id, path.join(empty, 'nowhere'))).rejects.toThrow('工作文件夹不存在')
    await expect(store.list(36)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: created.project.id, workspaceStatus: 'missing' })]))
  })

  it('relinks a project without assets to any folder of its own', async () => {
    const { workspace, store } = createFixture('relink-blank')
    const created = await store.create(36, '空项目', workspace)
    fs.rmSync(workspace, { recursive: true, force: true })
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-relink-fresh-'))
    roots.push(fresh)
    await expect(store.relinkWorkspace(36, created.project.id, fresh)).resolves.toMatchObject({ workspaceStatus: 'ready' })
    expect(fs.existsSync(path.join(fresh, 'assets'))).toBe(true)
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

  it('saves the open workflow as a new project and copies the source project assets', async () => {
    const { workspace, store } = createFixture('save-as')
    const source = await store.create(36, '源项目', workspace)
    await store.save(36, source.project.id, workflow('源项目'))
    fs.writeFileSync(path.join(workspace, 'assets', 'sample.bin'), 'asset-bytes', 'utf8')
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-save-as-target-'))
    roots.push(target)
    const edited = workflow('源项目', 'edited-audio')

    const created = await store.createWithContent(36, '源项目 · 本地副本', target, edited, source.project.id)

    expect(created.project).toEqual(expect.objectContaining({ name: '源项目 · 本地副本', nodeCount: 1, assetCount: 1, workspaceStatus: 'ready' }))
    expect(JSON.parse(created.content)).toMatchObject({ name: '源项目 · 本地副本', nodes: [{ id: 'edited-audio' }] })
    expect(fs.readFileSync(path.join(target, 'assets', 'sample.bin'), 'utf8')).toBe('asset-bytes')
    await expect(store.open(36, created.project.id)).resolves.toMatchObject({ project: { name: '源项目 · 本地副本' } })
    // The source project is untouched.
    expect(JSON.parse((await store.open(36, source.project.id)).content)).toMatchObject({ nodes: [{ id: 'audio' }] })
  })

  it('refuses a save-as with unsafe content, another account\'s source or an archived source', async () => {
    const { workspace, store } = createFixture('save-as-reject')
    const source = await store.create(36, '源项目', workspace)
    await store.save(36, source.project.id, workflow('源项目'))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-save-as-reject-target-'))
    roots.push(target)
    const unsafe = JSON.parse(workflow('源项目'))
    unsafe.nodes[0].data.apiKey = 'sk-secret'

    await expect(store.createWithContent(36, '副本', target, JSON.stringify(unsafe), source.project.id)).rejects.toThrow('未知或敏感字段')
    await expect(store.createWithContent(37, '副本', target, workflow('源项目'), source.project.id)).rejects.toThrow()
    await store.setArchived(36, source.project.id, true)
    await expect(store.createWithContent(36, '副本', target, workflow('源项目'), source.project.id)).rejects.toThrow('已归档')
    expect(fs.readdirSync(target)).toEqual([])
    await expect(store.list(36)).resolves.toHaveLength(1)
    await expect(store.list(37)).resolves.toEqual([])
  })

  it('creates a project from content alone only when it uses no assets', async () => {
    const { workspace, store } = createFixture('content-only')
    const plain = JSON.stringify({
      schemaVersion: 2, name: '模板', nodes: [{ id: 'note', kind: 'note', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', settings: { text: 'https://example.com 开头的便签' } } }], edges: [],
    })

    const created = await store.createWithContent(36, '新项目', workspace, plain)
    expect(JSON.parse(created.content)).toMatchObject({ name: '新项目', nodes: [{ id: 'note' }] })
    expect(fs.existsSync(path.join(workspace, 'assets'))).toBe(true)

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-content-assets-'))
    roots.push(other)
    await expect(store.createWithContent(36, '新项目二', other, workflow('带素材'))).rejects.toThrow('请从原项目另存副本')
    await expect(store.list(36)).resolves.toHaveLength(1)
  })

  it('registers an imported project whose assets are already in its folder, with the folder checks of create', async () => {
    const { workspace, store } = createFixture('imported')
    fs.mkdirSync(path.join(workspace, 'assets'))
    fs.writeFileSync(path.join(workspace, 'assets', 'already-imported.wav'), 'wav')

    const created = await store.createImported(36, '导入的项目', workspace, workflow('包里的名字'))
    expect(JSON.parse(created.content)).toMatchObject({ name: '导入的项目', nodes: [{ id: 'audio' }] })
    expect(created.project).toMatchObject({ name: '导入的项目', nodeCount: 1, assetCount: 1, workspaceStatus: 'ready' })
    expect(fs.readFileSync(path.join(workspace, 'assets', 'already-imported.wav'), 'utf8')).toBe('wav')
    await expect(store.open(36, created.project.id)).resolves.toMatchObject({ project: { id: created.project.id } })

    await expect(store.createImported(36, '再导一次', workspace, workflow('包'))).rejects.toThrow('已绑定项目「导入的项目」')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-imported-other-'))
    roots.push(other)
    await expect(store.createImported(36, '名字\n带换行', other, workflow('包'))).rejects.toThrow('项目名称无效')
    const unsafe = { ...JSON.parse(workflow('包')), apiKey: 'sk-should-not-be-stored' }
    await expect(store.createImported(36, '不安全', other, JSON.stringify(unsafe))).rejects.toThrow('未知或敏感字段')
    await expect(store.createImported(36, '不在的文件夹', path.join(other, 'missing'), workflow('包'))).rejects.toThrow()
    await expect(store.list(36)).resolves.toHaveLength(1)
  })

  it('does not count archived projects toward the hundred and refuses to restore one past it', async () => {
    const { root, workspace, store } = createFixture('limit')
    seedProjects(root, 36, 99, false)
    seedProjects(root, 36, 150, true)
    const hundredth = await store.create(36, '第一百个', workspace)
    expect((await store.list(36)).filter((project) => !project.archivedAt)).toHaveLength(100)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-limit-other-'))
    roots.push(other)
    await expect(store.create(36, '第一百零一个', other)).rejects.toThrow('画布项目最多 100 个（已归档的不算），请先归档一些不用的项目')
    await expect(store.createImported(36, '导入的', other, workflow('包'))).rejects.toThrow('已归档的不算')
    const archived = (await store.list(36)).find((project) => project.archivedAt)!
    await expect(store.setArchived(36, archived.id, false)).rejects.toThrow('请先归档一个再恢复')

    await store.setArchived(36, hundredth.project.id, true)
    await expect(store.setArchived(36, archived.id, false)).resolves.not.toHaveProperty('archivedAt')
    await expect(store.create(36, '第一百零一个', other)).rejects.toThrow('已归档的不算')
  })

  it('stops at five hundred projects counting the archived ones', async () => {
    const { root, workspace, store } = createFixture('stored-limit')
    seedProjects(root, 36, 500, true)
    await expect(store.list(36)).resolves.toHaveLength(500)
    await expect(store.create(36, '新项目', workspace)).rejects.toThrow('画布项目连同已归档的最多 500 个，请先在「已归档」里删掉一些')
  })

  it('removes only an archived project and only its record', async () => {
    const { workspace, store } = createFixture('remove')
    const created = await store.create(36, '旧海报', workspace)
    fs.writeFileSync(path.join(workspace, 'assets', 'image.png'), 'png')
    await expect(store.remove(36, created.project.id)).rejects.toThrow('请先归档这个项目再删除')
    await store.setArchived(36, created.project.id, true)
    await expect(store.remove(37, created.project.id)).rejects.toThrow()

    const removed = await store.remove(36, created.project.id)
    expect(removed).toMatchObject({ project: { id: created.project.id, name: '旧海报' }, workspaceDirectory: path.resolve(workspace) })
    await expect(store.list(36)).resolves.toEqual([])
    await expect(store.open(36, created.project.id)).rejects.toThrow()
    expect(fs.readFileSync(path.join(workspace, 'assets', 'image.png'), 'utf8')).toBe('png')
    // The folder is free again for a new project.
    await expect(store.create(36, '新海报', workspace)).resolves.toMatchObject({ project: { name: '新海报' } })
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

/** A profile whose 文档 was moved to "another disk" and left a junction behind (「C 盘搬家」). */
function relocatedDocuments(root: string): { home: string; documents: string } {
  const home = path.join(root, 'Users', 'alice')
  const moved = path.join(root, 'D', 'Documents')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(moved, { recursive: true })
  const documents = path.join(home, 'Documents')
  // Junctions need no privilege on Windows; POSIX ignores the type argument.
  fs.symlinkSync(moved, documents, 'junction')
  return { home, documents }
}

describe('CanvasProjectStore on a relocated documents folder', () => {
  afterEach(() => setRelocatedFolderPolicy(null))

  it('accepts a workspace in or at a 文档 folder that was moved to another disk', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-relocated-')))
    roots.push(root)
    const { home, documents } = relocatedDocuments(root)
    const inside = path.join(documents, '我的画布')
    fs.mkdirSync(inside)
    setRelocatedFolderPolicy({ homeDirectories: [home], acceptsTarget: () => true })
    const store = new CanvasProjectStore(path.join(root, 'projects'))

    const nested = await store.create(36, '搬家后的项目', inside)
    const atFolder = await store.create(36, '直接选文档', documents)

    await expect(store.getWorkspaceDirectory(36, nested.project.id)).resolves.toBe(inside)
    await expect(store.getWorkspaceDirectory(36, atFolder.project.id)).resolves.toBe(documents)
    expect(fs.existsSync(path.join(inside, 'assets'))).toBe(true)
  })

  it('keeps refusing the relocated folder while no policy accepts it', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-relocated-')))
    roots.push(root)
    const { documents } = relocatedDocuments(root)
    const store = new CanvasProjectStore(path.join(root, 'projects'))

    await expect(store.create(36, '搬家后的项目', documents)).rejects.toThrow()
  })
})
