const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')

const PART_BYTES = 1024 * 1024
const THRESHOLD_BYTES = 16 * 1024 * 1024
const MAX_XML_BYTES = 64 * 1024
const TOTAL_UPLOAD_MS = 75 * 60 * 1000

function readMultipartOptions(env = process.env) {
  const enabled = env.XINGMANG_COS_MULTIPART_ENABLED
  if (enabled !== undefined && !['true', 'false', ''].includes(enabled)) throw new Error('COS 分块上传开关必须为 true 或 false')
  const concurrency = env.XINGMANG_COS_MULTIPART_CONCURRENCY === undefined ? 8 : Number(env.XINGMANG_COS_MULTIPART_CONCURRENCY)
  if (!Number.isInteger(concurrency) || concurrency < 4 || concurrency > 8) throw new Error('COS 分块上传并发数必须为 4 至 8')
  return { enabled: enabled === 'true', concurrency }
}

function decodeXmlText(value) {
  if (/&(?!amp;|quot;|apos;|lt;|gt;)/.test(value)) throw new Error('COS 分块响应包含无效 XML 实体')
  return value.replace(/&(amp|quot|apos|lt|gt);/g, (_, name) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name])
}

function parseMultipartXml(body, root, fields) {
  if (!Buffer.isBuffer(body) || body.length > MAX_XML_BYTES) throw new Error('COS 分块响应超出 XML 限制')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body).trim() } catch { throw new Error('COS 分块响应不是有效 UTF-8') }
  text = text.replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>\s*/i, '')
  const match = new RegExp(`^<${root}>\\s*([\\s\\S]*?)\\s*</${root}>$`).exec(text)
  if (!match) throw new Error('COS 分块响应不是预期的最终 XML')
  const result = {}
  let remaining = match[1]
  while (remaining.trim()) {
    const field = /^\s*<([A-Za-z]+)>([^<]*)<\/\1>\s*/.exec(remaining)
    if (!field || !fields.includes(field[1]) || Object.hasOwn(result, field[1])) throw new Error('COS 分块响应包含重复或无效字段')
    result[field[1]] = decodeXmlText(field[2])
    remaining = remaining.slice(field[0].length)
  }
  if (fields.some(name => !Object.hasOwn(result, name))) throw new Error('COS 分块响应缺少必需字段')
  return result
}

function validateMultipartIdentity(value, bucket, key) {
  if (value.Bucket !== bucket || value.Key !== key) throw new Error('COS 分块响应的存储桶或对象身份不匹配')
}

function assertSourceStat(before, after) {
  if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('分块上传期间源文件发生变化')
}

async function readPart(handle, offset, length) {
  const body = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const result = await handle.read(body, read, length - read, offset + read)
    if (!result.bytesRead) throw new Error('分块上传读取源文件时提前结束')
    read += result.bytesRead
  }
  return body
}

function partDigest(body) {
  return { md5: crypto.createHash('md5').update(body).digest('hex'), sha256: crypto.createHash('sha256').update(body).digest('hex') }
}

function buildCompleteMultipartBody(parts) {
  return Buffer.from(`<CompleteMultipartUpload>${parts.map((part, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${part.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`)
}

async function uploadMultipart({ handle, stat, hash, bucket, key, concurrency, request, failure, onPartCommitted, shouldRetryPart = function () { return false }, monotonicNow = function () { return performance.now() } }) {
  if (!Number.isInteger(concurrency) || concurrency < 4 || concurrency > 8 || hash.bytes !== stat.size ||
      !Number.isSafeInteger(hash.bytes) || hash.bytes < 1 || hash.bytes > 2 * 1024 * 1024 * 1024) throw new Error('COS 分块上传参数无效')
  // Hash the same trusted, open inode used by positional part reads. Part SHA256
  // checks bind every outgoing buffer to this full-file snapshot, independently
  // of MD5 (which is required by the COS UploadPart protocol).
  const parts = []
  const started = monotonicNow()
  function checkDeadline() {
    if (monotonicNow() - started >= TOTAL_UPLOAD_MS) throw new Error('COS 分块上传已超过总时间限制')
  }
  const fullHash = crypto.createHash('sha256')
  for (let offset = 0; offset < hash.bytes; offset += PART_BYTES) {
    checkDeadline()
    const body = await readPart(handle, offset, Math.min(PART_BYTES, hash.bytes - offset))
    fullHash.update(body)
    parts.push({ offset, bytes: body.length, ...partDigest(body) })
  }
  assertSourceStat(stat, await handle.stat())
  if (fullHash.digest('hex') !== hash.sha256) throw new Error('分块上传的完整源文件摘要与预校验不一致')
  let uploadId
  let completeStarted = false
  try {
    const initialized = await request('init', 'POST', { uploads: '' }, Buffer.alloc(0))
    const identity = parseMultipartXml(initialized.body, 'InitiateMultipartUploadResult', ['Bucket', 'Key', 'UploadId'])
    validateMultipartIdentity(identity, bucket, key)
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(identity.UploadId)) throw new Error('COS 分块上传标识无效')
    uploadId = identity.UploadId
    let cursor = 0
    let committedBytes = 0
    let primaryError
    async function worker() {
      while (!primaryError && cursor < parts.length) {
        const index = cursor++
        const part = parts[index]
        try {
          checkDeadline()
          const body = await readPart(handle, part.offset, part.bytes)
          const digest = partDigest(body)
          if (digest.sha256 !== part.sha256) throw new Error('分块上传的源文件内容发生变化')
          let result
          for (let attempt = 0; attempt < 3; attempt += 1) {
            checkDeadline()
            if (primaryError) throw primaryError
            try {
              // COS overwrites the same UploadId/partNumber. Reuse this verified
              // buffer so even a saved part with a lost reply is idempotent.
              result = await request('part', 'PUT', { partNumber: String(index + 1), uploadId }, body)
              break
            } catch (error) {
              if (attempt === 2 || !shouldRetryPart(error)) throw error
            }
          }
          if (result.bytes !== 0 || result.headers.etag !== `"${digest.md5}"`) throw new Error('COS 分块响应 ETag 与实际分块 MD5 不一致')
          part.etag = result.headers.etag
          committedBytes += part.bytes
          try { onPartCommitted?.(committedBytes) } catch {}
        } catch (error) { primaryError ||= error }
      }
    }
    // Every outstanding part settles before abort: late writes must never race
    // an abort for the upload session we own. Complete is never retried.
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    if (primaryError) throw primaryError
    assertSourceStat(stat, await handle.stat())
    checkDeadline()
    const body = buildCompleteMultipartBody(parts)
    completeStarted = true
    const completed = await request('complete', 'POST', { uploadId }, body)
    const value = parseMultipartXml(completed.body, 'CompleteMultipartUploadResult', ['Location', 'Bucket', 'Key', 'ETag'])
    validateMultipartIdentity(value, bucket, key)
    if (!/^"[a-f0-9]{32}(?:-[1-9][0-9]{0,3})?"$/.test(value.ETag)) throw new Error('COS 分块合并响应 ETag 无效')
    // Location is server data (official examples even use HTTP). Never follow
    // it: callers confirm the object with their fixed HTTPS full GET + SHA256.
  } catch (error) {
    let abortError
    if (uploadId && !completeStarted) {
      try { await request('abort', 'DELETE', { uploadId }, Buffer.alloc(0)) } catch (error) { abortError = error }
    }
    throw failure(error, completeStarted ? 'complete-unconfirmed' : 'not-completed', abortError)
  }
}

module.exports = { PART_BYTES, THRESHOLD_BYTES, MAX_XML_BYTES, readMultipartOptions, parseMultipartXml, buildCompleteMultipartBody, uploadMultipart }
