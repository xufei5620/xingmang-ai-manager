import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isImageUpscaleJob, isOrtModuleLike, runImageUpscaleJob, type ImageUpscaleJob, type ImageUpscaleWorkerMessage, type OrtModuleLike } from './image-upscale-worker'
import { resolveImageUpscaleModelPath, resolveImageUpscaleOrtDirectory } from './image-upscale-service'

const projectRoot = path.resolve(__dirname, '..')

function bgra(width: number, height: number, alpha = 255): ArrayBuffer {
  const bytes = new Uint8Array(width * height * 4)
  for (let index = 0; index < bytes.length; index += 4) {
    bytes[index] = (index * 3) & 0xff
    bytes[index + 1] = (index * 5) & 0xff
    bytes[index + 2] = (index * 7) & 0xff
    bytes[index + 3] = alpha
  }
  return bytes.buffer
}

function job(overrides: Partial<ImageUpscaleJob> = {}): ImageUpscaleJob {
  return { type: 'run', model: new ArrayBuffer(4), width: 6, height: 5, bgra: bgra(6, 5), scale: 2, ...overrides }
}

/** A runtime whose "model" repeats each input pixel 4×4 times. */
function fakeOrt(options: { run?: (input: Float32Array, width: number, height: number) => Float32Array | Promise<Float32Array> } = {}) {
  const disposed: string[] = []
  const release = vi.fn(async () => undefined)
  const create = vi.fn(async () => ({
    inputNames: ['input'],
    outputNames: ['output'],
    async run(feeds: Record<string, { data: unknown; dims: readonly number[] }>) {
      const tensor = feeds.input
      const [, , height, width] = tensor.dims
      const input = tensor.data as Float32Array
      const output = options.run ? await options.run(input, width, height) : nearest(input, width, height)
      return { output: { data: output, dims: [1, 3, height * 4, width * 4], dispose: () => disposed.push('output') } }
    },
    release,
  }))
  const ort = {
    env: { wasm: {} as { numThreads?: number } },
    Tensor: class {
      constructor(public type: string, public data: Float32Array, public dims: number[]) {}
      dispose() { disposed.push('input') }
    },
    InferenceSession: { create },
  }
  return { ort: ort as unknown as OrtModuleLike, create, release, disposed, wasm: ort.env.wasm }
}

function nearest(input: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(width * height * 48)
  const outWidth = width * 4
  const plane = width * height
  for (let channel = 0; channel < 3; channel += 1) {
    for (let y = 0; y < height * 4; y += 1) {
      for (let x = 0; x < outWidth; x += 1) output[channel * plane * 16 + y * outWidth + x] = input[channel * plane + (y >> 2) * width + (x >> 2)]
    }
  }
  return output
}

describe('image upscale worker', () => {
  it('accepts only a well-formed job and a runtime with the parts it calls', () => {
    expect(isImageUpscaleJob(job())).toBe(true)
    expect(isImageUpscaleJob({ ...job(), scale: 3 })).toBe(false)
    expect(isImageUpscaleJob({ ...job(), model: new Uint8Array(4) })).toBe(false)
    expect(isImageUpscaleJob({ ...job(), width: 1.5 })).toBe(false)
    expect(isImageUpscaleJob({ ...job(), type: 'stop' })).toBe(false)
    expect(isOrtModuleLike(fakeOrt().ort)).toBe(false)
    expect(isOrtModuleLike({ env: { wasm: {} }, Tensor: class {}, InferenceSession: class { static create() {} } })).toBe(true)
    expect(isOrtModuleLike({ env: { wasm: {} }, Tensor: class {}, InferenceSession: class {} })).toBe(false)
  })

  it('runs every tile on the wasm backend, reports progress and hands back a PNG it transfers', async () => {
    const { ort, create, release, disposed, wasm } = fakeOrt()
    const posted: Array<{ message: ImageUpscaleWorkerMessage; transfer?: ArrayBuffer[] }> = []
    await runImageUpscaleJob(job({ width: 300, height: 10, bgra: bgra(300, 10), scale: 4 }), ort, 9, (message, transfer) => posted.push({ message, transfer }))
    expect(wasm.numThreads).toBe(4)
    expect(create).toHaveBeenCalledWith(expect.any(Uint8Array), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    expect(posted.map(({ message }) => message.type)).toEqual(['progress', 'progress', 'done'])
    const done = posted[2]
    if (done.message.type !== 'done') throw new Error('expected done')
    expect([done.message.width, done.message.height]).toEqual([1200, 40])
    expect(Buffer.from(done.message.png).subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(done.transfer).toEqual([done.message.png])
    expect(disposed.filter((name) => name === 'input')).toHaveLength(2)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('turns any failure into one failed message and still releases the session', async () => {
    const { ort, release } = fakeOrt({ run: () => new Float32Array(3) })
    const posted: ImageUpscaleWorkerMessage[] = []
    await runImageUpscaleJob(job(), ort, 1, (message) => posted.push(message))
    expect(posted).toEqual([{ type: 'failed', message: '模型输出尺寸与输入不符' }])
    expect(release).toHaveBeenCalledTimes(1)

    const broken = fakeOrt()
    broken.create.mockRejectedValueOnce(new Error('bad model'))
    const failures: ImageUpscaleWorkerMessage[] = []
    await runImageUpscaleJob(job(), broken.ort, 0, (message) => failures.push(message))
    expect(failures).toEqual([{ type: 'failed', message: 'bad model' }])
    expect(broken.wasm.numThreads).toBe(1)
  })

  it('upscales with the real runtime and the bundled model', async () => {
    const loaded: unknown = createRequire(__filename)(resolveImageUpscaleOrtDirectory(projectRoot, false))
    if (!isOrtModuleLike(loaded)) throw new Error('onnxruntime-web did not load')
    const model = fs.readFileSync(resolveImageUpscaleModelPath(projectRoot))
    const posted: ImageUpscaleWorkerMessage[] = []
    const width = 20
    const height = 12
    await runImageUpscaleJob({
      type: 'run',
      model: model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength),
      width,
      height,
      bgra: bgra(width, height, 200),
      scale: 2,
    }, loaded, 1, (message) => posted.push(message))
    const done = posted.at(-1)
    if (done?.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(done)}`)
    expect([done.width, done.height]).toEqual([40, 24])
    const png = Buffer.from(done.png)
    // Colour type 6: the half-transparent source keeps its alpha channel.
    expect(png[25]).toBe(6)
  }, 60_000)
})
