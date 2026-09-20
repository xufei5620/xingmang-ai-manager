const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const root = path.resolve(__dirname, '..')
const workflowPath = path.join(root, '.github', 'workflows', 'publish-release.yml')
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = YAML.parse(source)
const windowsJob = workflow.jobs['windows-build']
const macosJob = workflow.jobs['macos-build']
const publishJob = workflow.jobs.publish
const buildJobs = [windowsJob, macosJob]

// 产品所有者 2026-09-20 已经按这八个名字在 release 环境里建 secret 了。工作流读的
// 名字与他建的名字必须字字相同，否则表现是一条看不出原因的 403 或一个空取值。
const RELEASE_SECRET_NAMES = [
  'CSC_NAME',
  'R2_ACCESS_KEY_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_SECRET_ACCESS_KEY',
  'XINGMANG_MAC_SIGNING_P12_BASE64',
  'XINGMANG_MAC_SIGNING_P12_PASSWORD',
  'XINGMANG_MAC_SIGNING_SHA256',
]

function stepIndex(job, pattern) {
  return job.steps.findIndex((step) => pattern.test(`${step.name || ''}\n${step.run || ''}`))
}

function referencedSecretNames() {
  const names = new Set()
  for (const match of source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) names.add(match[1])
  return [...names].sort()
}

test('the manifests are published last, after the installers are proven downloadable', () => {
  // latest.yml 是客户端用来判断「有没有新版本」的清单。它先落地，用户就会在安装包
  // 还没传完时被告知有新版本，点下载拿到 404。所以这三步的先后是发布正确性的一部分，
  // 不是风格问题：先传安装包与 blockmap，确认它们能从客户会用的地址下载且字节一致，
  // 最后才覆盖清单。
  const payload = stepIndex(publishJob, /Upload the installers and their blockmaps/)
  const verify = stepIndex(publishJob, /Verify the uploaded files are downloadable/)
  const manifest = stepIndex(publishJob, /Publish the update manifests/)
  const feed = stepIndex(publishJob, /update:verify-feed/)
  assert.ok(payload >= 0 && verify > payload, '下载校验必须排在安装包上传之后')
  assert.ok(manifest > verify, '清单必须排在下载校验之后')
  assert.ok(feed > manifest, '端到端复核必须排在清单发布之后')

  // 清单只能由那一步动。别的步骤顺手 cp 一次 latest.yml，上面那道顺序就形同虚设。
  // 两个平台各有一份清单，两份都受这条约束。
  const touchingManifest = publishJob.steps.filter((step) => {
    const script = String(step.run || '')
    return /aws s3 cp/.test(script) && /latest(?:-mac)?\.yml/.test(script)
  })
  assert.equal(touchingManifest.length, 1)
  assert.match(String(touchingManifest[0].name), /Publish the update manifests/)
  assert.match(String(touchingManifest[0].run), /latest\.yml latest-mac\.yml/)
})

test('both platforms get their published feed re-verified end to end', () => {
  // 只复核 Windows 那一半的话，一次传坏的 latest-mac.yml 要等客户点更新才暴露。
  const feeds = publishJob.steps.filter((step) => /update:verify-feed/.test(String(step.run || '')))
  assert.deepEqual(
    feeds.map((step) => String(step.run).trim()),
    ['npm run update:verify-feed -- --platform=windows', 'npm run update:verify-feed -- --platform=macos'],
  )
})

test('uploading is gated on the release environment, which is where the owner approves', () => {
  // RELEASING.md 要求「上传文件、修改 R2 或切换线上 latest.yml 必须获得产品所有者
  // 针对当前版本的明确发布授权」。这条工作流把那道授权实现为 release 环境的
  // required reviewers：批准的就是这一次运行、这一个版本。少了这一行，凭据会对
  // 任意分支可见，而 workflow_dispatch 允许指定任意 ref。
  assert.equal(publishJob.environment, 'release')
  assert.equal(publishJob.permissions.contents, 'write')
  assert.equal(workflow.permissions.contents, 'read')
  assert.deepEqual(Object.keys(workflow.permissions), ['contents'])
})

test('the workflow reads exactly the secrets the owner was told to create', () => {
  assert.deepEqual(referencedSecretNames(), RELEASE_SECRET_NAMES)
})

test('the Windows build job holds no credentials at all', () => {
  // Windows 那一份是无签名发布，出包不需要任何 secret。少一个作业能读到凭据，
  // 「谁能读到证书和 R2 密钥」这个问题就少一个答案。
  assert.equal(windowsJob.environment, undefined)
  assert.equal(windowsJob.permissions, undefined)
  assert.doesNotMatch(YAML.stringify(windowsJob), /secrets\./)
})

test('the macOS build job reads the signing identity and nothing else', () => {
  // 它必须读 .p12，所以也挂 release 环境、也停下来等一次批准；但 R2 凭据与它无关。
  assert.equal(macosJob.environment, 'release')
  assert.equal(macosJob.permissions, undefined)
  const macosSecrets = new Set(
    [...YAML.stringify(macosJob).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]),
  )
  assert.deepEqual([...macosSecrets].sort(), [
    'CSC_NAME',
    'XINGMANG_MAC_SIGNING_P12_BASE64',
    'XINGMANG_MAC_SIGNING_P12_PASSWORD',
    'XINGMANG_MAC_SIGNING_SHA256',
  ])
})

test('the macOS signing keychain is always torn down, even when the build fails', () => {
  // 用户 keychain 搜索列表是全局状态，私钥落在 runner 磁盘上。构建失败或作业取消
  // 时跳过撤销，等于把签名私钥留给这台 runner 上后续的一切。
  const importIndex = stepIndex(macosJob, /macos-release-keychain\.cjs --import/)
  const buildIndex = stepIndex(macosJob, /dist:mac:free/)
  const releaseIndex = stepIndex(macosJob, /macos-release-keychain\.cjs --release/)
  assert.ok(importIndex >= 0 && importIndex < buildIndex, '导入必须排在构建之前')
  assert.ok(releaseIndex > buildIndex, '撤销必须排在构建之后')
  assert.equal(macosJob.steps[releaseIndex].if, '${{ always() }}')
})

test('the macOS packages are signed with the published identity, never an ephemeral one', () => {
  // 一次性身份签出来的包进了更新源，老用户的机器不认它会拒绝更新，新装用户拿到的
  // 又是一个没人认得的发布者。package-for-testing 才是那条路径。
  const build = macosJob.steps.find((step) => /dist:mac:free/.test(String(step.run || '')))
  assert.doesNotMatch(String(build.run), /--ci-temporary-signing/)
  assert.match(String(build.run), /--acceleration-arm64/)
  assert.match(String(build.run), /--acceleration-x64/)
})

test('no dispatch input, secret or step output is substituted into a shell script', () => {
  // P-26：run 块里的 ${{ ... }} 是在 shell 解析之前做的文本替换。取值里的一个单引号
  // 就能闭合字符串并执行后面的内容 —— 在这条工作流里，那是持有发布凭据的那台机器。
  for (const job of [...buildJobs, publishJob]) {
    for (const step of job.steps) {
      const script = String(step.run || '')
      if (!script) continue
      assert.doesNotMatch(script, /\$\{\{/, `${step.name || step.uses}：把取值绑进 env: 再读`)
    }
  }
})

test('the secrets are only ever bound, never echoed', () => {
  // 一次 echo 就把凭据写进了任何有仓库读权限的人都能看的运行日志里。
  for (const job of [macosJob, publishJob]) {
    for (const step of job.steps) {
      const script = String(step.run || '')
      assert.doesNotMatch(
        script,
        /echo\s+"?\$(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|R2_ACCOUNT_ID|XINGMANG_MAC_SIGNING_P12_BASE64|XINGMANG_MAC_SIGNING_P12_PASSWORD)/,
        step.name,
      )
    }
  }
})

test('every third-party action is pinned to a full commit id', () => {
  for (const step of [...windowsJob.steps, ...macosJob.steps, ...publishJob.steps]) {
    if (!step.uses) continue
    assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} 必须钉到完整提交号`)
  }
})

test('the build goes through the same release gate as a local release, with the lines carried', () => {
  const build = windowsJob.steps.find((step) => /release:build/.test(String(step.run || '')))
  assert.equal(String(build.run).trim(), 'npm run release:build:unsigned')
  assert.equal(build.env.XINGMANG_ACCELERATION_BUNDLE_DIR, '${{ runner.temp }}\\acceleration-win32-x64')
  const windowsPrepare = windowsJob.steps.filter((step) => /prepare-acceleration-bundle\.cjs/.test(String(step.run || '')))
  assert.equal(windowsPrepare.length, 1)
  // Mac 两个架构各要一份：资源清单里记着架构，内核也是按架构的 Mach-O。
  const macosPrepare = macosJob.steps.find((step) => /prepare-acceleration-bundle\.cjs/.test(String(step.run || '')))
  assert.match(String(macosPrepare.run), /--target darwin-arm64/)
  assert.match(String(macosPrepare.run), /--target darwin-x64/)
})

test('the requested version must match package.json before anything is built', () => {
  // 误发一个版本号的代价是线上 latest.yml 指向一个不存在或不该发的产物。
  for (const job of buildJobs) {
    const confirm = stepIndex(job, /Confirm the requested version/)
    const build = stepIndex(job, /release:build|dist:mac:free/)
    assert.ok(confirm >= 0 && confirm < build)
  }
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm_version.required, true)
})

test('a single-platform publish does not silently skip the publish job', () => {
  // 被跳过的 needs 默认会把依赖它的作业也跳过，表现是「跑完了但什么都没发」。
  assert.deepEqual(publishJob.needs, ['windows-build', 'macos-build'])
  assert.match(String(publishJob.if), /!cancelled\(\)/)
  assert.match(String(publishJob.if), /windows-build\.result != 'failure'/)
  assert.match(String(publishJob.if), /macos-build\.result != 'failure'/)
  assert.match(String(publishJob.if), /== 'success'/)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options, ['both', 'windows', 'macos'])
})

test('two publishes cannot run at once', () => {
  // 同版本两套不同哈希的产物，而 latest.yml 里只能有一份 SHA-512。
  assert.equal(workflow.concurrency.group, 'publish-release')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})
