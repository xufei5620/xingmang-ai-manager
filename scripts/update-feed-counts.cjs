#!/usr/bin/env node
// 每天打卡的台数（update-feed-stats 工作流 Summary 页「每天打卡」里的「每天多少台」）怎么加密、怎么解开。
//
// 仓库公开，运行页谁都能看，台数等于告诉别人星芒有多少客户（docs/SERVICE-STATUS.md「看各版本有多少人在用」）。
// 2026-11-21 服务端核对装机量时要每天的准台数：工作流拿仓库里的公钥
// （scripts/update-feed-counts.pub.pem）把台数那一段加密后才写进运行页，只有拿着私钥的人解得开。
// 私钥不在仓库里。
//
// 解开：node scripts/update-feed-counts.cjs <存下来的运行页或日志> <私钥文件>
// 文件里有几段密文就解开几段，按出现的先后打出来。
//
// The token is RSA-OAEP(SHA-256) wrapping a fresh AES-256-GCM key, over the
// deflated report text. GCM authenticates every byte, so a token anyone edited
// on its way (or pasted from a forged run page) fails to open instead of
// printing numbers that were never counted.
const crypto = require('node:crypto')
const fs = require('node:fs')
const zlib = require('node:zlib')

const TOKEN_PREFIX = 'XMC1'
const TOKEN_PATTERN = /XMC1\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})/g
const MIN_MODULUS_BITS = 3072
const MAX_PLAIN_BYTES = 256 * 1024
// 运行页存成文件、或者整份作业日志，都远小于这个数。
const MAX_INPUT_BYTES = 16 * 1024 * 1024
const MAX_KEY_BYTES = 16 * 1024

class CountsSealError extends Error {}

function rsaKey(key, type) {
  if (key.asymmetricKeyType !== 'rsa' || key.type !== type) throw new CountsSealError(type === 'public' ? '台数加密用的公钥不是 RSA 公钥' : '钥匙文件不是 RSA 私钥')
  const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength
  if (!Number.isSafeInteger(bits) || bits < MIN_MODULUS_BITS) throw new CountsSealError(`台数加密用的 RSA 钥匙至少要 ${MIN_MODULUS_BITS} 位`)
  return key
}

function readPublicKey(pem) {
  let key
  try {
    key = crypto.createPublicKey(pem)
  } catch {
    throw new CountsSealError('台数加密用的公钥读不出来')
  }
  return rsaKey(key, 'public')
}

function readPrivateKey(pem) {
  let key
  try {
    key = crypto.createPrivateKey(pem)
  } catch {
    throw new CountsSealError('钥匙文件读不出来，要的是 PEM 格式的私钥')
  }
  return rsaKey(key, 'private')
}

function oaep(key) {
  return { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }
}

/** 把一段文字加密成一行密文。每次都换一把新的内容钥匙，同样的台数两次加密出来也不一样。 */
function sealText(text, publicKeyPem) {
  const publicKey = readPublicKey(publicKeyPem)
  const plain = Buffer.from(String(text), 'utf8')
  if (plain.byteLength > MAX_PLAIN_BYTES) throw new CountsSealError('要加密的台数太长')
  const contentKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv)
  cipher.setAAD(Buffer.from(TOKEN_PREFIX))
  const body = Buffer.concat([cipher.update(zlib.deflateRawSync(plain)), cipher.final()])
  const wrapped = crypto.publicEncrypt(oaep(publicKey), contentKey)
  return [TOKEN_PREFIX, ...[wrapped, iv, cipher.getAuthTag(), body].map((part) => part.toString('base64'))].join('.')
}

/** 从一段文字里找出全部密文并解开，按出现的先后返回。一段都没有就是空数组。 */
function openSealedTexts(text, privateKeyPem) {
  const privateKey = readPrivateKey(privateKeyPem)
  const opened = []
  for (const match of String(text).matchAll(TOKEN_PATTERN)) {
    const [wrapped, iv, tag, body] = match.slice(1).map((part) => Buffer.from(part, 'base64'))
    let plain
    try {
      const contentKey = crypto.privateDecrypt(oaep(privateKey), wrapped)
      const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey, iv)
      decipher.setAAD(Buffer.from(TOKEN_PREFIX))
      decipher.setAuthTag(tag)
      plain = zlib.inflateRawSync(Buffer.concat([decipher.update(body), decipher.final()]), { maxOutputLength: MAX_PLAIN_BYTES })
    } catch {
      throw new CountsSealError('有一段密文解不开：钥匙不是这一把，或者密文复制时缺了一截、被改过')
    }
    opened.push(plain.toString('utf8'))
  }
  return opened
}

function readBoundedFile(file, limit, label) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new CountsSealError(`找不到${label}：${file}`)
  }
  if (!stat.isFile()) throw new CountsSealError(`${label}不是一个文件：${file}`)
  if (stat.size > limit) throw new CountsSealError(`${label}太大了：${file}`)
  return fs.readFileSync(file, 'utf8')
}

function main(argv) {
  if (argv.length !== 2) throw new CountsSealError('用法：node scripts/update-feed-counts.cjs <存下来的运行页或日志> <私钥文件>')
  const input = readBoundedFile(argv[0], MAX_INPUT_BYTES, '运行页或日志文件')
  const privateKeyPem = readBoundedFile(argv[1], MAX_KEY_BYTES, '钥匙文件')
  const opened = openSealedTexts(input, privateKeyPem)
  if (!opened.length) throw new CountsSealError('这个文件里没有台数的密文（找的是 XMC1. 开头的一长串）')
  return opened.join('\n\n---\n\n')
}

if (require.main === module) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`)
  } catch (error) {
    console.error(error instanceof CountsSealError ? error.message : '解开失败（脚本自身出错）')
    if (!(error instanceof CountsSealError)) console.error(error)
    process.exit(1)
  }
}

module.exports = {
  CountsSealError,
  openSealedTexts,
  readPublicKey,
  sealText,
}
