// 测试用：拿一把自己生成的发布者钥匙，在临时目录里真跑写状态文件的脚本和工作流步骤（D85）。
//
// 脚本从 electron/update-package-signature.ts 的源码里读客户端内置的公钥（readPinnedPublicKeys），那是发版那把，
// 测试手里没有它的私钥。所以临时目录里放一个指回仓库 scripts/ 的链接，旁边放一份只钉着测试公钥的
// electron/update-package-signature.ts，再让 node 带上 --preserve-symlinks：脚本的 __dirname 停在临时目录里，
// 读到的就是测试那份。仓库里的文件一个都不改。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { generateKeyPairSync } = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const PRESERVE_SYMLINKS = ['--preserve-symlinks', '--preserve-symlinks-main']

function createTestSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    // 工作流里 XINGMANG_UPDATE_SIGNING_KEY 的写法：PKCS8 DER 的 base64。
    privateKeyText: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

/** 建好临时目录：scripts、node_modules 指回仓库，electron/update-package-signature.ts 只钉 pinnedKeys。 */
function createPinnedWorkspace(prefix, pinnedKeys) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(workspace, 'scripts'))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(workspace, 'node_modules'))
  fs.mkdirSync(path.join(workspace, 'electron'))
  const lines = pinnedKeys.map((key) => `  '${key}',`).join('\n')
  fs.writeFileSync(
    path.join(workspace, 'electron', 'update-package-signature.ts'),
    `// update-signing-keys:begin\nexport const updateSigningPublicKeys: readonly string[] = [\n${lines}\n]\n// update-signing-keys:end\n`,
  )
  return workspace
}

module.exports = { PRESERVE_SYMLINKS, createPinnedWorkspace, createTestSigner }
