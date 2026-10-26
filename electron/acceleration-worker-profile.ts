import path from 'node:path'
import { createHash } from 'node:crypto'
import { readBoundedFile } from './bounded-file'
import { assertNoReparseComponents } from './safe-local-data'
import { MAX_ACCELERATION_CLASH_BYTES, parseClashAccelerationProfile } from './acceleration-clash-config'
import type { AccelerationDevelopmentConfig } from './acceleration-development-host'
import { readStoredAccelerationNodes } from './acceleration-online-nodes'

/**
 * 记在本机、签名对的在线节点优先（acceleration-online-nodes.ts）；没记过、读坏了、签名不对、发布者撤回了，
 * 就用安装包自带、受清单校验的那份。在线那份读不通不报错：退回自带的照常能连。
 */
export async function readAccelerationWorkerProfile(
  config: Pick<AccelerationDevelopmentConfig, 'profilePath' | 'profileSha256'>,
  onlineNodesPath?: string,
) {
  if (onlineNodesPath) {
    const online = await readStoredAccelerationNodes(onlineNodesPath)
    if (online?.profile) return online.profile
  }
  assertNoReparseComponents(path.dirname(config.profilePath), '私有加速节点目录')
  const bytes = await readBoundedFile(config.profilePath, MAX_ACCELERATION_CLASH_BYTES, '私有加速节点')
  if (config.profileSha256 && createHash('sha256').update(bytes).digest('hex') !== config.profileSha256.toLowerCase()) {
    throw new Error('加速节点完整性校验失败，请重新安装软件。')
  }
  return parseClashAccelerationProfile(bytes.toString('utf8'))
}
