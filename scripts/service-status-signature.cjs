#!/usr/bin/env node
// 给更新目录上的 service-status.json 里撤回名单、分批放量、最低版本这几项加发布者签名（D85，出处是深查
// 「自身更新」Z-4 第 2 条），给写这份文件的三条工作流调用：service-status、rollback-release、
// publish-release（写分批放量那一步）。
//
//   sign --file <状态文件>
//     用环境变量 XINGMANG_UPDATE_SIGNING_KEY（发版给更新清单签名的同一把 Ed25519 私钥）签上，原地写回。
//     签之前先确认这把私钥对应的公钥在客户端内置的名单里（electron/update-package-signature.ts），签完用
//     客户端那几把公钥再验一遍。
//
//   verify --file <状态文件>
//     撤回名单那几项的签名验不过就失败。只用来手动核对线上那份。
//
// 为什么签这几项：状态文件和更新清单放在同一个桶里，拿到桶的上传权限、或者拿下洛杉矶那台转发机的人，不用
// 签名私钥就能把当前版本写进撤回名单、再换上一份真签过名的旧清单，客户端就会「退回」那个旧版本；最低版本写高
// 能把所有客户挡在「必须更新」那道门外，放量写 0 能让修好的版本一直推不出去。别的项只能让客户端少做事、多说
// 一句话，不签：GitHub 用不了的时候还要能在 Cloudflare 后台手改维护提示（docs/SERVICE-STATUS.md「备用」）。
//
// 签的是这几项的值，不是文件的字节：键排好序、不带空白的 JSON（canonicalJson）。手改维护提示时这几项和签名
// 原样留着，签名照样验得过；动了其中任何一项就验不过，0.2.25 起的客户端当这几项没读到。
//
// 签的内容与 electron/service-status.ts 的 buildReleaseGuardPayload 必须逐字一致，两边由各自的测试钉住同一串字，
// electron/service-status.test.ts 还拿这里签出来的文件交给客户端验。
//
// 这个文件只引 node 自带模块和同目录脚本（update-manifest-signature.cjs 的 yaml 用到才加载）：service-status
// 的预览作业不装依赖，也要用它看出线上那份签没签。
const fs = require('node:fs')
const { sign, verify, createPublicKey } = require('node:crypto')
const { UpdateSignatureError, exportPublicKey, loadSigningKey, readPinnedPublicKeys } = require('./update-manifest-signature.cjs')

const SIGNATURE_FIELD = 'releaseGuardSignature'
const PAYLOAD_HEADER = 'xingmang-service-status-guard/v1'
// 跟客户端 releaseGuardFields 一样：撤回名单、只撤哪几种安装包、分批放量、最低版本、最低版本只拦哪几种，
// 再加决定哪份更新的 updatedAt（不签它，旧的那份签过名的文件就能拿来把撤回名单换回去）。
const GUARD_FIELDS = ['badVersions', 'badVersionPlatforms', 'rollout', 'minimumVersion', 'minimumVersionPlatforms', 'updatedAt']
// 跟客户端 maxStatusBytes 一样：超过的整份不读。
const MAX_STATUS_BYTES = 16 * 1024
const KEY_ENV = 'XINGMANG_UPDATE_SIGNING_KEY'

class StatusSignatureError extends Error {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 拼字而不是先拼出对象，文件里有个叫 "__proto__" 的键也只是普通的一个键。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 签的那串字：撤回名单那几项的原样（没写的不带），排好键的 JSON。 */
function buildGuardPayload(status) {
  const fields = {}
  for (const key of GUARD_FIELDS) {
    if (Object.hasOwn(status, key)) fields[key] = status[key]
  }
  return `${PAYLOAD_HEADER}\n${canonicalJson(fields)}\n`
}

function decodeSignature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.trim())) return null
  const bytes = Buffer.from(value.trim(), 'base64')
  return bytes.length === 64 ? bytes : null
}

/**
 * 这份状态文件撤回名单那几项签没签、签得对不对：'signed'、'unsigned'（没有签名）或 'signature'（有签名但
 * 对不上，有人没走工作流改过这几项）。跟客户端 inspectReleaseGuardSignature 同一套判法。
 */
function inspectStatusSignature(status, pinnedKeys) {
  if (!isRecord(status)) throw new StatusSignatureError('状态文件不是 JSON 对象')
  const value = status[SIGNATURE_FIELD]
  if (value === undefined || value === null || value === '') return 'unsigned'
  const signature = decodeSignature(value)
  if (!signature) return 'signature'
  const data = Buffer.from(buildGuardPayload(status), 'utf8')
  const accepted = pinnedKeys.some((encoded) => {
    try {
      const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
      return key.asymmetricKeyType === 'ed25519' && verify(null, data, key, signature)
    } catch {
      return false
    }
  })
  return accepted ? 'signed' : 'signature'
}

/** 签上（原来那个签名先拿掉），签名放在最后一项；签完照客户端的公钥再验一遍。返回新的一份，不改传进来的。 */
function signStatus(status, privateKey, pinnedKeys) {
  if (!isRecord(status)) throw new StatusSignatureError('状态文件不是 JSON 对象，不能签名')
  if (pinnedKeys.length === 0) throw new StatusSignatureError('客户端里还没有内置任何发布者签名公钥')
  const derived = exportPublicKey(privateKey)
  if (!pinnedKeys.includes(derived)) {
    throw new StatusSignatureError(`${KEY_ENV} 对应的公钥不在客户端内置名单里，签出来的撤回名单客户端不认。公钥是：${derived}`)
  }
  const next = { ...status }
  delete next[SIGNATURE_FIELD]
  next[SIGNATURE_FIELD] = sign(null, Buffer.from(buildGuardPayload(next), 'utf8'), privateKey).toString('base64')
  if (inspectStatusSignature(next, pinnedKeys) !== 'signed') throw new StatusSignatureError('签完验不过，没写出去')
  return next
}

/**
 * 批之前给批的人看的一句：线上那份撤回名单那几项没签名或签名对不上时，这次会照原样签上（等于替它们背书）。
 * 线上没有这份文件（null）或签得好好的，返回 null。
 */
function describeLiveSignatureWarning(current, pinnedKeys) {
  if (current === null || current === undefined) return null
  const state = inspectStatusSignature(current, pinnedKeys)
  if (state === 'signed') return null
  if (state === 'unsigned') {
    return '线上这份状态文件的撤回名单、分批放量、最低版本还没有发布者签名（0.2.25 起的客户端只认签过名的这几项）。这次会把它们照上面写的签上，批之前核一眼对不对。第一次签之后还看到这句，说明有人没走这个按钮改过它（比如在 Cloudflare 后台换了整份文件），先 Reject 去查。'
  }
  return '线上这份状态文件的撤回名单、分批放量、最低版本跟发布者签名对不上：有人没走这个按钮改过这几项（比如在 Cloudflare 后台手改），0.2.25 起的客户端现在不认它们。批了就会照上面写的重新签上；不是你改的，先 Reject 去查是谁动了更新目录。'
}

function readStatusFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new StatusSignatureError(`${file} 不是有效的 JSON`)
  }
  if (!isRecord(parsed)) throw new StatusSignatureError(`${file} 不是 JSON 对象`)
  return parsed
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    if (!flag.startsWith('--') || rest[index + 1] === undefined) throw new StatusSignatureError(`参数不对：${flag}`)
    options[flag.slice(2)] = rest[index + 1]
  }
  return { command, options }
}

function main(argv, env = process.env) {
  const { command, options } = parseArguments(argv)
  if (!options.file) throw new StatusSignatureError('用法：service-status-signature.cjs sign|verify --file <状态文件>')
  const status = readStatusFile(options.file)
  const pinnedKeys = readPinnedPublicKeys()
  if (command === 'sign') {
    const signed = signStatus(status, loadSigningKey(env[KEY_ENV]), pinnedKeys)
    const text = `${JSON.stringify(signed, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_STATUS_BYTES) throw new StatusSignatureError('签上以后状态文件超过 16 KB，客户端会拒绝读取')
    fs.writeFileSync(options.file, text)
    console.log('已给撤回名单、分批放量、最低版本签上发布者签名')
    return
  }
  if (command === 'verify') {
    const state = inspectStatusSignature(status, pinnedKeys)
    if (state !== 'signed') {
      throw new StatusSignatureError(state === 'unsigned' ? '撤回名单那几项没有发布者签名' : '撤回名单那几项跟发布者签名对不上')
    }
    console.log('撤回名单、分批放量、最低版本的发布者签名验过了')
    return
  }
  throw new StatusSignatureError(`不认识的命令：${command}`)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const known = error instanceof StatusSignatureError || error instanceof UpdateSignatureError
    console.error(`::error::${known ? error.message : '签状态文件时脚本自身出错，线上什么都没改，看上面的日志'}`)
    if (!known) console.error(error)
    process.exit(1)
  }
}

module.exports = {
  GUARD_FIELDS,
  SIGNATURE_FIELD,
  StatusSignatureError,
  buildGuardPayload,
  canonicalJson,
  describeLiveSignatureWarning,
  inspectStatusSignature,
  main,
  signStatus,
}
