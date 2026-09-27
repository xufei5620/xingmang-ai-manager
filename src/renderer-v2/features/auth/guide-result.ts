import type { AccountSourceSwitchResult } from '../../../../electron/ipc-contract'
import type { GuideRoute, GuideToolState } from './StartGuide'

interface GuideResultRow {
  value: string
  detail: string
  tone: 'ok' | 'warn' | 'neutral'
}

export interface GuideSetupResult {
  install: GuideResultRow
  connection: GuideResultRow
  billing: string
  next: GuideResultRow
  backupId: string | null
  prompt: string | null
}

interface GuideSetupInput {
  route: GuideRoute
  tool?: GuideToolState
  signedIn: boolean
  readiness: { prepared: boolean; connected: boolean }
  officialName: string
  switched?: AccountSourceSwitchResult | null
}

function installationResult(route: GuideRoute, tool: GuideToolState | undefined, prepared: boolean): GuideResultRow {
  if (route === 'chat') return { value: '无需另装工具', detail: '星芒聊天已在本软件内，可直接从问题开始。', tone: 'ok' }
  if (!tool || tool.detectionError) return { value: '安装状态暂未读到', detail: '请重新检测后再判断是否需要安装。', tone: 'warn' }
  if (!tool.installed) return { value: '尚未检测到安装', detail: '安装操作结束后仍需由本机检测确认。', tone: 'warn' }
  const version = tool.version ? ` v${tool.version.replace(/^v/i, '')}` : '，版本暂未读到'
  const update = tool.update
  const detail = !prepared ? '工具已找到，请继续处理运行环境或平台支持状态。'
    : update?.knownIssue ? `这个版本有已知问题，建议${update.manualHint ? '用原安装方式更新' : '更新'}到 ${update.target || update.version}。`
      : update ? `建议${update.manualHint ? '用原安装方式更新' : '更新'}到 ${update.target || update.version}；不影响继续准备。`
        : '已找到本机安装，接下来确认连接方式。'
  return { value: `已检测到安装${version}`, detail, tone: !prepared || update || !tool.version ? 'warn' : 'ok' }
}

function connectionResult(input: GuideSetupInput): { row: GuideResultRow; billing: string } {
  const { route, tool, signedIn, readiness, officialName, switched } = input
  if (route === 'chat') return signedIn
    ? { row: { value: '已登录星芒账号', detail: '进入聊天后发送第一句话。', tone: 'ok' }, billing: '在星芒聊天发送请求后，按所选模型和当前账号规则计费。' }
    : { row: { value: '等待登录星芒账号', detail: '登录后才能开始聊天。', tone: 'warn' }, billing: '尚未发起请求，不会产生本次任务用量。' }
  if (!tool || tool.detectionError) return { row: { value: '连接状态暂未读到', detail: '请重新检测本机配置。', tone: 'warn' }, billing: '配置未读到，暂不能判断计费归属。' }
  if (tool.source === 'official') return {
    row: tool.officialLoginRequired
      ? { value: `${officialName} 待在客户端登录`, detail: '本机尚未检测到该客户端的官方登录。', tone: 'warn' }
      : { value: `${officialName} 官方来源`, detail: '请在客户端确认登录状态与可用功能。', tone: 'neutral' },
    billing: '官方账号的额度与计费以客户端显示为准，星芒余额不代表官方额度。',
  }
  if (tool.source === 'manual') return {
    row: { value: '手动填写密钥', detail: readiness.connected ? '本机配置已识别，可打开工具尝试。' : '请核对密钥和模型。', tone: readiness.connected ? 'neutral' : 'warn' },
    billing: '请求按这把密钥所属服务的规则计费，账号归属需自行核对。',
  }
  if (tool.source === 'unknown') return {
    row: { value: '现有配置，归属待确认', detail: tool.keyState === 'otherAccount' ? '这把 Key 可能属于同站其他账号。' : '本机无法确认这份配置属于哪个账号。', tone: 'warn' },
    billing: '密钥的账号归属未确认，请先核对再判断用量与费用。',
  }
  if (tool.source === 'account') {
    const switchedHere = switched?.target === 'account' ? switched : null
    const detail = switchedHere?.verified && readiness.connected
      ? '切换时的连接基础检查通过。'
      : switchedHere && !switchedHere.verified
        ? '配置已切换，连接基础检查尚未完成。'
        : readiness.connected ? '本机配置已识别，可打开工具尝试。' : '请核对本机配置和登录状态。'
    return {
      row: { value: !readiness.connected ? '星芒账号来源待配置' : signedIn ? '当前星芒账号 Key' : '本机星芒账号 Key', detail, tone: readiness.connected && switchedHere?.verified ? 'ok' : readiness.connected ? 'neutral' : 'warn' },
      billing: !readiness.connected ? '密钥尚未确认写入，请先完成配置再判断计费来源。' : signedIn
        ? '经这把 Key 发出的模型请求按当前星芒账号规则计费；客户端其他功能另依其官方账号规则。'
        : '经这把 Key 发出的请求按密钥归属计费；请登录后核对是否属于当前账号。',
    }
  }
  return { row: { value: '连接未设置', detail: '请选择账号或密钥并保存配置。', tone: 'warn' }, billing: '尚未连接，暂不能判断计费归属。' }
}

export function buildGuideSetupResult(input: GuideSetupInput): GuideSetupResult {
  const { route, tool, readiness, switched } = input
  const connection = connectionResult(input)
  const backupId = route !== 'chat' && tool?.source === 'account' && switched?.target === 'account' && switched.backupId.trim()
    ? switched.backupId : null
  const next: GuideResultRow = !readiness.prepared
    ? { value: '请返回准备工具', detail: '完成安装或运行环境后重新检测。', tone: 'warn' }
    : !readiness.connected
      ? { value: '请核对连接', detail: '保存配置或在客户端登录后重新检测。', tone: 'warn' }
      : { value: route === 'chat' ? '可以开始聊天' : '可以尝试打开工具', detail: '打开后发送下面的示例。', tone: 'neutral' }
  const prompt = route === 'codexDesktop'
    ? '请用中文先阅读当前项目，概述目标，并列出开始实现前需要确认的三个问题；先不要修改文件。'
    : route === 'chat' ? '请先问我想解决的问题和限制，然后给我一个今天就能做的第一步。' : null
  return {
    install: installationResult(route, tool, readiness.prepared),
    connection: connection.row,
    billing: connection.billing,
    next,
    backupId,
    prompt,
  }
}
