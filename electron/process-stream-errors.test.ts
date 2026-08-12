import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { guardProcessOutputStreams, guardProcessStream } from './process-stream-errors'

describe('process output stream guards', () => {
  it('absorbs broken-pipe errors from detached stdout and stderr', () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    guardProcessOutputStreams(stdout, stderr)

    expect(() => stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
    expect(() => stderr.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
  })

  it('does not swallow unrelated stream failures', () => {
    const stream = new PassThrough()
    guardProcessStream(stream)
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' })

    expect(() => stream.emit('error', error)).toThrow(error)
  })

  it('installs at most one handler per stream', () => {
    const stream = new PassThrough()
    guardProcessStream(stream)
    guardProcessStream(stream)

    expect(stream.listenerCount('error')).toBe(1)
  })
})
