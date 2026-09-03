#!/usr/bin/env node
// Xingmang image generation helper. Never prints API keys.

import { Buffer } from 'node:buffer'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'https://xm.solov.cc'
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_QUALITY = 'low'
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function skillRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

async function readSkillConfig(skillRoot) {
  const filePath = path.join(skillRoot, 'config.json')
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    fail('还没有本机配置。请先打开星芒AI管理工具并登录，工具会自动检测「图片模型-中转/订阅」分组并写入 config.json。')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('config.json 损坏。请重新登录星芒AI管理工具，让它重写配置。')
  }
  if (!parsed || typeof parsed !== 'object') fail('config.json 格式错误')
  const baseUrl = typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
    ? parsed.baseUrl.trim()
    : DEFAULT_BASE_URL
  const keys = []
  const codexApiKey = typeof parsed.codexApiKey === 'string' ? parsed.codexApiKey.trim() : ''
  const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : ''
  if (codexApiKey.startsWith('sk-')) keys.push({ source: 'codex', apiKey: codexApiKey })
  if (apiKey.startsWith('sk-') && apiKey !== codexApiKey) keys.push({ source: 'image', apiKey })
  else if (apiKey.startsWith('sk-') && keys.length === 0) keys.push({ source: 'image', apiKey })
  if (keys.length === 0) {
    fail('config.json 里还没有 API Key。请先登录星芒AI管理工具，工具会写入 Codex Key，并在可用时补上生图分组 Key。')
  }
  return { keys, baseUrl }
}

function parseArgs(argv) {
  const options = {
    prompt: '',
    out: '',
    model: DEFAULT_MODEL,
    size: '1024x1024',
    quality: DEFAULT_QUALITY,
    edit: false,
    image: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]
    if (token === '--prompt' && next) {
      options.prompt = next
      index += 1
    } else if (token === '--out' && next) {
      options.out = next
      index += 1
    } else if (token === '--model' && next) {
      options.model = next
      index += 1
    } else if (token === '--size' && next) {
      options.size = next
      index += 1
    } else if (token === '--quality' && next) {
      options.quality = next
      index += 1
    } else if (token === '--image' && next) {
      options.image = next
      index += 1
    } else if (token === '--edit') {
      options.edit = true
    } else if (token === '--help' || token === '-h') {
      printUsage()
      process.exit(0)
    } else {
      fail(`未知参数：${token}`)
    }
  }

  return options
}

function printUsage() {
  process.stdout.write([
    '用法：node generate.mjs --prompt "描述" --out ./out.png [选项]',
    '',
    '选项：',
    '  --model     默认 gpt-image-2',
    '  --size      默认 1024x1024；gpt-image-2 宽高须为 16 的倍数',
    '  --quality   low|medium|high，仅 gpt-image，默认 low',
    '  --edit      图生图，需同时给 --image',
    '  --image     参考图路径',
    '',
    'Key 从本技能目录的 config.json 读取，由星芒AI管理工具登录后写入。',
    '先用软件签发的 Codex Key，失败再改用生图分组 Key。',
    '不要把 Key 打进日志。',
    '',
  ].join('\n'))
}

function assertHttpsOrigin(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    fail('Base URL 无效')
  }
  if (parsed.protocol !== 'https:') fail('Base URL 必须是 https')
  if (parsed.username || parsed.password) fail('Base URL 不能内嵌凭据')
  return parsed.origin
}

function parseSize(size) {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(String(size || '').trim())
  if (!match) fail(`尺寸无效：${size}`)
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || !Number.isInteger(height)) fail(`尺寸无效：${size}`)
  return { width, height, text: `${width}x${height}` }
}

function isGptImage2(model) {
  return /^gpt-image-2(?:-|$)/i.test(model)
}

function isGptImage(model) {
  return /^gpt-image-/i.test(model)
}

function isJimeng(model) {
  return /jimeng/i.test(model)
}

function isGeminiImage(model) {
  return /^gemini-3\.1-flash-image$/i.test(model)
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

function extensionForBytes(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return '.png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg'
  }
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return '.webp'
  }
  return '.png'
}

function aspectRatioForSize(width, height) {
  const pairs = [
    [1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [3, 2], [2, 3], [5, 4], [4, 5], [21, 9],
  ]
  const target = width / height
  let best = '1:1'
  let bestDelta = Number.POSITIVE_INFINITY
  for (const [a, b] of pairs) {
    const delta = Math.abs(a / b - target)
    if (delta < bestDelta) {
      best = `${a}:${b}`
      bestDelta = delta
    }
  }
  return best
}

function imageSizeLabel(width, height) {
  const longEdge = Math.max(width, height)
  if (longEdge >= 3000) return '4K'
  if (longEdge >= 1800) return '2K'
  return '1K'
}

function redactUpstream(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 300)
}

async function readResponseLimited(response) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_RESPONSE_BYTES) fail('上游响应过大')
    return buffer
  }
  const chunks = []
  let total = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) fail('上游响应过大')
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

class GenerateError extends Error {
  constructor(message, retryable = false) {
    super(message)
    this.retryable = retryable
  }
}

function abortableFailure(error, timeoutMessage, fallbackMessage) {
  if (error && error.name === 'AbortError') throw new GenerateError(timeoutMessage)
  throw new GenerateError(error instanceof Error ? error.message : fallbackMessage)
}

async function postJson(origin, pathname, apiKey, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${origin}${pathname}`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    abortableFailure(error, '请求超时（300 秒）', '请求失败')
  } finally {
    clearTimeout(timer)
  }
  if (response.status >= 300 && response.status < 400) throw new GenerateError('上游返回了重定向，已拒绝')
  const bytes = await readResponseLimited(response)
  return { status: response.status, bytes, contentType: response.headers.get('content-type') || '' }
}

async function postMultipart(origin, pathname, apiKey, fields, filePath) {
  const imageBytes = await readFile(filePath)
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value)
  }
  form.append('image', new Blob([imageBytes], { type: guessMime(filePath) }), path.basename(filePath))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${origin}${pathname}`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    })
  } catch (error) {
    abortableFailure(error, '请求超时（300 秒）', '请求失败')
  } finally {
    clearTimeout(timer)
  }
  if (response.status >= 300 && response.status < 400) throw new GenerateError('上游返回了重定向，已拒绝')
  const bytes = await readResponseLimited(response)
  return { status: response.status, bytes }
}

function parseJsonObject(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object') throw new GenerateError('上游返回了无法解析的 JSON')
    return parsed
  } catch (error) {
    if (error instanceof GenerateError) throw error
    throw new GenerateError('上游返回了无法解析的 JSON')
  }
}

function extractImagePayload(payload) {
  const first = Array.isArray(payload.data) ? payload.data[0] : null
  if (first && typeof first.b64_json === 'string' && first.b64_json) {
    return { kind: 'b64', value: first.b64_json }
  }
  if (first && typeof first.url === 'string' && first.url) {
    return { kind: 'url', value: first.url }
  }

  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    const match = content.match(/data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)/i)
    if (match) return { kind: 'b64', value: match[2] }
  }

  const message = typeof payload.error === 'string'
    ? payload.error
    : payload.error?.message || payload.message || '上游没有返回图片'
  throw new GenerateError(redactUpstream(message))
}

async function downloadImage(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new GenerateError('上游返回了无效图片地址')
  }
  if (parsed.protocol !== 'https:') throw new GenerateError('图片地址必须是 https')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let response
  try {
    response = await fetch(parsed.href, { method: 'GET', redirect: 'follow', signal: controller.signal })
  } catch (error) {
    abortableFailure(error, '下载图片超时', '下载图片失败')
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new GenerateError(`下载图片失败：HTTP ${response.status}`)
  return readResponseLimited(response)
}

function buildGenerationBody(options, size) {
  if (isGeminiImage(options.model)) {
    return {
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      stream: false,
      extra_body: {
        google: {
          image_config: {
            aspect_ratio: aspectRatioForSize(size.width, size.height),
            image_size: imageSizeLabel(size.width, size.height),
          },
        },
      },
    }
  }
  if (isJimeng(options.model)) {
    return {
      model: options.model,
      prompt: options.prompt,
      n: 1,
      extra_fields: { width: size.width, height: size.height },
    }
  }
  const body = {
    model: options.model,
    prompt: options.prompt,
    n: 1,
    size: size.text,
  }
  if (isGptImage(options.model)) body.quality = options.quality
  return body
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.prompt.trim()) fail('缺少 --prompt')
  if (!options.out.trim()) fail('缺少 --out')
  const config = await readSkillConfig(skillRootFromScript())
  const baseUrl = config.baseUrl
  if (options.edit && !options.image) fail('图生图需要 --image')
  if (options.edit && isGeminiImage(options.model)) fail('gemini-3.1-flash-image 不支持图生图')

  const origin = assertHttpsOrigin(baseUrl)
  const size = parseSize(options.size)
  if (isGptImage2(options.model) && (size.width % 16 !== 0 || size.height % 16 !== 0)) {
    fail('gpt-image-2 的宽高必须是 16 的倍数')
  }

  async function generateWithKey(apiKey) {
    let result
    if (options.edit) {
      const fields = {
        model: options.model,
        prompt: options.prompt,
      }
      if (!isJimeng(options.model)) fields.size = size.text
      if (isGptImage(options.model)) fields.quality = options.quality
      result = await postMultipart(origin, '/v1/images/edits', apiKey, fields, options.image)
    } else {
      const pathname = isGeminiImage(options.model) ? '/v1/chat/completions' : '/v1/images/generations'
      result = await postJson(origin, pathname, apiKey, buildGenerationBody(options, size))
    }

    if (result.status < 200 || result.status >= 300) {
      const payload = (() => {
        try {
          return JSON.parse(result.bytes.toString('utf8'))
        } catch {
          return null
        }
      })()
      const message = payload?.error?.message || payload?.message || `HTTP ${result.status}`
      throw new GenerateError(
        redactUpstream(message),
        [401, 403, 429, 503].includes(result.status),
      )
    }

    const payload = extractImagePayload(parseJsonObject(result.bytes))
    return payload.kind === 'b64'
      ? Buffer.from(payload.value, 'base64')
      : await downloadImage(payload.value)
  }

  let bytes
  let lastError
  for (let index = 0; index < config.keys.length; index += 1) {
    const entry = config.keys[index]
    try {
      bytes = await generateWithKey(entry.apiKey)
      break
    } catch (error) {
      lastError = error instanceof Error ? error : new GenerateError('生成失败')
      const retryable = error instanceof GenerateError && error.retryable
      const hasFallback = index < config.keys.length - 1
      if (!retryable || !hasFallback) fail(lastError.message)
      process.stderr.write('Codex Key 未能出图，已改用生图分组 Key。\n')
    }
  }

  const outputPath = path.resolve(options.out)
  const finalPath = path.extname(outputPath)
    ? outputPath
    : `${outputPath}${extensionForBytes(bytes)}`
  await writeFile(finalPath, bytes)
  process.stdout.write(`${finalPath}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : '生成失败')
  })
}
