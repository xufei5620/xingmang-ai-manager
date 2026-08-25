import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.DL_LANDING_PORT || 4173)
const host = '127.0.0.1'

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.dmg': 'application/octet-stream'
}

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

function sendJson(response, status, payload) {
  send(response, status, JSON.stringify(payload), 'application/json; charset=utf-8')
}

function resolvePublicPath(pathname) {
  const relative = pathname === '/' || pathname === '/sign-up' || pathname === '/sign-up/'
    ? 'index.html'
    : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(root, relative)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

async function readBody(request, limit = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handleMockApi(request, response, url) {
  if (url.pathname === '/api/status' && request.method === 'GET') {
    sendJson(response, 200, { success: true, data: { email_verification: true } })
    return true
  }
  if (url.pathname === '/api/verification' && request.method === 'GET') {
    const email = url.searchParams.get('email') || ''
    if (!email.includes('@')) {
      sendJson(response, 200, { success: false, message: '请输入邮箱地址和验证码' })
      return true
    }
    sendJson(response, 200, { success: true, message: '验证码已发送（本地预览不会真发邮件）' })
    return true
  }
  if (url.pathname === '/api/user/register' && request.method === 'POST') {
    const raw = await readBody(request)
    const body = raw ? JSON.parse(raw) : {}
    if (body.username === 'taken') {
      sendJson(response, 200, { success: false, message: 'Username already exists' })
      return true
    }
    sendJson(response, 200, { success: true })
    return true
  }
  return false
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`)
    if (await handleMockApi(request, response, url)) return
    const filePath = resolvePublicPath(url.pathname)
    if (!filePath) {
      send(response, 404, 'Not found')
      return
    }
    const body = await readFile(filePath)
    send(response, 200, body, mimeTypes[path.extname(filePath)] || 'application/octet-stream')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      send(response, 404, 'Not found')
      return
    }
    send(response, 500, 'Internal error')
  }
})

server.listen(port, host, () => {
  process.stdout.write(`dl-landing preview  http://${host}:${port}/sign-up?aff=6B4j\n`)
})
