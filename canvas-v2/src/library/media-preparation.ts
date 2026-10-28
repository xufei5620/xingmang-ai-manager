import type { CanvasGroupSummary, CanvasPreparedGroup } from '../host'
import type { CanvasMediaGroups } from '../store/canvas-state'
import { availableModelsForKind, withResolvedMediaModels, type MediaCapabilityKind } from './media-groups'

export type MediaPreparationKind = MediaCapabilityKind | 'all'
export type CanvasMediaPreparationErrors = Partial<Record<MediaCapabilityKind, string>>

export interface CanvasPreparedMediaConfiguration {
  mediaGroups: CanvasMediaGroups
  imageModels: string[]
  videoModels: string[]
  textModels: string[]
  errors: CanvasMediaPreparationErrors
  keyCreatedGroups: string[]
  warnings: string[]
}

export interface CanvasMediaPreparationProgress extends CanvasPreparedMediaConfiguration {
  pendingKinds: MediaCapabilityKind[]
}

export interface CanvasMediaPreparationScope {
  requestRevision: number
  projectEpoch: number
  projectId: string | null
  catalogSignature: string
}

const mediaKinds: readonly MediaCapabilityKind[] = ['image', 'video', 'text']
const mediaLabels: Record<MediaCapabilityKind, string> = { image: '生图', video: '视频', text: '文字' }

/** The desktop creates a source's key the first time it is used; the web host never does, so only desktop users see this. */
export function mediaKeyCreatedNotice(groupNames: readonly string[]): string | undefined {
  return groupNames.length ? `已自动创建「${groupNames.join('、')}」分组的密钥` : undefined
}

/** Only selected entries invalidate preparation. Legacy hosts have no revision. */
export function canvasMediaCatalogSignature(selected: CanvasMediaGroups, groups: readonly CanvasGroupSummary[], legacyReadRevision = 0): string {
  return JSON.stringify(mediaKinds.map((kind) => {
    const name = selected[kind] || ''
    const entry = groups.find((group) => group.name === name)
    return [kind, name, entry ? entry.revision ?? `legacy:${legacyReadRevision}` : 'missing', entry?.connectionStatus ?? '', entry?.purposes === undefined ? null : [...entry.purposes].sort()]
  }))
}

export function canvasMediaPreparationSignature(selected: CanvasMediaGroups, groups: readonly CanvasGroupSummary[], legacyReadRevision = 0, retryRevision = 0): string {
  return JSON.stringify([canvasMediaCatalogSignature(selected, groups, legacyReadRevision), selected.imageModel || '', selected.videoModel || '', selected.textModel || '', retryRevision])
}

export function isCanvasMediaPreparationCurrent(expected: CanvasMediaPreparationScope, current: CanvasMediaPreparationScope, active: boolean): boolean {
  return active && expected.requestRevision === current.requestRevision
    && expected.projectEpoch === current.projectEpoch && expected.projectId === current.projectId
    && expected.catalogSignature === current.catalogSignature
}

export function isCanvasMediaPreparationScopeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && (error.code === 'ACCOUNT_CHANGED' || error.code === 'HOST_DISPOSED' || error.code === 'HOST_LEASE_EXPIRED')) return true
  if ('name' in error && error.name === 'AbortError') return true
  return error instanceof Error && /^(?:画布页面已关闭|画布账号已变化|画布账户已变化|画布连接已停止|画布宿主已释放|画布会话已失效)/.test(error.message)
}

/** Sources publish independently; lifetime failures invalidate the whole batch. */
export async function prepareCanvasMediaSources(options: {
  target: CanvasMediaGroups
  groups: readonly CanvasGroupSummary[]
  kind: MediaPreparationKind
  previousModels: Record<MediaCapabilityKind, readonly string[]>
  previousErrors?: CanvasMediaPreparationErrors
  prepare(group: string): Promise<CanvasPreparedGroup>
  isCurrent(): boolean
  onProgress?(progress: CanvasMediaPreparationProgress): void
}): Promise<CanvasPreparedMediaConfiguration | null> {
  const kinds = options.kind === 'all' ? mediaKinds : [options.kind]
  const requestedGroups = [...new Set(kinds.map((kind) => options.target[kind]).filter((group): group is string => Boolean(group)))]
  const outcomes = new Map<string, { prepared?: CanvasPreparedGroup; error?: string }>()
  const models = {
    image: [...options.previousModels.image], video: [...options.previousModels.video], text: [...options.previousModels.text],
  }
  const errors: CanvasMediaPreparationErrors = { ...options.previousErrors }
  const sourceKinds = new Map<string, MediaCapabilityKind[]>()
  const pending = new Set<MediaCapabilityKind>()
  const ready = new Set<MediaCapabilityKind>()
  let stopped = false

  // A lost scope must never regain permission when an uncancellable sibling
  // eventually settles or the consumer happens to restore an old selection.
  function isActive(): boolean {
    if (stopped) return false
    if (!options.isCurrent()) { stopped = true; return false }
    return true
  }

  for (const kind of kinds) {
    delete errors[kind]
    models[kind] = []
    const name = options.target[kind]
    if (!name) continue
    const catalog = options.groups.find((group) => group.name === name)
    if (!catalog) {
      errors[kind] = '所选来源已不存在，请重新选择'
      continue
    }
    if (catalog.purposes !== undefined && !catalog.purposes.includes(kind)) {
      errors[kind] = '所选来源已不提供此用途，请重新选择来源'
      continue
    }
    if (catalog.connectionStatus && catalog.connectionStatus !== 'ready') {
      errors[kind] = catalog.connectionStatus === 'untested' ? '来源尚未检测，请到账户设置检测模型列表' : '来源连接检测未通过，请到账户设置核对'
      continue
    }
    const sharedKinds = sourceKinds.get(name) ?? []
    sharedKinds.push(kind)
    sourceKinds.set(name, sharedKinds)
    pending.add(kind)
  }

  function snapshot(): CanvasPreparedMediaConfiguration {
    const resolved = withResolvedMediaModels(options.target, models.image, models.video, models.text)
    const mediaGroups = { ...options.target }
    for (const kind of ready) {
      const field = kind === 'image' ? 'imageModel' : kind === 'video' ? 'videoModel' : 'textModel'
      if (!mediaGroups[field] && resolved[field]) mediaGroups[field] = resolved[field]
    }
    const warnings = [...new Set(requestedGroups.map((name) => outcomes.get(name)?.prepared?.storageWarning).filter((warning): warning is string => Boolean(warning)))]
    for (const kind of kinds) if (errors[kind]) warnings.push(`${mediaLabels[kind]}：${errors[kind]}`)
    return {
      mediaGroups, imageModels: [...models.image], videoModels: [...models.video], textModels: [...models.text], errors: { ...errors },
      keyCreatedGroups: requestedGroups.filter((group) => outcomes.get(group)?.prepared?.keyCreated), warnings,
    }
  }

  function publish(): void {
    if (!isActive() || !options.onProgress) return
    try {
      options.onProgress({ ...snapshot(), pendingKinds: mediaKinds.filter((kind) => pending.has(kind)) })
    } catch (error) {
      stopped = true
      throw error
    }
  }

  if (!isActive()) return null
  publish()
  await Promise.all([...sourceKinds.keys()].map(async (name) => {
    if (!isActive()) return
    const catalog = options.groups.find((group) => group.name === name)
    let outcome: { prepared?: CanvasPreparedGroup; error?: string }
    try {
      const prepared = await options.prepare(name)
      outcome = prepared.group !== name || (catalog?.revision !== undefined && prepared.revision !== catalog.revision)
        ? { error: '来源已在核对期间更新，请重新核对模型列表' }
        : { prepared }
    } catch (error) {
      if (isCanvasMediaPreparationScopeError(error)) { stopped = true; throw error }
      outcome = { error: error instanceof Error ? error.message : '来源暂时无法读取，请重试核对' }
    }
    if (!isActive()) return
    outcomes.set(name, outcome)
    for (const kind of sourceKinds.get(name) ?? []) {
      pending.delete(kind)
      if (!outcome.prepared) {
        errors[kind] = outcome.error ?? '来源暂时无法读取，请重试核对'
        continue
      }
      models[kind] = availableModelsForKind(kind, outcome.prepared.models, outcome.prepared.purposes ?? catalog?.purposes)
      if (models[kind].length === 0) errors[kind] = '所选来源当前没有可用于此用途的模型，请核对来源设置'
      else ready.add(kind)
    }
    publish()
  }))
  return isActive() ? snapshot() : null
}
