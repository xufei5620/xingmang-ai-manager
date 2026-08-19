import path from 'node:path'
import type { AiAssetMetadata, AiAssetStore, AiOwnedAssetRead, AiStoredAsset } from './ai-asset-store'
import type { AiAudioAssetStore, AiAudioOwnedAssetRead } from './ai-audio-asset-store'
import type { AiAssetMetadataStore } from './ai-asset-metadata-store'
import { createAiMediaAssetService, type AiMediaAssetService } from './ai-media-asset-service'
import type { AiStoredVideoAsset, AiVideoAssetStore, AiVideoOwnedAssetRead } from './ai-video-asset-store'
import type { CanvasProjectStore } from './canvas-project-store'

const projectIdPattern = /^[a-f0-9-]{36}$/

export interface CanvasProjectAssetContext {
  images: AiAssetStore
  videos: AiVideoAssetStore
  audios: AiAudioAssetStore
  metadata: AiAssetMetadataStore
  media: AiMediaAssetService
}

export interface CanvasProjectAssetManagerOptions {
  projects: Pick<CanvasProjectStore, 'list' | 'getUsableWorkspaceDirectory'>
  global: CanvasProjectAssetContext
  create(outputRoot: string): CanvasProjectAssetContext
  onMetadataError?(error: unknown, context: { userId: number; assetId: string; source: 'generated' }): void
}

export interface CanvasProjectImageMetadata extends AiAssetMetadata {
  projectId?: string
}

function assertProjectId(projectId: string): void {
  if (!projectIdPattern.test(projectId)) throw new Error('画布项目标识无效')
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('画布项目账号标识无效')
}

function locationKey(userId: number, kind: 'image' | 'video' | 'audio', assetId: string): string {
  return `${userId}:${kind}:${assetId}`
}

export class CanvasProjectAssetManager {
  private readonly projects: CanvasProjectAssetManagerOptions['projects']
  private readonly global: CanvasProjectAssetContext
  private readonly createContext: CanvasProjectAssetManagerOptions['create']
  private readonly onMetadataError: CanvasProjectAssetManagerOptions['onMetadataError']
  private readonly contexts = new Map<string, Promise<CanvasProjectAssetContext>>()
  private readonly locations = new Map<string, string | null>()

  constructor(options: CanvasProjectAssetManagerOptions) {
    this.projects = options.projects
    this.global = options.global
    this.createContext = options.create
    this.onMetadataError = options.onMetadataError
  }

  async forProject(userId: number, projectId: string): Promise<CanvasProjectAssetContext> {
    assertUserId(userId)
    assertProjectId(projectId)
    const key = `${userId}:${projectId}`
    const existing = this.contexts.get(key)
    if (existing) return existing
    const pending = this.projects.getUsableWorkspaceDirectory(userId, projectId).then((workspaceDirectory) => {
      if (!workspaceDirectory) return this.global
      const context = this.createContext(path.join(workspaceDirectory, 'assets'))
      context.images.ensureOutputDirectory()
      return context
    }).catch((error) => {
      this.contexts.delete(key)
      throw error
    })
    this.contexts.set(key, pending)
    return pending
  }

  async prepareProject(userId: number, projectId?: string): Promise<void> {
    if (!projectId) throw new Error('画布项目尚未选择，无法保存生成素材')
    const context = await this.forProject(userId, projectId)
    context.images.ensureOutputDirectory()
  }

  async storeBase64(userId: number, value: string, metadata?: CanvasProjectImageMetadata): Promise<AiStoredAsset> {
    const projectId = this.requiredMetadataProjectId(metadata)
    const context = await this.forProject(userId, projectId)
    const asset = await context.images.storeBase64(userId, value, this.imageMetadata(metadata))
    await this.markGenerated(context, userId, asset.assetId)
    this.remember(userId, 'image', asset.assetId, projectId, context)
    return asset
  }

  async storeRemoteUrl(userId: number, url: string, metadata?: CanvasProjectImageMetadata): Promise<AiStoredAsset> {
    const projectId = this.requiredMetadataProjectId(metadata)
    const context = await this.forProject(userId, projectId)
    const asset = await context.images.storeRemoteUrl(userId, url, this.imageMetadata(metadata))
    await this.markGenerated(context, userId, asset.assetId)
    this.remember(userId, 'image', asset.assetId, projectId, context)
    return asset
  }

  async readImageOwned(userId: number, assetId: string, projectId?: string): Promise<AiOwnedAssetRead> {
    return projectId
      ? (await this.forProject(userId, projectId)).images.readOwned(userId, assetId)
      : this.readOwned(userId, assetId, 'image') as Promise<AiOwnedAssetRead>
  }

  async storeMp4(userId: number, bytes: Buffer, metadata: { taskId: string; projectId?: string }): Promise<AiStoredVideoAsset> {
    const projectId = this.requiredMetadataProjectId(metadata)
    const context = await this.forProject(userId, projectId)
    const asset = await context.videos.storeMp4(userId, bytes, { taskId: metadata.taskId })
    await this.markGenerated(context, userId, asset.assetId)
    this.remember(userId, 'video', asset.assetId, projectId, context)
    return asset
  }

  async readImageDataUri(userId: number, assetId: string, projectId?: string): Promise<string> {
    const owned = await this.readImageOwned(userId, assetId, projectId)
    if (owned.bytes.byteLength > 8 * 1024 * 1024) throw new Error('视频参考图片超过 8 MB 安全上限，请压缩后重试')
    return `data:${owned.asset.mimeType};base64,${owned.bytes.toString('base64')}`
  }

  async readMediaOwned(
    userId: number,
    assetId: string,
    kind: 'image' | 'video' | 'audio',
    projectId?: string,
  ): Promise<AiOwnedAssetRead | AiVideoOwnedAssetRead | AiAudioOwnedAssetRead> {
    if (!projectId) return this.readOwned(userId, assetId, kind)
    const context = await this.forProject(userId, projectId)
    return this.readFromContext(context, userId, assetId, kind)
  }

  async readOwned(
    userId: number,
    assetId: string,
    kind?: 'image' | 'video' | 'audio',
  ): Promise<AiOwnedAssetRead | AiVideoOwnedAssetRead | AiAudioOwnedAssetRead> {
    assertUserId(userId)
    if (!kind) {
      try { return await this.readOwned(userId, assetId, 'image') } catch {
        try { return await this.readOwned(userId, assetId, 'video') } catch {
          return this.readOwned(userId, assetId, 'audio')
        }
      }
    }
    const cachedProjectId = this.locations.get(locationKey(userId, kind, assetId))
    if (cachedProjectId !== undefined) {
      const context = cachedProjectId === null ? this.global : await this.forProject(userId, cachedProjectId)
      return this.readFromContext(context, userId, assetId, kind)
    }
    try {
      const owned = await this.readFromContext(this.global, userId, assetId, kind)
      this.locations.set(locationKey(userId, kind, assetId), null)
      return owned
    } catch {
      // Project workspaces are searched below. Asset identifiers are random,
      // so the first owned match is unambiguous and is cached for range reads.
    }
    const projects = await this.projects.list(userId)
    for (const project of projects) {
      if (!project.workspaceConfigured) continue
      try {
        const context = await this.forProject(userId, project.id)
        const owned = await this.readFromContext(context, userId, assetId, kind)
        this.remember(userId, kind, assetId, project.id, context)
        return owned
      } catch {
        // A missing workspace or non-matching asset does not hide assets in
        // the remaining user-owned projects.
      }
    }
    throw new Error('AI 素材不存在或无权访问')
  }

  private async readFromContext(
    context: CanvasProjectAssetContext,
    userId: number,
    assetId: string,
    kind: 'image' | 'video' | 'audio',
  ): Promise<AiOwnedAssetRead | AiVideoOwnedAssetRead | AiAudioOwnedAssetRead> {
    if (kind === 'image') return context.images.readOwned(userId, assetId)
    if (kind === 'video') return context.videos.readOwned(userId, assetId)
    return context.audios.readOwned(userId, assetId)
  }

  private remember(
    userId: number,
    kind: 'image' | 'video' | 'audio',
    assetId: string,
    projectId: string,
    context: CanvasProjectAssetContext,
  ): void {
    this.locations.set(locationKey(userId, kind, assetId), context === this.global ? null : projectId)
  }

  private async markGenerated(context: CanvasProjectAssetContext, userId: number, assetId: string): Promise<void> {
    try {
      await context.media.setSource(userId, assetId, 'generated')
    } catch (error) {
      this.onMetadataError?.(error, { userId, assetId, source: 'generated' })
    }
  }

  private requiredMetadataProjectId(metadata: { projectId?: string } | undefined): string {
    if (!metadata?.projectId) throw new Error('画布项目尚未选择，无法保存生成素材')
    assertProjectId(metadata.projectId)
    return metadata.projectId
  }

  private imageMetadata(metadata: CanvasProjectImageMetadata | undefined): AiAssetMetadata | undefined {
    return metadata?.revisedPrompt ? { revisedPrompt: metadata.revisedPrompt } : undefined
  }
}

export function createCanvasProjectAssetContext(
  images: AiAssetStore,
  videos: AiVideoAssetStore,
  audios: AiAudioAssetStore,
  metadata: AiAssetMetadataStore,
  trashItem: (filePath: string) => Promise<void>,
): CanvasProjectAssetContext {
  return {
    images,
    videos,
    audios,
    metadata,
    media: createAiMediaAssetService({ images, videos, audios, metadata, trashItem }),
  }
}
