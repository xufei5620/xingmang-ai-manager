import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createUpdateRequestGuard } from './update-request-guard'

// Electron's ClientRequest as electron-updater uses it: the response callback is
// attached inside createRequest, before the request is handed back.
class FakeRequest extends EventEmitter {
  aborted = false

  abort(): void {
    this.aborted = true
    this.emit('abort')
  }
}

class FakeExecutor {
  readonly requests: FakeRequest[] = []

  createRequest(_options: unknown, callback: (response: unknown) => void): FakeRequest {
    const request = new FakeRequest()
    request.on('response', callback)
    this.requests.push(request)
    return request
  }
}

// What electron-updater does with a request: it reads the body of a response it takes
// inside the response callback, leaves one it turns down unread, and listens for the
// request's errors.
function libraryRequest(executor: FakeExecutor, takesResponse = true) {
  const responses: unknown[] = []
  const errors: unknown[] = []
  const request = executor.createRequest({}, (response) => {
    responses.push(response)
    if (takesResponse && response instanceof EventEmitter) response.on('data', () => {})
  })
  request.on('error', (error) => { errors.push(error) })
  return { request, responses, errors }
}

describe('update request guard', () => {
  it('wraps nothing when there is no createRequest to wrap', () => {
    expect(createUpdateRequestGuard(null)).toBeNull()
    expect(createUpdateRequestGuard({})).toBeNull()
    expect(createUpdateRequestGuard({ createRequest: 'not a function' })).toBeNull()
  })

  it('hands every request and response through and notes when data arrived', () => {
    let now = 1_000
    const executor = new FakeExecutor()
    const guard = createUpdateRequestGuard(executor, () => now)
    expect(guard?.lastReceivedAt()).toBeNull()

    const { request, responses } = libraryRequest(executor)
    expect(executor.requests).toEqual([request])
    const response = new EventEmitter()
    now = 2_000
    request.emit('response', response)
    expect(responses).toEqual([response])
    expect(guard?.lastReceivedAt()).toBe(2_000)

    now = 3_500
    response.emit('data', Buffer.alloc(1))
    expect(guard?.lastReceivedAt()).toBe(3_500)
  })

  it('keeps a response that fails mid-body from throwing for want of a listener', () => {
    const executor = new FakeExecutor()
    createUpdateRequestGuard(executor)
    for (const takesResponse of [true, false]) {
      const { request } = libraryRequest(executor, takesResponse)
      const response = new EventEmitter()
      request.emit('response', response)
      expect(() => response.emit('error', new Error('net::ERR_CONNECTION_CLOSED'))).not.toThrow()
    }
  })

  it('leaves a response electron-updater turned down unread and stops tracking it', () => {
    let now = 1_000
    const executor = new FakeExecutor()
    const guard = createUpdateRequestGuard(executor, () => now)
    const { request } = libraryRequest(executor, false)
    // Electron's IncomingMessage is a Readable that pulls more of the body off the
    // network only while something reads it.
    const response = new Readable({ read() {} })
    now = 2_000
    request.emit('response', response)
    expect(response.readableFlowing).toBeNull()
    expect(response.listenerCount('data')).toBe(0)
    expect(guard?.lastReceivedAt()).toBe(2_000)
    expect(guard?.abortAll(new Error('update download stalled'))).toBe(0)
    expect(request.aborted).toBe(false)
  })

  it('fails the requests still open the way a dropped connection would', () => {
    const executor = new FakeExecutor()
    const guard = createUpdateRequestGuard(executor)
    const finished = libraryRequest(executor)
    const finishedResponse = new EventEmitter()
    finished.request.emit('response', finishedResponse)
    finishedResponse.emit('end')
    const waiting = libraryRequest(executor)
    const stalled = libraryRequest(executor)
    stalled.request.emit('response', new EventEmitter())

    const reason = new Error('update download stalled')
    expect(guard?.abortAll(reason)).toBe(2)
    expect(waiting.errors).toEqual([reason])
    expect(stalled.errors).toEqual([reason])
    expect([waiting.request.aborted, stalled.request.aborted]).toEqual([true, true])
    expect(finished.errors).toEqual([])
    expect(finished.request.aborted).toBe(false)
    expect(guard?.abortAll(reason)).toBe(0)
  })

  it('forgets requests that already failed or were aborted on their own', () => {
    const executor = new FakeExecutor()
    const guard = createUpdateRequestGuard(executor)
    libraryRequest(executor).request.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'))
    libraryRequest(executor).request.abort()
    const closed = libraryRequest(executor)
    const response = new EventEmitter()
    closed.request.emit('response', response)
    response.emit('close')
    expect(guard?.abortAll(new Error('update download stalled'))).toBe(0)
  })

  it('still aborts the rest when one request throws', () => {
    const executor = new FakeExecutor()
    const guard = createUpdateRequestGuard(executor)
    const broken = libraryRequest(executor)
    broken.request.abort = () => { throw new Error('already gone') }
    const healthy = libraryRequest(executor)
    expect(guard?.abortAll(new Error('update download stalled'))).toBe(2)
    expect(healthy.request.aborted).toBe(true)
  })

  it('leaves alone what does not look like a request', () => {
    const plain = { id: 1 }
    const executor = { createRequest: () => plain }
    const guard = createUpdateRequestGuard(executor)
    expect(executor.createRequest()).toBe(plain)
    expect(guard?.abortAll(new Error('update download stalled'))).toBe(0)
  })
})
