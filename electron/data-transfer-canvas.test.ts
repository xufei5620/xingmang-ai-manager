import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'
import { AiAssetStore } from './ai-asset-store'
import { AiAudioAssetStore } from './ai-audio-asset-store'
import { AiVideoAssetStore } from './ai-video-asset-store'
import { CanvasProjectAssetManager, createCanvasProjectAssetContext } from './canvas-project-asset-manager'
import { CanvasProjectStore } from './canvas-project-store'
import {
  CANVAS_PROJECTS_FOLDER_NAME,
  CANVAS_PROJECTS_MANIFEST_FILE,
  createCanvasProjectsMigration,
  inspectCanvasProjectsFolder,
  parseCanvasProjectsManifest,
} from './data-transfer-canvas'
import { WORKS_FOLDER_NAME, createAccountWorksTransfer, inspectWorksFolder } from './data-transfer-works'
import type { DiskSpaceReading } from './disk-space'

const roots: string[] = []
const userId = 7
const now = () => new Date('2026-11-20T08:00:00.000Z')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
let serial = 0

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xingmang-canvas-transfer-${prefix}-`))
  roots.push(root)
  return root
}

function space(availableBytes: number): (target: string) => Promise<DiskSpaceReading> {
  return async (target) => ({ availableBytes, totalBytes: availableBytes * 2, measuredPath: target, deviceId: null })
}

const plenty = space(1024 ** 4)

function mp4(): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16), Buffer.from('mdatvideo')])
}

function localPng(width: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(3, 20)
  return bytes
}

/** The stores of one folder; every file stored in a test gets an id of its own. */
function storesAt(outputRoot: string) {
  const randomBytes = (size: number) => Buffer.alloc(size, (serial = serial % 250 + 1))
  return createCanvasProjectAssetContext(
    new AiAssetStore({ outputRoot, now, randomBytes }),
    new AiVideoAssetStore({ outputRoot, now, randomBytes }),
    new AiAudioAssetStore({ outputRoot, now }),
    new AiAssetMetadataStore({ outputRoot, now }),
    async () => undefined,
  )
}

/** One computer: its account library, its canvas projects, its 「星芒画布」 folder and the migration wired as the app wires it. */
function computer(label: string, readDiskSpace = plenty) {
  const libraryRoot = temporaryRoot(`${label}-library`)
  const projectsRoot = temporaryRoot(`${label}-records`)
  const canvasFolder = path.join(temporaryRoot(`${label}-documents`), '星芒画布')
  const global = storesAt(libraryRoot)
  const projects = new CanvasProjectStore(projectsRoot)
  const manager = new CanvasProjectAssetManager({ projects, global, create: storesAt })
  const transfer = createAccountWorksTransfer({
    outputRoot: libraryRoot,
    metadata: global.metadata,
    canvasFolders: (account) => manager.listLibraryFolders(account),
    canvasProjects: createCanvasProjectsMigration({ projects, assets: manager, projectsDirectory: () => canvasFolder, readDiskSpace }),
    readDiskSpace,
  })
  return { libraryRoot, projectsRoot, canvasFolder, global, projects, manager, transfer }
}

type Computer = ReturnType<typeof computer>

function workflowWith(name: string, results: Array<{ kind: 'image' | 'video'; assetId: string }>, edges = true) {
  const nodes = results.map((result, index) => ({
    id: `node-${index}`,
    kind: result.kind === 'image' ? 'image-generation' : 'video-generation',
    definitionVersion: 1,
    position: { x: index * 300, y: 0 },
    data: { prompt: '一只橘猫', model: 'gpt-image-2', result: { kind: result.kind, assetId: result.assetId, localUrl: `xingmang-asset://${result.kind}/${result.assetId}` } },
  }))
  return JSON.stringify({
    schemaVersion: 2,
    name,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: edges && nodes.length > 1 ? [{ id: 'edge-0', source: 'node-0', sourceHandle: 'out', target: 'node-1', targetHandle: 'in' }] : [],
  })
}

async function exportFrom(old: Computer) {
  const result = await old.transfer.exportTo(userId, { parentDirectory: temporaryRoot('export'), folderName: '星芒数据导出', dataContent: (summary) => JSON.stringify({ works: summary }) })
  const works = await inspectWorksFolder(result.dataFilePath)
  const canvas = await inspectCanvasProjectsFolder(result.dataFilePath)
  if (works.state !== 'ready' || canvas.state !== 'ready') throw new Error('export folder unreadable')
  return { result, works, canvas: { folder: canvas.folder, manifest: canvas.manifest } }
}

async function importInto(fresh: Computer, exported: Awaited<ReturnType<typeof exportFrom>>) {
  return fresh.transfer.importFrom(userId, exported.works.folder, exported.works.manifest, exported.canvas)
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe('canvas projects (迁移到新电脑)', () => {
  it('moves each project with its nodes, links and folder, and the new computer opens and lists it as before', async () => {
    const old = computer('old')
    const workspace = temporaryRoot('old-workspace')
    const project = (await old.projects.create(userId, '双十一主图', workspace)).project
    const made = await old.manager.storeBase64(userId, png, { projectId: project.id, prompt: '一只橘猫' })
    const clip = await old.manager.storeMp4(userId, mp4(), { taskId: 'video_transfer', projectId: project.id, prompt: '海边日落' })
    const folder = await old.manager.forProject(userId, project.id)
    await folder.media.rename(userId, made.assetId, '主图')
    // A picked reference picture is a material, not a work: it is not in the works folder, it goes with the project.
    const material = await folder.images.storeLocalBytes(userId, localPng(2))
    await folder.media.setSource(userId, material.assetId, 'imported')
    await old.projects.save(userId, project.id, workflowWith('双十一主图', [
      { kind: 'image', assetId: made.assetId },
      { kind: 'video', assetId: clip.assetId },
      { kind: 'image', assetId: material.assetId },
    ]))
    const chat = await old.global.images.storeBase64(userId, png)

    const summary = await old.transfer.summarize(userId)
    expect(summary).toMatchObject({ images: 2, videos: 1, canvasProjects: 1 })
    expect(summary).not.toHaveProperty('canvasProjectsUnreachable')
    const exported = await exportFrom(old)
    expect(exported.result).toMatchObject({ works: 3, canvasProjects: 1 })
    // What the project made is in the works folder once; only its material is copied beside the project.
    const [entry] = exported.canvas.manifest.projects
    expect(entry).toMatchObject({ id: project.id, legacy: false, files: [expect.objectContaining({ assetId: material.assetId })] })
    expect(entry.fromWorks.sort()).toEqual([made.assetId, clip.assetId].sort())
    expect(exported.works.manifest.files.map((file) => file.assetId)).not.toContain(material.assetId)
    // The project's folder on the old computer is the customer's own place: nothing in the export says where it was.
    const manifestText = fs.readFileSync(path.join(exported.canvas.folder, CANVAS_PROJECTS_MANIFEST_FILE), 'utf8')
    expect(manifestText).not.toContain(path.basename(workspace))
    expect(fs.readFileSync(path.join(exported.canvas.folder, project.id, 'workflow.json'), 'utf8')).not.toContain(path.basename(workspace))

    const fresh = computer('new')
    await expect(importInto(fresh, exported)).resolves.toEqual({
      status: 'done', added: 3, existing: 0, failed: 0, canvasProjects: { added: 1, existing: 0, full: 0, failed: 0 },
    })
    const [moved] = await fresh.projects.list(userId)
    expect(moved).toMatchObject({ id: project.id, name: '双十一主图', createdAt: project.createdAt, nodeCount: 3, workspaceStatus: 'ready', workspaceName: '双十一主图' })
    const opened = await fresh.projects.open(userId, project.id)
    expect(JSON.parse(opened.content)).toMatchObject({ edges: [expect.objectContaining({ id: 'edge-0' })] })
    // The project reads its pictures and clips from its own new folder under 「星芒画布」, as generation does.
    await expect(fresh.manager.readMediaOwned(userId, made.assetId, 'image', project.id)).resolves.toMatchObject({ asset: { assetId: made.assetId } })
    await expect(fresh.manager.readMediaOwned(userId, clip.assetId, 'video', project.id)).resolves.toMatchObject({ asset: { assetId: clip.assetId } })
    await expect(fresh.manager.readMediaOwned(userId, material.assetId, 'image', project.id)).resolves.toMatchObject({ asset: { assetId: material.assetId } })
    expect(await fresh.projects.getWorkspaceDirectory(userId, project.id)).toBe(path.join(fresh.canvasFolder, '双十一主图'))
    // The library lists the project's works as the project's, with their names and prompts; nothing is kept twice.
    const page = await fresh.manager.listLibrary(userId)
    expect(page.items.map((item) => item.assetId).sort()).toEqual([chat.assetId, made.assetId, clip.assetId].sort())
    expect(page.items.find((item) => item.assetId === made.assetId)).toMatchObject({ name: '主图', prompt: '一只橘猫', canvas: { projectId: project.id, projectName: '双十一主图' } })
    expect(filesUnder(path.join(fresh.libraryRoot, `user-${userId}`)).filter((file) => file.includes('xingmang-'))).toEqual([expect.stringContaining(chat.assetId)])

    // The same export once more adds nothing: the works are here, in the library or in the project's folder.
    await expect(importInto(fresh, exported)).resolves.toEqual({
      status: 'done', added: 0, existing: 3, failed: 0, canvasProjects: { added: 0, existing: 1, full: 0, failed: 0 },
    })
    expect(fs.readdirSync(fresh.canvasFolder)).toEqual(['双十一主图'])
  })

  it('keeps an archived project archived and a project without a folder of its own without one', async () => {
    const old = computer('kinds')
    const shelvedWorkspace = temporaryRoot('kinds-shelved')
    const shelved = (await old.projects.create(userId, '收起来的', shelvedWorkspace)).project
    const kept = await old.manager.storeBase64(userId, png, { projectId: shelved.id })
    await old.projects.save(userId, shelved.id, workflowWith('收起来的', [{ kind: 'image', assetId: kept.assetId }]))
    await old.projects.setArchived(userId, shelved.id, true)
    // A project from before projects had folders: its picture sits in the account library.
    const inLibrary = await old.global.images.storeBase64(userId, png)
    const legacyId = '11111111-1111-4111-8111-111111111111'
    fs.mkdirSync(path.join(old.projectsRoot, `user-${userId}`), { recursive: true })
    fs.writeFileSync(path.join(old.projectsRoot, `user-${userId}`, `${legacyId}.json`), JSON.stringify({
      version: 1, id: legacyId, createdAt: '2026-08-13T00:00:00Z', updatedAt: '2026-08-13 08:00', workflow: JSON.parse(workflowWith('老项目', [{ kind: 'image', assetId: inLibrary.assetId }])),
    }))

    const exported = await exportFrom(old)
    expect(exported.result.canvasProjects).toBe(2)
    // The archived project's work is not on the library page, so it travels with the project.
    expect(exported.canvas.manifest.projects.find((entry) => entry.id === shelved.id)?.files.map((file) => file.assetId)).toEqual([kept.assetId])
    // Old times that are not in the usual form still travel.
    expect(exported.canvas.manifest.projects.find((entry) => entry.id === legacyId)).toMatchObject({ legacy: true, createdAt: '2026-08-13T00:00:00Z', files: [], fromWorks: [] })

    const fresh = computer('kinds-new')
    await expect(importInto(fresh, exported)).resolves.toMatchObject({ status: 'done', canvasProjects: { added: 2 } })
    const listed = await fresh.projects.list(userId)
    expect(listed.find((project) => project.id === shelved.id)).toMatchObject({ archivedAt: expect.any(String), workspaceStatus: 'ready' })
    expect(listed.find((project) => project.id === legacyId)).toMatchObject({ name: '老项目', workspaceStatus: 'legacy' })
    await expect(fresh.manager.readMediaOwned(userId, inLibrary.assetId, 'image', legacyId)).resolves.toMatchObject({ asset: { assetId: inLibrary.assetId } })
    await expect(fresh.projects.setArchived(userId, shelved.id, false)).resolves.toMatchObject({ workspaceStatus: 'ready' })
    await expect(fresh.manager.readMediaOwned(userId, kept.assetId, 'image', shelved.id)).resolves.toMatchObject({ asset: { assetId: kept.assetId } })
  })

  it('counts a project whose folder cannot be reached instead of exporting it without its pictures', async () => {
    const old = computer('unplugged')
    const workspace = temporaryRoot('unplugged-workspace')
    const gone = (await old.projects.create(userId, 'U 盘上的', workspace)).project
    fs.rmSync(workspace, { recursive: true, force: true })
    const here = (await old.projects.create(userId, '本机的', temporaryRoot('unplugged-here'))).project

    await expect(old.transfer.summarize(userId)).resolves.toMatchObject({ canvasProjects: 1, canvasProjectsUnreachable: 1 })
    const exported = await exportFrom(old)
    expect(exported.canvas.manifest.projects.map((entry) => entry.id)).toEqual([here.id])
    expect(exported.canvas.manifest.projects.map((entry) => entry.id)).not.toContain(gone.id)
  })

  it('copies nothing for a project this computer has no room for, and leaves no folder behind for one it cannot register', async () => {
    const old = computer('room')
    const first = (await old.projects.create(userId, '第一个', temporaryRoot('room-first'))).project
    const made = await old.manager.storeBase64(userId, png, { projectId: first.id })
    await old.projects.save(userId, first.id, workflowWith('第一个', [{ kind: 'image', assetId: made.assetId }]))
    const second = (await old.projects.create(userId, '第二个', temporaryRoot('room-second'))).project
    const exported = await exportFrom(old)

    const fresh = computer('room-new')
    const seeded = path.join(fresh.projectsRoot, `user-${userId}`)
    fs.mkdirSync(seeded, { recursive: true })
    for (let index = 0; index < 100; index += 1) {
      const id = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`
      fs.writeFileSync(path.join(seeded, `${id}.json`), JSON.stringify({
        version: 3, id, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', lastOpenedAt: '2026-11-01T00:00:00.000Z',
        workflow: { schemaVersion: 2, name: `项目 ${index}`, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
      }))
    }
    // The project that cannot come keeps what it made in the account library, as before projects travelled.
    await expect(importInto(fresh, exported)).resolves.toEqual({
      status: 'done', added: 1, existing: 0, failed: 0, canvasProjects: { added: 0, existing: 0, full: 2, failed: 0 },
    })
    expect(fs.existsSync(fresh.canvasFolder)).toBe(false)
    expect(filesUnder(path.join(fresh.libraryRoot, `user-${userId}`)).some((file) => file.includes(made.assetId))).toBe(true)
    expect((await fresh.projects.list(userId)).map((project) => project.id)).not.toContain(second.id)

    // A project whose nodes were changed into something the canvas would not save is refused before anything is copied.
    const other = computer('room-tampered')
    fs.writeFileSync(path.join(exported.canvas.folder, first.id, 'workflow.json'), JSON.stringify({ schemaVersion: 2, name: '第一个', nodes: [{ id: 'x' }], edges: [] }))
    await expect(importInto(other, exported)).resolves.toMatchObject({ status: 'done', canvasProjects: { added: 1, failed: 1 } })
    expect(fs.readdirSync(other.canvasFolder)).toEqual(['第二个'])
    expect((await other.projects.list(userId)).map((project) => project.id)).toEqual([second.id])
  })

  it('takes back every file it put into the new folder when the project cannot be registered after all', async () => {
    const old = computer('rollback')
    const project = (await old.projects.create(userId, '项目', temporaryRoot('rollback-workspace'))).project
    const made = await old.manager.storeBase64(userId, png, { projectId: project.id })
    const folder = await old.manager.forProject(userId, project.id)
    const material = await folder.images.storeLocalBytes(userId, localPng(5))
    await folder.media.setSource(userId, material.assetId, 'imported')
    await old.projects.save(userId, project.id, workflowWith('项目', [{ kind: 'image', assetId: made.assetId }, { kind: 'image', assetId: material.assetId }]))
    const exported = await exportFrom(old)
    expect(exported.canvas.manifest.projects[0]).toMatchObject({ files: [expect.objectContaining({ assetId: material.assetId })], fromWorks: [made.assetId] })

    const fresh = computer('rollback-new')
    const failing = createAccountWorksTransfer({
      outputRoot: fresh.libraryRoot,
      metadata: fresh.global.metadata,
      canvasFolders: (account) => fresh.manager.listLibraryFolders(account),
      canvasProjects: createCanvasProjectsMigration({
        projects: {
          listTransferable: (account) => fresh.projects.listTransferable(account),
          admitTransferred: (account, id, archived) => fresh.projects.admitTransferred(account, id, archived),
          restoreTransferred: async () => { throw new Error('磁盘写入失败') },
        },
        assets: fresh.manager,
        projectsDirectory: () => fresh.canvasFolder,
        readDiskSpace: plenty,
      }),
      readDiskSpace: plenty,
    })
    // The project's work is not lost: it lands in the account library, as it did before projects travelled.
    await expect(importInto({ ...fresh, transfer: failing }, exported)).resolves.toEqual({
      status: 'done', added: 1, existing: 0, failed: 0, canvasProjects: { added: 0, existing: 0, full: 0, failed: 1 },
    })
    expect(fs.readdirSync(fresh.canvasFolder)).toEqual([])
    expect(filesUnder(path.join(fresh.libraryRoot, `user-${userId}`)).some((file) => file.includes(made.assetId))).toBe(true)
  })

  it('imports nothing when the works and the projects together do not fit', async () => {
    const old = computer('space')
    const project = (await old.projects.create(userId, '项目', temporaryRoot('space-workspace'))).project
    const material = await (await old.manager.forProject(userId, project.id)).images.storeLocalBytes(userId, localPng(4))
    await old.projects.save(userId, project.id, workflowWith('项目', [{ kind: 'image', assetId: material.assetId }]))
    const exported = await exportFrom(old)
    const fresh = computer('space-new', space(1024))
    await expect(importInto(fresh, exported)).resolves.toMatchObject({ status: 'no-space', availableBytes: 1024 })
    await expect(fresh.projects.list(userId)).resolves.toEqual([])
    expect(fs.existsSync(fresh.canvasFolder)).toBe(false)
  })

  it('leaves the projects out and still moves the works when the project list cannot be read', async () => {
    const libraryRoot = temporaryRoot('failing-library')
    const global = storesAt(libraryRoot)
    const chat = await global.images.storeBase64(userId, png)
    const transfer = createAccountWorksTransfer({
      outputRoot: libraryRoot,
      metadata: global.metadata,
      canvasProjects: createCanvasProjectsMigration({
        projects: {
          listTransferable: async () => { throw new Error('records unreadable') },
          admitTransferred: async () => 'ok',
          restoreTransferred: async () => 'added',
        },
        assets: { transferFolder: async () => null, transferTarget: () => { throw new Error('unused') }, forgetProject: () => undefined },
        projectsDirectory: () => temporaryRoot('failing-documents'),
      }),
      readDiskSpace: plenty,
    })
    await expect(transfer.summarize(userId)).resolves.toEqual(expect.not.objectContaining({ canvasProjects: expect.anything() }))
    const result = await transfer.exportTo(userId, { parentDirectory: temporaryRoot('failing-export'), folderName: '导出', dataContent: () => '{}' })
    expect(result).toMatchObject({ works: 1 })
    expect(result).not.toHaveProperty('canvasProjects')
    expect(fs.existsSync(path.join(result.folderPath, CANVAS_PROJECTS_FOLDER_NAME))).toBe(false)
    expect(fs.readdirSync(path.join(result.folderPath, WORKS_FOLDER_NAME), { recursive: true }).some((name) => String(name).includes(chat.assetId))).toBe(true)
  })
})

describe('parseCanvasProjectsManifest', () => {
  const id = '22222222-2222-4222-8222-222222222222'
  const assetId = 'B'.repeat(43)
  const times = { createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', lastOpenedAt: '2026-11-03T00:00:00.000Z' }
  const manifest = (projects: unknown[]) => JSON.stringify({ format: 'xingmang-canvas-projects', version: 1, projects })

  it('reads what the export writes', () => {
    expect(parseCanvasProjectsManifest(manifest([{ id, ...times, files: [{ path: `2026-11-01/xingmang-${assetId}.png`, bytes: 10 }], fromWorks: ['C'.repeat(43)], metadata: [] }]))).toEqual({
      projects: [expect.objectContaining({ id, legacy: false, files: [expect.objectContaining({ assetId, date: '2026-11-01' })], fromWorks: ['C'.repeat(43)] })],
    })
  })

  it('refuses a project folder or a file that points anywhere else, and anything else that is off', () => {
    const file = { path: `2026-11-01/xingmang-${assetId}.png`, bytes: 10 }
    for (const projects of [
      [{ id: '../outside', ...times, files: [], fromWorks: [] }],
      [{ id, ...times, files: [{ path: `../2026-11-01/xingmang-${assetId}.png`, bytes: 10 }], fromWorks: [] }],
      [{ id, ...times, files: [{ path: `2026-11-01/xingmang-${assetId}.exe`, bytes: 10 }], fromWorks: [] }],
      [{ id, ...times, files: [file, file], fromWorks: [] }],
      [{ id, ...times, files: [file], fromWorks: [assetId] }],
      [{ id, ...times, files: [], fromWorks: ['C:\\Windows'] }],
      [{ id, ...times, files: [file], fromWorks: [], legacy: true }],
      [{ id, ...times, createdAt: 'yesterday', files: [], fromWorks: [] }],
      [{ id, ...times, files: [], fromWorks: [] }, { id, ...times, files: [], fromWorks: [] }],
    ]) {
      expect(() => parseCanvasProjectsManifest(manifest(projects))).toThrow('画布项目清单无效')
    }
    expect(() => parseCanvasProjectsManifest('{ not json')).toThrow('画布项目清单无效')
    expect(() => parseCanvasProjectsManifest(JSON.stringify({ format: 'xingmang-works', version: 1, projects: [] }))).toThrow('画布项目清单无效')
  })

  it('looks only at the canvas projects folder beside the chosen file', async () => {
    const parent = temporaryRoot('inspect')
    const dataFile = path.join(parent, '星芒聊天记录与设置.json')
    await expect(inspectCanvasProjectsFolder(dataFile)).resolves.toEqual({ state: 'missing' })
    fs.mkdirSync(path.join(parent, CANVAS_PROJECTS_FOLDER_NAME))
    await expect(inspectCanvasProjectsFolder(dataFile)).resolves.toEqual({ state: 'unreadable' })
    fs.writeFileSync(path.join(parent, CANVAS_PROJECTS_FOLDER_NAME, CANVAS_PROJECTS_MANIFEST_FILE), manifest([]))
    await expect(inspectCanvasProjectsFolder(dataFile)).resolves.toMatchObject({ state: 'ready', manifest: { projects: [] } })
  })
})
