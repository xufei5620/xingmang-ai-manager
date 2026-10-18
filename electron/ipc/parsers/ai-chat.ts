// 对话页 chat:start 的入参。
import { isRecord } from '../../input-guards'
import type { AiChatStartInput } from '../../ipc-contract'
import { requiredString } from './common'

export function parseAiChatMessageImages(value: unknown, role: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 4 || (value.length > 0 && role !== 'user')) throw new Error('AI聊天图片格式错误')
  if (value.length === 0) return undefined
  const images = value.map((image) => {
    if (typeof image !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(image)) throw new Error('AI聊天图片格式错误')
    return image
  })
  if (new Set(images).size !== images.length) throw new Error('AI聊天图片格式错误')
  return images
}

export function parseAiChatStartInput(value: unknown): AiChatStartInput {
  if (!isRecord(value)) throw new Error('AI聊天请求格式错误')
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 100) {
    throw new Error('AI聊天消息格式错误')
  }
  const messages = value.messages.map((message) => {
    if (!isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role))) {
      throw new Error('AI聊天消息格式错误')
    }
    const images = parseAiChatMessageImages(message.images, message.role)
    return {
      role: message.role as 'system' | 'user' | 'assistant',
      // 只带图片、不写字的消息是允许的；其余消息仍然必须有字。
      content: images && message.content === '' ? '' : requiredString(message.content, 'AI聊天消息', 40_000),
      ...(images ? { images } : {}),
    }
  })
  if (value.parameters !== undefined && !isRecord(value.parameters)) throw new Error('AI聊天参数格式错误')
  const parameters = value.parameters as Record<string, unknown> | undefined
  const parsedParameters: AiChatStartInput['parameters'] = {}
  const parameterNames = ['temperature', 'topP', 'maxTokens', 'frequencyPenalty', 'presencePenalty', 'seed'] as const
  for (const name of parameterNames) {
    const entry = parameters?.[name]
    if (entry === undefined) continue
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new Error('AI聊天参数格式错误')
    parsedParameters[name] = entry
  }
  return {
    requestId: requiredString(value.requestId, 'AI聊天请求标识', 160),
    group: requiredString(value.group, 'AI聊天分组', 128),
    model: requiredString(value.model, 'AI聊天模型', 128),
    messages,
    ...(Object.keys(parsedParameters).length ? { parameters: parsedParameters } : {}),
  }
}
