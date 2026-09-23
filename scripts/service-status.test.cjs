const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const {
  StatusInputError,
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
  assert.deepEqual(describeStatus(next), ['维护：打开，说明「服务升级中， 预计 23:00 恢复」，2026-09-23T15:00:00.000Z 自动结束'])
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

test('an unreadable live file starts from a blank status', () => {
  for (const text of ['', 'not json', '[]', 'null']) assert.deepEqual(parseCurrentStatus(text), {})
  assert.deepEqual(parseCurrentStatus('﻿{"a":1}'), { a: 1 })
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
