// 临时探测：放好的那份跟 Claude 官网的 claude.exe.zst 解开后逐字节比，标记文件内容也打出来。
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex') }

async function main() {
  const profile = process.argv[2]
  const pin = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'pin.json'), 'utf8'))
  const dir = path.join(profile, 'claude-code', pin.version, pin.checksum.slice(0, 12))
  console.log('placed dir listing', fs.readdirSync(dir))
  const placed = fs.readFileSync(path.join(dir, 'claude.exe'))
  console.log('.verified', JSON.stringify(fs.readFileSync(path.join(dir, '.verified'), 'utf8')))
  console.log('.payload', JSON.stringify(fs.readFileSync(path.join(dir, '.payload'), 'utf8')))
  const url = `https://downloads.claude.ai/claude-code-releases/${pin.version}/win32-x64/${pin.binary}`
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`official ${response.status} ${url}`)
  const compressed = Buffer.from(await response.arrayBuffer())
  const official = pin.binary.endsWith('.zst') ? zlib.zstdDecompressSync(compressed) : compressed
  console.log('official file', url, 'size', compressed.length, 'sha256', sha256(compressed), 'pin checksum', pin.checksum, 'pin size', pin.size)
  console.log('placed  claude.exe size', placed.length, 'sha256', sha256(placed))
  console.log('official claude.exe size', official.length, 'sha256', sha256(official))
  console.log('identical', Buffer.compare(placed, official) === 0, 'official matches pin', sha256(compressed) === pin.checksum)
  if (Buffer.compare(placed, official) !== 0 || sha256(compressed) !== pin.checksum) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
