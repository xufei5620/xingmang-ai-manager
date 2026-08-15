import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AiAssetStore } from './ai-asset-store'
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
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('CanvasProjectAssetManager', () => {
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
        expect.objectContaining({ assetId: firstImage.assetId, mediaType: 'image' }),
        expect.objectContaining({ assetId: firstAudio.assetId, mediaType: 'audio' }),
      ]),
      total: 2,
    })
    await expect((await manager.forProject(7, second.project.id)).media.listOwnedPage(7)).resolves.toMatchObject({
      items: [expect.objectContaining({ assetId: secondVideo.assetId, mediaType: 'video' })],
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

    const chatImage = await globalContext.images.storeBase64(7, png)
    expect(fs.existsSync(path.join(globalOutput, 'user-7', '2026-08-14', chatImage.fileName))).toBe(true)
    expect(firstFiles).not.toContain(chatImage.fileName)
    await expect(manager.storeBase64(7, png)).rejects.toThrow('项目尚未选择')
  })
})
