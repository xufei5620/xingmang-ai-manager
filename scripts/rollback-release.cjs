#!/usr/bin/env node
// 坏版本回退用到的两件小事，给 publish-release 与 rollback-release 两个工作流调用：
//
//   version --manifest <file> --name latest.yml|latest-mac.yml
//     读出一份更新清单的版本号。发布新版之前，publish-release 用它把线上那份旧清单
//     按版本号备份到 manifests/<版本>/ 下——R2 上的根目录清单一覆盖就没了，没有这份
//     备份，发现坏版本时就没有东西可以退回去。
//
//   inspect --manifest <file> --name … --expect <版本> --live <线上版本>
//     核对一份备份清单确实是要退回的那个版本、而且比线上的旧，然后逐行打印它引用
//     的安装包路径，工作流据此确认这些安装包还在，才去覆盖根目录清单。
//
// 版本号只收 x.y.z：它要拼进对象路径，任何别的写法都不该出现在这里。
const fs = require('node:fs')
const { compareReleaseVersions, parseLatestMetadata } = require('./update-release-utils.cjs')

const MANIFEST_NAMES = new Set(['latest.yml', 'latest-mac.yml'])
const PLAIN_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/

class RollbackInputError extends Error {}

function requirePlainVersion(value, label) {
  const version = String(value ?? '').trim().replace(/^v/i, '')
  if (!PLAIN_VERSION.test(version)) throw new RollbackInputError(`${label}必须写成 0.2.9 这样的版本号：${value}`)
  return version
}

function readManifest(file, name) {
  if (!MANIFEST_NAMES.has(name)) throw new RollbackInputError(`不认识的更新清单：${name}`)
  return parseLatestMetadata(fs.readFileSync(file, 'utf8'), name)
}

function manifestVersion(file, name) {
  return requirePlainVersion(readManifest(file, name).version, `${name} 的版本号`)
}

function inspectBackup(file, name, expected, live) {
  const metadata = readManifest(file, name)
  const target = requirePlainVersion(expected, '要退回的版本')
  const current = requirePlainVersion(live, '线上版本')
  if (requirePlainVersion(metadata.version, `${name} 的版本号`) !== target) {
    throw new RollbackInputError(`备份的 ${name} 写的是 ${metadata.version}，不是要退回的 ${target}`)
  }
  if (compareReleaseVersions(target, current) >= 0) {
    throw new RollbackInputError(`${target} 不比线上的 ${current} 旧，这不是回退；修好的新版本请走正式发布`)
  }
  return metadata.files.map((entry) => entry.encodedPath)
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    if (!flag.startsWith('--') || rest[index + 1] === undefined) throw new RollbackInputError(`参数不对：${flag}`)
    options[flag.slice(2)] = rest[index + 1]
  }
  return { command, options }
}

function main(argv) {
  const { command, options } = parseArguments(argv)
  if (command === 'version') {
    console.log(manifestVersion(options.manifest, options.name))
    return
  }
  if (command === 'inspect') {
    for (const file of inspectBackup(options.manifest, options.name, options.expect, options.live)) console.log(file)
    return
  }
  throw new RollbackInputError('用法：rollback-release.cjs version|inspect --manifest <file> --name <latest.yml|latest-mac.yml> [--expect <版本> --live <版本>]')
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { RollbackInputError, inspectBackup, manifestVersion, requirePlainVersion }
