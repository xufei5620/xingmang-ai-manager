import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { missingAiAssetMessages } from './ai-asset-missing'
import { AiAssetStore } from './ai-asset-store'
import { AiAudioAssetStore } from './ai-audio-asset-store'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'
import { AiVideoAssetStore } from './ai-video-asset-store'
import { CanvasProjectAssetManager, createCanvasProjectAssetContext } from './canvas-project-asset-manager'
import { canvasProjectImageMessages, createCanvasProjectImageIntake } from './canvas-project-image-intake'
import { CanvasProjectStore } from './canvas-project-store'

const roots: string[] = []
const now = () => new Date('2026-11-22T08:00:00.000Z')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const pngBytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64')
const userId = 7

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label))
  roots.push(root)
  return root
}

function mp4(): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16), Buffer.from('mdatvideo')])
}

let randomByte = 0
function context(outputRoot: string) {
  // Each store draws its own asset ids, as the real random source does.
  randomByte += 1
  const seed = randomByte
  let drawn = 0
  return createCanvasProjectAssetContext(
    new AiAssetStore({ outputRoot, now, randomBytes: (size) => { drawn += 1; return Buffer.alloc(size, seed * 16 + drawn) } }),
    new AiVideoAssetStore({ outputRoot, now }),
    new AiAudioAssetStore({ outputRoot, now }),
    new AiAssetMetadataStore({ outputRoot, now }),
    async () => undefined,
  )
}

function setup() {
  const projects = new CanvasProjectStore(temporaryRoot('xingmang-intake-projects-'))
  const global = context(temporaryRoot('xingmang-intake-global-'))
  const assets = new CanvasProjectAssetManager({ projects, global, create: context })
  const documents = temporaryRoot('xingmang-intake-documents-')
  const defaultRoot = path.join(documents, '星芒画布')
  const onSourceError = vi.fn()
  const intake = createCanvasProjectImageIntake({ projects, assets, defaultProjectsDirectory: () => defaultRoot, onSourceError })
  return { projects, global, assets, defaultRoot, intake, onSourceError }
}

async function imagesOf(media: ReturnType<typeof context>['media'], view: 'all' | 'trash' = 'all') {
  return (await media.listOwnedPage(userId, { mediaType: 'image', view })).items
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('createCanvasProjectImageIntake', () => {
  it('copies the one picture into the chosen project as an imported material and leaves the original where it was', async () => {
    const { projects, global, assets, intake, onSourceError } = setup()
    const picture = await global.images.storeBase64(userId, png)
    const other = await global.images.storeBase64(userId, png)
    const project = await projects.create(userId, '双 11 主图', temporaryRoot('xingmang-intake-workspace-'))

    await expect(intake(userId, { assetId: picture.assetId, projectId: project.project.id })).resolves.toEqual({
      projectId: project.project.id, projectName: '双 11 主图', created: false,
    })

    const inProject = await imagesOf((await assets.forProject(userId, project.project.id)).media)
    expect(inProject).toHaveLength(1)
    expect(inProject[0]).toMatchObject({ source: 'imported', mimeType: 'image/png' })
    // The copy is the project's own file under its own id: nothing in the project points back at the account library.
    expect(inProject[0].assetId).not.toBe(picture.assetId)
    const copied = await (await assets.forProject(userId, project.project.id)).images.readOwned(userId, inProject[0].assetId)
    expect(copied.bytes.equals(pngBytes)).toBe(true)
    // Only the picked picture went: the other one in the account library is not in the project.
    expect(inProject.some((entry) => entry.assetId === other.assetId)).toBe(false)
    // The account library still holds both, and the main window's library lists no duplicate for the copy.
    expect((await imagesOf(global.media)).map((entry) => entry.assetId).sort()).toEqual([picture.assetId, other.assetId].sort())
    expect((await assets.listLibrary(userId, {})).total).toBe(2)
    expect(onSourceError).not.toHaveBeenCalled()
  })

  it('keeps one copy when the same picture is added to the same project twice', async () => {
    const { projects, global, assets, intake } = setup()
    const picture = await global.images.storeBase64(userId, png)
    const project = await projects.create(userId, '海报', temporaryRoot('xingmang-intake-workspace-'))

    await intake(userId, { assetId: picture.assetId, projectId: project.project.id })
    await intake(userId, { assetId: picture.assetId, projectId: project.project.id })

    expect(await imagesOf((await assets.forProject(userId, project.project.id)).media)).toHaveLength(1)
  })

  it('takes the copy back out of the project bin when the picture is added again', async () => {
    const { projects, global, assets, intake } = setup()
    const picture = await global.images.storeBase64(userId, png)
    const project = await projects.create(userId, '海报', temporaryRoot('xingmang-intake-workspace-'))
    await intake(userId, { assetId: picture.assetId, projectId: project.project.id })
    const media = (await assets.forProject(userId, project.project.id)).media
    const [copy] = await imagesOf(media)
    await media.softDelete(userId, copy.assetId)
    expect(await imagesOf(media)).toHaveLength(0)

    await intake(userId, { assetId: picture.assetId, projectId: project.project.id })

    expect((await imagesOf(media)).map((entry) => entry.assetId)).toEqual([copy.assetId])
    expect(await imagesOf(media, 'trash')).toHaveLength(0)
  })

  it('writes nothing when the project already keeps the picture', async () => {
    const { projects, global, assets, intake } = setup()
    // A project with its own folder, adding a picture it made itself.
    const own = await projects.create(userId, '自己做的', temporaryRoot('xingmang-intake-workspace-'))
    const made = await assets.storeBase64(userId, png, { projectId: own.project.id })
    await intake(userId, { assetId: made.assetId, projectId: own.project.id })
    const inOwn = await imagesOf((await assets.forProject(userId, own.project.id)).media)
    expect(inOwn.map((entry) => [entry.assetId, entry.source])).toEqual([[made.assetId, 'generated']])

    // A project from before work folders: its material library is the account library, where the picture already is.
    const legacyId = '33333333-3333-3333-3333-333333333333'
    const legacyStore = { list: vi.fn(async () => [{ id: legacyId, name: '老项目' }] as never), create: vi.fn(), getUsableWorkspaceDirectory: vi.fn(async () => null) }
    const legacyAssets = new CanvasProjectAssetManager({ projects: legacyStore, global, create: context })
    const legacyIntake = createCanvasProjectImageIntake({ projects: legacyStore, assets: legacyAssets, defaultProjectsDirectory: () => temporaryRoot('xingmang-intake-unused-') })
    const chatPicture = await global.images.storeBase64(userId, png)
    await global.media.softDelete(userId, chatPicture.assetId)

    await expect(legacyIntake(userId, { assetId: chatPicture.assetId, projectId: legacyId })).resolves.toEqual({ projectId: legacyId, projectName: '老项目', created: false })

    // Still one file, under the same id, and out of the bin: the user has just asked for it.
    expect((await imagesOf(global.media)).map((entry) => entry.assetId)).toEqual([chatPicture.assetId])
  })

  it('reads the picture before it touches any project, and only from the picture libraries of this account', async () => {
    const { projects, global, assets, defaultRoot, intake } = setup()
    const project = await projects.create(userId, '海报', temporaryRoot('xingmang-intake-workspace-'))
    const picture = await global.images.storeBase64(userId, png)
    const video = await global.videos.storeMp4(userId, mp4(), { taskId: 'video_intake' })
    const before = await projects.list(userId)

    // Another account's id for the same picture, a video, an id nothing answers to.
    for (const [account, assetId] of [[8, picture.assetId], [userId, video.assetId], [userId, 'z'.repeat(43)]] as const) {
      await expect(intake(account, { assetId, projectId: project.project.id })).rejects.toThrow()
      await expect(intake(account, { assetId, newProjectName: '不该建出来' })).rejects.toThrow()
    }
    // A file removed outside the app says so in the store's own words.
    fs.rmSync(await global.images.resolveOwnedFilePath(userId, picture.assetId))
    await expect(intake(userId, { assetId: picture.assetId, projectId: project.project.id })).rejects.toThrow(missingAiAssetMessages.image)

    expect(await imagesOf((await assets.forProject(userId, project.project.id)).media)).toHaveLength(0)
    expect(await projects.list(userId)).toEqual(before)
    expect(await projects.list(8)).toEqual([])
    expect(fs.existsSync(defaultRoot)).toBe(false)
  })

  it('only accepts an unarchived project of this account', async () => {
    const { projects, global, assets, intake } = setup()
    const picture = await global.images.storeBase64(userId, png)
    const archived = await projects.create(userId, '收起来的', temporaryRoot('xingmang-intake-workspace-'))
    await projects.setArchived(userId, archived.project.id, true)
    const foreign = await projects.create(8, '别人的', temporaryRoot('xingmang-intake-workspace-'))

    for (const projectId of [archived.project.id, foreign.project.id, '44444444-4444-4444-4444-444444444444']) {
      await expect(intake(userId, { assetId: picture.assetId, projectId })).rejects.toThrow(canvasProjectImageMessages.projectGone)
    }
    expect(await imagesOf((await assets.forProject(userId, archived.project.id)).media)).toHaveLength(0)
    expect(await imagesOf((await assets.forProject(8, foreign.project.id)).media)).toHaveLength(0)
  })

  it('says the work folder cannot be reached instead of the system error and its path', async () => {
    const { projects, global, intake } = setup()
    const picture = await global.images.storeBase64(userId, png)
    const workspace = temporaryRoot('xingmang-intake-workspace-')
    const project = await projects.create(userId, '在移动硬盘上', workspace)
    fs.rmSync(workspace, { recursive: true, force: true })

    const failure = await intake(userId, { assetId: picture.assetId, projectId: project.project.id }).then(() => null, (error: Error) => error)
    expect(failure?.message).toBe(canvasProjectImageMessages.folderUnreachable)
    expect(failure?.message).not.toContain(workspace)
  })

  it('makes a new project in the default folder with the picture in its library', async () => {
    const { projects, global, assets, defaultRoot, intake } = setup()
    const picture = await global.images.storeBase64(userId, png)

    const result = await intake(userId, { assetId: picture.assetId, newProjectName: '一只橘猫坐在窗台上' })

    expect(result).toMatchObject({ projectName: '一只橘猫坐在窗台上', created: true })
    const listed = await projects.list(userId)
    expect(listed.map((project) => [project.id, project.name, project.workspaceStatus])).toEqual([[result.projectId, '一只橘猫坐在窗台上', 'ready']])
    // A new folder of its own under the default place, named after the project, like the canvas's own 「新建项目」.
    expect(await projects.getWorkspaceDirectory(userId, result.projectId)).toBe(path.join(defaultRoot, '一只橘猫坐在窗台上'))
    const inProject = await imagesOf((await assets.forProject(userId, result.projectId)).media)
    expect(inProject.map((entry) => entry.source)).toEqual(['imported'])
    // A second one with the same name gets its own folder; the first is not reused.
    const second = await intake(userId, { assetId: picture.assetId, newProjectName: '一只橘猫坐在窗台上' })
    expect(await projects.getWorkspaceDirectory(userId, second.projectId)).toBe(path.join(defaultRoot, '一只橘猫坐在窗台上 (2)'))
  })

  it('leaves no project, no picture and no folder behind when the new project cannot be registered', async () => {
    const { projects, global, assets, defaultRoot } = setup()
    const picture = await global.images.storeBase64(userId, png)
    const full = { list: projects.list.bind(projects), create: vi.fn(async () => { throw new Error('画布项目最多 100 个（不含已归档），请先归档部分不再使用的项目') }) }
    const intake = createCanvasProjectImageIntake({ projects: full, assets, defaultProjectsDirectory: () => defaultRoot })

    await expect(intake(userId, { assetId: picture.assetId, newProjectName: '放不下的' })).rejects.toThrow('画布项目最多 100 个')

    expect(await projects.list(userId)).toEqual([])
    expect(filesUnder(defaultRoot)).toEqual([])
    expect(fs.existsSync(path.join(defaultRoot, '放不下的'))).toBe(false)
  })

  it('reports a default folder that cannot be made without its path, and creates nothing', async () => {
    const { projects, global, assets } = setup()
    const picture = await global.images.storeBase64(userId, png)
    // The place for new projects is a file, so no folder can be made in it.
    const blocked = path.join(temporaryRoot('xingmang-intake-blocked-'), '星芒画布')
    fs.writeFileSync(blocked, '')
    const intake = createCanvasProjectImageIntake({ projects, assets, defaultProjectsDirectory: () => blocked })

    const failure = await intake(userId, { assetId: picture.assetId, newProjectName: '建不出来的' }).then(() => null, (error: Error) => error)
    expect(failure?.message).toMatch(/^无法在「星芒画布」文件夹中新建项目（.+），图片未添加。请在画布中新建项目后重试。$/)
    expect(failure?.message).not.toContain(blocked)
    expect(await projects.list(userId)).toEqual([])
  })
})
