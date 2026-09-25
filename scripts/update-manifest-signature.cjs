#!/usr/bin/env node
// 给 Windows 更新清单 latest.yml 加发布者签名（Ed25519），给 publish-release 与
// rollback-release 两个工作流调用：
//
//   sign --manifest <latest.yml>
//     用环境变量 XINGMANG_UPDATE_SIGNING_KEY（Ed25519 私钥，PKCS8 DER 的 base64）给
//     files[] 里每一项加上 xingmangSignature 字段，原地写回。签之前先确认这把私钥
//     对应的公钥就在客户端内置的名单里（electron/update-package-signature.ts）——
//     secret 里放错一把钥匙，签出来的包每一台新客户端都会拒装，这一步就是挡它的。
//
//   verify --manifest <latest.yml>
//     用客户端内置的公钥逐项验签，任何一项不过都失败。
//
//   rollback --manifest <备份的 latest.yml> --release-dir <目录>
//     回退用。备份已经带签名的：验签即可。备份是加签名之前发的老版本、一项签名都
//     没有的：必须和 GitHub Release 上同版本的安装包逐项对上 SHA-512 才补签——
//     备份清单和 R2 上的安装包在同一个桶里，拿到上传密钥的人两个都能换；GitHub
//     Release 不在那个桶里，是独立的第二个来源。对不上就失败，绝不替桶里的东西背书。
//
// 为什么只签 Windows：macOS 的更新包由 Squirrel.Mac 按已装应用的指定要求验苹果代码
// 签名，指定要求钉着我们发布证书的指纹，那张证书的私钥同样只在 release 环境里。再加
// 一道 Ed25519 挡的是同一件事，却多了一种把 Mac 更新弄坏的方式。
//
// 签的内容与 electron/update-package-signature.ts 的 buildUpdateSignaturePayload
// 必须逐字一致，两边由 electron/update-package-signature.test.ts 钉在一起。
const fs = require('node:fs')
const path = require('node:path')
const { createHash, createPrivateKey, createPublicKey, sign, verify } = require('node:crypto')
const YAML = require('yaml')
const { parseLatestMetadata } = require('./update-release-utils.cjs')

const SIGNATURE_FIELD = 'xingmangSignature'
const PAYLOAD_HEADER = 'xingmang-update-signature/v1'
const KEY_SOURCE = path.join(__dirname, '..', 'electron', 'update-package-signature.ts')
const KEY_ENV = 'XINGMANG_UPDATE_SIGNING_KEY'

class UpdateSignatureError extends Error {}

function buildPayload(version, url, sha512) {
  for (const field of [version, url, sha512]) {
    if (typeof field !== 'string' || !field.trim() || /[\r\n\0]/.test(field)) {
      throw new UpdateSignatureError('更新清单里的版本号、文件地址或 SHA-512 不能签名')
    }
  }
  return `${PAYLOAD_HEADER}\nversion=${version.trim()}\nurl=${url.trim()}\nsha512=${sha512.trim()}\n`
}

/** 从客户端源码里读出内置公钥名单，两个标记之间一行一把。 */
function readPinnedPublicKeys(sourceText = fs.readFileSync(KEY_SOURCE, 'utf8')) {
  const match = sourceText.match(/\/\/ update-signing-keys:begin\r?\n([\s\S]*?)\/\/ update-signing-keys:end/)
  if (!match) throw new UpdateSignatureError('electron/update-package-signature.ts 里找不到公钥名单的起止标记')
  return [...match[1].matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((item) => item[1])
}

function publicKeyObject(encoded) {
  const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new UpdateSignatureError('内置公钥不是 Ed25519')
  return key
}

function exportPublicKey(key) {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
}

function loadSigningKey(encoded) {
  const text = String(encoded ?? '').trim()
  if (!text) throw new UpdateSignatureError(`release 环境缺少 secret：${KEY_ENV}（见 docs/RELEASING.md「更新包签名」）`)
  let key
  try {
    key = createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' })
  } catch {
    throw new UpdateSignatureError(`${KEY_ENV} 不是有效的私钥，请照 docs/RELEASING.md「更新包签名」重新粘贴`)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new UpdateSignatureError(`${KEY_ENV} 不是 Ed25519 私钥`)
  return key
}

function readDocument(text) {
  // parseLatestMetadata 做完整的结构校验；这里另外拿一份可改写的文档，改完其余内容
  // 原样保留，electron-updater 读到的除了多出的签名字段之外一个字节都不变。
  const metadata = parseLatestMetadata(text, 'latest.yml')
  const document = YAML.parseDocument(text, { uniqueKeys: true })
  if (document.errors.length > 0) throw new UpdateSignatureError('latest.yml 不是有效的 YAML')
  const files = document.get('files')
  if (!YAML.isSeq(files) || files.items.length !== metadata.files.length) {
    throw new UpdateSignatureError('latest.yml 的 files 结构不对')
  }
  return { metadata, document, items: files.items }
}

function entrySignature(item) {
  const value = item.get(SIGNATURE_FIELD)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function signManifestText(text, privateKey, pinnedKeys) {
  const derived = exportPublicKey(privateKey)
  if (!pinnedKeys.includes(derived)) {
    throw new UpdateSignatureError(`${KEY_ENV} 对应的公钥不在客户端内置名单里，签出来的包客户端会拒装。公钥是：${derived}`)
  }
  const { metadata, document, items } = readDocument(text)
  items.forEach((item, index) => {
    const file = metadata.files[index]
    const payload = buildPayload(metadata.version, file.rawUrl, file.sha512)
    item.set(SIGNATURE_FIELD, sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'))
  })
  const signed = document.toString()
  verifyManifestText(signed, pinnedKeys)
  return signed
}

/** 逐项验签；返回验过的项数。有一项没签或签错就抛错。 */
function verifyManifestText(text, pinnedKeys) {
  if (pinnedKeys.length === 0) throw new UpdateSignatureError('客户端里还没有内置任何更新签名公钥')
  const keys = pinnedKeys.map(publicKeyObject)
  const { metadata, items } = readDocument(text)
  items.forEach((item, index) => {
    const file = metadata.files[index]
    const signature = entrySignature(item)
    if (!signature) throw new UpdateSignatureError(`latest.yml 的 ${file.relativePath} 没有发布者签名`)
    const bytes = Buffer.from(signature, 'base64')
    const data = Buffer.from(buildPayload(metadata.version, file.rawUrl, file.sha512), 'utf8')
    if (bytes.length !== 64 || !keys.some((key) => verify(null, data, key, bytes))) {
      throw new UpdateSignatureError(`latest.yml 的 ${file.relativePath} 签名校验不通过`)
    }
  })
  return items.length
}

function sha512Base64(file) {
  return createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

/**
 * 回退时处理备份清单。返回 { text, action }：action 为 'verified'（本来就带签名）、
 * 'signed'（老版本，对过 GitHub Release 后补签）或 'unsigned'（老版本，GitHub Release
 * 上找不到同名安装包，原样退回，missing 是缺的文件名）。对不上、只签了一部分、签名
 * 不对都直接失败：那是备份被动过的迹象。
 */
function prepareRollbackText(text, { releaseDir, privateKey, pinnedKeys }) {
  const { metadata, items } = readDocument(text)
  const signedCount = items.filter((item) => entrySignature(item) !== null).length
  if (signedCount === items.length) {
    verifyManifestText(text, pinnedKeys)
    return { text, action: 'verified' }
  }
  if (signedCount > 0) throw new UpdateSignatureError('备份的 latest.yml 只有一部分文件带签名，可能被改过，不能用来回退')
  for (const file of metadata.files) {
    const name = path.basename(file.relativePath)
    const local = path.join(releaseDir, name)
    if (!fs.existsSync(local)) {
      // 拿不到第二个来源就不补签，但回退照做：老客户端照样能退回去，只有认签名的
      // 新客户端会停在被撤回的版本上并看到「这个版本有已知问题」。为这个把整次回退
      // 卡住，等于让所有人都退不回去。
      return { text, action: 'unsigned', missing: name }
    }
    if (sha512Base64(local) !== file.sha512) {
      throw new UpdateSignatureError(`${name} 和 GitHub Release 上同名文件的 SHA-512 不一致，备份可能被换过，不能补签`)
    }
  }
  return { text: signManifestText(text, privateKey, pinnedKeys), action: 'signed' }
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    if (!flag.startsWith('--') || rest[index + 1] === undefined) throw new UpdateSignatureError(`参数不对：${flag}`)
    options[flag.slice(2)] = rest[index + 1]
  }
  return { command, options }
}

function main(argv, env = process.env) {
  const { command, options } = parseArguments(argv)
  if (!options.manifest) throw new UpdateSignatureError('用法：update-manifest-signature.cjs sign|verify|rollback --manifest <latest.yml> [--release-dir <目录>]')
  const text = fs.readFileSync(options.manifest, 'utf8')
  const pinnedKeys = readPinnedPublicKeys()
  if (command === 'sign') {
    fs.writeFileSync(options.manifest, signManifestText(text, loadSigningKey(env[KEY_ENV]), pinnedKeys))
    console.log(`已给 ${options.manifest} 签名`)
    return
  }
  if (command === 'verify') {
    console.log(`${options.manifest}：${verifyManifestText(text, pinnedKeys)} 个文件签名校验通过`)
    return
  }
  if (command === 'rollback') {
    if (!options['release-dir']) throw new UpdateSignatureError('rollback 需要 --release-dir')
    const result = prepareRollbackText(text, {
      releaseDir: options['release-dir'],
      privateKey: loadSigningKey(env[KEY_ENV]),
      pinnedKeys,
    })
    fs.writeFileSync(options.manifest, result.text)
    if (result.action === 'unsigned') {
      console.log(`::warning::GitHub Release 上找不到 ${result.missing}，这份老版本备份没法补签，原样退回。0.2.11 起的客户端只装带签名的包，它们会停在被撤回的版本上，并看到「这个版本有已知问题」`)
      return
    }
    console.log(result.action === 'signed' ? '老版本备份已核对 GitHub Release 并补签' : '备份本来就带签名，校验通过')
    return
  }
  throw new UpdateSignatureError(`不认识的命令：${command}`)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = {
  SIGNATURE_FIELD,
  UpdateSignatureError,
  buildPayload,
  exportPublicKey,
  loadSigningKey,
  prepareRollbackText,
  readPinnedPublicKeys,
  signManifestText,
  verifyManifestText,
}
