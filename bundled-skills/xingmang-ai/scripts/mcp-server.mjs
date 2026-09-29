#!/usr/bin/env node
// Xingmang image MCP bridge. It returns MCP image content so Codex Desktop can
// render the result without enabling the ChatGPT-only image_gen executor.

import { lstat, readFile } from 'node:fs/promises'

const MAX_LINE_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 300_000
const DEFAULT_MODEL = 'gpt-image-2'
const ALLOWED_MODELS = new Set([
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
])
const ALLOWED_RELAY_HOSTS = new Set(['xm.solov.cc', 'api.solov.cc'])

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function errorMessage(id, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } })
}

function resultMessage(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function configPath() {
  const value = process.env.XINGMANG_IMAGE_CONFIG_PATH?.trim()
  if (!value) throw new Error('星芒图片 MCP 尚未完成账号同步')
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
    throw new Error('星芒图片 MCP 配置不可读，请在星芒AI中重新同步账号')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('星芒图片 MCP 配置格式错误')
  }
  const value = parsed
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  const imageKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  const codexKey = typeof value.codexApiKey === 'string' ? value.codexApiKey.trim() : ''
  const apiKey = imageKey || codexKey
  if (!baseUrl || !apiKey) throw new Error('星芒图片 MCP 缺少图片分组 Key')
  let origin
  try {
    const url = new URL(baseUrl)
    const localTest = process.env.XINGMANG_IMAGE_MCP_ALLOW_INSECURE_LOCAL === '1'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    if ((!ALLOWED_RELAY_HOSTS.has(url.hostname) && !localTest)
      || (url.protocol !== 'https:' && !localTest)
      || url.username || url.password) throw new Error('unsafe')
    origin = url.origin
  } catch {
    throw new Error('星芒图片 MCP Base URL 无效')
  }
  if (!apiKey.startsWith('sk-')) throw new Error('星芒图片 MCP Key 格式无效')
  return { origin, apiKey }
}

function schema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '要生成的图片描述' },
      model: { type: 'string', enum: [...ALLOWED_MODELS], default: DEFAULT_MODEL },
      size: { type: 'string', description: '例如 1024x1024、1024x1536 或 auto' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], default: 'low' },
      background: { type: 'string', enum: ['opaque', 'transparent', 'auto'], default: 'opaque' },
    },
    required: ['prompt'],
  }
}

function toolList() {
  return [{
    name: 'generate_image',
    description: '通过星芒AI图片中转生成图片。用户要求画图、生成图片或编辑图片时调用；结果会直接显示在当前 Codex 对话中。',
    inputSchema: schema(),
  }]
}

function textValue(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('图片参数格式错误')
  return value.trim()
}

function parseArguments(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new Error('图片参数格式错误')
  }
  const prompt = textValue(argumentsValue.prompt, '', 32_000)
  if (!prompt) throw new Error('图片描述不能为空')
  const model = textValue(argumentsValue.model, DEFAULT_MODEL, 80)
  if (!ALLOWED_MODELS.has(model)) throw new Error('图片模型不在允许列表中')
  const size = textValue(argumentsValue.size, '1024x1024', 32)
  if (size !== 'auto' && !/^\d{2,5}x\d{2,5}$/.test(size)) throw new Error('图片尺寸格式错误')
  const quality = textValue(argumentsValue.quality, 'low', 16)
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('图片质量参数错误')
  const background = textValue(argumentsValue.background, 'opaque', 16)
  if (!['opaque', 'transparent', 'auto'].includes(background)) throw new Error('图片背景参数错误')
  return { prompt, model, size, quality, background }
}

async function readLimited(response) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('图片服务响应过大')
    return Buffer.from(bytes)
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) throw new Error('图片服务响应过大')
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function generateImage(argumentsValue) {
  const input = parseArguments(argumentsValue)
  const config = await readConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${config.origin}/v1/images/generations`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        background: input.background,
        n: 1,
        output_format: 'png',
      }),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('图片生成超时（300 秒）')
    throw new Error('图片服务请求失败')
  } finally {
    clearTimeout(timer)
  }
  if (response.status >= 300 && response.status < 400) throw new Error('图片服务返回了重定向，已拒绝')
  const bytes = await readLimited(response)
  let payload
  try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('图片服务返回格式错误') }
  if (!response.ok) {
    const message = payload?.error?.message
    throw new Error(typeof message === 'string' ? message.slice(0, 500) : `图片服务返回 HTTP ${response.status}`)
  }
  const encoded = payload?.data?.[0]?.b64_json
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_RESPONSE_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('图片服务没有返回有效图片')
  }
  return {
    content: [
      { type: 'image', data: encoded, mimeType: 'image/png' },
      { type: 'text', text: `已通过星芒AI生成 ${input.model} 图片` },
    ],
  }
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return
  if (message.method === 'ping') return resultMessage(message.id, {})
  if (message.method === 'initialize') {
    return resultMessage(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'xingmang-image', version: '1.0.0' },
    })
  }
  if (message.method === 'tools/list') return resultMessage(message.id, { tools: toolList() })
  if (message.method !== 'tools/call') return errorMessage(message.id, '不支持的图片 MCP 方法')
  if (message.params?.name !== 'generate_image') return errorMessage(message.id, '不支持的图片工具')
  try {
    return resultMessage(message.id, await generateImage(message.params.arguments))
  } catch (error) {
    return resultMessage(message.id, {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : '图片生成失败' }],
    })
  }
}

let pending = ''
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8')
  if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES * 2) {
    process.stderr.write('星芒图片 MCP 请求过大\n')
    process.exitCode = 1
    return
  }
  while (true) {
    const newline = pending.indexOf('\n')
    if (newline < 0) break
    const line = pending.slice(0, newline).trim()
    pending = pending.slice(newline + 1)
    if (!line) continue
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      errorMessage(null, '图片 MCP 请求过大')
      continue
    }
    try {
      const message = JSON.parse(line)
      void handle(message).catch(() => errorMessage(message.id, '图片 MCP 请求失败'))
    } catch {
      errorMessage(null, '图片 MCP 请求格式错误')
    }
  }
})
