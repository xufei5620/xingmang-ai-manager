import type { CanvasGroupSummary } from '../host'
import type { CanvasMediaGroups } from '../store/canvas-state'
import type { CanvasRunPreflight } from '../runtime/run-preflight'
import type { MediaCapabilityKind } from './media-groups'
import { canvasMediaCatalogSignature } from './media-preparation'

const mediaKinds: readonly MediaCapabilityKind[] = ['image', 'video', 'text']
const imageKinds = new Set(['image', 'image-generate', 'image-edit'])
const videoKinds = new Set(['video', 'video-generate'])
const textKinds = new Set(['text-generate', 'drama-parse'])

export function canvasMediaPurposePreparationSignature(
  kind: MediaCapabilityKind,
  selected: CanvasMediaGroups,
  groups: readonly CanvasGroupSummary[],
  legacyReadRevision: number,
  project: { projectEpoch: number; projectId: string | null },
): string {
  return JSON.stringify([project.projectEpoch, project.projectId,
    canvasMediaCatalogSignature({ [kind]: selected[kind] }, groups, legacyReadRevision)])
}

/** Admission reads live refs: a catalog update can precede React's effect. */
export function canvasPendingMediaKinds(options: {
  selected: CanvasMediaGroups
  groups: readonly CanvasGroupSummary[]
  legacyReadRevision: number
  projectEpoch: number
  projectId: string | null
  settledSignatures: Partial<Record<MediaCapabilityKind, string>>
  pendingKinds: readonly MediaCapabilityKind[]
}): MediaCapabilityKind[] {
  return mediaKinds.filter((kind) => Boolean(options.selected[kind]) && (options.pendingKinds.includes(kind)
    || options.settledSignatures[kind] !== canvasMediaPurposePreparationSignature(kind, options.selected, options.groups, options.legacyReadRevision, options)))
}

export function pendingCanvasMediaRunKinds(preflight: CanvasRunPreflight, pendingKinds: readonly MediaCapabilityKind[], selected?: CanvasMediaGroups): MediaCapabilityKind[] {
  const involved = new Set<MediaCapabilityKind>()
  for (const item of preflight.items) {
    // A pinned paid result is only a possible server cache hit. Preflight still
    // plans it as execute, so it must never bypass source validation here.
    if (!item.paid || item.action === 'skip' || item.action === 'cached') continue
    const kind = imageKinds.has(item.kind) ? 'image' : videoKinds.has(item.kind) ? 'video' : textKinds.has(item.kind) ? 'text' : undefined
    if (selected && kind && item.group !== selected[kind]) continue
    if (imageKinds.has(item.kind)) involved.add('image')
    else if (videoKinds.has(item.kind)) involved.add('video')
    else if (textKinds.has(item.kind)) involved.add('text')
  }
  return pendingKinds.filter((kind) => involved.has(kind))
}

export function unavailableCanvasMediaRunGroups(preflight: CanvasRunPreflight, groups: readonly CanvasGroupSummary[]): string[] {
  const available = new Set(groups.map((group) => group.name))
  return [...new Set(preflight.items.filter((item) => item.paid && item.action !== 'skip' && item.action !== 'cached'
    && Boolean(item.group) && !available.has(item.group!)).map((item) => item.group!))]
}

/** Late background defaults cannot replace a choice made while reading. */
export function mergeCanvasMediaPreparationDefaults(current: CanvasMediaGroups, prepared: CanvasMediaGroups): CanvasMediaGroups {
  const merged = { ...current }
  for (const kind of mediaKinds) {
    const modelField = kind === 'image' ? 'imageModel' : kind === 'video' ? 'videoModel' : 'textModel'
    if (!merged[kind] && prepared[kind]) merged[kind] = prepared[kind]
    if (!merged[modelField] && merged[kind] === prepared[kind] && prepared[modelField]) merged[modelField] = prepared[modelField]
  }
  return merged
}
