import path from 'node:path'
import type { AiAssetMetadata, AiAssetStore, AiOwnedAssetRead, AiStoredAsset } from './ai-asset-store'
import type { AiAudioAssetStore, AiAudioOwnedAssetRead } from './ai-audio-asset-store'
import type { AiAssetMetadataStore } from './ai-asset-metadata-store'
import {
  assertAiMediaLibraryQuery, createAiMediaAssetService, pageAiMediaLibraryRows,
  type AiMediaAssetService, type AiMediaLibraryPage, type AiMediaLibraryQuery, type AiMediaLibraryRow,
} from './ai-media-asset-service'
import type { AiStoredVideoAsset, AiVideoAssetStore, AiVideoOwnedAssetRead, AiVideoOwnedRangeRead } from './ai-video-asset-store'
import type { ByteRange } from './byte-range'
import type { CanvasProjectLibrarySource, CanvasProjectStore } from './canvas-project-store'

const projectIdPattern = /^[a-f0-9-]{36}$/
// How long one look at the project list and at a project folder answers for the main window's library.
// The page re-reads it whenever the window comes to the front, a picture arrives or a picker opens, and
// each read would otherwise parse every project file and walk every project folder again. What a project
// generates through this manager drops its folder's snapshot at once, so new work is not held back by it.
const LIBRARY_SNAPSHOT_MS = 5_000
const MAXIMUM_LIBRARY_SNAPSHOTS = 512

export interface CanvasProjectAssetContext {
  images: AiAssetStore
  videos: AiVideoAssetStore
  audios: AiAudioAssetStore
  metadata: AiAssetMetadataStore
  media: AiMediaAssetService
}

export interface CanvasProjectAssetManagerOptions {
  /** Separate foreign-realm media even if a user explicitly selects the same workspace. */
  realmId?: 'xm-account' | 'api-account'
  /** Without listLibrarySources the account-wide library lists the account library alone. */
  projects: Pick<CanvasProjectStore, 'list' | 'getUsableWorkspaceDirectory'> & Partial<Pick<CanvasProjectStore, 'listLibrarySources'>>
  global: CanvasProjectAssetContext
  create(outputRoot: string): CanvasProjectAssetContext
  onMetadataError?(error: unknown, context: { userId: number; assetId: string; source: 'generated' }): void
  /** Milliseconds; injected so tests can age the library snapshots. */
  now?: () => number
}

/** The main window's library query (融合第 5 步): one folder's query, optionally narrowed to one canvas project. */
export interface CanvasAccountLibraryQuery extends AiMediaLibraryQuery {
  canvasProjectId?: string
}

/**
 * One canvas project folder as the account-wide library lists it, for 「迁移到新电脑」 (画布也搬, yoyo
 * 2026-11-22): the works the library shows from there go along with the account library's own.
 */
export interface CanvasLibraryFolder {
  /** The project whose folder this is: its works go along with the project when the project goes too. */
  projectId: string
  /** The root of the folder's asset stores: user-<id>/<date>/xingmang-<id>.<ext> below it, the account library's layout. */
  outputRoot: string
  metadata: Pick<AiAssetMetadataStore, 'getAll'>
  /**
   * The works the library lists from this folder. A work the account library holds too, or the copy a
   * project listed earlier also holds, is listed from there and is not among them.
   */
  assetIds: string[]
}

/** One project folder's media as 「迁移到新电脑」 copies them: user-<id>/<date>/xingmang-<id>.<ext> below outputRoot. */
export interface CanvasTransferFolder {
  outputRoot: string
  metadata: Pick<AiAssetMetadataStore, 'getAll' | 'importMissing'>
}

export interface CanvasProjectImageMetadata extends AiAssetMetadata {
  projectId?: string
  /** The prompt the user submitted, kept in logical metadata rather than beside the bytes. */
  prompt?: string
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
  private readonly realmId: 'xm-account' | 'api-account'
  private readonly projects: CanvasProjectAssetManagerOptions['projects']
  private readonly global: CanvasProjectAssetContext
  private readonly createContext: CanvasProjectAssetManagerOptions['create']
  private readonly onMetadataError: CanvasProjectAssetManagerOptions['onMetadataError']
  private readonly contexts = new Map<string, Promise<CanvasProjectAssetContext>>()
  private readonly locations = new Map<string, string | null>()
  private readonly now: () => number
  private readonly librarySourceSnapshots = new Map<number, { at: number; listed: CanvasProjectLibrarySource[] }>()
  private readonly libraryFolderSnapshots = new Map<string, { at: number; rows: AiMediaLibraryRow[] }>()
  // The asset root each project folder's stores were made for: the migration copies their files by path.
  private readonly contextRoots = new WeakMap<CanvasProjectAssetContext, string>()

  constructor(options: CanvasProjectAssetManagerOptions) {
    this.realmId = options.realmId ?? 'xm-account'
    this.projects = options.projects
    this.global = options.global
    this.createContext = options.create
    this.onMetadataError = options.onMetadataError
    this.now = options.now ?? Date.now
  }

  async forProject(userId: number, projectId: string): Promise<CanvasProjectAssetContext> {
    assertUserId(userId)
    assertProjectId(projectId)
    const key = `${userId}:${projectId}`
    const existing = this.contexts.get(key)
    if (existing) return existing
    const pending = this.projects.getUsableWorkspaceDirectory(userId, projectId).then((workspaceDirectory) => {
      if (!workspaceDirectory) return this.global
      return this.forWorkspace(workspaceDirectory)
    }).catch((error) => {
      this.contexts.delete(key)
      throw error
    })
    this.contexts.set(key, pending)
    return pending
  }

  /**
   * The asset stores of a folder that is not a project yet. Importing a
   * project package as a new project fills its folder first and registers the
   * project last, so a failed import leaves no half-made project in the list.
   * Not remembered: the project registered afterwards goes through forProject().
   */
  forNewWorkspace(workspaceDirectory: string): CanvasProjectAssetContext {
    if (typeof workspaceDirectory !== 'string' || !path.isAbsolute(workspaceDirectory)) throw new Error('画布项目工作文件夹无效')
    return this.forWorkspace(workspaceDirectory)
  }

  private forWorkspace(workspaceDirectory: string): CanvasProjectAssetContext {
    const outputRoot = this.realmId === 'api-account'
      ? path.join(workspaceDirectory, 'assets', 'realms', 'api-account')
      : path.join(workspaceDirectory, 'assets')
    const context = this.createContext(outputRoot)
    this.contextRoots.set(context, outputRoot)
    context.images.ensureOutputDirectory()
    return context
  }

  /**
   * Where a project keeps its own media, for 「迁移到新电脑」 to copy every file of it: the root of its folder's
   * stores and their metadata. Null for a project without a folder of its own, whose media sit in the account
   * library; a folder that cannot be reached right now throws, as forProject() does.
   */
  async transferFolder(userId: number, projectId: string): Promise<CanvasTransferFolder | null> {
    const context = await this.forProject(userId, projectId)
    const outputRoot = context === this.global ? undefined : this.contextRoots.get(context)
    return outputRoot ? { outputRoot, metadata: context.metadata } : null
  }

  /** The same for the new, empty folder an imported project is about to move into (see forNewWorkspace). */
  transferTarget(workspaceDirectory: string): CanvasTransferFolder {
    const context = this.forNewWorkspace(workspaceDirectory)
    return { outputRoot: this.contextRoots.get(context) as string, metadata: context.metadata }
  }

  /** Drops the remembered folder of a project bound to another folder, so the next use reads the new one. */
  forgetProject(userId: number, projectId: string): void {
    assertUserId(userId)
    assertProjectId(projectId)
    this.contexts.delete(`${userId}:${projectId}`)
    this.libraryFolderSnapshots.delete(`${userId}:${projectId}`)
    this.librarySourceSnapshots.delete(userId)
  }

  async prepareProject(userId: number, projectId?: string): Promise<void> {
    if (!projectId) throw new Error('画布项目尚未选择，无法保存生成素材')
    const context = await this.forProject(userId, projectId)
    context.images.ensureOutputDirectory()
  }

  /**
   * Runs before every new paid image or video request of a canvas project, but
   * not before resuming a task the account has already paid for (that path
   * still uses prepareProject). Images and videos share the context's output
   * root, so the image store's probe answers for both.
   */
  async assertWritable(userId: number, projectId?: string): Promise<void> {
    if (!projectId) throw new Error('画布项目尚未选择，无法保存生成素材')
    const context = await this.forProject(userId, projectId)
    await context.images.assertWritable(userId)
  }

  async storeBase64(userId: number, value: string, metadata?: CanvasProjectImageMetadata): Promise<AiStoredAsset> {
    const projectId = this.requiredMetadataProjectId(metadata)
    const context = await this.forProject(userId, projectId)
    const asset = await context.images.storeBase64(userId, value, this.imageMetadata(metadata))
    await this.markGenerated(context, userId, asset.assetId, metadata?.prompt)
    this.libraryFolderSnapshots.delete(`${userId}:${projectId}`)
    this.remember(userId, 'image', asset.assetId, projectId, context)
    return asset
  }

  async storeRemoteUrl(userId: number, url: string, metadata?: CanvasProjectImageMetadata): Promise<AiStoredAsset> {
    const projectId = this.requiredMetadataProjectId(metadata)
    const context = await this.forProject(userId, projectId)
    const asset = await context.images.storeRemoteUrl(userId, url, this.imageMetadata(metadata))
    await this.markGenerated(context, userId, asset.assetId, metadata?.prompt)
    this.libraryFolderSnapshots.delete(`${userId}:${projectId}`)
    this.remember(userId, 'image', asset.assetId, projectId, context)
    return asset
  }

  /**
   * Tags pictures this project has just stored, next to the tags already on
   * them. The tag lands in the same metadata file as the picture: a project
   * with its own folder keeps both there, the rest share the account library.
   */
  async addImageTag(userId: number, assetIds: readonly string[], tag: string, projectId?: string): Promise<void> {
    const context = await this.forProject(userId, this.requiredMetadataProjectId({ projectId }))
    for (const assetId of assetIds) await context.metadata.addTag(userId, assetId, tag)
  }

  async readImageOwned(userId: number, assetId: string, projectId?: string): Promise<AiOwnedAssetRead> {
    return projectId
      ? (await this.forProject(userId, projectId)).images.readOwned(userId, assetId)
      : this.readOwned(userId, assetId, 'image') as Promise<AiOwnedAssetRead>
  }

  async storeMp4(userId: number, bytes: Buffer, metadata: { taskId: string; projectId?: string; prompt?: string }): Promise<AiStoredVideoAsset> {
    const projectId = this.requiredMetadataProjectId(metadata)
    const context = await this.forProject(userId, projectId)
    const asset = await context.videos.storeMp4(userId, bytes, { taskId: metadata.taskId })
    await this.markGenerated(context, userId, asset.assetId, metadata.prompt)
    this.libraryFolderSnapshots.delete(`${userId}:${projectId}`)
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
    return this.locate(userId, kind, assetId, (context) => this.readFromContext(context, userId, assetId, kind))
  }

  /**
   * Where this account keeps a picture or video, for the main window's own reads (融合第 5 步: 另存、
   * 用播放器打开、读片段、基于此图继续编辑). The account library answers first, then the project folders,
   * each through its own store's ownership and file checks. When no place holds it the account library is
   * returned, so the read that follows fails with that store's own words, as it did before project folders
   * were looked at.
   */
  async holderOf(userId: number, kind: 'image' | 'video', assetId: string): Promise<CanvasProjectAssetContext> {
    assertUserId(userId)
    try {
      return await this.locate(userId, kind, assetId, async (context) => {
        await this.filePathFromContext(context, userId, assetId, kind)
        return context
      })
    } catch {
      return this.global
    }
  }

  /**
   * The main window's library across the whole account (融合第 5 步): the account library, plus what each
   * unarchived canvas project keeps in its own folder, newest first. Only directories and metadata are
   * read, never media.
   *
   * What a project folder contributes is what the project made: files the user imported there (reference
   * pictures, masks, extracted frames) are materials, not works, and stay out. A project without a folder
   * keeps its media in the account library, where they are listed anyway; the ones its nodes hold are
   * marked as that project's. Archived projects and folders that cannot be reached right now contribute
   * nothing, and a failure to read the project list leaves the account library on its own rather than
   * failing the page.
   */
  async listLibrary(userId: number, query: CanvasAccountLibraryQuery = {}): Promise<AiMediaLibraryPage> {
    assertUserId(userId)
    const { canvasProjectId, ...paging } = query
    assertAiMediaLibraryQuery(paging)
    if (canvasProjectId !== undefined) assertProjectId(canvasProjectId)
    const sources = await this.librarySources(userId)
    if (canvasProjectId !== undefined) {
      const project = sources.find((source) => source.id === canvasProjectId)
      return pageAiMediaLibraryRows(project ? await this.projectWorks(userId, project) : [], paging)
    }
    const { merged, fromFolders } = await this.accountLibraryRows(userId, sources)
    return pageAiMediaLibraryRows([...merged.values(), ...fromFolders.values()], paging)
  }

  /**
   * The project folders whose works the account-wide library lists, each with the ids it lists from
   * there, for 「迁移到新电脑」 (画布也搬): the export takes exactly what the library page shows, so the
   * numbers in the question match the page. Same rules as listLibrary: unarchived projects with a folder
   * that can be reached, what they made rather than what was imported into them, nothing from the bin.
   * A folder whose stores cannot be opened right now is left out, as it is from the page.
   */
  async listLibraryFolders(userId: number): Promise<CanvasLibraryFolder[]> {
    assertUserId(userId)
    const { fromFolders } = await this.accountLibraryRows(userId, await this.librarySources(userId))
    const byProject = new Map<string, string[]>()
    for (const row of fromFolders.values()) {
      const projectId = row.canvas?.projectId
      if (!projectId) continue
      const held = byProject.get(projectId)
      if (held) held.push(row.assetId)
      else byProject.set(projectId, [row.assetId])
    }
    const folders: CanvasLibraryFolder[] = []
    for (const [projectId, assetIds] of byProject) {
      try {
        const context = await this.forProject(userId, projectId)
        const outputRoot = this.contextRoots.get(context)
        if (outputRoot) folders.push({ projectId, outputRoot, metadata: context.metadata, assetIds })
      } catch {
        // Its folder went away since the library read it: it adds nothing, as on the page.
      }
    }
    return folders
  }

  /**
   * The account library's rows and the rows only a project folder holds, keyed by asset id. A work in
   * both is listed from the account library; a work in two folders, from the earliest file.
   */
  private async accountLibraryRows(userId: number, sources: readonly CanvasProjectLibrarySource[]): Promise<{
    merged: Map<string, AiMediaLibraryRow>
    fromFolders: Map<string, AiMediaLibraryRow>
  }> {
    const folderless = new Map<string, CanvasProjectLibrarySource>()
    for (const source of sources) {
      if (source.workspaceStatus !== 'legacy') continue
      for (const assetId of source.assetIds) if (!folderless.has(assetId)) folderless.set(assetId, source)
    }
    const merged = new Map<string, AiMediaLibraryRow>()
    for (const row of await this.global.media.listOwnedLibraryRows(userId)) {
      const project = folderless.get(row.assetId)
      // The account library also holds what the chat and the video editor made, and anything can sit on a
      // node: only what the stores marked as generated is called the project's own work.
      merged.set(row.assetId, project
        ? { ...row, canvas: { projectId: project.id, projectName: project.name, ...(row.source === 'generated' ? {} : { used: true as const }) } }
        : row)
    }
    const fromFolders = new Map<string, AiMediaLibraryRow>()
    for (const source of sources) {
      if (source.workspaceStatus !== 'ready') continue
      for (const row of await this.folderWorks(userId, source)) {
        if (merged.has(row.assetId)) continue
        // A copied project keeps the ids of what it copied; the earliest file is the original.
        const known = fromFolders.get(row.assetId)
        if (!known || row.createdAt < known.createdAt) fromFolders.set(row.assetId, row)
      }
    }
    return { merged, fromFolders }
  }

  private async librarySources(userId: number): Promise<CanvasProjectLibrarySource[]> {
    if (!this.projects.listLibrarySources) return []
    const now = this.now()
    const known = this.librarySourceSnapshots.get(userId)
    if (known && now >= known.at && now - known.at < LIBRARY_SNAPSHOT_MS) return known.listed
    let listed: CanvasProjectLibrarySource[]
    try {
      listed = await this.projects.listLibrarySources(userId)
    } catch {
      return []
    }
    if (this.librarySourceSnapshots.size >= MAXIMUM_LIBRARY_SNAPSHOTS) this.librarySourceSnapshots.clear()
    this.librarySourceSnapshots.set(userId, { at: now, listed })
    return listed
  }

  /** What one project made, as the main window lists it when a single project is opened. */
  private async projectWorks(userId: number, source: CanvasProjectLibrarySource): Promise<AiMediaLibraryRow[]> {
    if (source.workspaceStatus === 'ready') return this.folderWorks(userId, source)
    if (source.workspaceStatus === 'missing') return []
    const held = new Set(source.assetIds)
    return (await this.global.media.listOwnedLibraryRows(userId))
      .filter((row) => held.has(row.assetId) && row.source === 'generated')
      .map((row) => ({ ...row, canvas: { projectId: source.id, projectName: source.name } }))
  }

  /** The works in a project's own folder. A folder that cannot be read lists nothing; it is not an error of the page. */
  private async folderWorks(userId: number, source: CanvasProjectLibrarySource): Promise<AiMediaLibraryRow[]> {
    const key = `${userId}:${source.id}`
    const now = this.now()
    const known = this.libraryFolderSnapshots.get(key)
    let rows: AiMediaLibraryRow[]
    if (known && now >= known.at && now - known.at < LIBRARY_SNAPSHOT_MS) {
      rows = known.rows
    } else {
      try {
        const context = await this.forProject(userId, source.id)
        // forProject answers with the account library for a project whose folder record is gone; that is
        // not this project's folder and its rows are already listed.
        rows = context === this.global ? [] : (await context.media.listOwnedLibraryRows(userId)).filter((row) => row.source !== 'imported')
      } catch {
        rows = []
      }
      if (this.libraryFolderSnapshots.size >= MAXIMUM_LIBRARY_SNAPSHOTS) this.libraryFolderSnapshots.clear()
      this.libraryFolderSnapshots.set(key, { at: now, rows })
    }
    return rows.map((row) => ({ ...row, canvas: { projectId: source.id, projectName: source.name } }))
  }

  /**
   * A byte range of an owned video for the asset protocol, found through the
   * same global-then-project search as `readOwned`; the store re-verifies the
   * file before reading only the range `select` picks.
   */
  async readOwnedVideoRange(
    userId: number,
    assetId: string,
    select: (totalBytes: number) => ByteRange | null,
  ): Promise<AiVideoOwnedRangeRead> {
    assertUserId(userId)
    return this.locate(userId, 'video', assetId, (context) => context.videos.readOwnedRange(userId, assetId, select))
  }

  /**
   * Filesystem path of an owned asset, resolved through the same global-then-
   * project search as `readOwned`. Thumbnail derivation needs a real path for
   * the platform provider, and resolving it against the global store alone
   * misses every asset that lives in a project workspace.
   */
  async resolveOwnedFilePath(
    userId: number,
    assetId: string,
    kind: 'image' | 'video' | 'audio',
  ): Promise<string> {
    assertUserId(userId)
    return this.locate(userId, kind, assetId, (context) => this.filePathFromContext(context, userId, assetId, kind))
  }

  /**
   * Runs `read` where this account keeps an asset: the place remembered for
   * it first, then the global library, then each project folder. Asset
   * identifiers are random, so the first owned match is unambiguous and is
   * remembered for the range reads that follow.
   *
   * The remembered place is only a guess. A copied project keeps the ids of
   * the assets it copied, so when the original's files are moved or deleted,
   * or its folder is unplugged, the copy must still be found (O14). Each
   * candidate goes through its own store's full file checks; nothing here
   * reads a path that is not inside one of this account's libraries.
   */
  private async locate<T>(
    userId: number,
    kind: 'image' | 'video' | 'audio',
    assetId: string,
    read: (context: CanvasProjectAssetContext) => Promise<T>,
  ): Promise<T> {
    const key = locationKey(userId, kind, assetId)
    const remembered = this.locations.get(key)
    let rememberedError: unknown
    if (remembered !== undefined) {
      try {
        return await read(remembered === null ? this.global : await this.forProject(userId, remembered))
      } catch (error) {
        // Leave a place a concurrent store or lookup has just remembered.
        if (this.locations.get(key) === remembered) this.locations.delete(key)
        rememberedError = error
      }
    }
    if (remembered !== null) {
      try {
        const found = await read(this.global)
        this.locations.set(key, null)
        return found
      } catch {
        // Project workspaces are searched below.
      }
    }
    const projects = await this.projects.list(userId)
    for (const project of projects) {
      if (!project.workspaceConfigured || project.id === remembered) continue
      try {
        const context = await this.forProject(userId, project.id)
        const found = await read(context)
        this.remember(userId, kind, assetId, project.id, context)
        return found
      } catch {
        // A missing workspace or non-matching asset does not hide assets in
        // the remaining user-owned projects.
      }
    }
    // With no copy anywhere, say what the remembered place said, as before.
    if (rememberedError !== undefined) throw rememberedError
    throw new Error('AI 素材不存在或无权访问')
  }

  private async filePathFromContext(
    context: CanvasProjectAssetContext,
    userId: number,
    assetId: string,
    kind: 'image' | 'video' | 'audio',
  ): Promise<string> {
    if (kind === 'image') return context.images.resolveOwnedFilePath(userId, assetId)
    if (kind === 'video') return context.videos.resolveOwnedFilePath(userId, assetId)
    return context.audios.resolveOwnedFilePath(userId, assetId)
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

  private async markGenerated(context: CanvasProjectAssetContext, userId: number, assetId: string, prompt?: string): Promise<void> {
    try {
      await context.media.setSource(userId, assetId, 'generated', prompt)
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
