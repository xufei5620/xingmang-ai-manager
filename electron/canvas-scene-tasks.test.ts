import { describe, expect, it } from 'vitest'
import {
  assertCommerceOutputSize,
  buildCommerceTaskPrompt,
  commercePreserveOptions,
  commerceStylePresets,
  commerceViews,
  parseCommerceTask,
  parseNodeCommerceTask,
  resolveCommerceTargetSize,
} from '../canvas-v2/src/commerce/commerce-task'
import { assertCommerceTaskConfiguration, assertImageReferenceRunConfiguration } from '../canvas-v2/src/commerce/image-task-configuration'
import {
  buildExteriorAnalysisPrompt,
  exteriorDistantOptions,
  exteriorEnvironmentOptions,
  exteriorLightTemperatureOptions,
  exteriorTaskKinds,
  exteriorTaskRoles,
  exteriorTaskUsesAnalysis,
  exteriorTimeOptions,
  exteriorWeatherOptions,
  parseExteriorTask,
  parseNodeExteriorTask,
  resolveExteriorImageRequest,
} from '../canvas-v2/src/exterior/exterior-task'
import {
  interiorExteriorOptions,
  interiorFilterOptions,
  interiorTimeOptions,
  interiorWeatherOptions,
  parseInteriorTask,
  parseNodeInteriorTask,
  resolveInteriorImageRequest,
} from '../canvas-v2/src/interior/interior-task'
import {
  buildStoryboardAnalysisPrompt,
  parseNodeStoryboardTask,
  parseStoryboardTask,
  resolveStoryboardImageRequest,
  storyboardPanelOptions,
  storyboardStyleOptions,
  storyboardTaskRoles,
} from '../canvas-v2/src/storyboard/storyboard-task'
import { assertCanvasImageReferenceRunConfiguration, canvasImageReferenceRolePrompt } from './canvas-reference-order'
import type { CanvasImageReferenceOrder, CanvasRunGraph, CanvasRunGraphNode } from './canvas-run-contract'
import {
  assertCanvasCommerceOutputSize,
  assertCanvasCommerceTargetSizeSupported,
  assertCanvasSceneRunConfiguration,
  assertCanvasSceneSourceImages,
  assertCanvasSceneTaskConfiguration,
  buildCanvasExteriorAnalysisPrompt,
  buildCanvasSceneImagePrompt,
  buildCanvasStoryboardAnalysisPrompt,
  canvasExteriorTaskRoles,
  canvasExteriorTaskUsesAnalysis,
  canvasSceneSourceChecks,
  canvasStoryboardTaskRoles,
  parseCanvasCommerceTask,
  parseCanvasExteriorTask,
  parseCanvasInteriorTask,
  parseCanvasNodeCommerceTask,
  parseCanvasNodeExteriorTask,
  parseCanvasNodeInteriorTask,
  parseCanvasNodeStoryboardTask,
  parseCanvasStoryboardTask,
  resolveCanvasCommerceTargetSize,
} from './canvas-scene-tasks'

type Outcome = { value: unknown } | { error: string }

function outcome(action: () => unknown): Outcome {
  try {
    return { value: action() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function asyncOutcome(action: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: await action() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Deterministic, so a failing case can be replayed from its seed.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

function subsets<T>(values: readonly T[]): T[][] {
  return Array.from({ length: 2 ** values.length }, (_, mask) => values.filter((_, index) => mask & (1 << index)))
}

// Mostly what the kernel writes, with one field nudged now and then, plus garbage.
function nudge(random: () => number, task: Record<string, unknown>, garbage: Record<string, readonly unknown[]>): unknown {
  const roll = random()
  if (roll < 0.04) return pick(random, [null, [], 'task', 1, undefined])
  const value: Record<string, unknown> = { ...task }
  if (roll < 0.5) return value
  const keys = Object.keys(value)
  const key = pick(random, keys)
  const action = random()
  if (action < 0.15) delete value[key]
  else if (action < 0.25) value.extra = true
  else if (action < 0.35) value.version = pick(random, [0, 2, '1'])
  else value[key] = pick(random, garbage[key] ?? [undefined, null, 'x', 7, true])
  return value
}

const supplements = ['', '   ', '主体放在画面中央', '  前后留白\n第二行 ']

function randomCommerce(random: () => number): unknown {
  const kind = pick(random, ['material-a', 'material-b', 'style-preset', 'style-reference', 'product-view', 'other'])
  const preserve = random() < 0.9
    ? subsets(commercePreserveOptions.map((option) => option.value))[Math.floor(random() * 16)].sort(() => random() - 0.5)
    : pick(random, [['shape', 'shape'], ['size'], ['shape', 'color', 'logo', 'composition', 'shape'], 'shape'])
  const task: Record<string, unknown> = { version: 1, kind, preserve }
  if (kind === 'material-a' || kind === 'material-b') task.strength = pick(random, [0, 0.35, 0.5, 1, 0.123])
  if (kind === 'material-b') task.upscale = pick(random, [1, 1.25, 1.5, 2])
  if (kind === 'style-preset') task.preset = pick(random, commerceStylePresets.map((preset) => preset.value))
  if (kind === 'product-view') task.view = pick(random, commerceViews.map((view) => view.value))
  return nudge(random, task, { strength: [-0.1, 1.1, Number.NaN, '0.5', Infinity], upscale: [0.5, 2.5, Number.NaN, '1'], preset: ['anime', '', 1], view: ['side', 2], kind: ['material-c', ''] })
}

function randomInterior(random: () => number): unknown {
  return nudge(random, {
    version: 1, kind: 'interior-render', addDecor: random() < 0.5, addPeople: random() < 0.5, enclosedSpace: random() < 0.5, interiorLighting: random() < 0.5,
    weather: pick(random, interiorWeatherOptions.map((option) => option.value)), time: pick(random, interiorTimeOptions.map((option) => option.value)),
    exterior: pick(random, interiorExteriorOptions.map((option) => option.value)), filter: pick(random, interiorFilterOptions.map((option) => option.value)),
  }, { addDecor: ['true', 1, null], weather: ['snowy', ''], time: ['noon'], exterior: ['desert'], filter: ['vivid'], kind: ['exterior-render'] })
}

function randomExterior(random: () => number): unknown {
  const kind = pick(random, [...exteriorTaskKinds, 'other'])
  const task: Record<string, unknown> = kind === 'exterior-render'
    ? { version: 1, kind, addPeople: random() < 0.5, motionBlur: random() < 0.5, interiorLighting: random() < 0.5, lightTemperature: pick(random, exteriorLightTemperatureOptions.map((option) => option.value)),
      weather: pick(random, exteriorWeatherOptions.map((option) => option.value)), time: pick(random, exteriorTimeOptions.map((option) => option.value)),
      environment: pick(random, exteriorEnvironmentOptions.map((option) => option.value)), distant: pick(random, exteriorDistantOptions.map((option) => option.value)) }
    : kind === 'exterior-redraw' ? { version: 1, kind, useToneReference: random() < 0.5 } : { version: 1, kind, automaticPrompt: random() < 0.5 }
  return nudge(random, task, { lightTemperature: [5000, '3000', 3000.5], weather: ['foggy'], environment: ['moon'], distant: ['ocean'], useToneReference: ['yes', 0], automaticPrompt: [1, 'false'] })
}

function randomStoryboard(random: () => number): unknown {
  return nudge(random, { version: 1, kind: 'storyboard', automaticPlot: random() < 0.5, style: pick(random, storyboardStyleOptions.map((option) => option.value)), panels: pick(random, storyboardPanelOptions) },
    { automaticPlot: ['true', 0], style: ['anime', ''], panels: [3, 36, '4', 4.5] })
}

const nodeKinds = ['image', 'image-generate', 'image-edit', 'text-generate', 'video-generate', 'image-crop', 'prompt']

describe('canvas scene tasks', () => {
  it('parses the four tasks exactly as the kernel does', () => {
    const parsers: Array<[string, (random: () => number) => unknown, (value: unknown) => unknown, (value: unknown) => unknown]> = [
      ['commerce', randomCommerce, parseCanvasCommerceTask, parseCommerceTask],
      ['interior', randomInterior, parseCanvasInteriorTask, parseInteriorTask],
      ['exterior', randomExterior, parseCanvasExteriorTask, parseExteriorTask],
      ['storyboard', randomStoryboard, parseCanvasStoryboardTask, parseStoryboardTask],
    ]
    for (const [name, generate, desktop, kernel] of parsers) {
      let accepted = 0
      for (let seed = 0; seed < 3_000; seed += 1) {
        const value = generate(seededRandom(seed))
        const ours = outcome(() => desktop(structuredClone(value)))
        expect(ours, `${name} seed ${seed}`).toEqual(outcome(() => kernel(structuredClone(value))))
        if ('value' in ours) accepted += 1
      }
      // Both outcomes are well covered.
      expect(accepted, name).toBeGreaterThan(1_000)
      expect(accepted, name).toBeLessThan(2_900)
    }
    const tasks: Array<[unknown, (kind: string, value: unknown) => unknown, (kind: string, value: unknown) => unknown]> = [
      [{ version: 1, kind: 'style-reference', preserve: [] }, parseCanvasNodeCommerceTask, parseNodeCommerceTask],
      [{ version: 1, kind: 'interior-render', addDecor: false, addPeople: false, enclosedSpace: false, interiorLighting: false, weather: 'sunny', time: 'noon-overcast', exterior: 'none', filter: 'none' }, parseCanvasNodeInteriorTask, parseNodeInteriorTask],
      [{ version: 1, kind: 'landscape-redesign', automaticPrompt: true }, parseCanvasNodeExteriorTask, parseNodeExteriorTask],
      [{ version: 1, kind: 'storyboard', automaticPlot: true, style: 'cinematic', panels: 4 }, parseCanvasNodeStoryboardTask, parseNodeStoryboardTask],
    ]
    for (const [task, desktop, kernel] of tasks) {
      for (const kind of nodeKinds) expect(outcome(() => desktop(kind, task)), kind).toEqual(outcome(() => kernel(kind, task)))
    }
  })

  it('writes the commerce and interior prompts exactly as the kernel does, for every option', () => {
    const presets = commerceStylePresets.map((preset) => preset.value)
    const views = commerceViews.map((view) => view.value)
    const preserves = subsets(commercePreserveOptions.map((option) => option.value))
    let compared = 0
    for (const preserve of [...preserves, ['composition', 'shape'], ['logo', 'color', 'shape']]) {
      const commerce: unknown[] = [
        ...[0, 0.354, 0.5, 1].map((strength) => ({ version: 1, kind: 'material-a', preserve, strength })),
        ...[1, 1.5, 2].map((upscale) => ({ version: 1, kind: 'material-b', preserve, strength: 0.35, upscale })),
        ...presets.map((preset) => ({ version: 1, kind: 'style-preset', preserve, preset })),
        { version: 1, kind: 'style-reference', preserve },
        ...views.map((view) => ({ version: 1, kind: 'product-view', preserve, view })),
      ]
      for (const task of commerce) {
        for (const supplement of supplements) {
          const node = pictureNode({ commerceTask: parseCanvasCommerceTask(task) })
          expect(buildCanvasSceneImagePrompt(node, supplement, noRoles)).toBe(buildCommerceTaskPrompt(parseCommerceTask(task), supplement))
          compared += 1
        }
      }
    }
    // Each option adds its own line, so every value of every option and every
    // pair of the first three is enough; the last two take turns.
    let turn = 0
    for (const toggles of subsets(['addDecor', 'addPeople', 'enclosedSpace', 'interiorLighting'])) {
      for (const weather of interiorWeatherOptions) for (const time of interiorTimeOptions) for (const exteriorOffset of [0, 1, 2]) {
        turn += 1
        const exterior = interiorExteriorOptions[(turn + exteriorOffset * 3) % interiorExteriorOptions.length]
        const filter = interiorFilterOptions[(turn * 3 + exteriorOffset) % interiorFilterOptions.length]
        const task = { version: 1, kind: 'interior-render', addDecor: toggles.includes('addDecor'), addPeople: toggles.includes('addPeople'), enclosedSpace: toggles.includes('enclosedSpace'), interiorLighting: toggles.includes('interiorLighting'), weather: weather.value, time: time.value, exterior: exterior.value, filter: filter.value }
        const supplement = supplements[compared % supplements.length]
        const node = pictureNode({ interiorTask: parseCanvasInteriorTask(task) })
        expect(buildCanvasSceneImagePrompt(node, supplement, noRoles)).toBe(resolveInteriorImageRequest(parseInteriorTask(task), { model: 'gpt-image-2', prompt: supplement }).prompt)
        compared += 1
      }
    }
    expect(compared).toBeGreaterThan(2_500)
  })

  it('writes the exterior and storyboard prompts, analysis prompts and roles exactly as the kernel does', () => {
    let compared = 0
    const exterior: unknown[] = [
      ...exteriorTaskKinds.filter((kind) => kind !== 'exterior-render' && kind !== 'exterior-redraw').flatMap((kind) => [true, false].map((automaticPrompt) => ({ version: 1, kind, automaticPrompt }))),
      ...[true, false].map((useToneReference) => ({ version: 1, kind: 'exterior-redraw', useToneReference })),
    ]
    let turn = 0
    for (const toggles of subsets(['addPeople', 'motionBlur', 'interiorLighting'])) {
      for (const lightTemperature of exteriorLightTemperatureOptions) for (const weather of exteriorWeatherOptions) for (const time of exteriorTimeOptions) for (const offset of [0, 1]) {
        turn += 1
        const environment = exteriorEnvironmentOptions[(turn + offset * 6) % exteriorEnvironmentOptions.length]
        const distant = exteriorDistantOptions[(turn * 3 + offset) % exteriorDistantOptions.length]
        exterior.push({ version: 1, kind: 'exterior-render', addPeople: toggles.includes('addPeople'), motionBlur: toggles.includes('motionBlur'), interiorLighting: toggles.includes('interiorLighting'), lightTemperature: lightTemperature.value, weather: weather.value, time: time.value, environment: environment.value, distant: distant.value })
      }
    }
    for (const [index, task] of exterior.entries()) {
      const supplement = supplements[index % supplements.length]
      const ours = parseCanvasExteriorTask(task)
      const theirs = parseExteriorTask(task)
      expect(outcome(() => buildCanvasSceneImagePrompt(pictureNode({ exteriorTask: ours }), supplement, noRoles)), JSON.stringify(task))
        .toEqual(outcome(() => resolveExteriorImageRequest(theirs, { model: 'gpt-image-2', prompt: supplement }).prompt))
      expect(canvasExteriorTaskRoles(ours)).toEqual(exteriorTaskRoles(theirs))
      expect(canvasExteriorTaskUsesAnalysis(ours)).toBe(exteriorTaskUsesAnalysis(theirs))
      expect(outcome(() => buildCanvasExteriorAnalysisPrompt(ours))).toEqual(outcome(() => buildExteriorAnalysisPrompt(theirs)))
      compared += 1
    }
    for (const automaticPlot of [true, false]) for (const style of storyboardStyleOptions) for (const panels of storyboardPanelOptions) {
      const task = { version: 1, kind: 'storyboard', automaticPlot, style: style.value, panels }
      const ours = parseCanvasStoryboardTask(task)
      const theirs = parseStoryboardTask(task)
      for (const supplement of supplements) {
        expect(outcome(() => buildCanvasSceneImagePrompt(pictureNode({ storyboardTask: ours }), supplement, noRoles)))
          .toEqual(outcome(() => resolveStoryboardImageRequest(theirs, { model: 'gpt-image-2', prompt: supplement }).prompt))
        expect(outcome(() => buildCanvasStoryboardAnalysisPrompt(ours, supplement))).toEqual(outcome(() => buildStoryboardAnalysisPrompt(theirs, supplement)))
        compared += 1
      }
      for (const count of [-1, 0, 1, 2, 4, 5, 1.5]) expect(outcome(() => canvasStoryboardTaskRoles(ours, count))).toEqual(outcome(() => storyboardTaskRoles(theirs, count)))
    }
    expect(compared).toBeGreaterThan(1_200)
    // Without a task: role lines when the node has roles, else the user's words as they are.
    const order: CanvasImageReferenceOrder = { version: 1, slots: [{ role: 'source', edgeId: 'e1', outputIndex: 0 }] }
    expect(buildCanvasSceneImagePrompt(pictureNode({ imageReferenceOrder: order }), '换成夜景', (prompt) => canvasImageReferenceRolePrompt(order, prompt))).toBe('第 1 张图片：原始主体图。\n换成夜景')
    expect(buildCanvasSceneImagePrompt(pictureNode({}), '换成夜景', noRoles)).toBe('换成夜景')
  })

  it('works out material B sizes and checks the result exactly as the kernel does', () => {
    const sources: Array<{ width?: number; height?: number } | undefined> = [undefined, {}, { width: 1024, height: 768 }, { width: 333, height: 777 }, { width: 0, height: 10 }, { width: 16384, height: 1 }, { width: 16385, height: 10 }, { width: 10.5, height: 10 }]
    for (const upscale of [1, 1.25, 1.5, 2]) {
      for (const kind of ['material-a', 'material-b', 'style-reference']) {
        const task = kind === 'material-b' ? { version: 1, kind, preserve: [], strength: 0.35, upscale } : kind === 'material-a' ? { version: 1, kind, preserve: [], strength: 0.35 } : { version: 1, kind, preserve: [] }
        for (const source of sources) {
          const target = outcome(() => resolveCanvasCommerceTargetSize(parseCanvasCommerceTask(task), source))
          expect(target, `${kind} ${upscale} ${JSON.stringify(source)}`).toEqual(outcome(() => resolveCommerceTargetSize(parseCommerceTask(task), source)))
          for (const output of [{}, { width: 1024, height: 768 }, { width: 1280, height: 960 }, { width: 1536, height: 1152 }, { width: 2048, height: 1536 }]) {
            expect(outcome(() => assertCanvasCommerceOutputSize(parseCanvasCommerceTask(task), source, output)))
              .toEqual(outcome(() => assertCommerceOutputSize(parseCommerceTask(task), source, output)))
          }
        }
      }
    }
    expect(outcome(() => assertCanvasCommerceOutputSize(undefined, undefined, {}))).toEqual(outcome(() => assertCommerceOutputSize(undefined, undefined, {})))
  })

  it('refuses a material-B size the desktop would not send exactly, before anything is paid', () => {
    expect(() => assertCanvasCommerceTargetSizeSupported('gpt-image-2', { width: 1536, height: 1152, size: '1536x1152' })).not.toThrow()
    // 1000 is not a multiple of 16: the relay would be asked for another size.
    expect(() => assertCanvasCommerceTargetSizeSupported('gpt-image-2', { width: 1000, height: 1000, size: '1000x1000' }))
      .toThrow('当前模型无法精确输出派生尺寸 1000x1000；请更换原图、请求倍率或模型。这个型号的宽和高都要是 16 的倍数，并在 256 到 4096 之间')
    expect(() => assertCanvasCommerceTargetSizeSupported('gpt-image-2', { width: 5120, height: 2880, size: '5120x2880' })).toThrow('当前模型无法精确输出派生尺寸 5120x2880')
    // gpt-image-1 only knows three sizes; Grok picks its own.
    expect(() => assertCanvasCommerceTargetSizeSupported('gpt-image-1', { width: 1024, height: 1536, size: '1024x1536' })).not.toThrow()
    expect(() => assertCanvasCommerceTargetSizeSupported('gpt-image-1', { width: 1280, height: 1280, size: '1280x1280' }))
      .toThrow('当前模型无法精确输出派生尺寸 1280x1280；请更换原图、请求倍率或模型。这个型号只支持这几种尺寸：1024x1024、1024x1536、1536x1024、auto')
    expect(() => assertCanvasCommerceTargetSizeSupported('grok-imagine-image', { width: 1024, height: 1024, size: '1024x1024' }))
      .toThrow('当前模型无法精确输出派生尺寸 1024x1024；请更换原图、请求倍率或模型。这个型号由服务决定尺寸，不能指定')
  })

  it('checks that a node carries one task with the picture roles it needs exactly as the kernel does', () => {
    const slot = (role: 'source' | 'reference', edgeId: string) => ({ role, edgeId, outputIndex: 0 })
    const orders: Array<CanvasImageReferenceOrder | undefined> = [
      undefined,
      { version: 1, slots: [slot('source', 'e1')] },
      { version: 1, slots: [slot('source', 'e1'), slot('reference', 'e2')] },
      { version: 1, slots: [slot('source', 'e1'), slot('reference', 'e2'), slot('reference', 'e3')] },
      { version: 1, slots: [slot('source', 'e1'), slot('reference', 'e2'), slot('reference', 'e3'), slot('reference', 'e4')] },
      { version: 1, slots: [slot('source', 'e1'), { role: 'reference', missing: true }] },
    ]
    const commerce = [undefined, ...['material-a', 'style-reference', 'product-view'].map((kind) => parseCommerceTask(kind === 'material-a' ? { version: 1, kind, preserve: [], strength: 0.4 } : kind === 'product-view' ? { version: 1, kind, preserve: [], view: 'top' } : { version: 1, kind, preserve: [] })),
      parseCommerceTask({ version: 1, kind: 'material-b', preserve: [], strength: 0.4, upscale: 1.5 })]
    const interior = [undefined, parseInteriorTask({ version: 1, kind: 'interior-render', addDecor: false, addPeople: false, enclosedSpace: false, interiorLighting: false, weather: 'sunny', time: 'noon-overcast', exterior: 'none', filter: 'none' })]
    const exterior = [undefined, parseExteriorTask({ version: 1, kind: 'exterior-redraw', useToneReference: false }), parseExteriorTask({ version: 1, kind: 'facade-renovation', automaticPrompt: false })]
    const storyboard = [undefined, parseStoryboardTask({ version: 1, kind: 'storyboard', automaticPlot: false, style: 'hand-drawn', panels: 9 })]
    const sizes: Array<{ size?: string; imageResolution?: '1K' | '2K' | '4K' }> = [{ size: 'auto' }, { size: 'auto', imageResolution: '1K' }, { size: 'auto', imageResolution: '2K' }, { size: '1024x1024' }, {}]
    let refusals = 0
    let compared = 0
    for (const order of orders) for (const commerceTask of commerce) for (const interiorTask of interior) for (const exteriorTask of exterior) for (const storyboardTask of storyboard) for (const size of sizes) {
      const data = { ...size, imageReferenceOrder: order, commerceTask, interiorTask, exteriorTask, storyboardTask }
      const ours = outcome(() => assertCanvasSceneTaskConfiguration(data))
      expect(ours, JSON.stringify(data)).toEqual(outcome(() => assertCommerceTaskConfiguration(commerceTask, order, size, interiorTask, exteriorTask, storyboardTask)))
      if ('error' in ours) refusals += 1
      compared += 1
    }
    expect(refusals).toBeGreaterThan(compared / 2)
    expect(refusals).toBeLessThan(compared)
  })

  it('refuses an automatic exterior prompt or storyboard plot that reads other pictures before a run, as the kernel does', () => {
    const exteriorTask = parseCanvasExteriorTask({ version: 1, kind: 'landscape-redesign', automaticPrompt: true })
    const storyboardTask = parseCanvasStoryboardTask({ version: 1, kind: 'storyboard', automaticPlot: true, style: 'cinematic', panels: 4 })
    const pictures = ['a', 'b', 'c'].map((name) => ({ id: name, kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: name.repeat(43) } }) satisfies CanvasRunGraphNode)
    const roles = (target: string, names: readonly string[]): CanvasImageReferenceOrder => ({ version: 1, slots: names.map((name, index) => ({ role: index === 0 ? 'source' : 'reference', edgeId: `${name}-${target}`, outputIndex: 0 })) })
    const imageEdges = (target: string, names: readonly string[]): CanvasRunGraph['edges'] => names.map((name) => ({ id: `${name}-${target}`, source: name, sourceHandle: 'out:image', target, targetHandle: 'in:images' }))
    const textEdge = { id: 'text-target', source: 'analysis', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:text' }
    interface Variant { name: string; analysis?: Partial<CanvasRunGraphNode['data']> & { disabled?: boolean; kind?: CanvasRunGraphNode['kind'] }; analysisPictures?: readonly string[]; analysisOrder?: readonly string[]; targetPictures?: readonly string[]; extraEdges?: CanvasRunGraph['edges']; noText?: boolean; prompt?: string }
    const variants: Variant[] = [
      { name: 'matching' },
      { name: 'no analysis node', noText: true },
      { name: 'not a text node', analysis: { kind: 'text' } },
      { name: 'disabled', analysis: { disabled: true } },
      { name: 'edited prompt', analysis: { prompt: '自己写的分析' } },
      { name: 'model that cannot see', analysis: { model: 'gpt-5.6-sol' } },
      { name: 'other pictures', analysisPictures: ['a', 'c'], analysisOrder: ['a', 'c'] },
      { name: 'swapped order', analysisOrder: ['b', 'a'] },
      { name: 'picture without a role', analysisPictures: ['a', 'b', 'c'] },
      { name: 'extra text into the analysis', extraEdges: [{ id: 'extra', source: 'a', sourceHandle: 'out:text', target: 'analysis', targetHandle: 'in:text' }] },
      { name: 'analysis without roles', analysisOrder: [] },
      { name: 'one picture on the target', targetPictures: ['a'] },
      { name: 'the plot changed since the analysis', prompt: '他们去了海边' },
    ]
    let refusals = 0
    for (const kind of ['exterior', 'storyboard'] as const) {
      for (const variant of variants) {
        const targetPictures = variant.targetPictures ?? ['a', 'b']
        const analysisPictures = variant.analysisPictures ?? ['a', 'b']
        const analysisOrder = variant.analysisOrder ?? ['a', 'b']
        const targetPrompt = kind === 'storyboard' ? '两只猫在窗台上' : ''
        const analysisPrompt = kind === 'exterior' ? buildCanvasExteriorAnalysisPrompt(exteriorTask) : buildCanvasStoryboardAnalysisPrompt(storyboardTask, targetPrompt)
        const { disabled, kind: analysisKind, ...analysisData } = variant.analysis ?? {}
        const analysis: CanvasRunGraphNode = {
          id: 'analysis', kind: analysisKind ?? 'text-generate', definitionVersion: 1, ...(disabled ? { disabled } : {}),
          data: { prompt: analysisPrompt, model: 'gpt-5.5', ...(analysisOrder.length ? { imageReferenceOrder: roles('analysis', analysisOrder) } : {}), ...analysisData },
        }
        const target: CanvasRunGraphNode = {
          id: 'target', kind: 'image-edit', definitionVersion: 1,
          data: { prompt: variant.prompt ?? targetPrompt, model: 'gpt-image-2', imageReferenceOrder: roles('target', targetPictures), ...(kind === 'exterior' ? { exteriorTask } : { storyboardTask }) },
        }
        const edges = [...imageEdges('target', targetPictures), ...imageEdges('analysis', analysisPictures), ...(variant.noText ? [] : [textEdge]), ...(variant.extraEdges ?? [])]
        const nodes = new Map<string, CanvasRunGraphNode>([...pictures, analysis, target].map((node) => [node.id, node]))
        const ours = outcome(() => {
          assertCanvasSceneRunConfiguration(target, edges, nodes)
          assertCanvasImageReferenceRunConfiguration(target, edges, nodes)
        })
        const kernel = outcome(() => assertImageReferenceRunConfiguration(JSON.parse(JSON.stringify(target)), JSON.parse(JSON.stringify(edges)), new Map(JSON.parse(JSON.stringify([...nodes.entries()])))))
        expect(ours, `${kind}: ${variant.name}`).toEqual(kernel)
        if ('error' in ours) refusals += 1
        expect(ours, `${kind}: ${variant.name}`).toEqual(variant.name === 'matching' || kind === 'exterior' && variant.name === 'the plot changed since the analysis' ? { value: undefined } : expect.objectContaining({ error: expect.any(String) }))
        // The analysis node reads the same pictures, so its bytes are compared too.
        if (variant.name === 'matching') expect(canvasSceneSourceChecks(analysis, edges, nodes)).toEqual([kind])
      }
    }
    expect(refusals).toBeGreaterThan(20)
  })

  it('names the nodes whose pictures are compared by their bytes, as the web host does', () => {
    const edge = (id: string, source: string, target: string, handles: [string, string]) => ({ id, source, sourceHandle: handles[0], target, targetHandle: handles[1] })
    const exteriorOne = pictureNode({ exteriorTask: parseCanvasExteriorTask({ version: 1, kind: 'exterior-redraw', useToneReference: false }) }, 'one')
    const exteriorTwo = pictureNode({ exteriorTask: parseCanvasExteriorTask({ version: 1, kind: 'exterior-redraw', useToneReference: true }) }, 'two')
    const exteriorTyped = pictureNode({ exteriorTask: parseCanvasExteriorTask({ version: 1, kind: 'storefront-redesign', automaticPrompt: false }) }, 'typed')
    const storyboard = pictureNode({ storyboardTask: parseCanvasStoryboardTask({ version: 1, kind: 'storyboard', automaticPlot: false, style: 'white-model', panels: 16 }) }, 'board')
    const text: CanvasRunGraphNode = { id: 'text', kind: 'text-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-5.5' } }
    const nodes = new Map([exteriorOne, exteriorTwo, exteriorTyped, storyboard, text].map((node) => [node.id, node]))
    expect(canvasSceneSourceChecks(exteriorOne, [], nodes)).toEqual([])
    expect(canvasSceneSourceChecks(exteriorTwo, [], nodes)).toEqual(['exterior'])
    expect(canvasSceneSourceChecks(exteriorTyped, [], nodes)).toEqual(['exterior'])
    expect(canvasSceneSourceChecks(storyboard, [], nodes)).toEqual(['storyboard'])
    expect(canvasSceneSourceChecks(pictureNode({}), [], nodes)).toEqual([])
    // A text node only when it writes the prompt of a task that reads it automatically.
    expect(canvasSceneSourceChecks(text, [edge('t1', 'text', 'typed', ['out:text', 'in:text']), edge('t2', 'text', 'board', ['out:text', 'in:text'])], nodes)).toEqual([])
    const automatic = pictureNode({ storyboardTask: parseCanvasStoryboardTask({ version: 1, kind: 'storyboard', automaticPlot: true, style: 'white-model', panels: 16 }) }, 'auto')
    nodes.set('auto', automatic)
    expect(canvasSceneSourceChecks(text, [edge('t3', 'text', 'auto', ['out:text', 'in:text'])], nodes)).toEqual(['storyboard'])
  })

  it('compares the pictures by their bytes before the paid request, refusing the same picture under two ids', async () => {
    const files = new Map<string, Buffer>([['a', Buffer.from('aaaa')], ['b', Buffer.from('bbbb')], ['copy', Buffer.from('aaaa')], ['big', Buffer.alloc(13 * 1024 * 1024, 1)], ['big2', Buffer.alloc(12 * 1024 * 1024, 2)]])
    const reads: string[] = []
    async function read(assetId: string): Promise<Buffer> {
      reads.push(assetId)
      return files.get(assetId)!
    }
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages([], ['a', 'a'], undefined))).toEqual({ value: undefined })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['a', 'b'], read))).toEqual({ value: undefined })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['a', 'copy'], read))).toEqual({ error: '原图与参考图内容相同，请选择内容不同的两张图片；当前没有提交生成请求' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['a'], read))).toEqual({ error: '室外双图任务需要两张内容不同的原图和参考图' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['a', 'a'], read))).toEqual({ error: '室外双图任务需要两张内容不同的原图和参考图' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['big', 'big2'], read))).toEqual({ error: '室外参考图片总容量不能超过 24 MB，当前没有提交生成请求' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['a', 'b'], undefined))).toEqual({ error: '室外参考图内容核对服务暂时不可用，当前没有提交生成请求' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['storyboard'], ['a'], read))).toEqual({ value: undefined })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['storyboard'], ['b', 'a', 'copy'], read))).toEqual({ error: '故事板输入图片内容相同，请选择内容不同的图片；当前没有提交生成请求' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['storyboard'], [], read))).toEqual({ error: '故事板需要 1–4 张内容不同的有序图片' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['storyboard'], ['a', 'b', 'copy', 'big', 'big2'], read))).toEqual({ error: '故事板需要 1–4 张内容不同的有序图片' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['storyboard'], ['big', 'big2'], read))).toEqual({ error: '故事板输入图片总容量不能超过 24 MB，当前没有提交生成请求' })
    expect(await asyncOutcome(() => assertCanvasSceneSourceImages(['storyboard'], ['a'], undefined))).toEqual({ error: '故事板输入图片内容核对服务暂时不可用，当前没有提交生成请求' })
    // A refusal by count reads nothing.
    reads.length = 0
    await asyncOutcome(() => assertCanvasSceneSourceImages(['exterior'], ['a', 'b', 'copy'], read))
    expect(reads).toEqual([])
  })
})

function noRoles(prompt: string): string {
  return prompt
}

function pictureNode(data: Partial<CanvasRunGraphNode['data']>, id = 'target'): CanvasRunGraphNode {
  return { id, kind: 'image-edit', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', ...data } }
}
