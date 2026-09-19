const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const root = path.resolve(__dirname, '..')
const workflowPath = path.join(root, '.github', 'workflows', 'publish-release.yml')
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = YAML.parse(source)
const buildJob = workflow.jobs['windows-build']
const publishJob = workflow.jobs.publish

function stepIndex(job, pattern) {
  return job.steps.findIndex((step) => pattern.test(`${step.name || ''}\n${step.run || ''}`))
}

test('the manifest is published last, after the installer is proven downloadable', () => {
  // latest.yml 是客户端用来判断「有没有新版本」的清单。它先落地，用户就会在安装包
  // 还没传完时被告知有新版本，点下载拿到 404。所以这三步的先后是发布正确性的一部分，
  // 不是风格问题：先传安装包与 blockmap，确认它们能从客户会用的地址下载且字节一致，
  // 最后才覆盖清单。
  const payload = stepIndex(publishJob, /Upload the installer and its blockmap/)
  const verify = stepIndex(publishJob, /Verify the uploaded files are downloadable/)
  const manifest = stepIndex(publishJob, /Publish the update manifest/)
  const feed = stepIndex(publishJob, /update:verify-feed/)
  assert.ok(payload >= 0 && verify > payload, '下载校验必须排在安装包上传之后')
  assert.ok(manifest > verify, '清单必须排在下载校验之后')
  assert.ok(feed > manifest, '端到端复核必须排在清单发布之后')

  // 清单只能由那一步动。别的步骤顺手 cp 一次 latest.yml，上面那道顺序就形同虚设。
  const touchingManifest = publishJob.steps.filter((step) => /aws s3 cp\s+\S*latest\.yml/.test(String(step.run || '')))
  assert.equal(touchingManifest.length, 1)
  assert.match(String(touchingManifest[0].name), /Publish the update manifest/)
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

test('the build job holds no credentials at all', () => {
  // 出包不需要任何 secret。把凭据集中在一个作业里，「谁能读到证书和 R2 密钥」
  // 这个问题就只有一个答案。
  assert.equal(buildJob.environment, undefined)
  assert.equal(buildJob.permissions, undefined)
  assert.doesNotMatch(YAML.stringify(buildJob), /secrets\./)
})

test('no dispatch input, secret or step output is substituted into a shell script', () => {
  // P-26：run 块里的 ${{ ... }} 是在 shell 解析之前做的文本替换。取值里的一个单引号
  // 就能闭合字符串并执行后面的内容 —— 在这条工作流里，那是持有发布凭据的那台机器。
  for (const job of [buildJob, publishJob]) {
    for (const step of job.steps) {
      const script = String(step.run || '')
      if (!script) continue
      assert.doesNotMatch(script, /\$\{\{/, `${step.name || step.uses}：把取值绑进 env: 再读`)
    }
  }
})

test('the secrets are only ever bound, never echoed', () => {
  // 一次 echo 就把凭据写进了任何有仓库读权限的人都能看的运行日志里。
  for (const step of publishJob.steps) {
    const script = String(step.run || '')
    assert.doesNotMatch(script, /echo\s+"?\$(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|R2_ACCOUNT_ID)/, step.name)
  }
})

test('every third-party action is pinned to a full commit id', () => {
  for (const step of [...buildJob.steps, ...publishJob.steps]) {
    if (!step.uses) continue
    assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} 必须钉到完整提交号`)
  }
})

test('the build goes through the same release gate as a local release, with the lines carried', () => {
  const build = buildJob.steps.find((step) => /release:build/.test(String(step.run || '')))
  assert.equal(String(build.run).trim(), 'npm run release:build:unsigned')
  assert.equal(build.env.XINGMANG_ACCELERATION_BUNDLE_DIR, '${{ runner.temp }}\\acceleration-win32-x64')
  const prepare = buildJob.steps.filter((step) => /prepare-acceleration-bundle\.cjs/.test(String(step.run || '')))
  assert.equal(prepare.length, 1)
})

test('the requested version must match package.json before anything is built', () => {
  // 误发一个版本号的代价是线上 latest.yml 指向一个不存在或不该发的产物。
  const confirm = stepIndex(buildJob, /Confirm the requested version/)
  const build = stepIndex(buildJob, /release:build/)
  assert.ok(confirm >= 0 && confirm < build)
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm_version.required, true)
})

test('two publishes cannot run at once', () => {
  // 同版本两套不同哈希的产物，而 latest.yml 里只能有一份 SHA-512。
  assert.equal(workflow.concurrency.group, 'publish-release')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})
