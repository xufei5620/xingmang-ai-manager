#!/usr/bin/env node
// Xingmang image MCP server. The client (Codex, Claude Code, Gemini CLI, Grok)
// starts it outside its command sandbox, so everything that crosses that line is
// narrowed here: the only network peer is the account's own image endpoint, the
// only files read are the skill config and images the user asked to edit, and
// the API key never leaves this process except in that one auth header.

import { open, lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LINE_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_INPUT_IMAGES = 4
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 300_000
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_QUALITY = 'high'
// 认型号三处同一套（主程序 xingmang-ai-skill.ts、技能脚本 generate.mjs、这里），测试钉住。
// 以前这里只认写死的 5 个，站上换代后主程序写进来的新型号会被悄悄换回 gpt-image-2（#1059）。
// 默认只用 OpenAI 的 gpt-image 系列；Nano Banana 和 Grok 要点名才用，只走图片模型分组的 Key。
const OPENAI_IMAGE_MODEL_PATTERN = /^gpt-image-[a-z0-9][a-z0-9._-]{0,63}$/i
const RETIRED_OPENAI_IMAGE_MODEL_PATTERN = /^gpt-image-1(?:[.-]|$)/i
const GEMINI_IMAGE_MODEL_PATTERN = /^(?:nano-banana(?:-[a-z0-9][a-z0-9._-]{0,63})?|gemini-[a-z0-9][a-z0-9._-]{0,63}-image(?:-[a-z0-9][a-z0-9._-]{0,63})?)$/i
const GROK_IMAGE_MODEL_PATTERN = /^grok-imagine-image(?:-[a-z0-9][a-z0-9._-]{0,63})?$/i
const SUPPORTED_MODELS_HINT = [
  'OpenAI：gpt-image-2.6-flare、gpt-image-2.5-flare、gpt-image-2、gpt-image-2.6-sunburst、gpt-image-2.5-sunburst（gpt-image- 开头的新型号也行）',
  'Nano Banana：nano-banana-2（即 gemini-3.1-flash-image）、nano-banana-pro',
  'Grok：grok-imagine-image、grok-imagine-image-2.0、grok-imagine-image-quality',
  '不填 model 就用星芒为当前账号挑好的那个。',
].join('\n')
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const SIZE_TIERS = { '1K': 1024, '2K': 2048, '4K': 3840 }
// gpt-image-2 系列：宽高都是 16 的倍数，总像素在这两个数之间（4K 16:9 = 3840x2160 正好顶格）。
const GPT_IMAGE_MIN_PIXELS = 655_360
const GPT_IMAGE_MAX_PIXELS = 8_294_400
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
  constructor(message, retryable = false, upstream = false) {
    super(message)
    this.retryable = retryable
    // 中转明确回了错误（不是连不上、超时）：自动挑的默认模型这样失败时，按顺序换下一个再试。
    this.upstream = upstream
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

function modelFamily(model) {
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
  for (const [field, source] of [['codexApiKey', 'codex'], ['apiKey', 'image']]) {
    const value = typeof parsed[field] === 'string' ? parsed[field].trim() : ''
    if (value.startsWith('sk-') && !keys.some((entry) => entry.value === value)) keys.push({ source, value })
  }
  if (keys.length === 0) throw new ImageError('当前账号还没有可以画图的 Key，请打开星芒AI管理工具登录')
  return { origin, keys, chain: defaultModelChain(parsed) }
}

function configuredModel(value) {
  const model = typeof value === 'string' ? value.trim() : ''
  return modelFamily(model) === 'openai' ? model : ''
}

/**
 * 星芒登录同步时按当前账号实际能用的 OpenAI 图片模型排好顺序：model 是第一个，fallbackModels 是后面的。
 * 没点名时按这个顺序往下退，只退到账号列表里有的；老版本写的配置没有 fallbackModels，照旧退到 gpt-image-2。
 */
function defaultModelChain(parsed) {
  const model = configuredModel(parsed.model)
  if (!model) return [DEFAULT_MODEL]
  const rest = Array.isArray(parsed.fallbackModels)
    ? parsed.fallbackModels.map(configuredModel).filter(Boolean)
    : [DEFAULT_MODEL]
  return [...new Set([model, ...rest])]
}

async function defaultModel() {
  try {
    return (await readConfig()).chain[0]
  } catch {
    return DEFAULT_MODEL
  }
}

function schema(model) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '要画什么；改图时写要怎么改' },
      images: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_INPUT_IMAGES,
        description: '改图时填参考图（PNG、JPEG 或 WebP）的完整路径，可以给多张；画新图时不填',
      },
      model: {
        type: 'string',
        default: model,
        description: '一般不填，用星芒为当前账号挑好的 OpenAI 模型。用户点名时可写 gpt-image- 开头的型号、nano-banana-2、nano-banana-pro、grok-imagine-image',
      },
      size: { type: 'string', description: '1K、2K、4K，或 宽x高（如 1536x1024）；gpt-image-2 系列宽高要是 16 的倍数。4K 多收钱' },
      aspect: { type: 'string', enum: ASPECT_RATIOS, description: '画面比例，配 1K/2K/4K 用，默认 1:1' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], default: DEFAULT_QUALITY },
      background: { type: 'string', enum: ['opaque', 'transparent', 'auto'], default: 'opaque' },
    },
    required: ['prompt'],
  }
}

function toolList(model) {
  return [{
    name: 'generate_image',
    description: '用当前星芒账号画图或改图。用户要画一张图、生成图片，或者修改、编辑一张已有图片时调用；改图时把原图的完整路径放进 images。结果直接显示在对话里。不要自己写脚本或命令去调图片接口。',
    inputSchema: schema(model),
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
  // 没点名就留空，等读到配置再用星芒挑好的那个。
  const model = argumentsValue.model === undefined ? undefined : textValue(argumentsValue.model, '', 80)
  if (model !== undefined && !modelFamily(model)) throw new ImageError(unsupportedModelMessage(model))
  const size = textValue(argumentsValue.size, '', 32)
  if (size && size !== 'auto' && !SIZE_TIERS[size.toUpperCase()] && !/^(\d{2,5})x(\d{2,5})$/i.test(size)) {
    throw new ImageError('图片尺寸格式错误：写 1K、2K、4K，或者 宽x高')
  }
  const aspect = textValue(argumentsValue.aspect, '', 8)
  if (aspect && !ASPECT_RATIOS.includes(aspect)) throw new ImageError(`图片比例只能是 ${ASPECT_RATIOS.join('、')}`)
  if (aspect && /x/i.test(size)) throw new ImageError('已经用 size 写了宽高，就不要再给 aspect')
  const quality = textValue(argumentsValue.quality, DEFAULT_QUALITY, 16)
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
  return { prompt, model, size, aspect, quality, background, images }
}

function greatestCommonDivisor(left, right) {
  return right === 0 ? left : greatestCommonDivisor(right, left % right)
}

// 与 generate.mjs 的 tierDimensions 同一套换算，测试钉住两边结果一样。
function tierDimensions(tier, aspect) {
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
  const unitWidth = 16 * ratioWidth
  const unitHeight = 16 * ratioHeight
  let scale = Math.floor(SIZE_TIERS[tier] / Math.max(unitWidth, unitHeight))
  scale = Math.min(scale, Math.floor(Math.sqrt(GPT_IMAGE_MAX_PIXELS / (unitWidth * unitHeight))))
  while (unitWidth * unitHeight * scale * scale < GPT_IMAGE_MIN_PIXELS) scale += 1
  return `${unitWidth * scale}x${unitHeight * scale}`
}

/**
 * OpenAI 要宽x高（或 auto）；Nano Banana 要 imageSize 加比例；Grok 不收尺寸（实测传 aspect_ratio 也照样出 1280x720），
 * 返回 ignored 让结果里说一句。
 */
function resolveImageSize(family, size, aspect) {
  const tier = SIZE_TIERS[size.toUpperCase()] ? size.toUpperCase() : ''
  const dimensions = /^(\d{2,5})x(\d{2,5})$/i.exec(size)
  if (family === 'openai') {
    if (size === 'auto') return { size: 'auto' }
    if (dimensions) return { size: `${dimensions[1]}x${dimensions[2]}` }
    return { size: tierDimensions(tier || '1K', aspect || '1:1') }
  }
  if (family === 'grok') return { ignored: Boolean((size && size !== 'auto') || aspect) }
  let ratio = ''
  if (dimensions) {
    const width = Number(dimensions[1])
    const height = Number(dimensions[2])
    const divisor = greatestCommonDivisor(width, height) || 1
    ratio = `${width / divisor}:${height / divisor}`
    if (!ASPECT_RATIOS.includes(ratio)) {
      throw new ImageError(`这个模型按比例出图，${size} 不是能用的比例。改用 size 填 1K、2K、4K，aspect 填 ${ASPECT_RATIOS.join('、')}`)
    }
  }
  const longSide = dimensions ? Math.max(Number(dimensions[1]), Number(dimensions[2])) : 0
  const imageSize = tier || (!dimensions ? '1K' : longSide <= 1536 ? '1K' : longSide <= 3072 ? '2K' : '4K')
  return { imageSize, aspectRatio: aspect || ratio || '1:1' }
}

function assertSizeFitsModel(size, model) {
  const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(size ?? '')
  if (dimensions && model.startsWith('gpt-image-2')
    && (Number(dimensions[1]) % 16 !== 0 || Number(dimensions[2]) % 16 !== 0)) {
    throw new ImageError('gpt-image-2 系列的宽高必须是 16 的倍数')
  }
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

function imagesForm(fields, images) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
  const field = images.length === 1 ? 'image' : 'image[]'
  for (const image of images) form.append(field, new Blob([image.bytes], { type: image.mimeType }), image.name)
  return form
}

function requestBody(input, images, apiKey) {
  if (input.family === 'gemini') {
    // Gemini 类型的渠道走 Images API 会回「only imagen models are supported」，只能走原生接口；图放在 inlineData 里回来。
    return {
      pathname: `/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: input.prompt },
            ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } })),
          ],
        }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: input.resolved.aspectRatio, imageSize: input.resolved.imageSize },
        },
      }),
    }
  }
  const fields = input.family === 'grok'
    ? {
      model: input.model,
      prompt: input.prompt,
      n: 1,
      // xAI 默认回一个很快过期的地址，要 base64 省一次下载。
      response_format: 'b64_json',
    }
    : {
      model: input.model,
      prompt: input.prompt,
      size: input.resolved.size,
      quality: input.quality,
      background: input.background,
      n: 1,
      output_format: 'png',
    }
  const authorization = { Authorization: `Bearer ${apiKey}` }
  if (images.length === 0) {
    return {
      headers: { ...authorization, 'Content-Type': 'application/json' },
      pathname: '/v1/images/generations',
      body: JSON.stringify(fields),
    }
  }
  return { headers: authorization, pathname: '/v1/images/edits', body: imagesForm(fields, images) }
}

function encodedImage(payload, family) {
  if (family === 'gemini') {
    const parts = payload?.candidates?.[0]?.content?.parts
    for (const part of Array.isArray(parts) ? parts : []) {
      const inline = part?.inlineData ?? part?.inline_data
      if (typeof inline?.data === 'string' && inline.data) return inline.data
    }
    const said = (Array.isArray(parts) ? parts : []).map((part) => part?.text).filter((text) => typeof text === 'string').join(' ')
    const reason = payload?.promptFeedback?.blockReason || payload?.candidates?.[0]?.finishReason
    throw new ImageError(redactUpstream(`图片服务没有返回图片${said ? `：${said}` : reason ? `（${reason}）` : ''}`))
  }
  return payload?.data?.[0]?.b64_json
}

async function requestImage(origin, apiKey, input, images) {
  const request = requestBody(input, images, apiKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  let bytes
  try {
    response = await fetch(`${origin}${request.pathname}`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: request.headers,
      body: request.body,
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      throw new ImageError('图片服务返回了重定向，已拒绝')
    }
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
      true,
    )
  }
  const encoded = encodedImage(payload, input.family)
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_RESPONSE_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ImageError('图片服务没有返回有效图片')
  }
  // Nano Banana、Grok 回的是 JPEG，按内容标类型；认不出的照旧当 PNG。
  return { encoded, mimeType: imageMimeType(Buffer.from(encoded.slice(0, 32), 'base64')) ?? 'image/png' }
}

async function generateImage(argumentsValue) {
  const input = parseArguments(argumentsValue)
  const config = await readConfig()
  // AI 没点名、或点的就是星芒挑好的那个：按账号列表里有的顺序往下退（站上新开的这次没画出来：还没定价、渠道没好）。
  // 点名要别的就只用它，失败原样交回去让 AI 自己换。
  const requested = input.model ?? config.chain[0]
  const family = modelFamily(requested)
  const models = requested === config.chain[0] ? config.chain : [requested]
  const resolved = resolveImageSize(family, input.size, input.aspect)
  for (const model of models) assertSizeFitsModel(resolved.size, model)
  // Nano Banana 和 Grok 只在图片模型分组里有，Codex Key 一定被拒，不白试。
  const keys = family === 'openai' ? config.keys : config.keys.filter((entry) => entry.source === 'image')
  if (keys.length === 0) {
    throw new ImageError(`${requested} 只能用图片模型分组画图，当前账号还没有这个分组的 Key。请打开星芒AI管理工具重新登录；账号还没开通图片模型分组的，先开通再登录`)
  }
  const images = []
  for (const filePath of input.images) images.push(await readInputImage(filePath))
  let lastError = null
  for (const model of models) {
    for (let index = 0; index < keys.length; index += 1) {
      try {
        const image = await requestImage(config.origin, keys[index].value, { ...input, model, family, resolved }, images)
        const done = images.length ? `已用 ${model} 改好图片` : `已用 ${model} 画好图片`
        return {
          content: [
            { type: 'image', data: image.encoded, mimeType: image.mimeType },
            { type: 'text', text: resolved.ignored ? `${done}（Grok 不能指定尺寸和比例，按它自己的默认尺寸出的）` : done },
          ],
        }
      } catch (error) {
        lastError = error
        if (!(error instanceof ImageError) || !error.retryable) break
      }
    }
    if (!(lastError instanceof ImageError) || !lastError.upstream) break
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
      serverInfo: { name: 'xingmang-image', version: '1.3.0' },
    })
  }
  if (message.method === 'tools/list') return resultMessage(message.id, { tools: toolList(await defaultModel()) })
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
