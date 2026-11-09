const assert = require('node:assert/strict')
const test = require('node:test')
const {
  RELEASE_COPYRIGHT_HOLDER,
  buildReleaseCopyright,
  resolveReleaseCopyrightYear,
} = require('./release-copyright.cjs')

test('the copyright line carries the year the package is built in', () => {
  assert.equal(buildReleaseCopyright(new Date('2026-11-10T03:00:00+08:00')), 'Copyright © 2026 绍兴星芒文化传媒有限责任公司')
  assert.equal(buildReleaseCopyright(new Date('2027-06-01T12:00:00+08:00')), 'Copyright © 2027 绍兴星芒文化传媒有限责任公司')
  assert.equal(RELEASE_COPYRIGHT_HOLDER, '绍兴星芒文化传媒有限责任公司')
})

// The release runners are on UTC. A package built in the first eight hours of
// January 1st in Beijing is still on December 31st there, and must already
// carry the new year.
test('the year turns over at midnight Beijing time, not at midnight UTC', () => {
  assert.equal(resolveReleaseCopyrightYear(new Date('2026-12-31T15:59:59.999Z')), 2026)
  assert.equal(resolveReleaseCopyrightYear(new Date('2026-12-31T16:00:00.000Z')), 2027)
  assert.equal(resolveReleaseCopyrightYear(new Date('2027-01-01T07:59:59.999Z')), 2027)
})

test('an unusable build time is refused instead of printing NaN into the installer', () => {
  assert.throws(() => buildReleaseCopyright(new Date('not a date')), TypeError)
  assert.throws(() => buildReleaseCopyright(undefined), TypeError)
  assert.throws(() => buildReleaseCopyright(Date.now()), TypeError)
})
