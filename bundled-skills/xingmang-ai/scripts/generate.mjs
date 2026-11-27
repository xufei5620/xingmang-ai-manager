#!/usr/bin/env node
// Image generation helper for this skill. Never prints API keys.

import { Buffer } from 'node:buffer'
import diagnosticsChannel from 'node:diagnostics_channel'
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
// 这条命令连不上网络时用这个退出码，和别的失败（1）分开：AI 只在看到它时申请联网后重跑一次。
const NETWORK_EXIT_CODE = 3

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
// gpt-image-2 系列的长宽比最多 3:1，长边最多 3840。
const GPT_IMAGE_MAX_RATIO = 3
const GPT_IMAGE_MAX_SIDE = 3840
// 改图时没写 --size，清晰度跟第一张原图走：长边取原图的长边，夹在这两个数之间（与画图工具 mcp-server.mjs 一致）。
// 上限停在 2K：1K、2K 同价，4K 多收钱，要 4K 得写明 --size 4K。比 1K 还小的原图照旧按 1K 出。
const EDIT_MIN_LONG_SIDE = 1024
const EDIT_MAX_LONG_SIDE = 2048
const QUALITIES = ['low', 'medium', 'high', 'auto']
const BACKGROUNDS = ['opaque', 'transparent', 'auto']

class GenerateError extends Error {
  constructor(message, switchKey = false, modelUnavailable = false, unexplained = false) {
    super(message)
    // 换一把 Key 可能就过了（401、403、429、503）。
    this.switchKey = switchKey
    // 这个型号现在用不了：自动挑的默认型号这样失败时，按顺序换下一个再试。
    this.modelUnavailable = modelUnavailable
    // 中转回了错误却没说原因：报错时换成一句人话，不把状态码或错误类别名交给 AI 转述。
    this.unexplained = unexplained
  }
}

// new-api 拿不到上游的原因时，拿错误类别名充当原因（relaykit/types/error.go 的 ToOpenAIError：
// openai_error、upstream_error、new_api_error 这类），等于什么都没说。
const PLACEHOLDER_ERROR_MESSAGE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_error$/i

/**
 * 中转回的原因是不是等于没说：空的，或者只有一个错误类别名。
 */
export function isUnexplainedUpstreamMessage(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  return !text || PLACEHOLDER_ERROR_MESSAGE_PATTERN.test(text)
}

/**
 * 没说原因时给 AI 和客户的那句话。Nano Banana、Grok 是点名才用的，建议换回默认的 GPT 图片模型。
 */
export function unexplainedFailureMessage(model, family, editing) {
  const action = editing ? '改图' : '出图'
  const next = family === 'openai' ? '可以稍后再试一次。' : '可以换回默认的 GPT 图片模型再试一次。'
  return `${model} 这次没能${action}，图片服务没说原因。${next}`
}

// 余额不足：认的是服务端自己写死的错误码和那几句话，和主程序 relay-quota-failure.ts 认的是同一套。两把 Key 是
// 同一个账户，换 Key、换型号都一样没钱，认出来就立刻停。刻意不认光秃秃的 insufficient_quota 和「令牌额度不足」：
// 前一个是上游渠道自己欠费，后一个是这把 Key 设了上限，叫客户充值就说错了。与画图工具一致，测试钉住。
const INSUFFICIENT_BALANCE_STATUSES = new Set([401, 402, 403, 429])
const INSUFFICIENT_BALANCE_PATTERN = /insufficient_user_quota|用户额度不足|预扣费额度失败|订阅额度不足|user quota is not enough|INSUFFICIENT_BALANCE|insufficient account balance/i

export function isInsufficientBalance(status, code, message) {
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
export function insufficientBalanceMessage(said) {
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

// 只有「这个型号现在用不了」才换下一个型号：没有这个型号、这个分组里没有它的渠道、站上还没给它定价。
// 内容审核不通过、参数不对、参考图有问题，换型号结果一样，还要把参考图再传一遍。与画图工具一致，测试钉住。
const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found', 'model_price_error'])
const MODEL_UNAVAILABLE_PATTERN = /model_not_found|无可用渠道|no available channel|no available compatible accounts|倍率或价格未配置|ratio or price not set/i

export function isModelUnavailable(status, code, message) {
  return status === 404 || MODEL_UNAVAILABLE_CODES.has(code) || MODEL_UNAVAILABLE_PATTERN.test(typeof message === 'string' ? message : '')
}

// 请求一个字节都没发出去就失败了：这条命令连不上网络。AI 在命令沙箱里跑脚本时多半是这种情况，以前只打一句
// 「fetch failed」，AI 看不出原因，接着换各种办法试上几分钟。
class NetworkError extends GenerateError {
  constructor() {
    super(networkFailureMessage(process.env))
  }
}

/**
 * 连不上时给 AI 和客户的那句话。Codex 在禁止联网的沙箱里跑命令时会带上 CODEX_SANDBOX_NETWORK_DISABLED，
 * 有它就把原因说死；没有就两种可能都说，不替客户猜。
 */
export function networkFailureMessage(env) {
  return env?.CODEX_SANDBOX_NETWORK_DISABLED
    ? '无法连接图片服务：这条命令被沙箱禁止联网。请允许这条命令联网后重新运行一次。'
    : '无法连接图片服务：这条命令可能被沙箱禁止联网，也可能是当前网络不通。请允许这条命令联网后重新运行一次；仍然失败请检查网络。'
}

// 请求头发出去过几次。连不上和「发出去了、没等到回复」要分开说：后一种服务端可能已经出图并扣费，不能叫 AI 重跑。
// 这个频道由 Node 自带的 fetch 发布；万一哪个版本没有，计数一直是 0，一律按连不上处理。
let requestHeadersSent = 0
try {
  diagnosticsChannel.subscribe('undici:client:sendHeaders', (message) => {
    // 走代理时先发给代理的 CONNECT 不算：那时图片服务还什么都没收到。
    if (message?.request?.method !== 'CONNECT') requestHeadersSent += 1
  })
} catch {
  // 订阅不上不影响出图。
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
    '  --size        1K|2K|4K，或 宽x高（gpt-image-2 系列宽高须为 16 的倍数）。画新图默认 1K；改图不传就跟第一张原图的清晰度（长边最多 2048）',
    '  --aspect      16:9|9:16|1:1|4:3|3:4|3:2|2:3，配 1K/2K/4K 用；--size 已经写了宽高时不用传。画新图默认 1:1；改图不传就跟第一张原图的比例',
    `  --quality     low|medium|high|auto，仅 gpt-image，默认 ${DEFAULT_QUALITY}`,
    '  --background  opaque|transparent|auto，仅 gpt-image；要透明底传 transparent',
    '  --image       参考图路径，改图用；可以给多张（最多 4 张）',
    '  --edit        图生图，可省略：给了 --image 就是改图',
    '',
    'Key 从本技能目录的 config.json 读取，登录后自动写入。',
    '先用软件签发的 Codex Key，失败再改用生图分组 Key。',
    '不要把 Key 打进日志。',
    '',
    `退出码：0 成功；${NETWORK_EXIT_CODE} 这条命令连不上网络（多半是被沙箱禁止联网）；1 其他失败。`,
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
  return aspectDimensions(aspect, SIZE_TIERS[tier])
}

// 同上，长边不限于三个档位：改图时长边跟原图走。
export function aspectDimensions(aspect, longSide) {
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
  const unitWidth = 16 * ratioWidth
  const unitHeight = 16 * ratioHeight
  let scale = Math.floor(longSide / Math.max(unitWidth, unitHeight))
  scale = Math.min(scale, Math.floor(Math.sqrt(GPT_IMAGE_MAX_PIXELS / (unitWidth * unitHeight))))
  while (unitWidth * unitHeight * scale * scale < GPT_IMAGE_MIN_PIXELS) scale += 1
  return { width: unitWidth * scale, height: unitHeight * scale }
}

function roundToSixteen(value) {
  return Math.max(16, Math.round(value / 16) * 16)
}

/**
 * 原图那种不在比例表里的比例（手机截图约 9:19.5）换成 gpt-image-2 系列能接的宽高：都是 16 的倍数（比例因此会差一点），
 * 长宽比超过 3:1 的按 3:1，总像素不够下限就把长边往上加、超了上限就往下减。与画图工具的同名函数同一套，测试钉住。
 */
export function ratioDimensions(ratio, longSide) {
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
export function nearestAspect(ratio) {
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
 * 把 --size / --aspect 按模型换成请求要的样子。OpenAI 要宽x高；Nano Banana 要 imageSize（1K/2K/4K）加比例；
 * Grok 不收尺寸（实测传 aspect_ratio 也照样出 1280x720），返回空的。
 *
 * original 是改图时第一张原图看上去的宽高（画新图、读不出宽高时为 null）。改图时没写的跟它走：没写比例就用原图的比例，
 * 没写尺寸就用原图的清晰度（长边 1024～2048）。写了宽高，或者比例和档位都写了的，照写的出。
 */
export function resolveImageSize(family, sizeInput = '', aspectInput = '', original = null) {
  const size = String(sizeInput || '').trim().toUpperCase()
  const aspect = String(aspectInput || '').trim()
  if (aspect && !ASPECT_RATIOS.includes(aspect)) {
    fail(`比例无效：${aspect}。可选 ${ASPECT_RATIOS.join('、')}`)
  }
  const tier = size && SIZE_TIERS[size] ? size : ''
  const dimensions = size && !tier ? /^(\d{2,5})X(\d{2,5})$/.exec(size) : null
  if (size && !tier && !dimensions) fail(`尺寸无效：${sizeInput}。写 1K、2K、4K，或者 宽x高`)
  const width = dimensions ? Number(dimensions[1]) : 0
  const height = dimensions ? Number(dimensions[2]) : 0
  if (dimensions && aspect && !sizeMatchesAspect(width, height, aspect)) {
    fail(`--size 写的 ${width}x${height} 比例是 ${ratioText(width, height)}，--aspect 写的是 ${aspect}，两边不一致。请只保留其中一个，或把两边改成同一个比例。`)
  }
  const ratio = dimensions ? ratioOf(width, height) : ''
  const follow = original && !dimensions && !(tier && aspect) ? original : null

  if (family === 'openai') {
    if (dimensions) return { text: `${width}x${height}`, width, height }
    let picked = tierDimensions(tier || '1K', aspect || '1:1')
    if (follow) {
      const longSide = tier ? SIZE_TIERS[tier] : editLongSide(follow)
      picked = aspect ? aspectDimensions(aspect, longSide) : ratioDimensions(follow.width / follow.height, longSide)
    }
    return { text: `${picked.width}x${picked.height}`, ...picked }
  }
  if (family === 'grok') return {}
  // 同时给了对得上的 --aspect 就用它：1920x1088 这种凑整的宽高自己约不出能用的比例。
  if (dimensions && !aspect && !ASPECT_RATIOS.includes(ratio)) {
    fail(`这个模型按比例出图，${width}x${height} 不是能用的比例。改用 --size 1K|2K|4K 加 --aspect ${ASPECT_RATIOS.join('|')}`)
  }
  const longSide = dimensions ? Math.max(width, height) : follow ? editLongSide(follow) : 0
  const imageSize = tier || (!longSide ? '1K' : longSide <= 1536 ? '1K' : longSide <= 3072 ? '2K' : '4K')
  return { imageSize, aspectRatio: aspect || ratio || (follow ? nearestAspect(follow.width / follow.height) : '1:1') }
}

function ratioOf(width, height) {
  const divisor = greatestCommonDivisor(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

function ratioText(width, height) {
  const divisor = greatestCommonDivisor(width, height) || 1
  const [left, right] = [width / divisor, height / divisor]
  return left <= 64 && right <= 64 ? `${left}:${right}` : `约 ${(width / height).toFixed(2)}:1`
}

// --size 已经写了宽高、又给了 --aspect：比例对得上就照 --size 画，对不上才报错。宽高凑成 16 的倍数时比例会差一点，容 2%。
function sizeMatchesAspect(width, height, aspect) {
  const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
  return Math.abs(width * ratioHeight - height * ratioWidth) <= 0.02 * height * ratioWidth
}

function isGptImage2(model) {
  return /^gpt-image-2(?:[.-]|$)/i.test(model)
}

// 这个型号现在用不了时换哪些：默认型号按账号列表里有的顺序往下退；点名的 GPT 图片型号（这个账号没有它、站上下线了）
// 也改用默认的那几个，各型号同价，换了在结果里说明。点名 Nano Banana、Grok 的只用它：换成别家，价格和画风都不一样。
function modelsToTry(requested, family, chain, fits) {
  if (requested === chain[0]) return chain
  if (family !== 'openai') return [requested]
  return [requested, ...chain.filter((model) => model !== requested && fits(model))]
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

/**
 * 读出图片的宽高（PNG 读 IHDR，JPEG 找 SOF 段，WebP 读画布大小），认不出返回 null。只看文件头，不解码。
 * 与画图工具 mcp-server.mjs 的同名函数同一套。
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
 * 方向 5～8 带 90 度旋转，宽高对调。读不出宽高返回 null，改图照旧按默认尺寸出。与画图工具同一套，测试钉住。
 */
export function originalDimensions(bytes) {
  const dimensions = readImageDimensions(bytes)
  if (!dimensions || !(dimensions.width > 0) || !(dimensions.height > 0)) return null
  if (imageMimeType(bytes) === 'image/jpeg' && jpegOrientation(bytes) >= 5) {
    return { width: dimensions.height, height: dimensions.width }
  }
  return dimensions
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
  const sentBefore = requestHeadersSent
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
    if (requestHeadersSent === sentBefore) throw new NetworkError()
    throw new GenerateError('与图片服务的连接中途断开，这次请求可能已经送达并扣费。请先在管理工具的用量记录中确认，再决定是否重新生成。')
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
  // xAI 这类上游把原因直接写成字符串 error，也算说了原因。
  const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.message
  const rawCode = payload?.error?.code ?? payload?.code
  const code = typeof rawCode === 'string' ? rawCode : ''
  // 余额不足：不换 Key，也不换型号。
  if (isInsufficientBalance(result.status, code, message)) {
    return new GenerateError(insufficientBalanceMessage(message))
  }
  const switchKey = [401, 403, 429, 503].includes(result.status)
  const modelUnavailable = isModelUnavailable(result.status, code, message)
  if (typeof message !== 'string' || isUnexplainedUpstreamMessage(message)) {
    return new GenerateError(`图片服务没说原因（HTTP ${result.status}）`, switchKey, modelUnavailable, true)
  }
  return new GenerateError(redactUpstream(message), switchKey, modelUnavailable)
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
  let result
  try {
    result = await send(parsed.href, { method: 'GET', redirect: 'follow' }, '下载图片超时')
  } catch (error) {
    // 图已经画出来、钱已经扣了：不能按「连不上」退出，那会让 AI 申请联网后重画一张。
    if (error instanceof NetworkError) throw new GenerateError('图片已经生成，但下载失败。这次已经扣费，请不要立即重新生成。')
    throw error
  }
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

  const requested = options.model || config.model || DEFAULT_MODEL
  const family = modelFamily(requested)
  // 先读原图：改图时没写的 --size、--aspect 要跟第一张走。
  const images = []
  for (const filePath of options.images) images.push(await readInputImage(filePath))
  const size = resolveImageSize(family, options.size, options.aspect, images.length ? originalDimensions(images[0].bytes) : null)
  const models = modelsToTry(requested, family, defaultModelChain(config), (model) => {
    return !isGptImage2(model) || (size.width % 16 === 0 && size.height % 16 === 0)
  })
  if (family === 'openai' && models.some(isGptImage2) && (size.width % 16 !== 0 || size.height % 16 !== 0)) {
    fail('gpt-image-2 系列的宽高必须是 16 的倍数')
  }
  // Nano Banana 和 Grok 只在图片模型分组里有，Codex Key 一定被拒，不白试。
  const keys = family === 'openai' ? config.keys : config.keys.filter((entry) => entry.source === 'image')
  if (keys.length === 0) {
    fail(`${requested} 只能用图片模型分组的 Key 出图，当前账号还没有。请打开管理工具重新登录；账号还没开通图片模型分组的，先开通再登录。`)
  }
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
  let lastModel
  for (const model of models) {
    for (let index = 0; index < keys.length; index += 1) {
      try {
        bytes = await generateWithKey(model, keys[index].apiKey)
        usedModel = model
        break
      } catch (error) {
        lastError = error instanceof Error ? error : new GenerateError('生成失败')
        lastModel = model
        const switchKey = error instanceof GenerateError && error.switchKey
        if (!switchKey || index === keys.length - 1) break
        process.stderr.write('Codex Key 未能出图，已改用生图分组 Key。\n')
      }
    }
    if (bytes || !(lastError instanceof GenerateError) || !lastError.modelUnavailable) break
  }
  if (!bytes && lastError instanceof GenerateError && lastError.unexplained) {
    fail(unexplainedFailureMessage(lastModel, family, images.length > 0))
  }
  // 原样抛出：连不上网络的那一种要带着它的退出码出去。
  if (!bytes) throw lastError ?? new GenerateError('生成失败')
  if (usedModel !== requested) process.stderr.write(`${requested} 目前无法使用，已改用 ${usedModel}。\n`)

  const finalPath = outputPathFor(options.out, bytes)
  await writeFile(finalPath, bytes)
  process.stdout.write(`${finalPath}\n`)
  process.stderr.write(`已用 ${usedModel} 出图\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : '生成失败'}\n`)
    process.exitCode = error instanceof NetworkError ? NETWORK_EXIT_CODE : 1
  })
}
