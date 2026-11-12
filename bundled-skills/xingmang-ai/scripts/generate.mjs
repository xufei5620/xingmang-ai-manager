#!/usr/bin/env node
// Image generation helper for this skill. Never prints API keys.

import { Buffer } from 'node:buffer'
import { open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'https://xm.solov.cc'
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_QUALITY = 'high'
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_INPUT_IMAGES = 4
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024

// 认型号三处同一套（主程序 xingmang-ai-skill.ts、画图工具 mcp-server.mjs、这里），测试钉住。
// 默认只用 OpenAI 的 gpt-image 系列；Nano Banana 和 Grok 要点名才用，只走图片模型分组的 Key。
const OPENAI_IMAGE_MODEL_PATTERN = /^gpt-image-[a-z0-9][a-z0-9._-]{0,63}$/i
const RETIRED_OPENAI_IMAGE_MODEL_PATTERN = /^gpt-image-1(?:[.-]|$)/i
const GEMINI_IMAGE_MODEL_PATTERN = /^(?:nano-banana(?:-[a-z0-9][a-z0-9._-]{0,63})?|gemini-[a-z0-9][a-z0-9._-]{0,63}-image(?:-[a-z0-9][a-z0-9._-]{0,63})?)$/i
const GROK_IMAGE_MODEL_PATTERN = /^grok-imagine-image(?:-[a-z0-9][a-z0-9._-]{0,63})?$/i
const SUPPORTED_MODELS_HINT = [
  'OpenAI：gpt-image-2.6-flare、gpt-image-2.5-flare、gpt-image-2、gpt-image-2.6-sunburst、gpt-image-2.5-sunburst（gpt-image- 开头的新型号也行）',
  'Nano Banana：nano-banana-2（即 gemini-3.1-flash-image）、nano-banana-pro',
  'Grok：grok-imagine-image、grok-imagine-image-2.0、grok-imagine-image-quality',
  '不传 --model 就用登录时按当前账号挑好的那个。',
].join('\n')

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const SIZE_TIERS = { '1K': 1024, '2K': 2048, '4K': 3840 }
// gpt-image-2 系列：宽高都是 16 的倍数，总像素在这两个数之间（4K 16:9 = 3840x2160 正好顶格）。
const GPT_IMAGE_MIN_PIXELS = 655_360
const GPT_IMAGE_MAX_PIXELS = 8_294_400
const QUALITIES = ['low', 'medium', 'high', 'auto']
const BACKGROUNDS = ['opaque', 'transparent', 'auto']

class GenerateError extends Error {
  constructor(message, retryable = false, upstream = false) {
    super(message)
    this.retryable = retryable
    // 中转明确回了错误（不是连不上、超时）：自动挑的默认模型这样失败时，按顺序换下一个再试。
    this.upstream = upstream
  }
}

// 不在这里 process.exit：Windows 上 fetch 的连接还在关，直接退出会打出 libuv 的 Assertion 并以 127 退出。
function fail(message) {
  throw new GenerateError(message)
}

function skillRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function modelFamily(model) {
  if (OPENAI_IMAGE_MODEL_PATTERN.test(model)) return RETIRED_OPENAI_IMAGE_MODEL_PATTERN.test(model) ? null : 'openai'
  if (GEMINI_IMAGE_MODEL_PATTERN.test(model)) return 'gemini'
  if (GROK_IMAGE_MODEL_PATTERN.test(model)) return 'grok'
  return null
}

function unsupportedModelMessage(model) {
  const reason = RETIRED_OPENAI_IMAGE_MODEL_PATTERN.test(model)
    ? `${model} 已经下线，用不了。`
    : `不认识图片模型「${model}」。`
  return `${reason}能用的有：\n${SUPPORTED_MODELS_HINT}`
}

function configuredModel(value) {
  const model = typeof value === 'string' ? value.trim() : ''
  return modelFamily(model) === 'openai' ? model : ''
}

async function readSkillConfig(skillRoot) {
  const filePath = path.join(skillRoot, 'config.json')
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    fail('还没有本机配置。请先打开管理工具并登录当前账号，工具会自动检测「图片模型」分组并写入 config.json。')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('config.json 损坏。请在管理工具里重新登录当前账号，让它重写配置。')
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
  if (keys.length === 0) {
    fail('config.json 里还没有 API Key。请先在管理工具里登录当前账号，工具会写入 Codex Key，并在可用时补上生图分组 Key。')
  }
  // 主程序登录同步时按当前账号实际能用的 OpenAI 图片模型排好顺序：model 是第一个，fallbackModels 是后面的。
  const model = configuredModel(parsed.model)
  const fallbackModels = Array.isArray(parsed.fallbackModels)
    ? parsed.fallbackModels.map(configuredModel).filter(Boolean)
    : null
  return { keys, baseUrl, model, fallbackModels }
}

/**
 * 没点名时按这个顺序试。只退到账号列表里有的；老版本写的 config.json 没有 fallbackModels，照旧退到 gpt-image-2。
 */
export function defaultModelChain(config) {
  if (!config.model) return [DEFAULT_MODEL]
  return [...new Set([config.model, ...(config.fallbackModels ?? [DEFAULT_MODEL])])]
}

function parseArgs(argv) {
  const options = {
    prompt: '',
    out: '',
    // 没点名就留空，读到配置后用主程序挑好的那个。
    model: '',
    size: '',
    aspect: '',
    quality: DEFAULT_QUALITY,
    background: '',
    edit: false,
    images: [],
    help: false,
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
      options.model = next.trim()
      index += 1
    } else if (token === '--size' && next) {
      options.size = next.trim()
      index += 1
    } else if (token === '--aspect' && next) {
      options.aspect = next.trim()
      index += 1
    } else if (token === '--quality' && next) {
      options.quality = next.trim()
      index += 1
    } else if (token === '--background' && next) {
      options.background = next.trim()
      index += 1
    } else if (token === '--image' && next) {
      options.images.push(next)
      index += 1
    } else if (token === '--edit') {
      options.edit = true
    } else if (token === '--help' || token === '-h') {
      options.help = true
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
    '  --model       默认用登录时按当前账号挑好的 OpenAI 图片模型；也可以点名 Nano Banana、Grok（只走图片模型分组）',
    '  --size        1K|2K|4K，或 宽x高（gpt-image-2 系列宽高须为 16 的倍数），默认 1K',
    '  --aspect      16:9|9:16|1:1|4:3|3:4|3:2|2:3，配 1K/2K/4K 用，默认 1:1',
    `  --quality     low|medium|high|auto，仅 gpt-image，默认 ${DEFAULT_QUALITY}`,
    '  --background  opaque|transparent|auto，仅 gpt-image；要透明底传 transparent',
    '  --image       参考图路径，改图用；可以给多张（最多 4 张）',
    '  --edit        图生图，可省略：给了 --image 就是改图',
    '',
    'Key 从本技能目录的 config.json 读取，登录后自动写入。',
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

function greatestCommonDivisor(left, right) {
  return right === 0 ? left : greatestCommonDivisor(right, left % right)
}

/**
 * 1K/2K/4K 加比例换成 gpt-image-2 系列能接的宽高：比例严格不变、都是 16 的倍数，长边 1024 / 2048 / 3840，
 * 总像素超了上限就等比缩、低于下限就等比放（1K 16:9 = 1280x720，4K 1:1 = 2880x2880）。
 */
export function tierDimensions(tier, aspect) {
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
  const unitWidth = 16 * ratioWidth
  const unitHeight = 16 * ratioHeight
  let scale = Math.floor(SIZE_TIERS[tier] / Math.max(unitWidth, unitHeight))
  scale = Math.min(scale, Math.floor(Math.sqrt(GPT_IMAGE_MAX_PIXELS / (unitWidth * unitHeight))))
  while (unitWidth * unitHeight * scale * scale < GPT_IMAGE_MIN_PIXELS) scale += 1
  return { width: unitWidth * scale, height: unitHeight * scale }
}

/**
 * 把 --size / --aspect 按模型换成请求要的样子。OpenAI 要宽x高；Nano Banana 要 imageSize（1K/2K/4K）加比例；
 * Grok 不收尺寸（实测传 aspect_ratio 也照样出 1280x720），返回空的。
 */
export function resolveImageSize(family, sizeInput = '', aspectInput = '') {
  const size = String(sizeInput || '').trim().toUpperCase()
  const aspect = String(aspectInput || '').trim()
  if (aspect && !ASPECT_RATIOS.includes(aspect)) {
    fail(`比例无效：${aspect}。可选 ${ASPECT_RATIOS.join('、')}`)
  }
  const tier = size && SIZE_TIERS[size] ? size : ''
  const dimensions = size && !tier ? /^(\d{2,5})X(\d{2,5})$/.exec(size) : null
  if (size && !tier && !dimensions) fail(`尺寸无效：${sizeInput}。写 1K、2K、4K，或者 宽x高`)
  if (dimensions && aspect) fail('已经用 --size 写了宽高，就不要再给 --aspect')
  const width = dimensions ? Number(dimensions[1]) : 0
  const height = dimensions ? Number(dimensions[2]) : 0
  const ratio = dimensions ? ratioOf(width, height) : ''

  if (family === 'openai') {
    if (dimensions) return { text: `${width}x${height}`, width, height }
    const picked = tierDimensions(tier || '1K', aspect || '1:1')
    return { text: `${picked.width}x${picked.height}`, ...picked }
  }
  if (family === 'grok') return {}
  if (dimensions && !ASPECT_RATIOS.includes(ratio)) {
    fail(`这个模型按比例出图，${width}x${height} 不是能用的比例。改用 --size 1K|2K|4K 加 --aspect ${ASPECT_RATIOS.join('|')}`)
  }
  const longSide = Math.max(width, height)
  const imageSize = tier || (!dimensions ? '1K' : longSide <= 1536 ? '1K' : longSide <= 3072 ? '2K' : '4K')
  return { imageSize, aspectRatio: aspect || ratio || '1:1' }
}

function ratioOf(width, height) {
  const divisor = greatestCommonDivisor(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

function isGptImage2(model) {
  return /^gpt-image-2(?:[.-]|$)/i.test(model)
}

function imageMimeType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const EXTENSION_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/**
 * Nano Banana 和 Grok 回的是 JPEG：--out 写的是 .png 时换成 .jpg，免得扩展名和内容对不上。
 */
export function outputPathFor(out, bytes) {
  const outputPath = path.resolve(out)
  const actual = EXTENSION_BY_MIME[imageMimeType(bytes)] ?? '.png'
  const extension = path.extname(outputPath)
  if (!extension) return `${outputPath}${actual}`
  const lower = extension.toLowerCase()
  if (!IMAGE_EXTENSIONS.has(lower)) return outputPath
  const same = lower === actual || (actual === '.jpg' && lower === '.jpeg')
  return same ? outputPath : `${outputPath.slice(0, -extension.length)}${actual}`
}

async function readInputImage(filePath) {
  const name = path.basename(filePath)
  let handle
  try {
    handle = await open(filePath, 'r')
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a file')
    if (info.size > MAX_INPUT_IMAGE_BYTES) fail(`参考图太大（超过 20MB）：${name}`)
    const bytes = await handle.readFile()
    const mimeType = imageMimeType(bytes)
    if (!mimeType) throw new Error('not an image')
    return { bytes, mimeType, name }
  } catch (error) {
    if (error instanceof GenerateError) throw error
    throw new GenerateError(`读不到这张参考图，或它不是 PNG、JPEG、WebP 图片：${name}`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
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
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      fail('上游响应过大')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

// 超时管到读完响应体为止：只管到响应头的话，上游慢慢吐数据能拖过 300 秒。
async function send(url, init, timeoutMessage) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      throw new GenerateError('上游返回了重定向，已拒绝')
    }
    return { status: response.status, ok: response.ok, bytes: await readResponseLimited(response) }
  } catch (error) {
    if (error instanceof GenerateError) throw error
    if (error && error.name === 'AbortError') throw new GenerateError(timeoutMessage)
    throw new GenerateError(error instanceof Error ? error.message : '请求失败')
  } finally {
    clearTimeout(timer)
  }
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

function upstreamFailure(result) {
  let payload = null
  try {
    payload = JSON.parse(result.bytes.toString('utf8'))
  } catch {
    payload = null
  }
  const message = payload?.error?.message || payload?.message || `HTTP ${result.status}`
  return new GenerateError(redactUpstream(message), [401, 403, 429, 503].includes(result.status), true)
}

function extractImagePayload(payload) {
  const first = Array.isArray(payload.data) ? payload.data[0] : null
  if (first && typeof first.b64_json === 'string' && first.b64_json) {
    return { kind: 'b64', value: first.b64_json }
  }
  if (first && typeof first.url === 'string' && first.url) {
    return { kind: 'url', value: first.url }
  }

  const message = typeof payload.error === 'string'
    ? payload.error
    : payload.error?.message || payload.message || '上游没有返回图片'
  throw new GenerateError(redactUpstream(message))
}

// Gemini 原生接口把图放在 candidates[].content.parts[].inlineData 里；没图时把它说的那句话交回去。
function extractGeminiImage(payload) {
  const parts = payload.candidates?.[0]?.content?.parts
  for (const part of Array.isArray(parts) ? parts : []) {
    const inline = part?.inlineData ?? part?.inline_data
    if (typeof inline?.data === 'string' && inline.data) return inline.data
  }
  const said = (Array.isArray(parts) ? parts : []).map((part) => part?.text).filter((text) => typeof text === 'string').join(' ')
  const reason = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason
  throw new GenerateError(redactUpstream(`没有返回图片${said ? `：${said}` : reason ? `（${reason}）` : ''}`))
}

async function downloadImage(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new GenerateError('上游返回了无效图片地址')
  }
  if (parsed.protocol !== 'https:') throw new GenerateError('图片地址必须是 https')
  const result = await send(parsed.href, { method: 'GET', redirect: 'follow' }, '下载图片超时')
  if (!result.ok) throw new GenerateError(`下载图片失败：HTTP ${result.status}`)
  return result.bytes
}

function decodeImage(encoded) {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0) throw new GenerateError('上游没有返回有效图片')
  return bytes
}

export function buildOpenAiFields(options, model, size) {
  return {
    model,
    prompt: options.prompt,
    n: 1,
    size: size.text,
    quality: options.quality,
    ...(options.background ? { background: options.background } : {}),
  }
}

export function buildGeminiBody(options, size, images) {
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: options.prompt },
        ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } })),
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: size.aspectRatio, imageSize: size.imageSize },
    },
  }
}

export function buildGrokFields(options, model) {
  return {
    model,
    prompt: options.prompt,
    n: 1,
    // xAI 默认回一个很快过期的地址，要 base64 省一次下载。
    response_format: 'b64_json',
  }
}

function multipart(fields, images) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
  const field = images.length === 1 ? 'image' : 'image[]'
  for (const image of images) form.append(field, new Blob([image.bytes], { type: image.mimeType }), image.name)
  return form
}

async function requestOpenAiStyle(origin, apiKey, fields, images) {
  const result = images.length
    ? await send(`${origin}/v1/images/edits`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: multipart(fields, images),
    }, '请求超时（300 秒）')
    : await send(`${origin}/v1/images/generations`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }, '请求超时（300 秒）')
  if (!result.ok) throw upstreamFailure(result)
  const payload = extractImagePayload(parseJsonObject(result.bytes))
  return payload.kind === 'b64' ? decodeImage(payload.value) : downloadImage(payload.value)
}

async function requestGemini(origin, apiKey, model, body) {
  const result = await send(`${origin}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, '请求超时（300 秒）')
  if (!result.ok) throw upstreamFailure(result)
  return decodeImage(extractGeminiImage(parseJsonObject(result.bytes)))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }
  if (!options.prompt.trim()) fail('缺少 --prompt')
  if (!options.out.trim()) fail('缺少 --out')
  if (options.edit && options.images.length === 0) fail('图生图需要 --image')
  if (options.images.length > MAX_INPUT_IMAGES) fail(`参考图最多 ${MAX_INPUT_IMAGES} 张`)
  if (!QUALITIES.includes(options.quality)) fail(`画质无效：${options.quality}。可选 ${QUALITIES.join('、')}`)
  if (options.background && !BACKGROUNDS.includes(options.background)) {
    fail(`背景无效：${options.background}。可选 ${BACKGROUNDS.join('、')}`)
  }
  if (options.model && !modelFamily(options.model)) fail(unsupportedModelMessage(options.model))
  const config = await readSkillConfig(skillRootFromScript())
  const origin = assertHttpsOrigin(config.baseUrl)

  // 没点名、或点的就是主程序挑好的那个：按账号列表里有的顺序往下退（站上新开的这次没画出来：还没定价、渠道没好）。
  // 点名要别的就只用它。
  const requested = options.model || config.model || DEFAULT_MODEL
  const family = modelFamily(requested)
  const chain = defaultModelChain(config)
  const models = requested === chain[0] ? chain : [requested]
  const size = resolveImageSize(family, options.size, options.aspect)
  if (family === 'openai' && models.some(isGptImage2) && (size.width % 16 !== 0 || size.height % 16 !== 0)) {
    fail('gpt-image-2 系列的宽高必须是 16 的倍数')
  }
  // Nano Banana 和 Grok 只在图片模型分组里有，Codex Key 一定被拒，不白试。
  const keys = family === 'openai' ? config.keys : config.keys.filter((entry) => entry.source === 'image')
  if (keys.length === 0) {
    fail(`${requested} 只能用图片模型分组的 Key 出图，当前账号还没有。请打开管理工具重新登录；账号还没开通图片模型分组的，先开通再登录。`)
  }
  const images = []
  for (const filePath of options.images) images.push(await readInputImage(filePath))
  if (family === 'grok' && (options.size || options.aspect)) {
    process.stderr.write('Grok 不能指定尺寸和比例，按它自己的默认尺寸出图。\n')
  }

  async function generateWithKey(model, apiKey) {
    if (family === 'gemini') return requestGemini(origin, apiKey, model, buildGeminiBody(options, size, images))
    const fields = family === 'grok' ? buildGrokFields(options, model) : buildOpenAiFields(options, model, size)
    return requestOpenAiStyle(origin, apiKey, fields, images)
  }

  let bytes
  let usedModel
  let lastError
  for (const model of models) {
    for (let index = 0; index < keys.length; index += 1) {
      try {
        bytes = await generateWithKey(model, keys[index].apiKey)
        usedModel = model
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new GenerateError('生成失败')
        const retryable = error instanceof GenerateError && error.retryable
        if (!retryable || index === keys.length - 1) break
        process.stderr.write('Codex Key 未能出图，已改用生图分组 Key。\n')
      }
    }
    if (bytes || !(lastError instanceof GenerateError) || !lastError.upstream) break
  }
  if (!bytes) fail(lastError ? lastError.message : '生成失败')
  if (usedModel !== requested) process.stderr.write(`${requested} 没能出图，已改用 ${usedModel}。\n`)

  const finalPath = outputPathFor(options.out, bytes)
  await writeFile(finalPath, bytes)
  process.stdout.write(`${finalPath}\n`)
  process.stderr.write(`已用 ${usedModel} 出图\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : '生成失败'}\n`)
    process.exitCode = 1
  })
}
