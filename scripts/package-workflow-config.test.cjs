const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const root = path.resolve(__dirname, '..')
const workflowPath = path.join(root, '.github', 'workflows', 'package-for-testing.yml')
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = YAML.parse(source)
const windowsJob = workflow.jobs['windows-package']
const macosJob = workflow.jobs['macos-package']

function allSteps() {
  return [...windowsJob.steps, ...macosJob.steps]
}

test('the test-package build reads no secrets at all', () => {
  // P-06 的另一半：release-build.yml 用 environment 把签名证书圈在受保护环境里，
  // 而这个工作流的正确答案是根本不碰 secret —— 任何有 write 权限的人都能拿任意
  // 分支 dispatch 它，分支上的一行改动就能把读到的东西打印出来。没有 secret，
  // 这条攻击路径就不存在，也不必依赖仓库设置里的保护规则还在。
  assert.doesNotMatch(source, /secrets\./)
  assert.equal(windowsJob.environment, undefined)
  assert.equal(macosJob.environment, undefined)
  assert.equal(workflow.permissions.contents, 'read')
  assert.deepEqual(Object.keys(workflow.permissions), ['contents'])
})

test('no dispatch input or step output is ever substituted into a shell script', () => {
  // P-26：run 块里的 ${{ ... }} 是在 shell 解析之前做的文本替换，带引号的取值
  // 会闭合字符串字面量并执行后面的内容。取值一律绑进 env: 再用 $env: / $ 读回。
  for (const step of allSteps()) {
    const script = String(step.run || '')
    if (!script) continue
    assert.doesNotMatch(
      script,
      /\$\{\{/,
      `${step.name || step.uses}：把取值绑进 env: 再读，不要写进脚本正文`,
    )
  }
})

test('every third-party action is pinned to a full commit id', () => {
  // 浮动 tag 可以被仓库所有者重新指向任意提交，而这里跑的是要装到发布者机器上
  // 的安装包。
  for (const step of allSteps()) {
    if (!step.uses) continue
    assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} 必须钉到完整提交号`)
  }
})

test('the macOS package is the rehearsal build with its output kept, nothing else', () => {
  // quality.yml 的 macos-test 与这里跑的是同一个脚本、同一条签名路径；差别只有
  // 「产物留不留」。多出来的任何参数都意味着这份包与门禁验过的那份不是一回事。
  const buildSteps = macosJob.steps.filter((step) => /run-macos-free-build\.cjs/.test(String(step.run || '')))
  assert.equal(buildSteps.length, 1)
  const command = String(buildSteps[0].run).trim()
  assert.equal(command, 'node scripts/run-macos-free-build.cjs --ci-temporary-signing --ci-keep-package')
})

test('the Windows package goes through the same release gate as a real release', () => {
  // 出包的意义在于「装上去点一遍就能决定发不发」。走 electron-builder 的快包
  // 路径（test-build.yml）得到的是一个更新器关着、一道门禁都没跑的包，用它做
  // 验收会把问题留到发布之后。
  const buildSteps = windowsJob.steps.filter((step) => /release:build/.test(String(step.run || '')))
  assert.equal(buildSteps.length, 1)
  assert.equal(String(buildSteps[0].run).trim(), 'npm run release:build:unsigned')
})

test('both artifacts say in their own name that they cannot be shipped', () => {
  // 下载列表里只看得到名字。macOS 包的签名身份是一次性的，Windows 包没有私有
  // 加速线路，两者都不是可以发给客户的产物。
  const uploads = allSteps().filter((step) => String(step.uses || '').startsWith('actions/upload-artifact@'))
  assert.equal(uploads.length, 2)
  const names = uploads.map((step) => step.with.name)
  assert.ok(names.some((name) => name.includes('NO-ACCELERATION')), names.join('、'))
  assert.ok(names.some((name) => name.includes('DO-NOT-PUBLISH')), names.join('、'))
  for (const step of uploads) {
    assert.equal(step.with['if-no-files-found'], 'error', '出包作业不能以「没有产物」的形式悄悄成功')
  }
})

test('selecting one platform skips the other job instead of failing it', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.platforms.type, 'choice')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options, ['both', 'windows', 'macos'])
  assert.equal(windowsJob.if, "${{ inputs.platforms != 'macos' }}")
  assert.equal(macosJob.if, "${{ inputs.platforms != 'windows' }}")
})

test('the macOS job runs the checks and the compile its build script deliberately skips', () => {
  // runCiFreeMacBuild 以 skipChecks 调用打包，靠调用方已经跑过检查**和编译**。
  // workflow_dispatch 可以指向任意分支，所以这个前提必须由本作业自己满足。
  // 漏掉 compile 的代价不是一句「没编译」：electron-builder 会一路打包到最后，
  // 报的是「app.asar 里找不到 dist-electron/platform/entry.js」，看起来像产物
  // 损坏。首次实跑就踩了这个坑，所以把顺序也钉住。
  const commands = macosJob.steps.map((step) => String(step.run || '').trim())
  for (const command of ['npm run typecheck', 'npm test', 'npm run compile']) {
    assert.ok(commands.includes(command), `${command} 缺失：${commands.join(' / ')}`)
  }
  const compileIndex = commands.indexOf('npm run compile')
  const buildIndex = commands.findIndex((command) => /run-macos-free-build\.cjs/.test(command))
  assert.ok(compileIndex >= 0 && compileIndex < buildIndex, '编译必须排在打包之前')
})
