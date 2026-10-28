import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyCanvasAssetPage, type CanvasAssetPage, type CanvasAssetSummary, type CanvasListedAssetSummary } from '../host'
import { currentNodeCandidates } from '../runtime/current-batch-candidates'
import * as candidateModule from '../runtime/current-batch-candidates'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actualEffect(marker: string, environment: Record<string, unknown>): () => (() => void) | undefined {
  const expressions: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes(marker)) expressions.push(node.arguments[0].getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (expressions.length !== 1) throw new Error(`Expected one actual App effect: ${marker}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expressions[0]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => (() => void) | undefined
}
function actualGalleryIds(nodes: unknown[]): string {
  const expressions: string[] = []
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ['focusedGalleryAssetIds', 'galleryCandidateAssetIds'].includes(node.name.getText(source)) && node.initializer) expressions.push(node.initializer.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (expressions.length !== 1) throw new Error('Expected one actual gallery candidate metadata scope')
  const environment = { nodes, ...candidateModule }
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expressions[0]});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as string
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function asset(letter: string, mediaType: 'image' | 'video' | 'audio' = 'image'): CanvasListedAssetSummary {
  const assetId = letter.repeat(43), common = { assetId, localUrl: `xingmang-asset://${mediaType}/${assetId}`, thumbnailUrl: '', fileName: letter, displayName: letter, createdAt: '2026-10-15T00:00:00.000Z' }
  return mediaType === 'image' ? { ...common, mediaType, mimeType: 'image/png', width: 640, height: 480 }
    : mediaType === 'video' ? { ...common, mediaType, mimeType: 'video/mp4', taskId: 'imported', width: 640, height: 480, durationSeconds: 4 }
      : { ...common, mediaType, mimeType: 'audio/wav', durationSeconds: 3 }
}
function fixture(focused: CanvasListedAssetSummary[], initial: CanvasAssetSummary[] = []) {
  let catalog = [...initial]
  const page = deferred<CanvasAssetPage>(), reads = new Map(focused.map((item) => [item.assetId, deferred<CanvasListedAssetSummary>()]))
  const listAssets = vi.fn(() => page.promise)
  const getAssetDetail = vi.fn((id: string, _signal?: AbortSignal) => {
    const read = reads.get(id)
    if (!read) throw new Error('Unexpected asset read')
    return read.promise
  })
  const setAssetCatalog = vi.fn((value: CanvasAssetSummary[] | ((current: CanvasAssetSummary[]) => CanvasAssetSummary[])) => { catalog = typeof value === 'function' ? value(catalog) : value })
  const projectEpochRef = { current: 1 }, setBanner = vi.fn(), setAssetPage = vi.fn(), setAssetsLoading = vi.fn()
  const environment = { activeProject: { id: 'project-a' }, projectEpochRef, hostBridge: () => ({ listAssets, getAssetDetail }), emptyCanvasAssetPage,
    assetsRequestRevisionRef: { current: 0 }, assetQueryRef: { current: {} }, assetQueryGenerationRef: { current: 0 }, agentMountedRef: { current: true }, currentAssetLibraryScope: () => `project-a:${projectEpochRef.current}`,
    setAssetQuery: vi.fn(), setAssetPage, setAssetCatalog, setAssetsLoading, setBanner, setNodes: vi.fn(), applyCatalogClipDurationToNodes: vi.fn((nodes) => nodes),
    focusedGalleryAssetIds: focused.map((item) => item.assetId).join('|'), galleryCandidateAssetIds: focused.map((item) => item.assetId).join('|'), layerEditorScope: 'scope-a',
  }
  vi.stubGlobal('window', { xingmangCanvasHost: {} })
  return {
    page, reads, listAssets, getAssetDetail, setAssetCatalog, projectEpochRef, setBanner, setAssetPage, setAssetsLoading,
    catalog: () => catalog,
    startList: () => actualEffect('setAssetQuery(query)', { ...environment, assetCatalog: catalog })(),
    startDetails: () => actualEffect('getAssetDetail!(id, controller.signal)', { ...environment, assetCatalog: catalog })(),
    startProjectDetails: (nodes: unknown[]) => {
      const ids = actualGalleryIds(nodes)
      return actualEffect('getAssetDetail!(id, controller.signal)', { ...environment, focusedGalleryAssetIds: ids, galleryCandidateAssetIds: ids, assetCatalog: catalog })()
    },
    completeList: (items: CanvasListedAssetSummary[]) => page.resolve({ ...emptyCanvasAssetPage(), items, total: items.length }),
    completeDetails: () => focused.forEach((item) => reads.get(item.assetId)!.resolve(item)),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('actual App focused gallery metadata loading', () => {
  it('restores an unselected saved gallery outside the initial library page without projecting old runs', async () => {
    const images = [asset('b'), asset('c')], f = fixture(images)
    const saved = { prompt: '', model: '', status: 'succeeded' as const, dirty: true, candidateAssetIds: images.map((item) => item.assetId), result: { kind: 'image' as const, assetId: images[0].assetId } }
    const nodes = [{ id: 'gallery', type: 'gallery', selected: false, data: saved }, { id: 'unrelated', type: 'image-input', selected: true, data: { candidateAssetIds: [asset('z').assetId] } }]
    const before = JSON.stringify(nodes)
    expect(currentNodeCandidates('gallery', 'gallery', saved)).toHaveLength(1)
    const stop = f.startProjectDetails(nodes)
    expect(f.getAssetDetail).toHaveBeenCalledTimes(2)
    f.completeDetails()
    await vi.waitFor(() => expect(currentNodeCandidates('gallery', 'gallery', saved, f.catalog())).toHaveLength(2))
    expect(f.listAssets).not.toHaveBeenCalled()
    expect(JSON.stringify(nodes)).toBe(before)
    stop?.()
  })

  it('bounds project prefetch to 128 explicit gallery references and prioritizes the selected batch', () => {
    const id = (index: number) => String(index).padStart(43, 'a')
    const nodes = Array.from({ length: 10 }, (_, index) => ({ id: `gallery-${index}`, type: 'gallery', selected: index === 9, data: { candidateAssetIds: Array.from({ length: 16 }, (_, slot) => id(index * 16 + slot)) } }))
    nodes.push({ id: 'not-gallery', type: 'image-input', selected: false, data: { candidateAssetIds: [id(999)] } })
    const ids = actualGalleryIds(nodes).split('|')
    expect(ids).toHaveLength(128)
    expect(ids.slice(0, 16)).toEqual(nodes[9].data.candidateAssetIds)
    expect(new Set(ids).size).toBe(128)
    expect(ids).not.toContain(id(999))
  })

  it('deduplicates explicit current gallery IDs and excludes malformed IDs and historical candidates', () => {
    const ids = actualGalleryIds([{ id: 'gallery', type: 'gallery', selected: false, data: { candidateAssetIds: [asset('a').assetId, '../../other', asset('a').assetId, asset('b').assetId], candidates: [{ asset: { assetId: asset('z').assetId } }] } }]).split('|')
    expect(ids).toEqual([asset('a').assetId, asset('b').assetId])
  })

  it('makes at most 128 owned detail reads with four concurrent requests for a large current canvas', async () => {
    const images = Array.from({ length: 160 }, (_, index) => ({ ...asset('a'), assetId: String(index).padStart(43, 'a') })), f = fixture(images)
    const nodes = Array.from({ length: 10 }, (_, index) => ({ id: `gallery-${index}`, type: 'gallery', selected: index === 9, data: { candidateAssetIds: images.slice(index * 16, index * 16 + 16).map((image) => image.assetId) } }))
    const stop = f.startProjectDetails(nodes)
    expect(f.getAssetDetail).toHaveBeenCalledTimes(4)
    expect(f.getAssetDetail.mock.calls.map(([id]) => id)).toEqual(nodes[9].data.candidateAssetIds.slice(0, 4))
    f.completeDetails()
    await vi.waitFor(() => expect(f.catalog()).toHaveLength(128))
    expect(f.getAssetDetail).toHaveBeenCalledTimes(128)
    expect(f.listAssets).not.toHaveBeenCalled()
    stop?.()
  })

  it('keeps gallery references intact when a detail belongs to another ID or the asset is trashed', async () => {
    const images = [asset('b'), asset('c')], f = fixture(images)
    const nodes = [{ id: 'gallery', type: 'gallery', selected: false, data: { candidateAssetIds: images.map((image) => image.assetId) } }], before = JSON.stringify(nodes)
    const stop = f.startProjectDetails(nodes)
    f.reads.get(images[0].assetId)!.resolve(asset('z'))
    f.reads.get(images[1].assetId)!.resolve({ ...images[1], deletedAt: '2026-10-18T00:00:00.000Z' })
    await vi.waitFor(() => expect(f.setBanner).toHaveBeenCalledWith('部分画廊素材暂不可读取，已保留原顺序；可重新选择此节点重试'))
    expect(f.catalog()).toEqual([])
    expect(JSON.stringify(nodes)).toBe(before)
    stop?.()
  })
  it('preserves resolved mixed-media details when the initial library page arrives later', async () => {
    const video = asset('b', 'video'), audio = asset('c', 'audio'), f = fixture([video, audio])
    const stopList = f.startList(), stopDetails = f.startDetails()
    f.completeDetails()
    await vi.waitFor(() => expect(f.catalog()).toEqual([video, audio]))
    const newerVideo = { ...video, displayName: 'new name from library page' }
    f.completeList([asset('a'), newerVideo])
    await vi.waitFor(() => expect(f.setAssetsLoading).toHaveBeenLastCalledWith(false))
    expect(f.catalog()).toHaveLength(3)
    expect(f.catalog()).toContainEqual(audio)
    expect(f.catalog().filter((item) => item.assetId === video.assetId)).toEqual([newerVideo])
    const candidates = currentNodeCandidates('gallery', 'gallery', { prompt: '', model: '', status: 'succeeded', candidateAssetIds: [video.assetId, audio.assetId] }, f.catalog())
    expect(candidates.map((candidate) => [candidate.asset.assetId, candidate.asset.kind])).toEqual([[video.assetId, 'video'], [audio.assetId, 'audio']])
    expect(f.getAssetDetail).toHaveBeenCalledTimes(2)
    stopList?.(); stopDetails?.()
  })

  it('retains the initial page when focused details arrive later', async () => {
    const focused = [asset('b', 'video'), asset('c', 'audio')], f = fixture(focused)
    const stopList = f.startList(), stopDetails = f.startDetails()
    f.completeList([asset('a')])
    await vi.waitFor(() => expect(f.catalog()).toEqual([asset('a')]))
    f.completeDetails()
    await vi.waitFor(() => expect(f.catalog()).toEqual([asset('a'), ...focused]))
    stopList?.(); stopDetails?.()
  })

  it('does not merge either late response into the next project after cleanup', async () => {
    const f = fixture([asset('b', 'video')]), stopList = f.startList(), stopDetails = f.startDetails()
    stopList?.(); stopDetails?.(); f.projectEpochRef.current++
    f.setAssetCatalog([asset('n')])
    f.completeDetails(); f.completeList([asset('a')])
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(f.catalog()).toEqual([asset('n')])
    expect(f.getAssetDetail.mock.calls[0][1]?.aborted).toBe(true)
    expect(f.setBanner).not.toHaveBeenCalled()
    expect(f.setAssetPage).toHaveBeenCalledOnce()
  })

  it('rejects a detail completion from an earlier project epoch', async () => {
    const f = fixture([asset('b')]), stopDetails = f.startDetails()
    f.projectEpochRef.current++; f.completeDetails()
    await Promise.resolve(); await Promise.resolve()
    expect(f.catalog()).toEqual([])
    expect(f.setBanner).not.toHaveBeenCalled()
    stopDetails?.()
  })

  it('does not reread candidates whose owned metadata is already known', async () => {
    const focused = [asset('b'), asset('c', 'audio')], f = fixture(focused, focused)
    const stop = f.startDetails()
    await Promise.resolve()
    expect(f.getAssetDetail).not.toHaveBeenCalled()
    expect(f.catalog()).toEqual(focused)
    stop?.()
  })

  it('limits pending detail requests to four and stops scheduling after cleanup', async () => {
    const focused = 'abcdefg'.split('').map((letter) => asset(letter)), f = fixture(focused)
    const stop = f.startDetails()
    expect(f.getAssetDetail).toHaveBeenCalledTimes(4)
    f.reads.get(focused[0].assetId)!.resolve(focused[0])
    await vi.waitFor(() => expect(f.getAssetDetail).toHaveBeenCalledTimes(5))
    stop?.(); f.completeDetails()
    await Promise.resolve(); await Promise.resolve()
    expect(f.getAssetDetail).toHaveBeenCalledTimes(5)
    expect(f.catalog()).toEqual([focused[0]])
  })
})
