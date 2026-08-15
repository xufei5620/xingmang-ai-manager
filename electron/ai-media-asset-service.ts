import type { AiAssetStore, AiStoredAsset } from './ai-asset-store'
import type { AiStoredVideoAssetListItem, AiVideoAssetStore } from './ai-video-asset-store'
import type { AiAudioAssetStore, AiStoredAudioAssetListItem } from './ai-audio-asset-store'
import type { AiAssetMetadataStore } from './ai-asset-metadata-store'

export interface AiMediaAssetListQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
}

export interface AiMediaAssetListPage {
  items: Array<
    | (AiStoredAsset & { createdAt: string; mediaType: 'image'; thumbnailUrl: string; displayName: string })
    | (AiStoredVideoAssetListItem & { displayName: string })
    | (AiStoredAudioAssetListItem & { displayName: string })
  >
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export function createAiMediaAssetService(options: {
  images: Pick<AiAssetStore, 'readOwned' | 'listOwned' | 'copy' | 'saveAs' | 'contextMenu'>
  videos: Pick<AiVideoAssetStore, 'readOwned' | 'listOwned' | 'saveAs' | 'contextMenu'>
  audios?: Pick<AiAudioAssetStore, 'readOwned' | 'listOwned' | 'saveAs' | 'contextMenu'>
  metadata: Pick<AiAssetMetadataStore, 'getMany' | 'rename'>
}) {
  async function readOwned(userId: number, assetId: string, kind?: 'image' | 'video' | 'audio') {
    if (kind === 'image') return options.images.readOwned(userId, assetId)
    if (kind === 'video') return options.videos.readOwned(userId, assetId)
    if (kind === 'audio') {
      if (!options.audios) throw new Error('音频素材能力不可用')
      return options.audios.readOwned(userId, assetId)
    }
    try {
      return await options.images.readOwned(userId, assetId)
    } catch {
      try { return await options.videos.readOwned(userId, assetId) } catch {
        if (!options.audios) throw new Error('AI 素材不存在或无权访问')
        return options.audios.readOwned(userId, assetId)
      }
    }
  }

  async function listOwnedPage(userId: number, query: AiMediaAssetListQuery = {}): Promise<AiMediaAssetListPage> {
    const offset = query.offset ?? 0
    const limit = query.limit ?? 24
    const mediaType = query.mediaType ?? 'all'
    const search = query.search?.trim() ?? ''
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 500) throw new Error('AI 素材分页位置无效')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('AI 素材分页数量无效')
    if (!['all', 'image', 'video', 'audio'].includes(mediaType)) throw new Error('AI 素材媒体类型无效')
    if (search.length > 128 || /[\x00-\x1F\x7F]/.test(search)) throw new Error('AI 素材搜索内容无效')
    const [images, videos, audios] = await Promise.all([
      mediaType === 'video' || mediaType === 'audio' ? [] : options.images.listOwned(userId, 500),
      mediaType === 'image' || mediaType === 'audio' ? [] : options.videos.listOwned(userId, 500),
      mediaType === 'image' || mediaType === 'video' || !options.audios ? [] : options.audios.listOwned(userId, 500),
    ])
    const assets = [
      ...images.map((asset) => ({ ...asset, mediaType: 'image' as const, thumbnailUrl: asset.localUrl })),
      ...videos,
      ...audios,
    ]
    const metadata = await options.metadata.getMany(userId, assets.map((asset) => asset.assetId))
    const normalizedSearch = search.toLocaleLowerCase('zh-CN')
    const items = assets
      .map((asset) => ({ ...asset, displayName: metadata[asset.assetId]?.displayName ?? asset.fileName }))
      .filter((asset) => !normalizedSearch || [asset.displayName, asset.fileName, asset.assetId, 'revisedPrompt' in asset ? asset.revisedPrompt ?? '' : '']
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.assetId.localeCompare(left.assetId))
    const page = items.slice(offset, offset + limit)
    return { items: page, offset, limit, total: items.length, hasMore: offset + page.length < items.length }
  }

  async function assetKind(userId: number, assetId: string): Promise<'image' | 'video' | 'audio'> {
    try {
      await options.images.readOwned(userId, assetId)
      return 'image'
    } catch {
      try { await options.videos.readOwned(userId, assetId); return 'video' } catch {
        if (!options.audios) throw new Error('AI 素材不存在或无权访问')
        await options.audios.readOwned(userId, assetId); return 'audio'
      }
    }
  }

  async function copy(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (await assetKind(userId, assetId) !== 'image') throw new Error('视频不支持复制，请使用另存为')
    await options.images.copy(userId, assetId, authorize)
  }

  async function saveAs(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<boolean> {
    const kind = await assetKind(userId, assetId)
    if (kind === 'image') return options.images.saveAs(userId, assetId, authorize)
    if (kind === 'video') return options.videos.saveAs(userId, assetId, authorize)
    if (!options.audios) throw new Error('音频素材能力不可用')
    return options.audios.saveAs(userId, assetId, authorize)
  }

  async function contextMenu(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    const kind = await assetKind(userId, assetId)
    if (kind === 'image') return options.images.contextMenu(userId, assetId, authorize)
    if (kind === 'video') return options.videos.contextMenu(userId, assetId, authorize)
    if (!options.audios) throw new Error('音频素材能力不可用')
    return options.audios.contextMenu(userId, assetId, authorize)
  }

  async function rename(userId: number, assetId: string, displayName: string) {
    await readOwned(userId, assetId)
    const renamed = await options.metadata.rename(userId, assetId, displayName)
    return { assetId: renamed.assetId, displayName: renamed.displayName }
  }

  return { readOwned, listOwnedPage, copy, saveAs, contextMenu, rename }
}

export type AiMediaAssetService = ReturnType<typeof createAiMediaAssetService>
