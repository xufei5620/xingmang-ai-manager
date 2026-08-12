import type { AssetRef } from '../model'

// relay(xm.solov.cc / new-api)客户端骨架。端点形状已按 T12 标准从
// v1.0.0-rc.24 源码逐行核实(router/video-router.go、relay-router):
//   文生图: POST {base}/v1/images/generations   —— OpenAI 兼容,同步返回
//   视频:   POST {base}/v1/video/generations    —— 提交任务,返回 task_id
//           GET  {base}/v1/video/generations/{task_id} —— 轮询状态
// 渠道配置(具体模型名)由老板在 xm 后台完成后即可真跑;此前 M0 一律走
// mock 执行器,本文件不被调用 —— 测试绝不打生产(主仓 T12 铁律)。
// I10:每个请求都有超时 + 响应体上限 + redirect:'error'。

export interface RelayConfig {
  baseUrl: string
  apiKey: string
}

export interface RelayFetchOptions {
  timeoutMs?: number
  maxResponseBytes?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

async function relayRequest(
  config: RelayConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; form?: FormData },
  label: string,
  options: RelayFetchOptions = {},
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        // multipart 刻意不设 Content-Type:boundary 必须由运行时生成,
        // 手写会让上游解析失败(RECON-image-generation 第 5 节)。
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await response.text()
    if (text.length > (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
      throw new Error(`${label}响应超出大小上限`)
    }
    if (!response.ok) {
      const detail = extractRelayErrorDetail(text)
      throw new Error(`${label}失败,服务返回 ${response.status}${detail ? `:${detail}` : ''}`)
    }
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

// 把 new-api 错误响应体里的人话带上屏(2026-08-12 真机 503 复盘):503 的
// 典型信息是「分组下无可用渠道」—— 只报状态码会把分组/渠道配置问题伪装成
// 服务器故障,用户与运维都无从下手。上游文案剥控制字符并截断,防止超长/
// 畸形响应污染界面。
function extractRelayErrorDetail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return ''
    const error = parsed.error
    const candidate = isRecord(error) && typeof error.message === 'string'
      ? error.message
      : typeof parsed.message === 'string' ? parsed.message : ''
    return candidate.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 文生图。gpt-image 系列(xm 已配的四个模型,2026-08-11)返回
 * `data[0].b64_json`(base64 图像字节,不回 URL);dall-e 老形态回
 * `data[0].url`。两种都接:b64 转成 data: URL,<img> 预览与宿主落盘
 * (downloadAsset 已支持 data:)全链通用。刻意不发 response_format——
 * gpt-image 系列不接受该参数。
 */
export async function generateImage(
  config: RelayConfig,
  input: { model: string; prompt: string; size?: string; quality?: string },
): Promise<AssetRef> {
  const raw = await relayRequest(
    config,
    '/v1/images/generations',
    {
      method: 'POST',
      body: {
        model: input.model,
        prompt: input.prompt,
        n: 1,
        ...(input.size ? { size: input.size } : {}),
        // quality 由调用方按模型能力决定是否传(即梦不传);gpt-image 系
        // 必须显式传,否则 auto 档按提示词复杂度跳档,费用差可达 35 倍。
        ...(input.quality ? { quality: input.quality } : {}),
      },
    },
    '图像生成',
    // 实测 high 档最长 183s(RECON-image-generation),超时放到 320s;
    // b64 响应体是兆级字符串,给足余量(默认 8MB 会截断大图)。
    { timeoutMs: 320_000, maxResponseBytes: 64 * 1024 * 1024 },
  )
  const data = isRecord(raw) && Array.isArray(raw.data) ? raw.data[0] : null
  if (isRecord(data) && typeof data.url === 'string' && data.url) {
    return { kind: 'image', remoteUrl: data.url }
  }
  if (isRecord(data) && typeof data.b64_json === 'string' && data.b64_json) {
    return { kind: 'image', remoteUrl: `data:image/png;base64,${data.b64_json}` }
  }
  throw new Error('图像生成响应中没有产物(既无 URL 也无 base64 数据)')
}

function parseImageResult(raw: unknown, label: string): AssetRef {
  const data = isRecord(raw) && Array.isArray(raw.data) ? raw.data[0] : null
  if (isRecord(data) && typeof data.url === 'string' && data.url) {
    return { kind: 'image', remoteUrl: data.url }
  }
  if (isRecord(data) && typeof data.b64_json === 'string' && data.b64_json) {
    return { kind: 'image', remoteUrl: `data:image/png;base64,${data.b64_json}` }
  }
  throw new Error(`${label}响应中没有产物(既无 URL 也无 base64 数据)`)
}

/**
 * 把上游产物取成可上传的 Blob。gpt-image 系产物是 data: URL,本地解码即可,
 * 全程不出网;即梦那种 https 签名链接才需要真去取一次(且 24h 会过期)。
 */
async function fetchAssetBlob(url: string, maxBytes: number): Promise<Blob> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const meta = url.slice(5, comma)
    if (comma < 0 || !meta.endsWith(';base64')) throw new Error('参考图数据格式不支持')
    const binary = atob(url.slice(comma + 1))
    if (binary.length > maxBytes) throw new Error('参考图超出大小上限')
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: meta.slice(0, meta.length - ';base64'.length) || 'image/png' })
  }
  if (!url.startsWith('https://')) throw new Error('参考图地址不受支持(仅接受 https 或本地产物)')
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`参考图下载失败,服务返回 ${response.status}(链接可能已过期)`)
  const blob = await response.blob()
  if (blob.size > maxBytes) throw new Error('参考图超出大小上限')
  return blob
}

/**
 * 图生图 /v1/images/edits。**只吃 multipart/form-data**,JSON 会被上游报
 * `Missing required parameter: 'images'`(该提示有误导性,别照它改字段名);
 * 图片字段名用 `image[]`(实测 `image` / `image[]` 均可,`images` 报错)。
 * 仅 gpt-image 系支持,调用方须先按模型能力拦截。事实来源:
 * docs/RECON-image-generation.md 第 5 节(生产实测)。
 */
export async function editImage(
  config: RelayConfig,
  input: { model: string; prompt: string; imageUrl: string; size?: string; quality?: string },
): Promise<AssetRef> {
  const maxUploadBytes = 32 * 1024 * 1024
  const blob = await fetchAssetBlob(input.imageUrl, maxUploadBytes)
  const form = new FormData()
  form.append('model', input.model)
  form.append('prompt', input.prompt)
  form.append('n', '1')
  if (input.size) form.append('size', input.size)
  if (input.quality) form.append('quality', input.quality)
  form.append('image[]', blob, 'origin.png')
  const raw = await relayRequest(
    config,
    '/v1/images/edits',
    { method: 'POST', form },
    '图生图',
    { timeoutMs: 320_000, maxResponseBytes: 64 * 1024 * 1024 },
  )
  return parseImageResult(raw, '图生图')
}

export interface VideoTaskSubmission {
  taskId: string
}

/** 提交视频生成任务(文生视频或图生视频,image 传上游产物 URL)。 */
export async function submitVideoTask(
  config: RelayConfig,
  input: { model: string; prompt: string; imageUrl?: string },
): Promise<VideoTaskSubmission> {
  const raw = await relayRequest(
    config,
    '/v1/video/generations',
    {
      method: 'POST',
      body: {
        model: input.model,
        prompt: input.prompt,
        ...(input.imageUrl ? { image: input.imageUrl } : {}),
      },
    },
    '视频任务提交',
  )
  const taskId = isRecord(raw)
    ? (typeof raw.task_id === 'string' ? raw.task_id : (typeof raw.id === 'string' ? raw.id : null))
    : null
  if (!taskId) throw new Error('视频任务提交响应中没有任务 ID')
  return { taskId }
}

export type VideoTaskState =
  | { status: 'pending' }
  | { status: 'succeeded'; asset: AssetRef }
  | { status: 'failed'; reason: string }

/** 轮询一次视频任务状态。真实响应字段名以真机联调为准,此处按 rc.24 通用任务壳解析。 */
export async function pollVideoTask(config: RelayConfig, taskId: string): Promise<VideoTaskState> {
  const raw = await relayRequest(
    config,
    `/v1/video/generations/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    '视频任务查询',
  )
  if (!isRecord(raw)) return { status: 'pending' }
  const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : ''
  if (['succeeded', 'success', 'completed'].includes(status)) {
    const url = typeof raw.url === 'string'
      ? raw.url
      : (isRecord(raw.data) && typeof raw.data.url === 'string' ? raw.data.url : null)
    if (url) return { status: 'succeeded', asset: { kind: 'video', remoteUrl: url, taskId } }
    return { status: 'failed', reason: '任务成功但响应中没有产物 URL' }
  }
  if (['failed', 'error', 'cancelled'].includes(status)) {
    const reason = typeof raw.fail_reason === 'string' ? raw.fail_reason : '视频生成失败'
    return { status: 'failed', reason }
  }
  return { status: 'pending' }
}
