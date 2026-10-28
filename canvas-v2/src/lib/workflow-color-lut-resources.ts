import { parseColorLutSelection, type AssetColorLutSource } from '../image-tools/layer-color-lut-selection'
import type { ColorLutTable, ColorLutWorkOptions } from '../image-tools/layer-color-lut'
import { checkColorLutResourceWork, describeColorLutResource, parseColorLutResource, parseColorLutResourceDescriptor, serializeColorLutResource, type ColorLutResourceContentDescriptor, type ColorLutResourceDescriptor } from './color-lut-resource-contract'

export interface WorkflowColorLutResource { content: string }
export type ReadWorkflowColorLutResource = (source: AssetColorLutSource, signal: AbortSignal) => Promise<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>
export type UploadWorkflowColorLutResource = (table: ColorLutTable, signal: AbortSignal) => Promise<ColorLutResourceDescriptor>
export const maximumPortableColorLutResources = 20

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function fail(message: string): never { throw new Error(`调色资源${message}；原工程和配置未改变`) }
function sameDomain(first: readonly number[], second: readonly number[]): boolean { return first.length === second.length && first.every((value, index) => value === second[index]) }
function matchSource(source: AssetColorLutSource, expected: ColorLutResourceContentDescriptor): void {
  if (source.digest !== expected.digest || source.name !== expected.name || !sameDomain(source.domainMin, expected.domainMin) || !sameDomain(source.domainMax, expected.domainMax)) fail('摘要、名称或输入域与原设置不一致')
}
function matchDescriptor(value: unknown, expected: ColorLutResourceContentDescriptor): ColorLutResourceDescriptor {
  const result = parseColorLutResourceDescriptor(value)
  matchSource({ kind: 'asset', lutAssetId: result.assetId, ...result }, expected)
  if (result.byteSize !== expected.byteSize || result.mimeType !== expected.mimeType || result.version !== expected.version || result.size !== expected.size) fail('上传回执与文件内容不一致')
  return result
}

function mapRecipe(value: unknown, visit: (source: AssetColorLutSource) => AssetColorLutSource): unknown {
  const recipe = object(value)
  if (!recipe || !Array.isArray(recipe.layers)) return value
  return { ...recipe, layers: recipe.layers.map((raw) => {
    const layer = object(raw), grade = object(layer?.colorGrade)
    if (!layer || !grade || !Object.hasOwn(grade, 'lut')) return raw
    const lut = parseColorLutSelection(grade.lut)
    return { ...layer, colorGrade: { ...grade, lut: lut.source.kind === 'asset' ? { ...lut, source: visit(lut.source) } : lut } }
  }) }
}

function mapWorkflow<T>(value: T, visit: (source: AssetColorLutSource) => AssetColorLutSource): T {
  const graph = object(value)
  if (!graph || !Array.isArray(graph.nodes)) return value
  return { ...graph, nodes: graph.nodes.map((raw) => {
    const node = object(raw), data = object(node?.data)
    if (!node || !data) return raw
    const settings = object(data.settings)
    return { ...node, data: { ...data,
      ...(Object.hasOwn(data, 'imageTransform') ? { imageTransform: mapRecipe(data.imageTransform, visit) } : {}),
      ...(settings && Object.hasOwn(settings, 'imageTransform') ? { settings: { ...settings, imageTransform: mapRecipe(settings.imageTransform, visit) } } : {}),
    } }
  }) } as T
}

/** Includes disabled/zero-strength selections: their table remains editable.
 * Conflicting declarations for one immutable asset must never be deduplicated. */
export function collectWorkflowColorLutSources(workflow: unknown): AssetColorLutSource[] {
  const found = new Map<string, AssetColorLutSource>()
  mapWorkflow(workflow, (source) => {
    const previous = found.get(source.lutAssetId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) fail('同一素材编号包含相互冲突的设置')
    if (!previous) { if (found.size >= 1024) fail('数量超过工程读取上限'); found.set(source.lutAssetId, source) }
    return source
  })
  return [...found.values()]
}

/** Only a validated current-owner receipt can establish replacement IDs. */
export function remapWorkflowColorLutSources<T>(workflow: T, mapping: ReadonlyMap<string, ColorLutResourceDescriptor>): T {
  collectWorkflowColorLutSources(workflow)
  return mapWorkflow(workflow, (source) => {
    const raw = mapping.get(source.lutAssetId)
    if (!raw) fail('缺少已核验的目标账号素材')
    const descriptor = parseColorLutResourceDescriptor(raw)
    matchSource(source, descriptor)
    return { kind: 'asset', lutAssetId: descriptor.assetId, digest: descriptor.digest, name: descriptor.name, domainMin: [...descriptor.domainMin], domainMax: [...descriptor.domainMax] }
  })
}

function boundedSources(workflow: unknown): AssetColorLutSource[] {
  const sources = collectWorkflowColorLutSources(workflow)
  if (sources.length > maximumPortableColorLutResources) fail('单份文件最多携带 20 个自定义调色表，请拆分后导出')
  return sources
}

/** Synchronous file shape check. SHA-256 verification precedes every upload. */
export function parseWorkflowColorLutResources(workflow: unknown, value: unknown, options: ColorLutWorkOptions = {}): WorkflowColorLutResource[] {
  const sources = boundedSources(workflow)
  if (!Array.isArray(value) || value.length > maximumPortableColorLutResources) fail('清单格式或数量不正确')
  const expected = new Map(sources.map((source) => [source.digest, source]))
  const seen = new Set<string>()
  const result: WorkflowColorLutResource[] = []
  for (const raw of value) {
    checkColorLutResourceWork(options)
    const resource = object(raw)
    if (!resource || Object.keys(resource).length !== 1 || typeof resource.content !== 'string') fail('文件清单只允许规范内容，不能声明作者或外部地址')
    const table = parseColorLutResource(new TextEncoder().encode(resource.content), options)
    // The digest is checked asynchronously; shape validation still rejects
    // obvious unrelated tables before a file can reach the upload stage.
    if (!sources.some((source) => source.name === table.name && sameDomain(source.domainMin, table.domainMin) && sameDomain(source.domainMax, table.domainMax))) fail('文件包含与图层设置无关的调色表')
    if (seen.has(resource.content)) fail('文件包含重复的调色表')
    seen.add(resource.content); result.push({ content: resource.content })
  }
  if (result.length !== expected.size) fail('文件缺少完整调色表或包含多余内容')
  return result
}

function workScope(input: ColorLutWorkOptions) {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
  const options = { ...input, signal, deadline: Math.min(input.deadline ?? Infinity, Date.now() + 60_000) }
  checkColorLutResourceWork(options)
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    checkColorLutResourceWork(options)
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false
      function finish(callback: () => void) { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', abort); callback() }
      function abort() { finish(() => reject(signal.reason)) }
      function expire() { finish(() => { try { checkColorLutResourceWork(options) } catch (error) { reject(error); return } reject(new Error('调色资源读取超时')) }) }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(expire, Math.max(0, options.deadline - Date.now()))
      if (signal.aborted) { abort(); return }
      Promise.resolve().then(() => { checkColorLutResourceWork(options); return operation() }).then((value) => finish(() => { try { checkColorLutResourceWork(options); resolve(value) } catch (error) { reject(error) } }), (error) => finish(() => reject(error)))
    })
  }
  return { options, wait }
}

export async function buildWorkflowColorLutResources(workflow: unknown, read: ReadWorkflowColorLutResource, options: ColorLutWorkOptions = {}): Promise<WorkflowColorLutResource[]> {
  const work = workScope(options), resources = new Map<string, WorkflowColorLutResource>()
  for (const source of boundedSources(workflow)) {
    const found = await work.wait(() => read(source, work.options.signal))
    const bytes = serializeColorLutResource(found.table, work.options), expected = await work.wait(() => describeColorLutResource(bytes, work.options))
    const descriptor = matchDescriptor(found.descriptor, expected)
    matchSource(source, expected)
    if (descriptor.assetId !== source.lutAssetId) fail('读取到了其他素材')
    resources.set(expected.digest, { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
  }
  checkColorLutResourceWork(work.options)
  return [...resources.values()]
}

export async function importWorkflowColorLutResources<T>(workflow: T, value: unknown, upload: UploadWorkflowColorLutResource, options: ColorLutWorkOptions = {}): Promise<T> {
  const work = workScope(options), resources = parseWorkflowColorLutResources(workflow, value, work.options), sources = boundedSources(workflow)
  const verified = new Map<string, { table: ColorLutTable; descriptor: ColorLutResourceContentDescriptor }>()
  // Verify the entire registry before the first current-owner upload.
  for (const resource of resources) {
    const bytes = new TextEncoder().encode(resource.content), descriptor = await work.wait(() => describeColorLutResource(bytes, work.options))
    if (verified.has(descriptor.digest)) fail('包含重复摘要')
    verified.set(descriptor.digest, { table: parseColorLutResource(bytes, work.options), descriptor })
  }
  for (const source of sources) { const resource = verified.get(source.digest); if (!resource) fail('文件摘要与图层设置不一致'); matchSource(source, resource.descriptor) }
  const descriptors = new Map<string, ColorLutResourceDescriptor>()
  for (const [key, resource] of verified) descriptors.set(key, matchDescriptor(await work.wait(() => upload(resource.table, work.options.signal)), resource.descriptor))
  const mapping = new Map(sources.map((source) => [source.lutAssetId, descriptors.get(source.digest)!]))
  checkColorLutResourceWork(work.options)
  return remapWorkflowColorLutSources(workflow, mapping)
}
