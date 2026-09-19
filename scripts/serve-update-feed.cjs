const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { validateLocalRelease } = require('./update-release-utils.cjs')

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const contentTypes = new Map([
  ['.yml', 'application/yaml; charset=utf-8'],
  ['.yaml', 'application/yaml; charset=utf-8'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.blockmap', 'application/octet-stream'],
])

function isInsideDirectory(directory, target) {
  if (target === directory) return true
  const relative = path.relative(directory, target)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' &&
    !path.isAbsolute(relative)
}

/** P-33. path.relative only answers what the name looks like, and the release
 * directory is a place a developer drops symlinks into. A link inside it
 * passes the name check and then resolves anywhere at open() time, so the
 * containment question has to be asked a second time about the path the
 * kernel will actually serve. Both directories are compared after resolution
 * so a symlinked release directory still serves its own contents. */
async function resolveServableFile(root, realRoot, requestPath, realpath = fs.promises.realpath) {
  const target = path.resolve(root, requestPath || 'latest.yml')
  if (!isInsideDirectory(root, target)) return null
  const realTarget = await realpath(target)
  return isInsideDirectory(realRoot, realTarget) ? realTarget : null
}

async function main() {
  const root = path.resolve(argumentValue('--directory', 'release'))
  const port = Number(argumentValue('--port', '8123'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port 必须是 1-65535 之间的整数')
  }
  const result = await validateLocalRelease(root)
  const realRoot = await fs.promises.realpath(root)

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
      const decodedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
      const target = await resolveServableFile(root, realRoot, decodedPath)
      if (target === null) {
        response.writeHead(403).end('Forbidden')
        return
      }
      const stat = await fs.promises.stat(target)
      if (!stat.isFile()) {
        response.writeHead(404).end('Not Found')
        return
      }
      response.setHeader('Content-Type', contentTypes.get(path.extname(target).toLowerCase()) || 'application/octet-stream')
      response.setHeader('Content-Length', stat.size)
      response.setHeader('Cache-Control', 'no-store')
      if (request.method === 'HEAD') {
        response.writeHead(200).end()
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed')
        return
      }
      fs.createReadStream(target)
        .on('error', () => response.destroy())
        .pipe(response)
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 400
      response.writeHead(status).end(status === 404 ? 'Not Found' : 'Bad Request')
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`开发更新源已启动：http://127.0.0.1:${port}/`)
    console.log(`版本：${result.metadata.version}；目录：${root}`)
  })
  const close = () => server.close(() => process.exit(0))
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`开发更新源启动失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { isInsideDirectory, resolveServableFile }
