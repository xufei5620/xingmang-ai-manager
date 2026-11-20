// 出图型号按名字认是哪一家。规则跟桌面主进程认出图型号的那一套一样（xingmang-ai-manager 的
// electron/ai-chat-protocol.ts，resolveAiModelCapability，桌面 #1920）：桌面认得、能拿去出图的，画布才在
// 图片分组里列出来；桌面认不出的，画布列出来也跑不了。所以按完整型号名认，不像 knownNonImageModel 那样剥掉
// 「中转/」前缀。这里不 import 任何东西：请求构造器（image-request-parameters.ts）和型号预设（models.ts）都用它。

export type ImageModelFamily = 'gpt-image' | 'gemini-image' | 'images-api' | 'jimeng' | 'grok-image'

const gptImagePattern = /^gpt-image-[a-z0-9][a-z0-9._-]*$/i
// gpt-image-1.5 没有访问权限（项目权限 403），桌面同样标成不可用、不列；带日期的快照版刻意不列，用不带日期的那个。
const unlistedGptImagePattern = /^gpt-image-1\.5(?:-|$)|-\d{4}-\d{2}-\d{2}$/i
const jimengPattern = /^jimeng_[a-z0-9][a-z0-9_]*$/i
const grokImagePattern = /^grok-imagine-image(?:-[a-z0-9][a-z0-9._-]*)?$/i
// 名字一看就是视频的不当出图型号（桌面 #1059 同一条）。sora 只认后面跟版本号的：不少中转把出图型号叫 sora_image。
const videoLikePattern = /^minimax-h\d|(?:^|[-_./])(?:sora-?(?:\d|$)|(?:video|veo|kling|vidu|seedance|hailuo|t2v|i2v)(?:$|[-_./\d]))/i
// Nano Banana 和新版 Gemini 出图（nano-banana-2、nano-banana-pro、gemini-3-pro-image-preview 这类），桌面照
// gemini-3.1-flash-image 的接法走。
const geminiImagePattern = /^(?:nano-banana(?:-[a-z0-9][a-z0-9._-]{0,63})?|gemini-[a-z0-9][a-z0-9._-]{0,63}-image(?:-[a-z0-9][a-z0-9._-]{0,63})?)$/i
// Gemini 2.x 出图和 nano-banana 原版只出 1K。
const singleResolutionGeminiPattern = /^(?:gemini-[12][.-]|nano-banana$)/i
// 走 Images 接口、尺寸交给服务定的别家：dall-e、imagen、通义 qwen-image / z-image、万相 t2i、Flux、豆包 seedream。
// 只能改图的（qwen-image-edit 这类）不收。
const imageEditOnlyPattern = /(?:^|[-_.])edit(?:$|[-_.\d])/i
const imagesApiPatterns: readonly RegExp[] = [
  /^dall-e(?:-|$)/i,
  /^imagen-/i,
  /(?:^|\/)(?:qwen-image|z-image)(?:$|[-_.])/i,
  /^wanx?\d+(?:\.\d+)?-t2i(?:$|[-_.])/i,
  /(?:^|[/_-])flux(?:[-.]|$)/i,
  /(?:^|[/_-])seedream(?:$|[-_.\d])/i,
]

/** Which image family a model name belongs to, by the desktop main process's rules; null when it is not an image model there. */
export function imageModelFamily(model: string): ImageModelFamily | null {
  const name = model.trim()
  if (gptImagePattern.test(name)) return 'gpt-image'
  if (jimengPattern.test(name)) return 'jimeng'
  if (grokImagePattern.test(name)) return 'grok-image'
  if (videoLikePattern.test(name)) return null
  if (geminiImagePattern.test(name)) return 'gemini-image'
  if (imageEditOnlyPattern.test(name)) return null
  return imagesApiPatterns.some((pattern) => pattern.test(name)) ? 'images-api' : null
}

/** An image model the editor may list from an account's model list. */
export function listedImageModelFamily(model: string): ImageModelFamily | null {
  const family = imageModelFamily(model)
  return family === 'gpt-image' && unlistedGptImagePattern.test(model.trim()) ? null : family
}

/** Gemini image models that only produce 1K (Gemini 2.x and the original nano-banana). */
export function singleResolutionGeminiImageModel(model: string): boolean {
  return imageModelFamily(model) === 'gemini-image' && singleResolutionGeminiPattern.test(model.trim())
}
