#!/usr/bin/env node
// Xingmang image MCP server. The client (Codex, Claude Code, Gemini CLI, Grok)
// starts it outside its command sandbox, so everything that crosses that line is
// narrowed here: the only network peer is the account's own image endpoint, the
// only files read are the skill config and images the user asked to edit, and
// the API key never leaves this process except in that one Authorization header.

import { open, lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LINE_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_INPUT_IMAGES = 4
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 300_000
const DEFAULT_MODEL = 'gpt-image-2'
const ALLOWED_MODELS = new Set([
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
])
// This standalone script cannot import the desktop registry. Trust exact TLS
// origins instead of permitting other services on the same host to receive the
// account's keys. The desktop app rewrites this skill's base URL to the active
// line on every sync, so a retired test entry never needs to stay trusted here.
const ALLOWED_RELAY_ORIGINS = new Set([
  'https://xm.solov.cc',
  'https://api.solov.cc',
  'https://xm-direct.solov.cc',
])
// 这几种状态换一把 Key 可能就过了（没这个分组、额度、限流、上游忙），与生图技能一致。
const RETRYABLE_STATUSES = new Set([401, 403, 429, 503])

class ImageError extends Error {
  constructor(message, retryable = false) {
    super(message)
    this.retryable = retryable
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function errorMessage(id, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } })
}

function resultMessage(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function redactUpstream(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 300)
}

function configPath() {
  const value = process.env.XINGMANG_IMAGE_CONFIG_PATH?.trim()
  if (!value) throw new ImageError('星芒画图工具还没有完成账号同步，请打开星芒AI管理工具重新登录')
  return value
}

async function readConfig() {
  const configFile = configPath()
  let parsed
  try {
    const info = await lstat(configFile)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe config')
    parsed = JSON.parse(await readFile(configFile, 'utf8'))
  } catch {
    throw new ImageError('星芒画图工具读不到账号配置，请打开星芒AI管理工具重新登录')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ImageError('星芒画图工具的账号配置已损坏，请打开星芒AI管理工具重新登录')
  }
  const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : ''
  let origin
  try {
    const url = new URL(baseUrl)
    const localTest = process.env.XINGMANG_IMAGE_MCP_ALLOW_INSECURE_LOCAL === '1'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && (url.protocol === 'http:' || url.protocol === 'https:')
    if ((!ALLOWED_RELAY_ORIGINS.has(url.origin) && !localTest)
      || url.username || url.password || url.search || url.hash) throw new Error('unsafe')
    origin = url.origin
  } catch {
    throw new ImageError('星芒画图工具的服务地址无效，请打开星芒AI管理工具重新登录')
  }
  // 与生图技能同一个顺序：先用 Codex Key，被拒再换生图分组 Key。
  const keys = []
  for (const field of ['codexApiKey', 'apiKey']) {
    const value = typeof parsed[field] === 'string' ? parsed[field].trim() : ''
    if (value.startsWith('sk-') && !keys.includes(value)) keys.push(value)
  }
  if (keys.length === 0) throw new ImageError('当前账号还没有可以画图的 Key，请打开星芒AI管理工具登录')
  return { origin, keys }
}

function schema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '要画什么；改图时写要怎么改' },
      images: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_INPUT_IMAGES,
        description: '改图时填要修改的原图（PNG、JPEG 或 WebP）的完整路径；画新图时不填',
      },
      model: { type: 'string', enum: [...ALLOWED_MODELS], default: DEFAULT_MODEL },
      size: { type: 'string', description: '例如 1024x1024、1536x1024、1024x1536 或 auto；gpt-image-2 的宽高要是 16 的倍数' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], default: 'low' },
      background: { type: 'string', enum: ['opaque', 'transparent', 'auto'], default: 'opaque' },
    },
    required: ['prompt'],
  }
}

function toolList() {
  return [{
    name: 'generate_image',
    description: '用当前星芒账号画图或改图。用户要画一张图、生成图片，或者修改、编辑一张已有图片时调用；改图时把原图的完整路径放进 images。结果直接显示在对话里。不要自己写脚本或命令去调图片接口。',
    inputSchema: schema(),
  }]
}

function textValue(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new ImageError('图片参数格式错误')
  return value.trim()
}

function parseArguments(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new ImageError('图片参数格式错误')
  }
  const prompt = textValue(argumentsValue.prompt, '', 32_000)
  if (!prompt) throw new ImageError('图片描述不能为空')
  const model = textValue(argumentsValue.model, DEFAULT_MODEL, 80)
  if (!ALLOWED_MODELS.has(model)) throw new ImageError('图片模型不在允许列表中')
  const size = textValue(argumentsValue.size, '1024x1024', 32)
  const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(size)
  if (size !== 'auto' && !dimensions) throw new ImageError('图片尺寸格式错误')
  if (dimensions && model.startsWith('gpt-image-2')
    && (Number(dimensions[1]) % 16 !== 0 || Number(dimensions[2]) % 16 !== 0)) {
    throw new ImageError('gpt-image-2 的宽高必须是 16 的倍数')
  }
  const quality = textValue(argumentsValue.quality, 'low', 16)
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new ImageError('图片质量参数错误')
  const background = textValue(argumentsValue.background, 'opaque', 16)
  if (!['opaque', 'transparent', 'auto'].includes(background)) throw new ImageError('图片背景参数错误')
  const imagesValue = argumentsValue.images
  if (imagesValue !== undefined
    && (!Array.isArray(imagesValue) || imagesValue.length > MAX_INPUT_IMAGES
      || imagesValue.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 4096 || entry.includes('\0')))) {
    throw new ImageError(`原图最多 ${MAX_INPUT_IMAGES} 张，每张都要写完整路径`)
  }
  const images = (imagesValue ?? []).map((entry) => entry.trim())
  return { prompt, model, size, quality, background, images }
}

function imageMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/**
 * Only a real image the user pointed at goes out. The content check (not the
 * extension) keeps a prompt-injected "edit ~/.ssh/id_rsa" from uploading an
 * arbitrary file; lstat + fstat on the same descriptor rejects links and swaps.
 */
async function readInputImage(filePath) {
  if (!path.isAbsolute(filePath)) throw new ImageError('原图要写完整路径')
  const failure = `读不到这张原图，或它不是 PNG、JPEG、WebP 图片：${path.basename(filePath)}`
  let handle
  try {
    const linkInfo = await lstat(filePath)
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error('not a file')
    handle = await open(filePath, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.ino !== linkInfo.ino || info.dev !== linkInfo.dev) throw new Error('changed')
    if (info.size > MAX_INPUT_IMAGE_BYTES) throw new ImageError(`原图太大（超过 20MB）：${path.basename(filePath)}`)
    const bytes = await handle.readFile()
    if (bytes.length > MAX_INPUT_IMAGE_BYTES) throw new ImageError(`原图太大（超过 20MB）：${path.basename(filePath)}`)
    const mimeType = imageMimeType(bytes)
    if (!mimeType) throw new Error('not an image')
    return { bytes, mimeType, name: path.basename(filePath) }
  } catch (error) {
    if (error instanceof ImageError) throw error
    throw new ImageError(failure)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readLimited(response) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new ImageError('图片服务响应过大')
    return Buffer.from(bytes)
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new ImageError('图片服务响应过大')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function requestBody(input, images) {
  if (images.length === 0) {
    return {
      headers: { 'Content-Type': 'application/json' },
      pathname: '/v1/images/generations',
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        background: input.background,
        n: 1,
        output_format: 'png',
      }),
    }
  }
  const form = new FormData()
  form.append('model', input.model)
  form.append('prompt', input.prompt)
  form.append('size', input.size)
  form.append('quality', input.quality)
  form.append('background', input.background)
  form.append('n', '1')
  form.append('output_format', 'png')
  const field = images.length === 1 ? 'image' : 'image[]'
  for (const image of images) form.append(field, new Blob([image.bytes], { type: image.mimeType }), image.name)
  return { headers: {}, pathname: '/v1/images/edits', body: form }
}

async function requestImage(origin, apiKey, input, images) {
  const request = requestBody(input, images)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  let bytes
  try {
    response = await fetch(`${origin}${request.pathname}`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { ...request.headers, Authorization: `Bearer ${apiKey}` },
      body: request.body,
    })
    if (response.status >= 300 && response.status < 400) throw new ImageError('图片服务返回了重定向，已拒绝')
    bytes = await readLimited(response)
  } catch (error) {
    if (error instanceof ImageError) throw error
    if (error?.name === 'AbortError') throw new ImageError('画图超时（300 秒），可以把画质调低再试')
    throw new ImageError('连不上图片服务，请检查网络后再试', true)
  } finally {
    clearTimeout(timer)
  }
  let payload
  try { payload = JSON.parse(bytes.toString('utf8')) } catch { payload = null }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message
    throw new ImageError(
      typeof message === 'string' && message ? redactUpstream(message) : `图片服务返回 HTTP ${response.status}`,
      RETRYABLE_STATUSES.has(response.status),
    )
  }
  const encoded = payload?.data?.[0]?.b64_json
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_RESPONSE_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ImageError('图片服务没有返回有效图片')
  }
  return encoded
}

async function generateImage(argumentsValue) {
  const input = parseArguments(argumentsValue)
  const config = await readConfig()
  const images = []
  for (const filePath of input.images) images.push(await readInputImage(filePath))
  let lastError = null
  for (let index = 0; index < config.keys.length; index += 1) {
    try {
      const encoded = await requestImage(config.origin, config.keys[index], input, images)
      return {
        content: [
          { type: 'image', data: encoded, mimeType: 'image/png' },
          { type: 'text', text: images.length ? `已用 ${input.model} 改好图片` : `已用 ${input.model} 画好图片` },
        ],
      }
    } catch (error) {
      lastError = error
      if (!(error instanceof ImageError) || !error.retryable) break
    }
  }
  throw lastError ?? new ImageError('画图失败')
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return
  if (message.method.startsWith('notifications/')) return
  if (message.method === 'ping') return resultMessage(message.id, {})
  if (message.method === 'initialize') {
    return resultMessage(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'xingmang-image', version: '1.1.0' },
    })
  }
  if (message.method === 'tools/list') return resultMessage(message.id, { tools: toolList() })
  if (message.method !== 'tools/call') return errorMessage(message.id, '不支持的图片 MCP 方法')
  if (message.params?.name !== 'generate_image') return errorMessage(message.id, '不支持的图片工具')
  try {
    return resultMessage(message.id, await generateImage(message.params.arguments))
  } catch (error) {
    return resultMessage(message.id, {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : '画图失败' }],
    })
  }
}

let pending = ''
let discarding = false
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8')
  while (true) {
    const newline = pending.indexOf('\n')
    if (newline < 0) break
    const line = pending.slice(0, newline).trim()
    pending = pending.slice(newline + 1)
    // The tail of an oversized line: drop it and resume at the next message.
    if (discarding) {
      discarding = false
      continue
    }
    if (!line) continue
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      errorMessage(null, '图片 MCP 请求过大')
      continue
    }
    try {
      const message = JSON.parse(line)
      void handle(message).catch(() => errorMessage(message.id ?? null, '图片 MCP 请求失败'))
    } catch {
      errorMessage(null, '图片 MCP 请求格式错误')
    }
  }
  // An unterminated line past the limit is never going to be accepted, so stop
  // buffering it instead of growing without bound.
  if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) {
    pending = ''
    discarding = true
    errorMessage(null, '图片 MCP 请求过大')
  }
})
process.stdin.on('end', () => process.exit(0))
