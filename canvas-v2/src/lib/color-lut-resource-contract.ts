import { canonicalColorLutByteLength, canonicalColorLutSize, colorLutValueLimit, decodeColorLutTable, encodeColorLutTable, maximumColorLutNameLength, type ColorLutDomain, type ColorLutTable, type ColorLutWorkOptions } from '../image-tools/layer-color-lut'

export const colorLutResourceFormat = 'xingmang-color-lut'
export const colorLutResourceMimeType = 'application/vnd.xingmang.color-lut+json'
export const maximumColorLutResourceBytes = 640 * 1024
const base64Length = 4 * Math.ceil(canonicalColorLutByteLength / 3)

export interface ColorLutResourceDescriptor {
  version: 1
  assetId: string
  digest: string
  size: 33
  name: string
  domainMin: ColorLutDomain
  domainMax: ColorLutDomain
  byteSize: number
  mimeType: typeof colorLutResourceMimeType
}
export type ColorLutResourceContentDescriptor = Omit<ColorLutResourceDescriptor, 'assetId'>
export class ColorLutResourceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'COLOR_LUT_RESOURCE_INVALID') { super(message) }
}

export function checkColorLutResourceWork(options: ColorLutWorkOptions = {}): void {
  options.signal?.throwIfAborted()
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || Date.now() >= options.deadline)) throw new ColorLutResourceError('LUT 处理超时，请保留当前调整并重新核对', 408, 'COLOR_LUT_RESOURCE_TIMEOUT')
}
function invalid(): never { throw new ColorLutResourceError('LUT 资源格式、版本或内容不完整，请重新导入原文件') }
function bytesInput(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || !value.length || value.length > maximumColorLutResourceBytes) throw new ColorLutResourceError('LUT 资源必须非空且不能超过 640 KiB', 413)
}
function base64(bytes: Uint8Array, options: ColorLutWorkOptions): string {
  let result = ''
  for (let start = 0; start < bytes.length; start += 24 * 1024) {
    checkColorLutResourceWork(options)
    let text = ''
    for (const byte of bytes.subarray(start, start + 24 * 1024)) text += String.fromCharCode(byte)
    result += btoa(text)
  }
  return result
}
function envelope(table: ColorLutTable, data: string): string {
  return JSON.stringify({ format: colorLutResourceFormat, version: 1, size: canonicalColorLutSize, name: table.name, domainMin: table.domainMin, domainMax: table.domainMax, data })
}

/** Canonical order and shared F32LE codec make name/domain part of content identity. */
export function serializeColorLutResource(table: ColorLutTable, options: ColorLutWorkOptions = {}): Uint8Array {
  checkColorLutResourceWork(options)
  const samples = encodeColorLutTable(table, options)
  const canonical = decodeColorLutTable(samples, { name: table.name, domainMin: table.domainMin, domainMax: table.domainMax }, options)
  const bytes = new TextEncoder().encode(envelope(canonical, base64(samples, options)))
  bytesInput(bytes); checkColorLutResourceWork(options)
  return bytes
}

export function parseColorLutResource(bytes: Uint8Array, options: ColorLutWorkOptions = {}): ColorLutTable {
  checkColorLutResourceWork(options); bytesInput(bytes)
  let value: unknown, text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text) } catch { invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const raw = value as Record<string, unknown>, keys = ['format', 'version', 'size', 'name', 'domainMin', 'domainMax', 'data']
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key)) || raw.format !== colorLutResourceFormat || raw.version !== 1 || raw.size !== canonicalColorLutSize || typeof raw.data !== 'string' || raw.data.length !== base64Length || !/^[A-Za-z0-9+/]+$/.test(raw.data)) invalid()
  let decoded: string
  try { decoded = atob(raw.data) } catch { invalid() }
  if (decoded.length !== canonicalColorLutByteLength) invalid()
  const samples = new Uint8Array(decoded.length)
  for (let index = 0; index < samples.length; index++) { if (index % 24_576 === 0) checkColorLutResourceWork(options); samples[index] = decoded.charCodeAt(index) }
  let table: ColorLutTable
  try { table = decodeColorLutTable(samples, { name: raw.name as string, domainMin: raw.domainMin as ColorLutDomain, domainMax: raw.domainMax as ColorLutDomain }, options) }
  catch (error) { checkColorLutResourceWork(options); if (options.signal?.aborted) throw error; invalid() }
  if (envelope(table, base64(samples, options)) !== text) throw new ColorLutResourceError('LUT 资源不是规范编码，未按不同内容静默归一化，请重新导入')
  checkColorLutResourceWork(options)
  return table
}

export async function colorLutResourceDigest(bytes: Uint8Array, options: ColorLutWorkOptions = {}): Promise<string> {
  checkColorLutResourceWork(options); bytesInput(bytes)
  const buffer = new Uint8Array(bytes).buffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  checkColorLutResourceWork(options)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function describeColorLutResource(bytes: Uint8Array, options: ColorLutWorkOptions = {}): Promise<ColorLutResourceContentDescriptor> {
  const table = parseColorLutResource(bytes, options), digest = await colorLutResourceDigest(bytes, options)
  return { version: 1, digest, size: canonicalColorLutSize, name: table.name, domainMin: [...table.domainMin], domainMax: [...table.domainMax], byteSize: bytes.length, mimeType: colorLutResourceMimeType }
}

export function parseColorLutResourceDescriptor(value: unknown): ColorLutResourceDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const raw = value as Record<string, unknown>, keys = ['version', 'assetId', 'digest', 'size', 'name', 'domainMin', 'domainMax', 'byteSize', 'mimeType']
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key)) || raw.version !== 1 || raw.size !== canonicalColorLutSize || raw.mimeType !== colorLutResourceMimeType
    || typeof raw.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.assetId) || typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.digest)
    || typeof raw.name !== 'string' || !raw.name || raw.name !== raw.name.trim() || raw.name.length > maximumColorLutNameLength || /[\u0000-\u001f\u007f]/.test(raw.name) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(raw.name)
    || typeof raw.byteSize !== 'number' || !Number.isSafeInteger(raw.byteSize) || raw.byteSize <= base64Length || raw.byteSize > maximumColorLutResourceBytes) invalid()
  function domain(value: unknown): ColorLutDomain {
    if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || Math.abs(entry) > colorLutValueLimit)) invalid()
    return [value[0], value[1], value[2]]
  }
  const domainMin = domain(raw.domainMin), domainMax = domain(raw.domainMax)
  if (domainMin.some((minimum, index) => minimum >= domainMax[index])) invalid()
  return { version: 1, assetId: raw.assetId, digest: raw.digest, size: canonicalColorLutSize, name: raw.name, domainMin, domainMax, byteSize: raw.byteSize, mimeType: colorLutResourceMimeType }
}
