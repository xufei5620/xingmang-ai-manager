// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * 作品文件在星芒外面被删掉或挪走以后，图片、视频、音频三个作品库说的话（决定单 D37）。
 *
 * 以前三个库各说各的「AI 图片资产不存在或无权访问」：聊天里复制图片落到兜底「请稍后重试」，
 * 另存直接说「可以重试」，可文件已经没了，客户怎么重试都不行；画布作品库还轮着问三个库，
 * 最后问的音频库那句胜出，一张图找不到也说「音频」。
 *
 * 主进程的三个库抛这几句，作品库挑哪一句、聊天和视频剪辑认出是「文件没了」都照这一份，
 * 所以这里不许 import 任何东西。
 */
export const missingAiAssetMessages = {
  image: '这张图已经不在电脑上了，可能被移走或删掉了。',
  video: '这段视频已经不在电脑上了，可能被移走或删掉了。',
  audio: '这段音频已经不在电脑上了，可能被移走或删掉了。',
} as const

export type MissingAiAssetKind = keyof typeof missingAiAssetMessages

/**
 * 一句报错说的是不是「作品文件没了」，是的话给出原句，不是返回 null。
 * 按包含认：渲染层收到的报错可能还带着 IPC 那层前缀。
 */
export function resolveMissingAiAssetMessage(message: string): string | null {
  return Object.values(missingAiAssetMessages).find((sentence) => message.includes(sentence)) ?? null
}
