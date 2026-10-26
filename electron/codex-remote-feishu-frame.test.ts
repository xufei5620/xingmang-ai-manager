import { describe, expect, it } from 'vitest'
import { decodeFeishuFrame, encodeFeishuFrame, feishuFrameHeader, maxFeishuFrameBytes } from './codex-remote-feishu-frame'

// Both fixtures were produced by the pbbp2.Frame codec inside @larksuiteoapi/node-sdk 1.76.0
// (protobufjs 7), so these tests pin the wire format to what Feishu's own client sends.
const sdkEventFrameHex = '08ffffffffffffff0f100718b96020012a0d0a047479706512056576656e742a110a0a6d6573736167655f696412036d2d312a080a0373756d1201312a080a03736571120130420e7b2261223a22e4b8ade69687227d4a056c6f672d78'
const sdkPingFrameHex = '08001000186320002a0c0a0474797065120470696e67'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

describe('codex-remote-feishu-frame', () => {
  it('decodes an event frame encoded by the official SDK', () => {
    const frame = decodeFeishuFrame(Buffer.from(sdkEventFrameHex, 'hex'))
    expect(frame.seqId).toBe(9007199254740991n)
    expect(frame.logId).toBe(7n)
    expect(frame.service).toBe(12345)
    expect(frame.method).toBe(1)
    expect(feishuFrameHeader(frame, 'type')).toBe('event')
    expect(feishuFrameHeader(frame, 'message_id')).toBe('m-1')
    expect(new TextDecoder().decode(frame.payload)).toBe('{"a":"中文"}')
    expect(frame.logIdNew).toBe('log-x')
  })

  it('encodes byte for byte what the official SDK encodes', () => {
    expect(hex(encodeFeishuFrame({
      seqId: 9007199254740991n,
      logId: 7n,
      service: 12345,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'm-1' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
      ],
      payload: new TextEncoder().encode('{"a":"中文"}'),
      logIdNew: 'log-x',
    }))).toBe(sdkEventFrameHex)
    expect(hex(encodeFeishuFrame({ seqId: 0n, logId: 0n, service: 99, method: 0, headers: [{ key: 'type', value: 'ping' }] })))
      .toBe(sdkPingFrameHex)
  })

  it('keeps 64-bit ids exact when echoing a frame back', () => {
    const original = { seqId: 18446744073709551615n, logId: 123456789012345678n, service: 1, method: 1, headers: [] }
    const decoded = decodeFeishuFrame(encodeFeishuFrame(original))
    expect(decoded.seqId).toBe(original.seqId)
    expect(decoded.logId).toBe(original.logId)
  })

  it('skips fields it does not know', () => {
    // field 15, varint 1; then the ping frame.
    const withUnknown = Buffer.concat([Buffer.from('7801', 'hex'), Buffer.from(sdkPingFrameHex, 'hex')])
    expect(decodeFeishuFrame(withUnknown).service).toBe(99)
  })

  it('rejects truncated, oversized and malformed frames', () => {
    const bytes = Buffer.from(sdkEventFrameHex, 'hex')
    expect(() => decodeFeishuFrame(bytes.subarray(0, bytes.length - 3))).toThrow()
    expect(() => decodeFeishuFrame(new Uint8Array(maxFeishuFrameBytes + 1))).toThrow('过大')
    expect(() => decodeFeishuFrame(Buffer.from('0b', 'hex'))).toThrow()
    expect(() => decodeFeishuFrame(Buffer.from('08ffffffffffffffffffff01', 'hex'))).toThrow()
  })

  it('caps the number of headers', () => {
    const headers = Array.from({ length: 65 }, (_, index) => ({ key: `k${index}`, value: 'v' }))
    const bytes = encodeFeishuFrame({ seqId: 0n, logId: 0n, service: 0, method: 1, headers })
    expect(() => decodeFeishuFrame(bytes)).toThrow('头太多')
  })
})
