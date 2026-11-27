import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createImageUpscaleService,
  imageUpscaleMessages,
  imageUpscaleModelRelativePath,
  imageUpscaleModelSha256,
  imageUpscaleRefusalMessage,
  isImageUpscaleWorkerMessage,
  resolveImageUpscaleModelPath,
  resolveImageUpscaleOrtDirectory,
  resolveImageUpscaleThreads,
  type ImageUpscaleDecoded,
  type ImageUpscaleServiceOptions,
  type ImageUpscaleWorkerLike,
} from './image-upscale-service'
import type { ImageUpscaleJob } from './image-upscale-worker'

const projectRoot = path.resolve(__dirname, '..')
// The real bundled model: the service checks it against the hash it pins, and
// a test hook to change that hash would be one more way to skip the check.
const model = fs.readFileSync(resolveImageUpscaleModelPath(projectRoot))

class FakeWorker extends EventEmitter implements ImageUpscaleWorkerLike {
  jobs: ImageUpscaleJob[] = []
  transfers: ArrayBuffer[][] = []
  terminated = 0

  postMessage(value: unknown, transfer?: ArrayBuffer[]): void {
    this.jobs.push(value as ImageUpscaleJob)
    this.transfers.push(transfer ?? [])
  }

  terminate(): Promise<number> {
    this.terminated += 1
    return Promise.resolve(0)
  }
}

function decoded(width = 4, height = 3): ImageUpscaleDecoded {
  return { width, height, bgra: new Uint8Array(width * height * 4).fill(255) }
}

function createService(overrides: Partial<ImageUpscaleServiceOptions> = {}) {
  const workers: FakeWorker[] = []
  const log = vi.fn()
  const service = createImageUpscaleService({
    modelPath: '/app/bundled-catalog/image-upscale/realesr-general-x4v3.onnx',
    ortModuleDirectory: '/app/dist-image-upscale/node_modules/onnxruntime-web',
    decode: () => decoded(),
    readFile: async () => model,
    createWorker: (data) => {
      expect(data).toEqual({ kind: 'xingmang-image-upscale', ortModuleDirectory: '/app/dist-image-upscale/node_modules/onnxruntime-web', threads: 3 })
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
    threads: 3,
    log,
    now: () => 1000,
    ...overrides,
  })
  return { service, workers, log }
}

async function nextWorker(workers: FakeWorker[], index = 0): Promise<FakeWorker> {
  await vi.waitFor(() => expect(workers[index]?.jobs).toHaveLength(1))
  return workers[index]
}

function png(): ArrayBuffer {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
}

afterEach(() => {
  vi.useRealTimers()
})

describe('image upscale service', () => {
  it('pins the bundled model to the hash in the service, the manifest and the file itself', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'bundled-catalog', 'image-upscale', 'manifest.json'), 'utf8'))
    expect(manifest.onnx.sha256).toBe(imageUpscaleModelSha256)
    expect(manifest.onnx.file).toBe(imageUpscaleModelRelativePath.at(-1))
    const bytes = fs.readFileSync(resolveImageUpscaleModelPath(projectRoot))
    expect(bytes.byteLength).toBe(manifest.onnx.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(imageUpscaleModelSha256)
    expect(createHash('sha256').update(fs.readFileSync(path.join(projectRoot, 'bundled-catalog', 'image-upscale', 'LICENSE'))).digest('hex')).toBe(manifest.source.licenseSha256)
  })

  it('leaves a core for the rest of the computer and never runs more than four threads', () => {
    expect([1, 2, 3, 4, 6, 16, Number.NaN].map(resolveImageUpscaleThreads)).toEqual([1, 1, 2, 3, 4, 4, 1])
  })

  it('loads the runtime from the trimmed copy in a packaged build and from node_modules in development', () => {
    expect(resolveImageUpscaleOrtDirectory('/app.asar', true)).toBe(path.join(path.resolve('/app.asar'), 'dist-image-upscale', 'node_modules', 'onnxruntime-web'))
    expect(resolveImageUpscaleOrtDirectory('/project', false)).toBe(path.join(path.resolve('/project'), 'node_modules', 'onnxruntime-web'))
    expect(resolveImageUpscaleModelPath('/app.asar')).toBe(path.join(path.resolve('/app.asar'), 'bundled-catalog', 'image-upscale', 'realesr-general-x4v3.onnx'))
  })

  it('picks the sentence for a refusal, suggesting 2x only when 2x would fit', () => {
    expect(imageUpscaleRefusalMessage('output-too-large', 2048, 1152, 4)).toBe(imageUpscaleMessages.outputTooLargeFor4x)
    expect(imageUpscaleRefusalMessage('output-too-large', 5000, 100, 4)).toBe(imageUpscaleMessages.tooLarge)
    expect(imageUpscaleRefusalMessage('input-too-large', 3000, 3000, 2)).toBe(imageUpscaleMessages.tooLarge)
    expect(imageUpscaleRefusalMessage('empty', 0, 0, 2)).toBe(imageUpscaleMessages.unreadable)
  })

  it('recognises only the three messages a worker sends', () => {
    expect(isImageUpscaleWorkerMessage({ type: 'progress', done: 1, total: 2 })).toBe(true)
    expect(isImageUpscaleWorkerMessage({ type: 'done', png: new ArrayBuffer(1), width: 2, height: 2 })).toBe(true)
    expect(isImageUpscaleWorkerMessage({ type: 'failed', message: 'x' })).toBe(true)
    expect(isImageUpscaleWorkerMessage({ type: 'done', png: Buffer.from('x'), width: 2, height: 2 })).toBe(false)
    expect(isImageUpscaleWorkerMessage({ type: 'progress', done: '1', total: 2 })).toBe(false)
    expect(isImageUpscaleWorkerMessage(null)).toBe(false)
  })

  it('hands the verified model and the pixels to a worker, returns its PNG and ends the worker', async () => {
    const { service, workers, log } = createService()
    const pending = service.upscale({ bytes: Buffer.from('picture'), width: 4, height: 3, scale: 4 })
    const worker = await nextWorker(workers)
    const [job] = worker.jobs
    expect(job).toMatchObject({ type: 'run', width: 4, height: 3, scale: 4 })
    expect(Buffer.from(job.model).equals(model)).toBe(true)
    expect(worker.transfers[0]).toEqual([job.model, job.bgra])
    worker.emit('message', { type: 'progress', done: 1, total: 1 })
    worker.emit('message', { type: 'done', png: png(), width: 16, height: 12 })
    await expect(pending).resolves.toEqual({ png: Buffer.from(png()), width: 16, height: 12 })
    expect(worker.terminated).toBe(1)
    expect(log).toHaveBeenCalledWith('info', 'image-upscale.done', '图片已在本机变清晰', expect.objectContaining({ width: 4, height: 3, scale: 4, threads: 3 }))
  })

  it('runs one picture at a time', async () => {
    const { service, workers } = createService()
    const first = service.upscale({ bytes: Buffer.from('one'), scale: 2 })
    const second = service.upscale({ bytes: Buffer.from('two'), scale: 2 })
    const firstWorker = await nextWorker(workers)
    expect(workers).toHaveLength(1)
    firstWorker.emit('message', { type: 'failed', message: 'out of memory' })
    await expect(first).rejects.toThrow(imageUpscaleMessages.failed)
    const secondWorker = await nextWorker(workers, 1)
    secondWorker.emit('message', { type: 'done', png: png(), width: 8, height: 6 })
    await expect(second).resolves.toMatchObject({ width: 8, height: 6 })
  })

  it('gives up on a worker that stops reporting, and on one that exits or errors', async () => {
    vi.useFakeTimers()
    const { service, workers, log } = createService({ stallTimeoutMs: 5000 })
    const stalled = service.upscale({ bytes: Buffer.from('one'), scale: 2 })
    const worker = await nextWorker(workers)
    await vi.advanceTimersByTimeAsync(4000)
    worker.emit('message', { type: 'progress', done: 1, total: 4 })
    await vi.advanceTimersByTimeAsync(4000)
    expect(worker.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(stalled).rejects.toThrow(imageUpscaleMessages.failed)
    expect(worker.terminated).toBe(1)
    expect(log).toHaveBeenCalledWith('error', 'image-upscale.failed', '图片本机变清晰失败', expect.objectContaining({ reason: '后台线程长时间没有进展' }))

    const exited = service.upscale({ bytes: Buffer.from('two'), scale: 2 })
    ;(await nextWorker(workers, 1)).emit('exit', 1)
    await expect(exited).rejects.toThrow(imageUpscaleMessages.failed)
    const errored = service.upscale({ bytes: Buffer.from('three'), scale: 2 })
    ;(await nextWorker(workers, 2)).emit('error', new Error('worker crashed'))
    await expect(errored).rejects.toMatchObject({ message: imageUpscaleMessages.failed, cause: new Error('worker crashed') })
  })

  it('refuses a damaged or swapped model before starting a worker', async () => {
    const swapped = Buffer.from(model)
    swapped[swapped.length - 1] ^= 1
    const { service, workers } = createService({ readFile: async () => swapped })
    await expect(service.upscale({ bytes: Buffer.from('picture'), scale: 2 })).rejects.toMatchObject({ message: imageUpscaleMessages.failed, cause: new Error('本机模型文件校验失败') })
    const empty = createService({ readFile: async () => Buffer.alloc(0) })
    await expect(empty.service.upscale({ bytes: Buffer.from('picture'), scale: 2 })).rejects.toThrow(imageUpscaleMessages.failed)
    const unreadable = createService({ readFile: async () => { throw new Error('ENOENT') } })
    await expect(unreadable.service.upscale({ bytes: Buffer.from('picture'), scale: 2 })).rejects.toThrow(imageUpscaleMessages.failed)
    expect([...workers, ...empty.workers, ...unreadable.workers]).toHaveLength(0)
  })

  it('refuses a picture it cannot read or that is too large, before decoding when the header says so', async () => {
    const decode = vi.fn(() => decoded())
    const { service, workers } = createService({ decode })
    await expect(service.upscale({ bytes: Buffer.alloc(0), scale: 2 })).rejects.toThrow(imageUpscaleMessages.unreadable)
    await expect(service.upscale({ bytes: Buffer.from('x'), scale: 3 as never })).rejects.toThrow('放大倍数无效')
    await expect(service.upscale({ bytes: Buffer.from('x'), width: 2048, height: 1152, scale: 4 })).rejects.toThrow(imageUpscaleMessages.outputTooLargeFor4x)
    await expect(service.upscale({ bytes: Buffer.from('x'), width: 4000, height: 3000, scale: 2 })).rejects.toThrow(imageUpscaleMessages.tooLarge)
    expect(decode).not.toHaveBeenCalled()

    decode.mockReturnValueOnce(decoded(3000, 3000))
    await expect(service.upscale({ bytes: Buffer.from('x'), scale: 2 })).rejects.toThrow(imageUpscaleMessages.tooLarge)
    decode.mockReturnValueOnce(null as never)
    await expect(service.upscale({ bytes: Buffer.from('x'), scale: 2 })).rejects.toThrow(imageUpscaleMessages.unreadable)
    decode.mockReturnValueOnce({ width: 4, height: 3, bgra: new Uint8Array(5) })
    await expect(service.upscale({ bytes: Buffer.from('x'), scale: 2 })).rejects.toThrow(imageUpscaleMessages.unreadable)
    decode.mockImplementationOnce(() => { throw new Error('bad image') })
    await expect(service.upscale({ bytes: Buffer.from('x'), scale: 2 })).rejects.toThrow(imageUpscaleMessages.unreadable)
    expect(workers).toHaveLength(0)
  })

  it('ignores messages that are not one of the three a worker sends', async () => {
    const { service, workers } = createService()
    const pending = service.upscale({ bytes: Buffer.from('picture'), scale: 2 })
    const worker = await nextWorker(workers)
    worker.emit('message', { type: 'done', png: 'not bytes', width: 1, height: 1 })
    worker.emit('message', 'noise')
    worker.emit('message', { type: 'done', png: png(), width: 8, height: 6 })
    await expect(pending).resolves.toMatchObject({ width: 8 })
  })
})
