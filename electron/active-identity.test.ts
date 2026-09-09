import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createActiveIdentityReader, type AccountIdentitySource, type AccountRealmBinding } from './active-identity'

function fixture(binding: AccountRealmBinding = {
  siteId: 'solov', realmId: 'xm-account', accountOrigin: 'https://xm.solov.cc',
}) {
  let generation = 0
  let state: ReturnType<AccountIdentitySource['getSessionState']> = { authenticated: false, account: null }
  const source: AccountIdentitySource = {
    getSessionRevision: () => generation,
    getSessionState: () => state,
  }
  return {
    reader: createActiveIdentityReader(binding, source), source,
    login(userId = 7) {
      generation += 1
      state = { authenticated: true, account: { userId } }
    },
    logout() {
      generation += 1
      state = { authenticated: false, account: null }
    },
    beginAttempt() { generation += 1 },
    refresh() { state = { ...state, account: state.account ? { ...state.account } : null } },
    setState(value: typeof state) { state = value },
    setRevision(value: number) { generation = value },
  }
}

describe('main-process active identity', () => {
  it('does not treat signed-out state as an identity', () => {
    const { reader } = fixture()
    assert.equal(reader.read(), null)
    assert.throws(() => reader.capture(), /请先登录/)
  })

  it('copies only identity fields and returns a frozen snapshot', () => {
    const account = fixture()
    const profile = { userId: 7, accessToken: 'fixture-secret', cookies: 'fixture-cookie', username: 'fixture-name' }
    account.setState({ authenticated: true, account: profile })
    const captured = account.reader.capture()
    assert.deepEqual(captured, {
      siteId: 'solov', realmId: 'xm-account', accountOrigin: 'https://xm.solov.cc', userId: '7', sessionRevision: 0,
    })
    assert.ok(Object.isFrozen(captured))
    assert.ok(Object.isFrozen(account.reader))
    assert.ok(!JSON.stringify(captured).includes('fixture-'))
    profile.userId = 8
    assert.equal(captured.userId, '7')
  })

  it('retains its own copy of the realm binding', () => {
    const binding = { siteId: 'solov', realmId: 'xm-account', accountOrigin: 'https://xm.solov.cc' }
    const account = fixture(binding)
    binding.accountOrigin = 'https://other.example.invalid'
    account.login()
    assert.equal(account.reader.capture().accountOrigin, 'https://xm.solov.cc')
  })

  it('keeps a snapshot current through token refresh with stable revision', () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    account.refresh()
    assert.doesNotThrow(() => account.reader.assertCurrent(captured))
  })

  it('invalidates a snapshot on a pending login or switch intent', () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    account.beginAttempt()
    assert.throws(() => account.reader.assertCurrent(captured), /上下文已变化/)
  })

  it('invalidates a snapshot after logout', () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    account.logout()
    assert.throws(() => account.reader.assertCurrent(captured), /上下文已变化/)
  })

  it('does not revive a snapshot on re-login as the same user', () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    account.logout()
    account.login()
    assert.throws(() => account.reader.assertCurrent(captured), /上下文已变化/)
    assert.doesNotThrow(() => account.reader.assertCurrent(account.reader.capture()))
  })

  it('rejects a changed user even if an adapter forgot to advance its revision', () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    account.setState({ authenticated: true, account: { userId: 8 } })
    assert.throws(() => account.reader.assertCurrent(captured), /上下文已变化/)
  })

  it('does not accept a cloned or fabricated ownership snapshot', () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    for (const value of [undefined, null, 1, 'solov', {}, { ...captured }, JSON.parse(JSON.stringify(captured))]) {
      assert.throws(() => account.reader.assertCurrent(value), /上下文无效/)
    }
  })

  it('rejects snapshots from another runtime even with identical identity fields', () => {
    const first = fixture()
    const second = fixture()
    first.login()
    second.login()
    const left = first.reader.capture()
    const right = second.reader.capture()
    assert.deepEqual(left, right)
    assert.throws(() => second.reader.assertCurrent(left), /上下文无效/)
  })

  it('distinguishes two realms with the same numeric user id', () => {
    const first = fixture()
    const second = fixture({ siteId: 'fixture-site', realmId: 'fixture-realm', accountOrigin: 'https://second.example.invalid' })
    first.login()
    second.login()
    assert.notDeepEqual(first.reader.capture(), second.reader.capture())
    assert.throws(() => first.reader.assertCurrent(second.reader.capture()), /上下文无效/)
  })

  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects an invalid numeric new-api user id: ${String(value)}`, () => {
      const account = fixture()
      account.login(value)
      assert.throws(() => account.reader.capture(), /账号身份无效/)
    })
  }

  it('rejects an authenticated state with no profile', () => {
    const account = fixture()
    account.setState({ authenticated: true, account: null })
    assert.throws(() => account.reader.capture(), /账号身份无效/)
  })

  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects an invalid session revision: ${String(value)}`, () => {
      const account = fixture()
      account.login()
      account.setRevision(value)
      assert.throws(() => account.reader.capture(), /会话版本无效/)
    })
  }

  it('rejects a revision that moves backwards in the same client', () => {
    const account = fixture()
    account.login()
    account.reader.capture()
    account.setRevision(0)
    assert.throws(() => account.reader.capture(), /会话版本无效/)
  })

  it('rejects identity changes during synchronous capture', () => {
    const account = fixture()
    account.login()
    const getState = account.source.getSessionState
    account.source.getSessionState = () => {
      account.beginAttempt()
      return getState()
    }
    assert.throws(() => account.reader.capture(), /上下文已变化/)
  })

  it('blocks publication of an old asynchronous result when the caller checks ownership', async () => {
    const account = fixture()
    account.login()
    const captured = account.reader.capture()
    let resolve: (value: string) => void = () => { throw new Error('not initialized') }
    const result = new Promise<string>((done) => { resolve = done })
    let published = false
    const operation = (async () => {
      const value = await result
      account.reader.assertCurrent(captured)
      published = true
      return value
    })()
    const rejected = assert.rejects(operation, /上下文已变化/)
    account.logout()
    account.login()
    resolve('old-result')
    await rejected
    assert.equal(published, false)
  })
})
