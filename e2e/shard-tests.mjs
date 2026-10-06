import { test as nodeTest } from 'node:test'

// src/renderer-v2/testing/app-check.mjs is two thirds of the fixture browser
// suites on its own (528s of 818s on main 84e9447's Windows run) and is where
// nearly every new renderer test lands: 199 test() calls on 2026-10-03, 268
// three days later. node --test hands each file to one runner whole, so cutting
// the suites by file still left one runner holding all of it, and the slow
// Windows runners #873 drew (about 1.55 times as long as #871's over the same
// tests) ran that one out of its 18 minutes three times. So the file's tests
// are dealt to the runners instead.
//
// The deal happens at registration, in declaration order: with
// XINGMANG_TEST_SHARD=2/3 the second, fifth, eighth... test() calls register
// and the rest never do, so a shard reports only what it ran instead of listing
// half the file as skipped. Each position belongs to exactly one shard, which
// makes the shards add up to the whole file exactly once, as long as every one
// of them is dispatched; scripts/ci-workflow-config.test.cjs pins that. The
// file's before()/after() hooks still run in every shard.
//
// The wrapper has two costs, so it is only put in place when a shard is named.
// node:test records whoever called test() as the test's location, so a sharded
// run reports this file rather than the test's own line; the test name and the
// error's stack still lead there. And every test() call is dealt, including one
// made inside a running test, which can land in a shard that never runs its
// parent, so subtests go through t.test(). Unset, test is node:test's own,
// which is what a local run and the unsharded Linux job get.
const shardVariable = 'XINGMANG_TEST_SHARD'

/** 解析 `第几份/共几份`（例如 `2/2`）。没设 = 整份都跑；写错了直接报错，免得悄悄全跑或一条不跑。 */
export function parseTestShard(value) {
  if (value === undefined || value === '') return null
  const match = /^(\d+)\/(\d+)$/.exec(value)
  const index = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || index < 1 || index > total) {
    throw new Error(`${shardVariable} must name one shard as index/total, such as 1/2; got ${JSON.stringify(value)}`)
  }
  return { index, total }
}

/** 按声明顺序数的第 `ordinal` 条（从 0 数）归不归 `shard` 这一份。 */
export function belongsToShard(ordinal, shard) {
  return shard === null || ordinal % shard.total === shard.index - 1
}

/** 包一层 `test`：只把归这一份的用例交给 `register`，别的根本不登记。 */
export function createShardedTest(shard, register = nodeTest) {
  let ordinal = 0
  return function shardedTest(...args) {
    const mine = belongsToShard(ordinal, shard)
    ordinal += 1
    return mine ? register(...args) : undefined
  }
}

const shard = parseTestShard(process.env[shardVariable])

export const test = shard === null ? nodeTest : createShardedTest(shard)
