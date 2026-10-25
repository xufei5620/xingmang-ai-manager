// 飞书长连接的帧格式（pbbp2.Frame，protobuf）。照飞书官方 Node SDK（@larksuiteoapi/node-sdk
// 1.76.0 的 pbbp2.Frame）手写编解码，不为这几个字段引一整个 protobuf 运行时进主进程。
//
// message Header { string key = 1; string value = 2; }
// message Frame {
//   uint64 SeqID = 1; uint64 LogID = 2; int32 service = 3; int32 method = 4;
//   repeated Header headers = 5; string payload_encoding = 6; string payload_type = 7;
//   bytes payload = 8; string LogIDNew = 9;
// }
//
// The socket is fed by Feishu's servers, but anything that can sit on the path
// (a corporate TLS proxy, a broken middlebox) can also feed it, so decoding is
// bounded: unknown fields are skipped, lengths are checked against what is left,
// and the header count and frame size are capped.

export interface FeishuFrameHeader {
  key: string
  value: string
}

export interface FeishuFrame {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: FeishuFrameHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

/** 控制帧（ping / pong）和数据帧（事件）。 */
export const feishuFrameMethod = { control: 0, data: 1 } as const

export const maxFeishuFrameBytes = 1024 * 1024
const maxFeishuFrameHeaders = 64

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function pushVarint(output: number[], input: bigint): void {
  let value = BigInt.asUintN(64, input)
  while (value >= 0x80n) {
    output.push(Number(value & 0x7fn) | 0x80)
    value >>= 7n
  }
  output.push(Number(value))
}

function pushTag(output: number[], field: number, wireType: number): void {
  pushVarint(output, BigInt((field << 3) | wireType))
}

function pushBytes(output: number[], field: number, bytes: Uint8Array): void {
  pushTag(output, field, 2)
  pushVarint(output, BigInt(bytes.length))
  for (const byte of bytes) output.push(byte)
}

function pushString(output: number[], field: number, value: string): void {
  pushBytes(output, field, textEncoder.encode(value))
}

export function encodeFeishuFrame(frame: FeishuFrame): Uint8Array {
  const output: number[] = []
  pushTag(output, 1, 0)
  pushVarint(output, frame.seqId)
  pushTag(output, 2, 0)
  pushVarint(output, frame.logId)
  pushTag(output, 3, 0)
  // int32 negatives are sign-extended to 64 bits on the wire.
  pushVarint(output, BigInt(frame.service))
  pushTag(output, 4, 0)
  pushVarint(output, BigInt(frame.method))
  for (const header of frame.headers) {
    const nested: number[] = []
    pushString(nested, 1, header.key)
    pushString(nested, 2, header.value)
    pushBytes(output, 5, Uint8Array.from(nested))
  }
  if (frame.payloadEncoding !== undefined) pushString(output, 6, frame.payloadEncoding)
  if (frame.payloadType !== undefined) pushString(output, 7, frame.payloadType)
  if (frame.payload !== undefined) pushBytes(output, 8, frame.payload)
  if (frame.logIdNew !== undefined) pushString(output, 9, frame.logIdNew)
  return Uint8Array.from(output)
}

class FrameReader {
  offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error('飞书消息帧不完整')
      const byte = this.bytes[this.offset]
      this.offset += 1
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result)
      shift += 7n
    }
    throw new Error('飞书消息帧里的数字过长')
  }

  lengthDelimited(): Uint8Array {
    const length = this.varint()
    if (length > BigInt(this.bytes.length - this.offset)) throw new Error('飞书消息帧长度不对')
    const start = this.offset
    this.offset += Number(length)
    return this.bytes.subarray(start, this.offset)
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint()
        return
      case 1:
        this.advance(8)
        return
      case 2:
        this.lengthDelimited()
        return
      case 5:
        this.advance(4)
        return
      default:
        throw new Error('飞书消息帧里有认不出的字段')
    }
  }

  private advance(count: number): void {
    if (this.offset + count > this.bytes.length) throw new Error('飞书消息帧不完整')
    this.offset += count
  }
}

function toInt32(value: bigint): number {
  return Number(BigInt.asIntN(32, value))
}

function decodeHeader(bytes: Uint8Array): FeishuFrameHeader {
  const reader = new FrameReader(bytes)
  let key = ''
  let value = ''
  while (!reader.done) {
    const tag = reader.varint()
    const field = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    if (field === 1 && wireType === 2) key = textDecoder.decode(reader.lengthDelimited())
    else if (field === 2 && wireType === 2) value = textDecoder.decode(reader.lengthDelimited())
    else reader.skip(wireType)
  }
  return { key, value }
}

export function decodeFeishuFrame(bytes: Uint8Array): FeishuFrame {
  if (bytes.length > maxFeishuFrameBytes) throw new Error('飞书消息帧过大')
  const reader = new FrameReader(bytes)
  const frame: FeishuFrame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }
  while (!reader.done) {
    const tag = reader.varint()
    const field = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    if (field === 1 && wireType === 0) frame.seqId = reader.varint()
    else if (field === 2 && wireType === 0) frame.logId = reader.varint()
    else if (field === 3 && wireType === 0) frame.service = toInt32(reader.varint())
    else if (field === 4 && wireType === 0) frame.method = toInt32(reader.varint())
    else if (field === 5 && wireType === 2) {
      if (frame.headers.length >= maxFeishuFrameHeaders) throw new Error('飞书消息帧的头太多')
      frame.headers.push(decodeHeader(reader.lengthDelimited()))
    } else if (field === 6 && wireType === 2) frame.payloadEncoding = textDecoder.decode(reader.lengthDelimited())
    else if (field === 7 && wireType === 2) frame.payloadType = textDecoder.decode(reader.lengthDelimited())
    else if (field === 8 && wireType === 2) frame.payload = Uint8Array.from(reader.lengthDelimited())
    else if (field === 9 && wireType === 2) frame.logIdNew = textDecoder.decode(reader.lengthDelimited())
    else reader.skip(wireType)
  }
  return frame
}

export function feishuFrameHeader(frame: FeishuFrame, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value
}
