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
  init: { method: 'GET' | 'POST'; body?: unknown },
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
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await response.text()
    if (text.length > (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
      throw new Error(`${label}响应超出大小上限`)
    }
    if (!response.ok) {
      throw new Error(`${label}失败,服务返回 ${response.status}`)
    }
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
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
