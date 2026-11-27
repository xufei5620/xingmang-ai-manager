import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCodexDesktopOfficialPackageSource,
  downloadCodexDesktopOfficialPackage,
  downloadCodexDesktopPackage,
} from './codex-desktop-service'
import { InstallCancelledError, isInstallCancelledError } from './install-cancellation'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDestination(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-desktop-cancel-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'Codex.msix')
}

/**
 * 一个吐出头一块之后就停住的响应体：下载真正在跑的那一刻才有机会点取消，
 * 一次性交完整个 Buffer 的假响应测不到这条路径。请求信号一中止就让流出错，
 * 这正是 undici 对被 abort 的 fetch 的行为。
 */
function stallingResponse(
  url: string,
  firstChunk: Uint8Array,
  total: number,
  requestSignal: AbortSignal | null | undefined,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstChunk)
      const fail = () => controller.error(
        requestSignal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }),
      )
      if (requestSignal?.aborted) fail()
      else requestSignal?.addEventListener('abort', fail, { once: true })
    },
  })
  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/vnd.ms-appx',
      'Content-Length': String(total),
    },
  })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

describe('cancelling a Codex Desktop download', () => {
  it('stops the running download and asks for nothing more', async () => {
    const destination = temporaryDestination()
    const total = 10 * 1024 * 1024
    const packageUrl = buildCodexDesktopOfficialPackageSource('x64').url
    const controller = new AbortController()
    const requested: string[] = []
    const fetchMock = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = String(value)
      requested.push(url)
      return stallingResponse(url, Buffer.alloc(64 * 1024, 0x41), total, init?.signal)
    })

    const download = downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination,
      installedVersion: null,
      knownVersion: '26.721.4979.0',
      fetchImplementation: fetchMock,
      signal: controller.signal,
    })
    const settled = download.catch((error: unknown) => error)

    await vi.waitFor(() => expect(requested).toEqual([packageUrl]))
    controller.abort(new InstallCancelledError())

    expect(isInstallCancelledError(await settled)).toBe(true)
    // 断线续传那样再要一次就等于没取消。
    expect(requested).toEqual([packageUrl])
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('refuses to start when the cancel arrived while the install was queued', async () => {
    const destination = temporaryDestination()
    const fetchMock = vi.fn()
    const controller = new AbortController()
    controller.abort(new InstallCancelledError())

    const error = await downloadCodexDesktopOfficialPackage({
      architecture: 'x64',
      destination,
      installedVersion: null,
      knownVersion: null,
      fetchImplementation: fetchMock,
      signal: controller.signal,
    }).catch((cause: unknown) => cause)

    expect(isInstallCancelledError(error)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still calls a timed-out connection a timeout rather than a cancellation', async () => {
    const destination = temporaryDestination()
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    })

    await expect(downloadCodexDesktopPackage({
      label: '测试源',
      url: 'https://mirror.example.cn/Codex.msix',
    }, destination, () => undefined, fetchMock))
      .rejects.toThrow('连接或下载超时')
  })

  it('calls an abort that came from the user a cancellation, not a timeout', async () => {
    const destination = temporaryDestination()
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      controller.abort(new InstallCancelledError())
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    })

    const error = await downloadCodexDesktopPackage({
      label: '测试源',
      url: 'https://mirror.example.cn/Codex.msix',
    }, destination, () => undefined, fetchMock, controller.signal)
      .catch((cause: unknown) => cause)

    expect(isInstallCancelledError(error)).toBe(true)
  })
})
