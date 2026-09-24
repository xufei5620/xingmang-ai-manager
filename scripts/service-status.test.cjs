const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const {
  StatusInputError,
  applyBadVersions,
  applyRollout,
  applyStatusChanges,
  describeStatus,
  normalizeUntil,
  parseCurrentStatus,
} = require('./service-status.cjs')

const now = new Date('2026-09-23T08:00:00.000Z')

test('turning maintenance on writes an active block with the message and a UTC end time', () => {
  const next = applyStatusChanges({}, { maintenance: 'on', message: ' 服务升级中，\n预计 23:00 恢复 ', until: '2026-09-23 23:00' }, now)
  assert.deepEqual(next.maintenance, { active: true, message: '服务升级中， 预计 23:00 恢复', until: '2026-09-23T15:00:00.000Z' })
  assert.equal(next.updatedAt, now.toISOString())
  assert.deepEqual(describeStatus(next).slice(0, 1), ['维护：打开，说明「服务升级中， 预计 23:00 恢复」，2026-09-23T15:00:00.000Z 自动结束'])
})

test('turning maintenance off removes the block but keeps every other field', () => {
  const current = { maintenance: { active: true, message: 'x' }, badVersions: ['0.2.10'], custom: 1 }
  const next = applyStatusChanges(current, { maintenance: 'off' }, now)
  assert.equal(next.maintenance, undefined)
  assert.deepEqual(next.badVersions, ['0.2.10'])
  assert.equal(next.custom, 1)
})

test('keep leaves maintenance alone and refuses a message that would go nowhere', () => {
  const current = { maintenance: { active: true, message: 'x' } }
  assert.deepEqual(applyStatusChanges(current, { maintenance: 'keep', message: '', until: '' }, now).maintenance, current.maintenance)
  assert.throws(() => applyStatusChanges(current, { maintenance: 'keep', message: 'y' }, now), StatusInputError)
})

test('rejects an end time that is unreadable or already past, and an overlong message', () => {
  assert.throws(() => normalizeUntil('tonight', now), /看不懂这个时间/)
  assert.throws(() => normalizeUntil('2026-09-23 15:59', now), /已经过去了/)
  assert.equal(normalizeUntil('2026-09-24T00:00:00+08:00', now), '2026-09-23T16:00:00.000Z')
  assert.throws(() => applyStatusChanges({}, { maintenance: 'on', message: '长'.repeat(201) }, now), /最多 200 个字/)
  assert.throws(() => applyStatusChanges({}, { maintenance: 'maybe' }, now), /on \/ off \/ keep/)
})

test('only a live file that does not exist starts from a blank status', () => {
  assert.deepEqual(parseCurrentStatus(null), {})
  assert.deepEqual(parseCurrentStatus('\uFEFF{"a":1}'), { a: 1 })
  // #500：200 回来却读不懂，多半是缓存或路由回了网页，线上真正的文件里可能还有撤回名单。
  for (const text of ['', '  \n', '<!doctype html><html></html>', 'not json', '[]', 'null', '"text"', '42']) {
    assert.throws(() => parseCurrentStatus(text), StatusInputError, JSON.stringify(text))
  }
})

test('a corrupt live file stops the script before anything is written', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-status-'))
  try {
    const current = path.join(directory, 'current.json')
    const output = path.join(directory, 'service-status.json')
    const script = path.join(__dirname, 'service-status.cjs')
    fs.writeFileSync(current, '<html>502 Bad Gateway</html>')
    const corrupt = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off'], { encoding: 'utf8' })
    assert.equal(corrupt.status, 1)
    assert.match(corrupt.stderr, /不是有效的 JSON 对象/)
    assert.equal(fs.existsSync(output), false)

    // 有效的文件：只改这次填的，撤回名单与分批放量原样留着。
    fs.writeFileSync(current, JSON.stringify({ badVersions: ['0.2.10'], rollout: { version: '0.2.11', percent: 20 }, extra: 1 }))
    const valid = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off'], { encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)
    const written = JSON.parse(fs.readFileSync(output, 'utf8'))
    assert.deepEqual(written.badVersions, ['0.2.10'])
    assert.deepEqual(written.rollout, { version: '0.2.11', percent: 20 })
    assert.equal(written.extra, 1)

    // 线上 404：工作流删掉 current.json，从空白开始。
    fs.rmSync(current)
    const missing = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off'], { encoding: 'utf8' })
    assert.equal(missing.status, 0, missing.stderr)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the workflow keeps free text out of the shell and publishes only the status file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8')
  const workflow = YAML.parse(source)
  const job = workflow.jobs.publish
  assert.equal(job.environment, 'release')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  for (const step of job.steps) {
    assert.doesNotMatch(step.run ?? '', /\$\{\{\s*(inputs|github\.event)\./, `${step.name} must read inputs through env`)
  }
  const uploads = job.steps.filter((step) => /aws s3/.test(step.run ?? ''))
  assert.equal(uploads.length, 1)
  assert.match(uploads[0].run, /\$OBJECT_PREFIX\/service-status\.json/)
  assert.match(uploads[0].run, /--cache-control 'no-cache'/)
  assert.doesNotMatch(uploads[0].run, /latest(-mac)?\.yml/)
})

test('withdrawn versions are added, removed one by one, or cleared, never silently replaced', () => {
  assert.deepEqual(applyBadVersions(['0.2.8'], '0.2.10, v0.2.11'), ['0.2.8', '0.2.10', '0.2.11'])
  assert.deepEqual(applyBadVersions(['0.2.8', '0.2.10'], '-0.2.8'), ['0.2.10'])
  assert.deepEqual(applyBadVersions(['0.2.8'], 'none'), [])
  assert.deepEqual(applyBadVersions(['0.2.8'], ''), ['0.2.8'])
  assert.throws(() => applyBadVersions([], 'latest'), /0\.2\.10 这样/)
  const next = applyStatusChanges({ badVersions: ['0.2.8'] }, { 'bad-versions': 'none' }, now)
  assert.equal(next.badVersions, undefined)
})

test('a staged rollout names a version and a share of machines', () => {
  assert.deepEqual(applyRollout(undefined, '0.2.11 20'), { version: '0.2.11', percent: 20 })
  assert.deepEqual(applyRollout(undefined, 'v0.2.11 100%'), { version: '0.2.11', percent: 100 })
  assert.equal(applyRollout({ version: '0.2.11', percent: 20 }, 'none'), undefined)
  assert.throws(() => applyRollout(undefined, '0.2.11'), /版本号 空格 百分比/)
  assert.throws(() => applyRollout(undefined, '0.2.11 150'), /最多 100/)
  const next = applyStatusChanges({}, { rollout: '0.2.11 20' }, now)
  assert.deepEqual(describeStatus(next).slice(1), ['撤回的版本：无', '分批放量：0.2.11 先给 20% 的电脑'])
})
