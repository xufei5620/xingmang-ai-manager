import { describe, expect, it } from 'vitest'
import { parseSingleByteRange } from './byte-range'

describe('parseSingleByteRange', () => {
  it('supports bounded, open-ended and suffix media ranges', () => {
    expect(parseSingleByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseSingleByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseSingleByteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 })
    expect(parseSingleByteRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 })
  })

  it('rejects malformed, multipart and unsatisfiable ranges', () => {
    for (const value of ['bytes=-', 'bytes=-0', 'bytes=100-', 'bytes=20-10', 'bytes=0-1,3-4', 'items=0-1']) {
      expect(parseSingleByteRange(value, 100)).toBeNull()
    }
    expect(parseSingleByteRange('bytes=0-1', 0)).toBeNull()
  })
})
