#!/usr/bin/env node
// Image MCP server for this skill. The client (Codex, Claude Code, Gemini CLI, Grok)
// starts it outside its command sandbox, so everything that crosses that line is
// narrowed here: the only network peer is the account's own image endpoint, the
// only files read are the skill config and images the user asked to edit, the
// only file written is the finished image (always a new file, in a place this
// script picks, never a path from the caller), and the API key never leaves this
// process except in that one auth header.

import { open, lstat, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_LINE_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_INPUT_IMAGES = 4
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 300_000
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_QUALITY = 'high'
// 画好的原图存成文件：有工作目录就放它下面的这个目录，没有就放系统图片文件夹里的「AI画图」目录。
// 目录名会出现在交给客户的路径里，不带品牌名（测试钉住）。
// 原图不再放进工具结果：它会跟着对话历史每一轮重传（单张中位 3.5MB），新版 Codex 桌面端还会把 1MB 以上的图显示成一大段 JSON。
const OUTPUT_DIRECTORY_NAME = 'outputs'
const PICTURES_FOLDER_NAME = 'AI画图'
const MAX_SAME_NAME_FILES = 99
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
  '不填 model 就用登录时按当前账号挑好的那个。',
].join('\n')
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const SIZE_TIERS = { '1K': 1024, '2K': 2048, '4K': 3840 }
// gpt-image-2 系列：宽高都是 16 的倍数，总像素在这两个数之间（4K 16:9 = 3840x2160 正好顶格）。
const GPT_IMAGE_MIN_PIXELS = 655_360
const GPT_IMAGE_MAX_PIXELS = 8_294_400
// gpt-image-2 系列的长宽比最多 3:1，长边最多 3840。
const GPT_IMAGE_MAX_RATIO = 3
const GPT_IMAGE_MAX_SIDE = 3840
// 改图时没写尺寸，清晰度跟第一张原图走：长边取原图的长边，夹在这两个数之间。以前一律按 1024 出，
// 4032x3024 的照片改一次只剩四分之一的像素，接着改也回不来（yoyo 11-27「改图保持原尺寸」）。
// 上限停在 2K：1K、2K 同价，4K 多收钱，要 4K 得写明 size。比 1K 还小的原图照旧按 1K 出。
const EDIT_MIN_LONG_SIDE = 1024
const EDIT_MAX_LONG_SIDE = 2048
// This standalone script cannot import the desktop registry. Trust exact TLS
// origins instead of permitting other services on the same host to receive the
// account's keys. The desktop app rewrites this skill's base URL to the active
// line on every sync, so a retired test entry never needs to stay trusted here.
const ALLOWED_RELAY_ORIGINS = new Set([
  'https://xm.solov.cc',
  'https://api.solov.cc',
  'https://xm-direct.solov.cc',
])
// 这几种状态换一把 Key 可能就过了（这把 Key 失效、所在分组没有这个型号、限流、上游忙），与生图技能一致。
const SWITCH_KEY_STATUSES = new Set([401, 403, 429, 503])
// 只有「这个型号现在用不了」才换下一个型号：没有这个型号、这个分组里没有它的渠道、站上还没给它定价。
// 内容审核不通过、参数不对、参考图有问题，换型号结果一样，还要把参考图再传一遍。与生图技能脚本一致，测试钉住。
const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found', 'model_price_error'])
const MODEL_UNAVAILABLE_PATTERN = /model_not_found|无可用渠道|no available channel|no available compatible accounts|倍率或价格未配置|ratio or price not set/i

function isModelUnavailable(status, code, message) {
  return status === 404 || MODEL_UNAVAILABLE_CODES.has(code) || MODEL_UNAVAILABLE_PATTERN.test(typeof message === 'string' ? message : '')
}
// 余额不足：认的是服务端自己写死的错误码和那几句话，和主程序 relay-quota-failure.ts 认的是同一套。两把 Key 是
// 同一个账户，换 Key、换型号都一样没钱，认出来就立刻停。刻意不认光秃秃的 insufficient_quota 和「令牌额度不足」：
// 前一个是上游渠道自己欠费，后一个是这把 Key 设了上限，叫客户充值就说错了。与生图技能脚本一致，测试钉住。
const INSUFFICIENT_BALANCE_STATUSES = new Set([401, 402, 403, 429])
const INSUFFICIENT_BALANCE_PATTERN = /insufficient_user_quota|用户额度不足|预扣费额度失败|订阅额度不足|user quota is not enough|INSUFFICIENT_BALANCE|insufficient account balance/i

function isInsufficientBalance(status, code, message) {
  return INSUFFICIENT_BALANCE_STATUSES.has(status) && INSUFFICIENT_BALANCE_PATTERN.test(`${code} ${message}`)
}

function centsOf(match) {
  return match ? Math.round(Number(match[1]) * 100) : null
}

function moneyText(cents) {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`
}

/**
 * 余额不足时给 AI 和客户的那句话。金额从服务端的原话里取（「用户剩余额度: ＄0.137692, 需要预扣费额度: ＄0.200000」），
 * 只认带美元符号的：不带符号的数字可能是站上的额度单位，不当钱写出来。取不到就不写金额。
 */
function insufficientBalanceMessage(said) {
  const text = typeof said === 'string' ? said : ''
  const needed = centsOf(/需要预扣费额度[:：]\s*[＄$]\s*(\d+(?:\.\d+)?)/.exec(text))
  const remainingMatch = /剩余额度[:：]\s*[＄$]\s*(-?\d+(?:\.\d+)?)/.exec(text)
  let remaining = centsOf(remainingMatch)
  // 四舍五入后不能写成「需要 $0.20，剩余 $0.20」：差一点不够时剩余按舍去算。
  if (needed !== null && remaining !== null && remaining >= needed) remaining = Math.floor(Number(remainingMatch[1]) * 100)
  const amounts = remaining === null ? '' : needed === null
    ? `（剩余 ${moneyText(remaining)}）`
    : `（需要 ${moneyText(needed)}，剩余 ${moneyText(remaining)}）`
  return `当前账号余额不足，无法生成这张图片${amounts}。请在管理工具中充值后重试。`
}

class ImageError extends Error {
  constructor(message, switchKey = false, modelUnavailable = false) {
    super(message)
    // 换一把 Key 可能就过了。
    this.switchKey = switchKey
    // 这个型号现在用不了：自动挑的默认型号这样失败时，按顺序换下一个再试。
    this.modelUnavailable = modelUnavailable
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

// new-api 拿不到上游的原因时，拿错误类别名充当原因（relaykit/types/error.go 的 ToOpenAIError：
// openai_error、upstream_error、new_api_error 这类），等于什么都没说。与生图技能脚本一致，测试钉住。
const PLACEHOLDER_ERROR_MESSAGE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_error$/i

function isUnexplainedUpstreamMessage(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  return !text || PLACEHOLDER_ERROR_MESSAGE_PATTERN.test(text)
}

// 没说原因时给 AI 和客户的那句话。Nano Banana、Grok 是点名才用的，建议换回默认的 GPT 图片模型。
function unexplainedFailureMessage(model, family, editing) {
  const action = editing ? '改图' : '出图'
  const next = family === 'openai' ? '可以稍后再试一次。' : '可以换回默认的 GPT 图片模型再试一次。'
  return `${model} 这次没能${action}，图片服务没说原因。${next}`
}

function relayErrorCode(payload) {
  const code = payload?.error?.code ?? payload?.code
  return typeof code === 'string' ? code : ''
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
  if (!value) throw new ImageError('画图工具还没有完成账号同步，请打开管理工具重新登录当前账号')
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
    throw new ImageError('画图工具读不到账号配置，请打开管理工具重新登录当前账号')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ImageError('画图工具的账号配置已损坏，请打开管理工具重新登录当前账号')
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
    throw new ImageError('画图工具的服务地址无效，请打开管理工具重新登录当前账号')
  }
  // 与生图技能同一个顺序：先用 Codex Key，被拒再换生图分组 Key。
  const keys = []
  for (const [field, source] of [['codexApiKey', 'codex'], ['apiKey', 'image']]) {
    const value = typeof parsed[field] === 'string' ? parsed[field].trim() : ''
    if (value.startsWith('sk-') && !keys.some((entry) => entry.value === value)) keys.push({ source, value })
  }
  if (keys.length === 0) throw new ImageError('当前账号还没有可以画图的 Key，请打开管理工具登录')
  return { origin, keys, chain: defaultModelChain(parsed) }
}

function configuredModel(value) {
  const model = typeof value === 'string' ? value.trim() : ''
  return modelFamily(model) === 'openai' ? model : ''
}

/**
 * 主程序登录同步时按当前账号实际能用的 OpenAI 图片模型排好顺序：model 是第一个，fallbackModels 是后面的。
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
        description: '一般不填，用登录时按当前账号挑好的 OpenAI 模型。用户点名时可写 gpt-image- 开头的型号、nano-banana-2、nano-banana-pro、grok-imagine-image',
      },
      size: { type: 'string', description: '1K、2K、4K，或 宽x高（如 1536x1024）；gpt-image-2 系列宽高要是 16 的倍数。4K 多收钱。画新图默认 1K；改图不填就跟第一张原图的清晰度（长边最多 2048，同价）' },
      aspect: { type: 'string', enum: ASPECT_RATIOS, description: '画面比例，配 1K/2K/4K 用；size 已经写了宽高时不用填。画新图默认 1:1；改图不填就跟第一张原图的比例' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], default: DEFAULT_QUALITY },
      background: { type: 'string', enum: ['opaque', 'transparent', 'auto'], default: 'opaque' },
    },
    required: ['prompt'],
  }
}

function toolList(model) {
  return [{
    name: 'generate_image',
    description: '用当前账号画图或改图。用户要画一张图、生成图片，或者修改、编辑一张已有图片时调用；改图时把原图的完整路径放进 images。图片会保存成文件，结果里给出文件路径和一张预览图。不要自己写脚本或命令去调图片接口。',
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
  // 没点名就留空，等读到配置再用主程序挑好的那个。
  const model = argumentsValue.model === undefined ? undefined : textValue(argumentsValue.model, '', 80)
  if (model !== undefined && !modelFamily(model)) throw new ImageError(unsupportedModelMessage(model))
  const size = textValue(argumentsValue.size, '', 32)
  if (size && size !== 'auto' && !SIZE_TIERS[size.toUpperCase()] && !/^(\d{2,5})x(\d{2,5})$/i.test(size)) {
    throw new ImageError('图片尺寸格式错误：写 1K、2K、4K，或者 宽x高')
  }
  const aspect = textValue(argumentsValue.aspect, '', 8)
  if (aspect && !ASPECT_RATIOS.includes(aspect)) throw new ImageError(`图片比例只能是 ${ASPECT_RATIOS.join('、')}`)
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

function ratioText(width, height) {
  const divisor = greatestCommonDivisor(width, height) || 1
  const [left, right] = [width / divisor, height / divisor]
  return left <= 64 && right <= 64 ? `${left}:${right}` : `约 ${(width / height).toFixed(2)}:1`
}

// size 已经写了宽高、又给了 aspect：比例对得上就照 size 画，对不上才报错。宽高凑成 16 的倍数时比例会差一点，容 2%。
function sizeMatchesAspect(width, height, aspect) {
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
  return Math.abs(width * ratioHeight - height * ratioWidth) <= 0.02 * height * ratioWidth
}

// 与 generate.mjs 的 aspectDimensions 同一套换算，测试钉住两边结果一样。
function aspectDimensions(aspect, longSide) {
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
  const unitWidth = 16 * ratioWidth
  const unitHeight = 16 * ratioHeight
  let scale = Math.floor(longSide / Math.max(unitWidth, unitHeight))
  scale = Math.min(scale, Math.floor(Math.sqrt(GPT_IMAGE_MAX_PIXELS / (unitWidth * unitHeight))))
  while (unitWidth * unitHeight * scale * scale < GPT_IMAGE_MIN_PIXELS) scale += 1
  return { width: unitWidth * scale, height: unitHeight * scale }
}

function tierDimensions(tier, aspect) {
  const picked = aspectDimensions(aspect, SIZE_TIERS[tier])
  return `${picked.width}x${picked.height}`
}

function roundToSixteen(value) {
  return Math.max(16, Math.round(value / 16) * 16)
}

/**
 * 原图那种不在比例表里的比例（手机截图约 9:19.5）换成 gpt-image-2 系列能接的宽高：都是 16 的倍数（比例因此会差一点），
 * 长宽比超过 3:1 的按 3:1，总像素不够下限就把长边往上加、超了上限就往下减。与 generate.mjs 的同名函数同一套，测试钉住。
 */
function ratioDimensions(ratio, longSide) {
  const stretch = Math.min(GPT_IMAGE_MAX_RATIO, Math.max(ratio, 1 / ratio))
  function shortSideFor(long) {
    const short = roundToSixteen(long / stretch)
    return long > GPT_IMAGE_MAX_RATIO * short ? short + 16 : short
  }
  let long = roundToSixteen(Math.min(longSide, GPT_IMAGE_MAX_SIDE))
  let short = shortSideFor(long)
  while (long * short < GPT_IMAGE_MIN_PIXELS) {
    long += 16
    short = shortSideFor(long)
  }
  while (long * short > GPT_IMAGE_MAX_PIXELS) {
    long -= 16
    short = shortSideFor(long)
  }
  return ratio >= 1 ? { width: long, height: short } : { width: short, height: long }
}

function editLongSide(original) {
  return Math.min(EDIT_MAX_LONG_SIDE, Math.max(EDIT_MIN_LONG_SIDE, original.width, original.height))
}

// Nano Banana 只收比例表里的比例：取跟原图最接近的那个（按宽高比的倍数差算，竖图不会选到横的）。
function nearestAspect(ratio) {
  let nearest = '1:1'
  let distance = Infinity
  for (const aspect of ASPECT_RATIOS) {
    const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
    const gap = Math.abs(Math.log(ratio * ratioHeight / ratioWidth))
    if (gap < distance) {
      nearest = aspect
      distance = gap
    }
  }
  return nearest
}

/**
 * OpenAI 要宽x高（或 auto）；Nano Banana 要 imageSize 加比例；Grok 不收尺寸（实测传 aspect_ratio 也照样出 1280x720），
 * 返回 ignored 让结果里说一句。
 *
 * original 是改图时第一张原图看上去的宽高（画新图、读不出宽高时为 null）。改图时没写的跟它走：没写比例就用原图的比例，
 * 没写尺寸就用原图的清晰度（长边 1024～2048）。写了宽高、写了 auto，或者比例和档位都写了的，照写的出。
 */
function resolveImageSize(family, size, aspect, original = null) {
  const tier = SIZE_TIERS[size.toUpperCase()] ? size.toUpperCase() : ''
  const dimensions = /^(\d{2,5})x(\d{2,5})$/i.exec(size)
  if (dimensions && aspect && !sizeMatchesAspect(Number(dimensions[1]), Number(dimensions[2]), aspect)) {
    throw new ImageError(`size 写的 ${dimensions[1]}x${dimensions[2]} 比例是 ${ratioText(Number(dimensions[1]), Number(dimensions[2]))}，aspect 写的是 ${aspect}，两边不一致。请只保留其中一个，或把两边改成同一个比例。`)
  }
  const follow = original && !dimensions && size !== 'auto' && !(tier && aspect) ? original : null
  if (family === 'openai') {
    if (size === 'auto') return { size: 'auto' }
    if (dimensions) return { size: `${dimensions[1]}x${dimensions[2]}` }
    if (!follow) return { size: tierDimensions(tier || '1K', aspect || '1:1') }
    const longSide = tier ? SIZE_TIERS[tier] : editLongSide(follow)
    const picked = aspect ? aspectDimensions(aspect, longSide) : ratioDimensions(follow.width / follow.height, longSide)
    return { size: `${picked.width}x${picked.height}` }
  }
  if (family === 'grok') return { ignored: Boolean((size && size !== 'auto') || aspect) }
  let ratio = ''
  if (dimensions) {
    const width = Number(dimensions[1])
    const height = Number(dimensions[2])
    const divisor = greatestCommonDivisor(width, height) || 1
    ratio = `${width / divisor}:${height / divisor}`
    // 同时给了对得上的 aspect 就用它：1920x1088 这种凑整的宽高自己约不出能用的比例。
    if (!aspect && !ASPECT_RATIOS.includes(ratio)) {
      throw new ImageError(`这个模型按比例出图，${size} 不是能用的比例。改用 size 填 1K、2K、4K，aspect 填 ${ASPECT_RATIOS.join('、')}`)
    }
  }
  const longSide = dimensions ? Math.max(Number(dimensions[1]), Number(dimensions[2])) : follow ? editLongSide(follow) : 0
  const imageSize = tier || (!longSide ? '1K' : longSide <= 1536 ? '1K' : longSide <= 3072 ? '2K' : '4K')
  return { imageSize, aspectRatio: aspect || ratio || (follow ? nearestAspect(follow.width / follow.height) : '1:1') }
}

function sizeFitsModel(size, model) {
  const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(size ?? '')
  return !(dimensions && model.startsWith('gpt-image-2')
    && (Number(dimensions[1]) % 16 !== 0 || Number(dimensions[2]) % 16 !== 0))
}

function assertSizeFitsModel(size, model) {
  if (!sizeFitsModel(size, model)) throw new ImageError('gpt-image-2 系列的宽高必须是 16 的倍数')
}

// 这个型号现在用不了时换哪些：默认型号按账号列表里有的顺序往下退；点名的 GPT 图片型号（这个账号没有它、站上下线了）
// 也改用默认的那几个，各型号同价，换了在结果里说明。点名 Nano Banana、Grok 的只用它：换成别家，价格和画风都不一样。
function modelsToTry(requested, family, chain, fits) {
  if (requested === chain[0]) return chain
  if (family !== 'openai') return [requested]
  return [requested, ...chain.filter((model) => model !== requested && fits(model))]
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
    // 连不上不换 Key 也不换型号：换了一样连不上。
    throw new ImageError('连不上图片服务，请检查网络后再试')
  } finally {
    clearTimeout(timer)
  }
  let payload
  try { payload = JSON.parse(bytes.toString('utf8')) } catch { payload = null }
  if (!response.ok) {
    // xAI 这类上游把原因直接写成字符串 error，也算说了原因。
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message
    const code = relayErrorCode(payload)
    if (isInsufficientBalance(response.status, code, message)) {
      process.stderr.write(`画图失败，余额不足（HTTP ${response.status}）\n`)
      // 不换 Key，也不换型号。
      throw new ImageError(insufficientBalanceMessage(message))
    }
    const switchKey = SWITCH_KEY_STATUSES.has(response.status)
    const modelUnavailable = isModelUnavailable(response.status, code, message)
    if (typeof message !== 'string' || isUnexplainedUpstreamMessage(message)) {
      // 原话只进日志（MCP 的 stderr 由宿主记进日志，不进对话），AI 和客户看到的是一句人话。
      const said = typeof message === 'string' && message.trim() ? redactUpstream(message) : '没有内容'
      process.stderr.write(`画图失败，图片服务回了 HTTP ${response.status}：${said}\n`)
      throw new ImageError(unexplainedFailureMessage(input.model, input.family, images.length > 0), switchKey, modelUnavailable)
    }
    throw new ImageError(redactUpstream(message), switchKey, modelUnavailable)
  }
  const encoded = encodedImage(payload, input.family)
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_RESPONSE_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ImageError('图片服务没有返回有效图片')
  }
  // Nano Banana、Grok 回的是 JPEG，按内容标类型；认不出的照旧当 PNG。
  return { encoded, mimeType: imageMimeType(Buffer.from(encoded.slice(0, 32), 'base64')) ?? 'image/png' }
}

/**
 * 读出图片的宽高（PNG 读 IHDR，JPEG 找 SOF 段，WebP 读画布大小），认不出返回 null。只看文件头，不解码。
 */
function readImageDimensions(bytes) {
  const mimeType = imageMimeType(bytes)
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + bytes.readUInt16BE(offset + 2)
    }
    return null
  }
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const format = bytes.toString('latin1', 12, 16)
    if (format === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    if (format === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (format === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    }
  }
  return null
}

/**
 * JPEG 里 Exif 记的拍摄方向（1～8），没有或读不出就是 1。只看 SOS 之前的 APP1 段，不解码。
 */
function jpegOrientation(bytes) {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Start of scan or end of image: the metadata segments are all before it.
    if (marker === 0xda || marker === 0xd9) return 1
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return 1
    if (marker === 0xe1 && length >= 16 && bytes.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
      return exifOrientation(bytes.subarray(offset + 10, offset + 2 + length))
    }
    offset += 2 + length
  }
  return 1
}

// TIFF header, then IFD0; tag 0x0112 is the orientation, a SHORT stored in the first two value bytes.
function exifOrientation(tiff) {
  if (tiff.length < 8) return 1
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  function short(at) {
    return order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)
  }
  if (short(2) !== 42) return 1
  const directory = order === 'II' ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)
  if (directory + 2 > tiff.length) return 1
  const count = short(directory)
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12
    if (entry + 12 > tiff.length) return 1
    if (short(entry) === 0x0112) {
      const value = short(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

/**
 * 原图看上去的宽高：手机竖拍的照片常常横着存（iPhone 是 4032x3024），靠 Exif 方向标记竖着显示，客户看到的是竖图。
 * 方向 5～8 带 90 度旋转，宽高对调。读不出宽高返回 null，改图照旧按默认尺寸出。与 generate.mjs 同一套，测试钉住。
 */
function originalDimensions(bytes) {
  const dimensions = readImageDimensions(bytes)
  if (!dimensions || !(dimensions.width > 0) || !(dimensions.height > 0)) return null
  if (imageMimeType(bytes) === 'image/jpeg' && jpegOrientation(bytes) >= 5) {
    return { width: dimensions.height, height: dimensions.width }
  }
  return dimensions
}

function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function homeDirectory() {
  try {
    const home = os.homedir()
    return home && path.isAbsolute(home) ? home : ''
  } catch {
    return ''
  }
}

/**
 * 当前目录算不算一个「工作目录」。命令行里的 AI 工具在项目目录里启动本工具，图就该放进项目；桌面端启动时的当前目录
 * 却是盘符根、系统目录、软件自己的安装目录或用户主目录，图放进去客户找不到，也不该往那里写。不算时返回空。
 */
function workingDirectory() {
  let cwd
  try {
    cwd = process.cwd()
  } catch {
    return ''
  }
  if (!path.isAbsolute(cwd) || path.parse(cwd).root === cwd) return ''
  const home = homeDirectory()
  if (home && isInside(cwd, home)) {
    // 主目录本身，和它下面放软件数据的目录（.codex、.claude、AppData、Library 这些）。
    const first = path.relative(home, cwd).split(path.sep)[0].toLowerCase()
    if (!first || first.startsWith('.') || first === 'appdata' || first === 'library') return ''
  }
  const env = process.env
  const systemDirectories = process.platform === 'win32'
    ? [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData, env.APPDATA, env.LOCALAPPDATA]
    : ['/Applications', '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/proc', '/sys', '/boot', '/lib', '/snap']
  if (systemDirectories.some((entry) => entry && path.isAbsolute(entry) && isInside(cwd, entry))) return ''
  return cwd
}

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

async function picturesDirectory(home) {
  const candidates = [path.join(home, 'Pictures')]
  // Windows 开了 OneDrive 备份时「图片」文件夹被挪到 OneDrive 下面，主目录里那个不一定还在。
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = process.env[key]?.trim()
    if (root && path.isAbsolute(root)) candidates.push(path.join(root, 'Pictures'), path.join(root, '图片'))
  }
  candidates.push(path.join(home, '图片'))
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate
  }
  return candidates[0]
}

// 依次试：工作目录下的 outputs、系统图片文件夹里的目录、系统临时目录。前一个写不进去才用后一个。
async function outputDirectories() {
  const directories = []
  const cwd = workingDirectory()
  if (cwd) directories.push(path.join(cwd, OUTPUT_DIRECTORY_NAME))
  const home = homeDirectory()
  if (home) directories.push(path.join(await picturesDirectory(home), PICTURES_FOLDER_NAME))
  directories.push(path.join(os.tmpdir(), PICTURES_FOLDER_NAME))
  return directories
}

function twoDigits(value) {
  return String(value).padStart(2, '0')
}

// 文件名带时间和型号：20261126-173005-gpt-image-2.6-flare.png。
function outputFileBase(model, now) {
  const day = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`
  return `${day}-${time}-${model.replace(/[^A-Za-z0-9._-]/g, '-')}`
}

async function writeNewFile(directory, base, extension, bytes) {
  for (let attempt = 1; attempt <= MAX_SAME_NAME_FILES; attempt += 1) {
    const filePath = path.join(directory, attempt === 1 ? `${base}${extension}` : `${base}-${attempt}${extension}`)
    let handle
    try {
      // wx: fails when the name is taken, so an existing file is never overwritten and an
      // existing link is never written through. Same second, same model gets -2, -3, ...
      handle = await open(filePath, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
    try {
      await handle.writeFile(bytes)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(filePath).catch(() => undefined)
      throw error
    }
    await handle.close()
    return filePath
  }
  throw new Error('too many files with the same name')
}

/**
 * 把原图存成文件，返回完整路径；哪里都写不进去返回 null。保存位置只由这里决定，不收调用方给的路径：
 * 本工具在命令沙箱外面运行，收路径就等于给了 AI 一个在沙箱外任意位置写文件的口子。
 */
async function saveOriginal(bytes, model, mimeType) {
  const base = outputFileBase(model, new Date())
  const extension = { 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mimeType] ?? '.png'
  for (const directory of await outputDirectories()) {
    try {
      await mkdir(directory, { recursive: true })
      // 这个名字被一个链接或文件占着就换下一个位置，不顺着链接写到别处去。
      if (!(await lstat(directory)).isDirectory()) continue
      return await writeNewFile(directory, base, extension, bytes)
    } catch (error) {
      process.stderr.write(`图片没能存进 ${directory}：${error?.code ?? '写入失败'}\n`)
    }
  }
  return null
}

// 预览做不出来（模块读不到、图解不开）不算失败：照样给文件路径。
async function buildPreview(bytes, mimeType, dimensions) {
  try {
    const { buildImagePreview } = await import('./image-preview.mjs')
    return await buildImagePreview(bytes, mimeType, dimensions)
  } catch (error) {
    process.stderr.write(`预览图没有做出来：${redactUpstream(error instanceof Error ? error.message : '')}\n`)
    return null
  }
}

/**
 * 画好以后交回去的内容：原图存成文件，结果里只有一张小预览和一段固定的话。那段话是写给 AI 看的：
 * 路径照抄给客户，客户说看不到图时指给他文件在哪，不要重画（重画一次扣一次钱）。
 */
async function finishedContent(image, model, notes) {
  const bytes = Buffer.from(image.encoded, 'base64')
  const dimensions = readImageDimensions(bytes)
  const done = `已用 ${model} 画好${dimensions ? `，${dimensions.width}x${dimensions.height}` : ''}。`
  const filePath = await saveOriginal(bytes, model, image.mimeType)
  if (!filePath) {
    // 图已经画好、钱已经扣了，哪里都存不进去时原图照旧放在结果里，不能丢。
    return [
      { type: 'image', data: image.encoded, mimeType: image.mimeType },
      { type: 'text', text: `${done}图片未能保存成文件，原图在这条结果里。${notes}` },
    ]
  }
  const text = `${done}文件：${filePath}。回复客户时请原样给出这个路径，不要自己拼路径；客户说看不到图时，告诉他文件在哪，不要重新生成。${notes}`
  const preview = await buildPreview(bytes, image.mimeType, dimensions)
  if (!preview) return [{ type: 'text', text: `${text}这张图没有预览。` }]
  return [
    { type: 'image', data: preview.bytes.toString('base64'), mimeType: preview.mimeType },
    { type: 'text', text },
  ]
}

async function generateImage(argumentsValue) {
  const input = parseArguments(argumentsValue)
  const config = await readConfig()
  const requested = input.model ?? config.chain[0]
  const family = modelFamily(requested)
  // 先读原图：改图时没写的尺寸和比例要跟第一张走。
  const images = []
  for (const filePath of input.images) images.push(await readInputImage(filePath))
  const resolved = resolveImageSize(family, input.size, input.aspect, images.length ? originalDimensions(images[0].bytes) : null)
  const models = modelsToTry(requested, family, config.chain, (model) => sizeFitsModel(resolved.size, model))
  for (const model of models) assertSizeFitsModel(resolved.size, model)
  // Nano Banana 和 Grok 只在图片模型分组里有，Codex Key 一定被拒，不白试。
  const keys = family === 'openai' ? config.keys : config.keys.filter((entry) => entry.source === 'image')
  if (keys.length === 0) {
    throw new ImageError(`${requested} 只能用图片模型分组画图，当前账号还没有这个分组的 Key。请打开管理工具重新登录；账号还没开通图片模型分组的，先开通再登录`)
  }
  let lastError = null
  for (const model of models) {
    for (let index = 0; index < keys.length; index += 1) {
      try {
        const image = await requestImage(config.origin, keys[index].value, { ...input, model, family, resolved }, images)
        const notes = [
          model === requested ? '' : `${requested} 目前无法使用，已改用 ${model}。`,
          resolved.ignored ? 'Grok 不能指定尺寸和比例，这张图按它的默认尺寸生成。' : '',
        ]
        return { content: await finishedContent(image, model, notes.join('')) }
      } catch (error) {
        lastError = error
        if (!(error instanceof ImageError) || !error.switchKey) break
      }
    }
    if (!(lastError instanceof ImageError) || !lastError.modelUnavailable) break
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
      serverInfo: { name: 'xingmang-image', version: '1.4.0' },
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
