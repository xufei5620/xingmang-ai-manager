// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// 视频剪辑「一句话出片」的分镜：把客户的一句想法交给文字模型拆成几个镜头，每个镜头一句给视频模型的
// 画面描述和一句字幕。请求在主进程发（凭据不出主进程），这里只放拼提示词和读回答两件纯计算，
// 上限和页面共用一份，所以零依赖、能进渲染层。

export type VideoStudioPlanAspect = '16:9' | '9:16' | '1:1'

export const videoStudioPlanLimits = {
  maximumIdeaLength: 2_000,
  minimumShots: 1,
  maximumShots: 12,
  minimumSecondsPerShot: 1,
  maximumSecondsPerShot: 15,
  maximumPromptLength: 1_500,
  maximumCaptionLength: 60,
  maximumTitleLength: 40,
} as const

export interface VideoStudioPlanRequest {
  idea: string
  shotCount: number
  secondsPerShot: number
  aspect: VideoStudioPlanAspect
  captions: boolean
}

export interface VideoStudioPlanShot {
  prompt: string
  /** 不要字幕，或者模型这一镜没写字幕时没有这一项。 */
  caption?: string
}

export interface VideoStudioPlan {
  title: string
  shots: VideoStudioPlanShot[]
}

export const videoStudioPlanUnreadableMessage = '这次 AI 没按格式写出分镜，把想法写具体一点或换个文字模型再试'

const aspectDescriptions: Readonly<Record<VideoStudioPlanAspect, string>> = {
  '16:9': '横屏 16:9',
  '9:16': '竖屏 9:16',
  '1:1': '方形 1:1',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 模型写的字只拿来上屏和交给视频模型：换行、制表和别的控制字符一律换成空格，多余空白并成一个。
function cleanText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum).trim()
}

export function buildVideoStudioPlanMessages(request: VideoStudioPlanRequest): { system: string; user: string } {
  const { shotCount, secondsPerShot } = request
  const system = [
    '你是短视频分镜师。用户给一句想法，你把它拆成几个镜头；每个镜头会交给 AI 视频模型单独生成一段片段，最后按顺序拼成一条成片。',
    '只输出一个 JSON 对象，不要解释、不要 Markdown：{"title":"","shots":[{"prompt":"","caption":""}]}',
    `shots 正好 ${shotCount} 个，按播放顺序排；成片是${aspectDescriptions[request.aspect]}，每个镜头 ${secondsPerShot} 秒。`,
    `prompt 写给视频模型看：一段话写清主体、动作、场景、镜头运动、光线和画风，是 ${secondsPerShot} 秒内演得完的一件事。`,
    '每个镜头是分开生成的，互相看不到，所以人物的长相和穿着、场景和画风要在每一个 prompt 里完整重复写，前后保持一致。',
    'prompt 里不要写字幕、文字、水印和 Logo。',
    request.captions
      ? 'caption 是烧在这一镜画面上的一句字幕：15 个字以内，口语，和画面对得上；这一镜不需要字幕就写空字符串。'
      : 'caption 一律写空字符串。',
    'title 是成片标题，12 个字以内。prompt、caption 和 title 都用用户想法的语言写。',
  ].join('\n')
  return { system, user: request.idea.trim() }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(videoStudioPlanUnreadableMessage)
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown
  } catch {
    throw new Error(videoStudioPlanUnreadableMessage)
  }
}

/**
 * 读模型回的分镜表。多写的镜头只留前面要的那几个；少写的照收，页面上看得到少了几个。
 * 一个镜头都读不出来就抛同一句话，交给调用方决定要不要再问一次。
 */
export function parseVideoStudioPlanJson(text: string, request: VideoStudioPlanRequest): VideoStudioPlan {
  const raw = extractJsonObject(text)
  if (!isRecord(raw) || !Array.isArray(raw.shots)) throw new Error(videoStudioPlanUnreadableMessage)
  const shots: VideoStudioPlanShot[] = []
  for (const entry of raw.shots) {
    if (shots.length >= request.shotCount) break
    if (!isRecord(entry)) throw new Error(videoStudioPlanUnreadableMessage)
    const prompt = cleanText(entry.prompt, videoStudioPlanLimits.maximumPromptLength)
    if (!prompt) throw new Error(videoStudioPlanUnreadableMessage)
    const caption = request.captions ? cleanText(entry.caption, videoStudioPlanLimits.maximumCaptionLength) : ''
    shots.push({ prompt, ...(caption ? { caption } : {}) })
  }
  if (shots.length === 0) throw new Error(videoStudioPlanUnreadableMessage)
  const title = cleanText(raw.title, videoStudioPlanLimits.maximumTitleLength)
    || cleanText(request.idea, 12)
  return { title, shots }
}
