import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { missingAiAssetMessages } from './ai-asset-missing'
import { AiAssetStore } from './ai-asset-store'
import { createAiImageService } from './ai-image-service'
import { AiAudioAssetStore } from './ai-audio-asset-store'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'
import { AiVideoAssetStore } from './ai-video-asset-store'
import { CanvasProjectAssetManager, createCanvasProjectAssetContext } from './canvas-project-asset-manager'
import { CanvasProjectStore } from './canvas-project-store'

const roots: string[] = []
const now = () => new Date('2026-08-14T08:00:00.000Z')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label))
  roots.push(root)
  return root
}

function mp4(): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16), Buffer.from('mdatvideo')])
}

function wav(): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(24)])
}

function context(outputRoot: string, randomByte = 1) {
  return createCanvasProjectAssetContext(
    new AiAssetStore({ outputRoot, now, randomBytes: () => Buffer.alloc(32, randomByte) }),
    new AiVideoAssetStore({ outputRoot, now }),
    new AiAudioAssetStore({ outputRoot, now }),
    new AiAssetMetadataStore({ outputRoot, now }),
    async () => undefined,
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('CanvasProjectAssetManager', () => {
  it('isolates equal user IDs even when both realms select the same project workspace', async () => {
    const workspace = temporaryRoot('xingmang-dual-workspace-')
    const projectId = '22222222-2222-2222-2222-222222222222'
    const projects = { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => workspace) }
    const xm = new CanvasProjectAssetManager({ projects, global: context(temporaryRoot('xm-global-')), create: context })
    const api = new CanvasProjectAssetManager({ projects, realmId: 'api-account', global: context(temporaryRoot('api-global-')), create: context })
    const oldAsset = await xm.storeBase64(7, png, { projectId })
    await expect((await api.forProject(7, projectId)).images.readOwned(7, oldAsset.assetId)).rejects.toThrow()
    const newAsset = await api.storeBase64(7, png, { projectId })
    const oldPath = await (await xm.forProject(7, projectId)).images.resolveOwnedFilePath(7, oldAsset.assetId)
    const newPath = await (await api.forProject(7, projectId)).images.resolveOwnedFilePath(7, newAsset.assetId)
    expect(newPath).not.toBe(oldPath)
    expect(newPath).toContain(path.join('assets', 'realms', 'api-account'))
  })
  it('resolves a file path for assets that live in a project workspace, not just the global root', async () => {
    // Thumbnail derivation needs a real path. Resolving it against the global
    // store alone left every project-workspace asset without a thumbnail, and
    // the tray rendered a placeholder for all of them.
    const projectId = '22222222-2222-2222-2222-222222222222'
    const globalRoot = temporaryRoot('xingmang-global-')
    const projectRoot = temporaryRoot('xingmang-project-')
    const projectContext = context(projectRoot, 2)
    const stored = await projectContext.images.storeBase64(7, png)

    const manager = new CanvasProjectAssetManager({
      projects: {
        list: vi.fn(async () => [{ id: projectId, workspaceConfigured: true }] as never),
        getUsableWorkspaceDirectory: vi.fn(async () => projectRoot),
      },
      global: context(globalRoot, 1),
      create: () => projectContext,
    })

    await expect(manager.resolveOwnedFilePath(7, stored.assetId, 'image')).resolves.toContain(projectRoot)
    await expect(manager.resolveOwnedFilePath(7, 'z'.repeat(43), 'image')).rejects.toThrow('不存在或无权访问')
  })

  it('finds the copy in a duplicated project once the remembered original is gone', async () => {
    // O14: a copied project keeps its assets' ids, so the place remembered for
    // the original must not hide the copy once the original's files move.
    const projectDataRoot = temporaryRoot('xingmang-copy-projects-')
    const originalWorkspace = temporaryRoot('xingmang-copy-original-')
    const copyWorkspace = temporaryRoot('xingmang-copy-target-')
    const projects = new CanvasProjectStore(projectDataRoot)
    const original = await projects.create(7, '原项目', originalWorkspace)
    const manager = new CanvasProjectAssetManager({ projects, global: context(temporaryRoot('xingmang-copy-global-'), 2), create: context })
    const image = await manager.storeBase64(7, png, { projectId: original.project.id })
    const video = await manager.storeMp4(7, mp4(), { taskId: 'video_copy', projectId: original.project.id })
    await expect(manager.readOwned(7, image.assetId, 'image')).resolves.toMatchObject({ asset: { assetId: image.assetId } })
    await expect(manager.readOwnedVideoRange(7, video.assetId, () => null)).resolves.toMatchObject({ totalBytes: mp4().length })

    await projects.duplicate(7, original.project.id, '副本', copyWorkspace)
    fs.renameSync(path.join(originalWorkspace, 'assets'), path.join(originalWorkspace, 'moved-away'))

    await expect(manager.readOwned(7, image.assetId, 'image')).resolves.toMatchObject({ asset: { assetId: image.assetId } })
    await expect(manager.readOwned(7, image.assetId)).resolves.toMatchObject({ asset: { assetId: image.assetId } })
    await expect(manager.resolveOwnedFilePath(7, image.assetId, 'image')).resolves.toContain(copyWorkspace)
    await expect(manager.readOwnedVideoRange(7, video.assetId, () => ({ start: 4, end: 7 }))).resolves.toEqual({
      asset: { mimeType: 'video/mp4' }, totalBytes: mp4().length, bytes: mp4().subarray(4, 8),
    })
    await expect(manager.resolveOwnedFilePath(7, video.assetId, 'video')).resolves.toContain(copyWorkspace)
    // Another account with the same asset id still finds nothing.
    await expect(manager.readOwned(8, image.assetId, 'image')).rejects.toThrow('不存在或无权访问')
  })

  it('still refuses a remembered asset whose only remaining copy fails the file checks', async () => {
    const projectDataRoot = temporaryRoot('xingmang-link-projects-')
    const originalWorkspace = temporaryRoot('xingmang-link-original-')
    const copyWorkspace = temporaryRoot('xingmang-link-target-')
    const projects = new CanvasProjectStore(projectDataRoot)
    const original = await projects.create(7, '原项目', originalWorkspace)
    const manager = new CanvasProjectAssetManager({ projects, global: context(temporaryRoot('xingmang-link-global-'), 2), create: context })
    const image = await manager.storeBase64(7, png, { projectId: original.project.id })
    await projects.duplicate(7, original.project.id, '副本', copyWorkspace)
    const copied = await manager.resolveOwnedFilePath(7, image.assetId, 'image')
    expect(copied).toContain(originalWorkspace)
    fs.renameSync(path.join(originalWorkspace, 'assets'), path.join(originalWorkspace, 'moved-away'))
    // A second name for the copy's file: the store refuses multi-link files.
    const copyFile = copied.replace(originalWorkspace, copyWorkspace)
    fs.linkSync(copyFile, path.join(temporaryRoot('xingmang-link-elsewhere-'), 'second-name.png'))

    // The copy is not served, and the error is still the one the remembered place gave.
    await expect(manager.readOwned(7, image.assetId, 'image')).rejects.toThrow(missingAiAssetMessages.image)
  })

  it('probes the project context before a paid request without touching the probe for resumed work', async () => {
    const assertWritable = vi.fn(async () => undefined)
    const ensureOutputDirectory = vi.fn()
    const global = { images: { ensureOutputDirectory, assertWritable }, videos: {}, audios: {}, metadata: {}, media: {} }
    const manager = new CanvasProjectAssetManager({
      projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => null) },
      global: global as never,
      create: vi.fn(),
    })
    const projectId = '11111111-1111-1111-1111-111111111111'

    await manager.prepareProject(7, projectId)
    expect(assertWritable).not.toHaveBeenCalled()
    await manager.assertWritable(7, projectId)
    expect(assertWritable).toHaveBeenCalledWith(7)
    await expect(manager.assertWritable(7)).rejects.toThrow('画布项目尚未选择')
  })

  it('tags a stored picture in the library it was stored in and keeps the tags already on it', async () => {
    const globalOutput = temporaryRoot('xingmang-global-output-')
    const workspace = temporaryRoot('xingmang-tag-workspace-')
    const ownFolder = '11111111-1111-1111-1111-111111111111'
    const sharedLibrary = '22222222-2222-2222-2222-222222222222'
    const projects = {
      list: vi.fn(async () => []),
      getUsableWorkspaceDirectory: vi.fn(async (_userId: number, projectId: string) => projectId === ownFolder ? workspace : null),
    }
    const globalContext = context(globalOutput, 2)
    const manager = new CanvasProjectAssetManager({ projects, global: globalContext, create: context })

    const inWorkspace = await manager.storeBase64(7, png, { projectId: ownFolder, prompt: '一只猫' })
    const projectContext = await manager.forProject(7, ownFolder)
    await projectContext.media.updateMetadata(7, inWorkspace.assetId, { tags: ['角色'] })
    await manager.addImageTag(7, [inWorkspace.assetId], '已停止，但已扣费', ownFolder)
    await expect(projectContext.media.listOwnedPage(7)).resolves.toMatchObject({
      items: [expect.objectContaining({ assetId: inWorkspace.assetId, tags: ['角色', '已停止，但已扣费'], source: 'generated', prompt: '一只猫' })],
    })
    await expect(globalContext.metadata.getMany(7, [inWorkspace.assetId])).resolves.toEqual({})

    const inLibrary = await manager.storeBase64(7, png, { projectId: sharedLibrary })
    await manager.addImageTag(7, [inLibrary.assetId], '已停止，但已扣费', sharedLibrary)
    await expect(globalContext.metadata.getMany(7, [inLibrary.assetId])).resolves.toMatchObject({
      [inLibrary.assetId]: { tags: ['已停止，但已扣费'] },
    })
    await expect(manager.addImageTag(7, [inLibrary.assetId], '已停止，但已扣费')).rejects.toThrow('项目尚未选择')
  })

  it('puts a picture paid for before a stop into the paying account library with the stop tag', async () => {
    const globalOutput = temporaryRoot('xingmang-global-output-')
    const workspace = temporaryRoot('xingmang-stop-workspace-')
    const projectId = '11111111-1111-1111-1111-111111111111'
    const manager = new CanvasProjectAssetManager({
      projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => workspace) },
      global: context(globalOutput, 2),
      create: context,
    })
    // 直接等发请求和停止后收尾这两个回调本身，不用 vi.waitFor 的 1 秒轮询：发请求前要
    // 先探一次能不能写，收尾要存图、打标签，都是带刷盘的原子写，Windows CI 上撞过
    // 1 秒（#1515、#1534 的 vitest-3）。
    let answer!: (value: Response) => void
    let requested!: () => void
    const dispatched = new Promise<void>((resolve) => { requested = resolve })
    let userId = 7
    const finished = vi.fn()
    const finishedAfterStop = new Promise((resolve) => { finished.mockImplementation(resolve) })
    const service = createAiImageService({
      baseUrl: 'https://xm.solov.cc',
      credentials: {
        resolveCredential: vi.fn(async (group: string) => ({
          userId, group, models: ['gpt-image-2'], keyCreated: false, apiKey: 'sk-test-only', keyId: 1, keyName: 'image',
        })),
      },
      fetchImpl: vi.fn(() => new Promise<Response>((resolve) => {
        answer = resolve
        requested()
      })) as unknown as typeof fetch,
      finishDispatchedAfterStop: true,
      onFinishedAfterStop: finished,
      assets: {
        prepareProject: (owner, project) => manager.prepareProject(owner, project),
        assertWritable: (owner, project) => manager.assertWritable(owner, project),
        storeBase64: (owner, value, metadata) => manager.storeBase64(owner, value, metadata),
        storeRemoteUrl: (owner, url, metadata) => manager.storeRemoteUrl(owner, url, metadata),
        readOwned: (owner, assetId, project) => manager.readImageOwned(owner, assetId, project),
        addTag: (owner, assetIds, tag, project) => manager.addImageTag(owner, assetIds, tag, project),
      },
    })
    const pending = service.generate(4, {
      requestId: 'canvas-run:paid', group: '图片模型', model: 'gpt-image-2', prompt: '一只猫', expectedUserId: 7, projectId,
    })
    await dispatched
    expect(service.cancelSender(4)).toBe(1)
    await expect(pending).rejects.toThrow('已停止等待')

    // Another account signs in before the answer arrives.
    userId = 9
    answer(new Response(JSON.stringify({ data: [{ b64_json: png.slice(png.indexOf(',') + 1) }] }), { status: 200 }))
    await expect(finishedAfterStop).resolves.toEqual({ requestId: 'canvas-run:paid', stored: 1 })
    expect(finished).toHaveBeenCalledTimes(1)

    const paying = await manager.forProject(7, projectId)
    await expect(paying.media.listOwnedPage(7)).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ mediaType: 'image', source: 'generated', prompt: '一只猫', tags: ['已停止，但已扣费'] })],
    })
    await expect((await manager.forProject(9, projectId)).media.listOwnedPage(9)).resolves.toMatchObject({ total: 0 })
  })

  it('keeps a saved generated asset usable when only source metadata persistence fails', async () => {
    const asset = { assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, mimeType: 'image/png', fileName: 'generated.png' }
    const metadataError = new Error('metadata disk full')
    const onMetadataError = vi.fn()
    const global = {
      images: { ensureOutputDirectory: vi.fn(), storeBase64: vi.fn(async () => asset) },
      videos: {}, audios: {}, metadata: {},
      media: { setSource: vi.fn(async () => { throw metadataError }) },
    }
    const manager = new CanvasProjectAssetManager({
      projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => null) },
      global: global as never,
      create: vi.fn(),
      onMetadataError,
    })

    await expect(manager.storeBase64(7, png, { projectId: '11111111-1111-1111-1111-111111111111' })).resolves.toEqual(asset)
    expect(onMetadataError).toHaveBeenCalledWith(metadataError, { userId: 7, assetId: asset.assetId, source: 'generated' })
  })

  it('fills a folder that is not a project yet and finds the same files once the folder is registered', async () => {
    const projectDataRoot = temporaryRoot('xingmang-import-projects-')
    const workspace = temporaryRoot('xingmang-import-workspace-')
    const globalOutput = temporaryRoot('xingmang-import-global-')
    const projects = new CanvasProjectStore(projectDataRoot)
    const manager = new CanvasProjectAssetManager({ projects, global: context(globalOutput, 2), create: context })

    const stored = await manager.forNewWorkspace(workspace).images.storeBase64(7, png)
    expect(fs.readdirSync(path.join(workspace, 'assets', 'user-7', '2026-08-14'))).toHaveLength(1)
    expect(fs.readdirSync(globalOutput)).toEqual([])
    const created = await projects.createImported(7, '导入的项目', workspace, JSON.stringify({
      schemaVersion: 2, name: '包', edges: [],
      nodes: [{ id: 'image', kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', result: { kind: 'image', assetId: stored.assetId, localUrl: stored.localUrl, mimeType: 'image/png' } } }],
    }))
    await expect((await manager.forProject(7, created.project.id)).images.readOwned(7, stored.assetId)).resolves.toBeTruthy()

    const api = new CanvasProjectAssetManager({ projects, realmId: 'api-account', global: context(temporaryRoot('xingmang-import-api-global-')), create: context })
    const apiWorkspace = temporaryRoot('xingmang-import-api-workspace-')
    await api.forNewWorkspace(apiWorkspace).images.storeBase64(7, png)
    expect(fs.existsSync(path.join(apiWorkspace, 'assets', 'realms', 'api-account', 'user-7'))).toBe(true)
    expect(() => manager.forNewWorkspace('relative/folder')).toThrow('画布项目工作文件夹无效')
  })

  it('isolates generated and imported media in each selected project folder while leaving global output unchanged', async () => {
    const projectDataRoot = temporaryRoot('xingmang-project-data-')
    const globalOutput = temporaryRoot('xingmang-global-output-')
    const firstWorkspace = temporaryRoot('xingmang-first-workspace-')
    const secondWorkspace = temporaryRoot('xingmang-second-workspace-')
    const sourceRoot = temporaryRoot('xingmang-audio-source-')
    const audioPath = path.join(sourceRoot, 'reference.wav')
    fs.writeFileSync(audioPath, wav())

    const projects = new CanvasProjectStore(projectDataRoot)
    const first = await projects.create(7, '项目一', firstWorkspace)
    const second = await projects.create(7, '项目二', secondWorkspace)
    const globalContext = context(globalOutput, 2)
    const manager = new CanvasProjectAssetManager({ projects, global: globalContext, create: context })

    const firstImage = await manager.storeBase64(7, png, { projectId: first.project.id })
    const firstContext = await manager.forProject(7, first.project.id)
    const firstAudio = await firstContext.audios.storeLocalFile(7, audioPath)
    const secondVideo = await manager.storeMp4(7, mp4(), { taskId: 'video_project_two', projectId: second.project.id })

    const firstFiles = fs.readdirSync(path.join(firstWorkspace, 'assets', 'user-7', '2026-08-14'))
    const secondFiles = fs.readdirSync(path.join(secondWorkspace, 'assets', 'user-7', '2026-08-14'))
    expect(firstFiles).toEqual(expect.arrayContaining([firstImage.fileName, firstAudio.fileName]))
    expect(firstFiles).not.toContain(secondVideo.fileName)
    expect(secondFiles).toEqual([secondVideo.fileName])
    expect(fs.existsSync(path.join(globalOutput, 'user-7'))).toBe(false)

    await expect(firstContext.media.listOwnedPage(7)).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ assetId: firstImage.assetId, mediaType: 'image', source: 'generated' }),
        expect.objectContaining({ assetId: firstAudio.assetId, mediaType: 'audio' }),
      ]),
      total: 2,
    })
    await expect((await manager.forProject(7, second.project.id)).media.listOwnedPage(7)).resolves.toMatchObject({
      items: [expect.objectContaining({ assetId: secondVideo.assetId, mediaType: 'video', source: 'generated' })],
      total: 1,
    })

    const secondImage = await manager.storeBase64(7, png, { projectId: second.project.id })
    const secondContext = await manager.forProject(7, second.project.id)
    expect(secondImage.assetId).toBe(firstImage.assetId)
    await firstContext.media.rename(7, firstImage.assetId, '项目一主视觉')
    await secondContext.media.rename(7, secondImage.assetId, '项目二主视觉')
    await expect(firstContext.media.listOwnedPage(7)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ assetId: firstImage.assetId, displayName: '项目一主视觉' })]),
    })
    await expect(secondContext.media.listOwnedPage(7)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ assetId: secondImage.assetId, displayName: '项目二主视觉' })]),
    })

    const restarted = new CanvasProjectAssetManager({ projects, global: context(globalOutput, 2), create: context })
    await expect(restarted.readOwned(7, firstImage.assetId, 'image')).resolves.toMatchObject({ asset: { assetId: firstImage.assetId } })
    await expect(restarted.readOwned(7, firstAudio.assetId, 'audio')).resolves.toMatchObject({ asset: { assetId: firstAudio.assetId } })
    await expect(restarted.readOwned(7, secondVideo.assetId, 'video')).resolves.toMatchObject({ asset: { assetId: secondVideo.assetId } })
    // The asset protocol's ranged read finds the same project video, for a fresh manager too, and only that account's.
    const ranged = new CanvasProjectAssetManager({ projects, global: context(globalOutput, 2), create: context })
    await expect(ranged.readOwnedVideoRange(7, secondVideo.assetId, () => ({ start: 4, end: 7 }))).resolves.toEqual({
      asset: { mimeType: 'video/mp4' }, totalBytes: mp4().length, bytes: mp4().subarray(4, 8),
    })
    await expect(ranged.readOwnedVideoRange(7, secondVideo.assetId, () => null)).resolves.toMatchObject({ bytes: Buffer.alloc(0) })
    await expect(ranged.readOwnedVideoRange(8, secondVideo.assetId, () => null)).rejects.toThrow('不存在或无权访问')

    const chatImage = await globalContext.images.storeBase64(7, png)
    expect(fs.existsSync(path.join(globalOutput, 'user-7', '2026-08-14', chatImage.fileName))).toBe(true)
    expect(firstFiles).not.toContain(chatImage.fileName)
    await expect(manager.storeBase64(7, png)).rejects.toThrow('项目尚未选择')
  })

  it('shows a picture imported again from the recycle bin in the library, once, as the user left it (R28-7)', async () => {
    const assets = context(temporaryRoot('xingmang-reimport-output-'))
    const sourceRoot = temporaryRoot('xingmang-reimport-source-')
    function pngFile(name: string, width: number): string {
      const bytes = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      bytes.write('IHDR', 12, 'ascii')
      bytes.writeUInt32BE(width, 16)
      bytes.writeUInt32BE(3, 20)
      const filePath = path.join(sourceRoot, name)
      fs.writeFileSync(filePath, bytes)
      return filePath
    }
    // What the canvas does for a picked or dropped file (canvas-window.ts importCanvasAsset).
    async function importFile(filePath: string) {
      const asset = await assets.images.storeLocalFile(7, filePath)
      await assets.media.setSource(7, asset.assetId, 'imported')
      return asset
    }
    async function listed(view: 'all' | 'trash') {
      const page = await assets.media.listOwnedPage(7, { view })
      return page.items.map((item) => ({ assetId: item.assetId, displayName: item.displayName, favorite: item.favorite, tags: item.tags }))
    }

    const poster = pngFile('poster.png', 2)
    const first = await importFile(poster)
    await assets.media.rename(7, first.assetId, '海报')
    await assets.media.updateMetadata(7, first.assetId, { favorite: true, tags: ['主视觉'] })
    await assets.media.softDelete(7, first.assetId)
    await expect(listed('all')).resolves.toEqual([])

    const again = await importFile(poster)
    expect(again.assetId).toBe(first.assetId)
    const kept = { assetId: first.assetId, displayName: '海报', favorite: true, tags: ['主视觉'] }
    await expect(listed('all')).resolves.toEqual([kept])
    await expect(listed('trash')).resolves.toEqual([])

    // Importing what is already in the library adds nothing; other content is a new picture.
    await importFile(poster)
    const other = await importFile(pngFile('other.png', 5))
    expect(other.assetId).not.toBe(first.assetId)
    const library = await listed('all')
    expect(library).toHaveLength(2)
    expect(library).toEqual(expect.arrayContaining([kept, expect.objectContaining({ assetId: other.assetId, favorite: false, tags: [] })]))
    await expect(listed('trash')).resolves.toEqual([])
  })
})

describe('the account-wide library the main window lists (融合第 5 步)', () => {
  let serial = 0
  /** Like context(), but every stored file gets an id of its own, across all folders of a test. */
  function distinct(outputRoot: string) {
    const randomBytes = (size: number) => Buffer.alloc(size, (serial = serial % 250 + 1))
    return createCanvasProjectAssetContext(
      new AiAssetStore({ outputRoot, now, randomBytes }),
      new AiVideoAssetStore({ outputRoot, now, randomBytes }),
      new AiAudioAssetStore({ outputRoot, now }),
      new AiAssetMetadataStore({ outputRoot, now }),
      async () => undefined,
    )
  }
  function localPng(width: number): Buffer {
    const bytes = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
    bytes.write('IHDR', 12, 'ascii')
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(3, 20)
    return bytes
  }
  const ids = (page: { items: readonly { assetId: string }[] }) => page.items.map((item) => item.assetId).sort()

  it('lists the account library together with what each unarchived project made in its own folder', async () => {
    const projects = new CanvasProjectStore(temporaryRoot('xingmang-library-projects-'))
    const workspace = temporaryRoot('xingmang-library-workspace-')
    const shelvedWorkspace = temporaryRoot('xingmang-library-shelved-')
    const globalContext = distinct(temporaryRoot('xingmang-library-global-'))
    const manager = new CanvasProjectAssetManager({ projects, global: globalContext, create: distinct })
    const project = (await projects.create(7, '双十一主图', workspace)).project
    const shelved = (await projects.create(7, '收起来的', shelvedWorkspace)).project

    const chatImage = await globalContext.images.storeBase64(7, png)
    const made = await manager.storeBase64(7, png, { projectId: project.id, prompt: '一只橘猫' })
    const clip = await manager.storeMp4(7, mp4(), { taskId: 'video_library', projectId: project.id, prompt: '海边日落' })
    const folder = await manager.forProject(7, project.id)
    // What the canvas does for a picked or dropped file: a material, not a work.
    const imported = await folder.images.storeLocalBytes(7, localPng(2))
    await folder.media.setSource(7, imported.assetId, 'imported')
    const binned = await manager.storeBase64(7, png, { projectId: project.id })
    await folder.media.softDelete(7, binned.assetId)
    const inShelved = await manager.storeBase64(7, png, { projectId: shelved.id })
    await projects.setArchived(7, shelved.id, true)

    const page = await manager.listLibrary(7)
    expect(ids(page)).toEqual([chatImage.assetId, made.assetId, clip.assetId].sort())
    expect(page.counts).toEqual({ image: 2, video: 1, film: 0 })
    const origin = { projectId: project.id, projectName: '双十一主图' }
    expect(page.items.find((item) => item.assetId === chatImage.assetId)).not.toHaveProperty('canvas')
    expect(page.items.find((item) => item.assetId === made.assetId)).toMatchObject({ mediaType: 'image', prompt: '一只橘猫', canvas: origin })
    expect(page.items.find((item) => item.assetId === clip.assetId)).toMatchObject({ mediaType: 'video', prompt: '海边日落', canvas: origin })
    expect(JSON.stringify(page)).not.toContain(path.basename(workspace))
    expect(ids(page)).not.toContain(inShelved.assetId)

    // One project on its own, by its name in the search, and by kind.
    expect(ids(await manager.listLibrary(7, { canvasProjectId: project.id }))).toEqual([made.assetId, clip.assetId].sort())
    expect(ids(await manager.listLibrary(7, { search: '双十一' }))).toEqual([made.assetId, clip.assetId].sort())
    expect(ids(await manager.listLibrary(7, { kind: 'film', filmAssetIds: [clip.assetId, made.assetId] }))).toEqual([clip.assetId])
    // An archived project, a project of nobody and another account list nothing; a malformed id is refused.
    await expect(manager.listLibrary(7, { canvasProjectId: shelved.id })).resolves.toMatchObject({ items: [], total: 0 })
    await expect(manager.listLibrary(7, { canvasProjectId: '99999999-9999-4999-8999-999999999999' })).resolves.toMatchObject({ items: [], total: 0 })
    await expect(manager.listLibrary(8)).resolves.toMatchObject({ items: [], total: 0 })
    await expect(manager.listLibrary(8, { canvasProjectId: project.id })).resolves.toMatchObject({ items: [], total: 0 })
    await expect(manager.listLibrary(7, { canvasProjectId: '../../etc/passwd' })).rejects.toThrow('画布项目标识无效')
    await expect(manager.listLibrary(7, { limit: 61 })).rejects.toThrow('AI 素材分页数量无效')
    await expect(manager.listLibrary(0)).rejects.toThrow('画布项目账号标识无效')
  })

  it('marks what a project without a folder holds, and calls only what was generated its own work', async () => {
    const legacyId = '11111111-1111-4111-8111-111111111111'
    const otherId = '22222222-2222-4222-8222-222222222222'
    const globalContext = distinct(temporaryRoot('xingmang-library-legacy-global-'))
    const sources = [
      { id: legacyId, name: '旧项目', workspaceStatus: 'legacy' as const, assetIds: [] as string[] },
      { id: otherId, name: '后来的', workspaceStatus: 'legacy' as const, assetIds: [] as string[] },
    ]
    const manager = new CanvasProjectAssetManager({
      projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => null), listLibrarySources: vi.fn(async () => sources) },
      global: globalContext,
      create: distinct,
    })
    const generated = await manager.storeBase64(7, png, { projectId: legacyId, prompt: '一只橘猫' })
    const chatImage = await globalContext.images.storeBase64(7, png)
    const untouched = await globalContext.images.storeBase64(7, png)
    sources[0]!.assetIds = [generated.assetId, chatImage.assetId, 'z'.repeat(43)]
    // The first project in the list keeps the asset when two hold it.
    sources[1]!.assetIds = [generated.assetId]

    const page = await manager.listLibrary(7)
    expect(ids(page)).toEqual([generated.assetId, chatImage.assetId, untouched.assetId].sort())
    expect(page.items.find((item) => item.assetId === generated.assetId)?.canvas).toEqual({ projectId: legacyId, projectName: '旧项目' })
    expect(page.items.find((item) => item.assetId === chatImage.assetId)?.canvas).toEqual({ projectId: legacyId, projectName: '旧项目', used: true })
    expect(page.items.find((item) => item.assetId === untouched.assetId)).not.toHaveProperty('canvas')

    expect(ids(await manager.listLibrary(7, { canvasProjectId: legacyId }))).toEqual([generated.assetId])
    expect(ids(await manager.listLibrary(7, { canvasProjectId: otherId }))).toEqual([generated.assetId])
  })

  it('lists a copied asset once, lists nothing for a folder that cannot be reached, and never fails the page', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111'
    const copyId = '22222222-2222-4222-8222-222222222222'
    const goneId = '33333333-3333-4333-8333-333333333333'
    const brokenId = '44444444-4444-4444-8444-444444444444'
    const firstWorkspace = temporaryRoot('xingmang-library-first-')
    const copyWorkspace = temporaryRoot('xingmang-library-copy-')
    const globalContext = distinct(temporaryRoot('xingmang-library-copy-global-'))
    const listLibrarySources = vi.fn(async () => [
      { id: copyId, name: '副本', workspaceStatus: 'ready' as const, assetIds: [] },
      { id: firstId, name: '原项目', workspaceStatus: 'ready' as const, assetIds: [] },
      { id: goneId, name: '文件夹不在了', workspaceStatus: 'missing' as const, assetIds: [] },
      { id: brokenId, name: '读不了', workspaceStatus: 'ready' as const, assetIds: [] },
    ])
    const manager = new CanvasProjectAssetManager({
      projects: {
        list: vi.fn(async () => []),
        getUsableWorkspaceDirectory: vi.fn(async (_userId: number, projectId: string) => {
          if (projectId === firstId) return firstWorkspace
          if (projectId === copyId) return copyWorkspace
          throw new Error('画布项目工作文件夹不存在')
        }),
        listLibrarySources,
      },
      global: globalContext,
      create: distinct,
    })
    const original = await manager.storeBase64(7, png, { projectId: firstId })
    // A copied project keeps the ids of what it copied.
    fs.cpSync(path.join(firstWorkspace, 'assets'), path.join(copyWorkspace, 'assets'), { recursive: true })

    const page = await manager.listLibrary(7)
    expect(ids(page)).toEqual([original.assetId])
    expect(page.total).toBe(1)
    await expect(manager.listLibrary(7, { canvasProjectId: goneId })).resolves.toMatchObject({ total: 0 })
    await expect(manager.listLibrary(7, { canvasProjectId: brokenId })).resolves.toMatchObject({ total: 0 })

    // Without a project list the account library still lists.
    const chatImage = await globalContext.images.storeBase64(7, png)
    const failing = new CanvasProjectAssetManager({
      projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => null), listLibrarySources: vi.fn(async () => { throw new Error('disk') }) },
      global: globalContext,
      create: distinct,
    })
    expect(ids(await failing.listLibrary(7))).toEqual([chatImage.assetId])
    const plain = new CanvasProjectAssetManager({ projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => null) }, global: globalContext, create: distinct })
    expect(ids(await plain.listLibrary(7))).toEqual([chatImage.assetId])
  })

  it('reads the project list and each folder at most once in five seconds, and shows a new work at once', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111'
    const workspace = temporaryRoot('xingmang-library-snapshot-')
    let clock = 1_000_000
    const listLibrarySources = vi.fn(async () => [{ id: projectId, name: '项目', workspaceStatus: 'ready' as const, assetIds: [] }])
    const manager = new CanvasProjectAssetManager({
      projects: { list: vi.fn(async () => []), getUsableWorkspaceDirectory: vi.fn(async () => workspace), listLibrarySources },
      global: distinct(temporaryRoot('xingmang-library-snapshot-global-')),
      create: distinct,
      now: () => clock,
    })
    const first = await manager.storeBase64(7, png, { projectId })
    expect(ids(await manager.listLibrary(7))).toEqual([first.assetId])
    expect(listLibrarySources).toHaveBeenCalledOnce()

    // What the manager stores itself is listed straight away.
    const second = await manager.storeBase64(7, png, { projectId })
    const clip = await manager.storeMp4(7, mp4(), { taskId: 'video_snapshot', projectId })
    expect(ids(await manager.listLibrary(7))).toEqual([first.assetId, second.assetId, clip.assetId].sort())

    // A file that reached the folder some other way shows after the snapshot ages out.
    const folder = await manager.forProject(7, projectId)
    const aside = await folder.images.storeBase64(7, png)
    clock += 4_999
    expect(ids(await manager.listLibrary(7))).not.toContain(aside.assetId)
    expect(listLibrarySources).toHaveBeenCalledOnce()
    clock += 1
    expect(ids(await manager.listLibrary(7))).toContain(aside.assetId)
    expect(listLibrarySources).toHaveBeenCalledTimes(2)
    // A clock that went backwards does not keep an old snapshot alive.
    clock -= 60_000
    await manager.listLibrary(7)
    expect(listLibrarySources).toHaveBeenCalledTimes(3)
  })
})

describe('holderOf', () => {
  it('answers with the place that holds a picture or video, and with the account library when none does', async () => {
    const projects = new CanvasProjectStore(temporaryRoot('xingmang-holder-projects-'))
    const workspace = temporaryRoot('xingmang-holder-workspace-')
    const globalRoot = temporaryRoot('xingmang-holder-global-')
    const globalContext = context(globalRoot, 2)
    const manager = new CanvasProjectAssetManager({ projects, global: globalContext, create: (outputRoot) => context(outputRoot, 3) })
    const project = (await projects.create(7, '项目', workspace)).project
    const chatImage = await globalContext.images.storeBase64(7, png)
    const made = await manager.storeBase64(7, png, { projectId: project.id })
    const clip = await manager.storeMp4(7, mp4(), { taskId: 'video_holder', projectId: project.id })

    await expect(manager.holderOf(7, 'image', chatImage.assetId)).resolves.toBe(globalContext)
    const folder = await manager.holderOf(7, 'image', made.assetId)
    expect(folder).not.toBe(globalContext)
    await expect(folder.images.resolveOwnedFilePath(7, made.assetId)).resolves.toContain(workspace)
    await expect((await manager.holderOf(7, 'video', clip.assetId)).videos.resolveOwnedFilePath(7, clip.assetId)).resolves.toContain(workspace)
    // A fresh manager has remembered nothing and still finds the folder.
    const fresh = new CanvasProjectAssetManager({ projects, global: globalContext, create: (outputRoot) => context(outputRoot, 3) })
    await expect((await fresh.holderOf(7, 'image', made.assetId)).images.readOwned(7, made.assetId)).resolves.toMatchObject({ asset: { assetId: made.assetId } })

    // Nobody's asset, the wrong kind and another account get the account library, whose own read then refuses.
    for (const holder of [
      await manager.holderOf(7, 'image', 'z'.repeat(43)),
      await manager.holderOf(7, 'video', made.assetId),
      await manager.holderOf(8, 'image', made.assetId),
    ]) expect(holder).toBe(globalContext)
    await expect(globalContext.images.readOwned(8, made.assetId)).rejects.toThrow(missingAiAssetMessages.image)
    await expect(manager.holderOf(0, 'image', made.assetId)).rejects.toThrow('画布项目账号标识无效')
  })
})
