import type { NodeKind } from '../model'
import type { NodeExecutor } from './engine'
import { generateImage, pollVideoTask, submitVideoTask, type RelayConfig } from './relay'

// relay 真执行器(M1)。与 mock 执行器同一 NodeExecutor 接口,App.tsx 按
// "宿主给了账号 token 就走真,没给就走 mock"选择,编排逻辑零改动。
// 渠道未配置时真执行器也能被调到 —— relay 会返回模型不存在类错误,
// 中文透传上屏,这正是"开发先行、渠道后配"的预期形态。

const DEFAULT_POLL_INTERVAL_MS = 4_000
// 视频任务上限兜底:轮询不能无限等(网络/上游卡死时用户没有任何退出路径)。
const DEFAULT_MAX_POLL_MS = 10 * 60 * 1000

export interface RelayExecutorHooks {
  /** 视频任务提交成功即回调 —— App 把 taskId 立刻写进节点数据,存盘后可断线恢复。 */
  onVideoTaskSubmitted?(nodeId: string, taskId: string): void
}

function combinedPrompt(upstreamText: string | undefined, ownPrompt: string): string {
  return [upstreamText, ownPrompt].filter((part) => part && part.trim()).join('\n')
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }, { once: true })
  })
}

export function createRelayExecutors(
  config: RelayConfig,
  hooks: RelayExecutorHooks = {},
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollMs = DEFAULT_MAX_POLL_MS,
): Record<NodeKind, NodeExecutor> {
  return {
    text: async (node) => ({ output: { text: node.data.prompt } }),

    image: async (node, inputs) => {
      const prompt = combinedPrompt(inputs.text, node.data.prompt)
      if (!prompt) throw new Error('请输入图像提示词或连接上游文本节点')
      if (!node.data.model.trim()) throw new Error('请填写图像模型名(渠道配置后可用)')
      const asset = await generateImage(config, { model: node.data.model.trim(), prompt })
      return { output: { asset } }
    },

    video: async (node, inputs, signal) => {
      const prompt = combinedPrompt(inputs.text, node.data.prompt)
      if (!prompt && !inputs.image) throw new Error('请输入视频提示词或连接上游图像节点')
      if (!node.data.model.trim()) throw new Error('请填写视频模型名(渠道配置后可用)')
      const { taskId } = await submitVideoTask(config, {
        model: node.data.model.trim(),
        prompt,
        imageUrl: inputs.image?.remoteUrl,
      })
      hooks.onVideoTaskSubmitted?.(node.id, taskId)
      const deadline = Date.now() + maxPollMs
      for (;;) {
        if (signal.aborted) throw new Error('已取消')
        if (Date.now() > deadline) throw new Error('视频任务等待超时,可稍后用任务 ID 恢复查询')
        const state = await pollVideoTask(config, taskId)
        if (state.status === 'succeeded') return { output: { asset: state.asset } }
        if (state.status === 'failed') throw new Error(state.reason)
        await waitFor(pollIntervalMs, signal)
      }
    },
  }
}
