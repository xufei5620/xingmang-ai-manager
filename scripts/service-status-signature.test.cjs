const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const {
  SIGNATURE_FIELD,
  StatusSignatureError,
  buildGuardPayload,
  canonicalJson,
  describeLiveSignatureWarning,
  inspectStatusSignature,
  signStatus,
} = require('./service-status-signature.cjs')
const { PRESERVE_SYMLINKS, createPinnedWorkspace, createTestSigner } = require('./service-status-signature.test-support.cjs')

const root = path.resolve(__dirname, '..')
const signer = createTestSigner()
const pinned = [signer.publicKey]
const guard = { badVersions: ['0.2.21'], rollout: { version: '0.2.25', percent: 20 }, minimumVersion: '0.2.22', updatedAt: '2026-11-20T00:00:00.000Z' }

test('builds exactly the text electron/service-status.ts verifies', () => {
  // 与 electron/service-status.test.ts 的同名断言逐字一致；改一边必须改另一边。
  const document = { maintenance: { active: true, message: '升级中' }, featuresOff: [{ feature: 'video-studio' }], accountGroups: { codex: ['GPT'] }, updatedAt: '2026-11-20T00:00:00.000Z', rollout: { version: '0.2.25', percent: 20 }, badVersions: ['0.2.21'] }
  assert.equal(
    buildGuardPayload(document),
    'xingmang-service-status-guard/v1\n{"badVersions":["0.2.21"],"rollout":{"percent":20,"version":"0.2.25"},"updatedAt":"2026-11-20T00:00:00.000Z"}\n',
  )
  assert.equal(buildGuardPayload({}), 'xingmang-service-status-guard/v1\n{}\n')
})

test('the canonical text sorts keys at every depth and keeps a "__proto__" key as an ordinary one', () => {
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: '中' }), '{"a":"中","b":[{"c":2,"d":1}]}')
  const parsed = JSON.parse('{"rollout":{"__proto__":{"x":1},"version":"0.2.25"}}')
  assert.equal(canonicalJson(parsed), '{"rollout":{"__proto__":{"x":1},"version":"0.2.25"}}')
  assert.equal(canonicalJson(null), 'null')
})

test('signs with a pinned key, puts the signature last and replaces an old one', () => {
  const signed = signStatus({ ...guard, [SIGNATURE_FIELD]: 'stale', maintenance: { active: true } }, signer.privateKey, pinned)
  assert.equal(Object.keys(signed).at(-1), SIGNATURE_FIELD)
  assert.notEqual(signed[SIGNATURE_FIELD], 'stale')
  assert.equal(inspectStatusSignature(signed, pinned), 'signed')
  // Ed25519 是确定性的：同一份内容重跑签出一样的字节，上传后的核对认得出。
  assert.deepEqual(signStatus(signed, signer.privateKey, pinned), signed)
})

test('refuses to sign with a key the client does not pin, or with no key pinned at all', () => {
  const other = createTestSigner()
  assert.throws(() => signStatus(guard, other.privateKey, pinned), (error) => error instanceof StatusSignatureError && error.message.includes(other.publicKey))
  assert.throws(() => signStatus(guard, signer.privateKey, []), /还没有内置任何发布者签名公钥/)
  assert.throws(() => signStatus([], signer.privateKey, pinned), /不是 JSON 对象/)
})

test('tells a missing signature from one that no longer matches the signed fields', () => {
  const signed = signStatus(guard, signer.privateKey, pinned)
  assert.equal(inspectStatusSignature(guard, pinned), 'unsigned')
  assert.equal(inspectStatusSignature({ ...guard, [SIGNATURE_FIELD]: '' }, pinned), 'unsigned')
  assert.equal(inspectStatusSignature({ ...signed, badVersions: ['0.2.21', '0.2.25'] }, pinned), 'signature')
  assert.equal(inspectStatusSignature({ ...signed, [SIGNATURE_FIELD]: 42 }, pinned), 'signature')
  assert.equal(inspectStatusSignature(signed, [createTestSigner().publicKey]), 'signature')
  // 不在签名里的项手改了照样验得过。
  assert.equal(inspectStatusSignature({ ...signed, maintenance: { active: true, message: '手改的' } }, pinned), 'signed')
})

test('warns the approver only when a live file exists and its guard is not properly signed', () => {
  assert.equal(describeLiveSignatureWarning(null, pinned), null)
  assert.equal(describeLiveSignatureWarning(signStatus(guard, signer.privateKey, pinned), pinned), null)
  assert.match(describeLiveSignatureWarning(guard, pinned), /还没有发布者签名.*照上面写的签上/)
  assert.match(describeLiveSignatureWarning({ ...signStatus(guard, signer.privateKey, pinned), minimumVersion: '9.9.9' }, pinned), /跟发布者签名对不上.*先 Reject/)
})

function runCommand(args, env = {}) {
  const workspace = createPinnedWorkspace('xingmang-status-signature-', pinned)
  try {
    const file = path.join(workspace, 'service-status.json')
    if (args.content !== undefined) fs.writeFileSync(file, args.content)
    const result = spawnSync(process.execPath, [...PRESERVE_SYMLINKS, path.join(workspace, 'scripts', 'service-status-signature.cjs'), ...args.argv, '--file', file], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    })
    const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    return { status: result.status, output: result.stdout + result.stderr, written }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

test('the command line signs the file in place and verifies it', () => {
  const signed = runCommand({ argv: ['sign'], content: `${JSON.stringify(guard)}\n` }, { XINGMANG_UPDATE_SIGNING_KEY: signer.privateKeyText })
  assert.equal(signed.status, 0, signed.output)
  assert.match(signed.written, /\n {2}"releaseGuardSignature": "[A-Za-z0-9+/]{86}=="\n\}\n$/)
  assert.equal(inspectStatusSignature(JSON.parse(signed.written), pinned), 'signed')
  const verified = runCommand({ argv: ['verify'], content: signed.written })
  assert.equal(verified.status, 0, verified.output)

  const unsigned = runCommand({ argv: ['verify'], content: JSON.stringify(guard) })
  assert.equal(unsigned.status, 1)
  assert.match(unsigned.output, /::error::撤回名单那几项没有发布者签名/)
})

test('the command line refuses to sign without the key, with the wrong key, or a file it cannot read', () => {
  const missing = runCommand({ argv: ['sign'], content: JSON.stringify(guard) })
  assert.equal(missing.status, 1)
  assert.match(missing.output, /::error::release 环境缺少 secret：XINGMANG_UPDATE_SIGNING_KEY/)
  assert.equal(missing.written, JSON.stringify(guard))
  const wrong = runCommand({ argv: ['sign'], content: JSON.stringify(guard) }, { XINGMANG_UPDATE_SIGNING_KEY: createTestSigner().privateKeyText })
  assert.equal(wrong.status, 1)
  assert.match(wrong.output, /不在客户端内置名单里/)
  const html = runCommand({ argv: ['sign'], content: '<html></html>' }, { XINGMANG_UPDATE_SIGNING_KEY: signer.privateKeyText })
  assert.equal(html.status, 1)
  assert.match(html.output, /::error::.*不是有效的 JSON/)
  const big = runCommand({ argv: ['sign'], content: JSON.stringify({ ...guard, padding: 'x'.repeat(16 * 1024 - 300) }) }, { XINGMANG_UPDATE_SIGNING_KEY: signer.privateKeyText })
  assert.equal(big.status, 1)
  assert.match(big.output, /超过 16 KB/)
})

test('the signing script loads without any installed package, so the preview job can use it', () => {
  const source = fs.readFileSync(path.join(__dirname, 'service-status-signature.cjs'), 'utf8')
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual(requires, ['node:fs', 'node:crypto', './update-manifest-signature.cjs'])
  // update-manifest-signature.cjs 的 yaml 要到读清单时才加载。
  const manifestSource = fs.readFileSync(path.join(__dirname, 'update-manifest-signature.cjs'), 'utf8')
  const topLevel = manifestSource.split('\n').filter((line) => /^const .*require\(/.test(line))
  assert.ok(topLevel.every((line) => !/require\('yaml'\)/.test(line)), topLevel.join('\n'))
})

// D85：0.2.25 起的客户端不认没签名的撤回名单、放量、最低版本。往更新目录写状态文件的每一个作业，都要在上传前
// 签上，签的就是传上去的那个文件；私钥只给签名那一步（或者签名就在上传那一步里），别的步骤看不到。
test('every job that uploads the status file signs exactly that file first', () => {
  const directory = path.join(root, '.github', 'workflows')
  const uploaders = []
  for (const file of fs.readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const workflow = YAML.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
    for (const [id, job] of Object.entries(workflow.jobs || {})) {
      const steps = job.steps || []
      steps.forEach((step, index) => {
        const upload = /aws s3 cp "([^"]+)" \\\s*\n\s*"s3:\/\/\$R2_BUCKET\/\$OBJECT_PREFIX\/service-status\.json"/.exec(String(step.run || ''))
        if (!upload) return
        uploaders.push(`${file}#${id}`)
        const source = upload[1]
        const signing = steps.slice(0, index + 1).filter((candidate) => String(candidate.run || '').includes(`node scripts/service-status-signature.cjs sign --file "${source}"`))
        assert.equal(signing.length, 1, `${file}#${id} must sign ${source} once before uploading it`)
        const [signStep] = signing
        assert.equal(signStep.env?.XINGMANG_UPDATE_SIGNING_KEY, '${{ secrets.XINGMANG_UPDATE_SIGNING_KEY }}')
        if (signStep !== step) {
          // 单独一步签名：只拿私钥，别的什么都不拿；跟上传那步同一个条件，上传了就一定签过。
          assert.deepEqual(Object.keys(signStep.env), ['XINGMANG_UPDATE_SIGNING_KEY'])
          assert.equal(signStep.if, step.if)
        } else {
          const lines = String(step.run).split('\n')
          const signLine = lines.findIndex((line) => line.includes('service-status-signature.cjs sign'))
          const uploadLine = lines.findIndex((line) => line.includes('aws s3 cp'))
          assert.ok(signLine >= 0 && signLine < uploadLine, `${file}#${id} must sign before the upload line`)
        }
        // 签完到上传之间不许再改这个文件。
        for (const between of steps.slice(steps.indexOf(signStep) + 1, index)) {
          assert.doesNotMatch(String(between.run || ''), new RegExp(`--output "${source.replace(/[$]/g, '\\$')}"`), `${file}#${id} rewrites the status file after signing it`)
        }
      })
    }
  }
  assert.deepEqual(uploaders, ['publish-release.yml#publish', 'rollback-release.yml#rollback', 'service-status.yml#publish'])
})

test('every job that signs the status file checks the signing key is there before it touches anything', () => {
  for (const [file, job] of [['service-status.yml', 'publish'], ['rollback-release.yml', 'rollback']]) {
    const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'))
    const early = workflow.jobs[job].steps.find((step) => /^Fail early/.test(step.name || ''))
    assert.equal(early.env.XINGMANG_UPDATE_SIGNING_KEY, '${{ secrets.XINGMANG_UPDATE_SIGNING_KEY }}', file)
    assert.match(early.run, /for name in [^;]*XINGMANG_UPDATE_SIGNING_KEY; do/, file)
  }
})
