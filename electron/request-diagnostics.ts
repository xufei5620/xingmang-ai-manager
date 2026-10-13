/**
 * 客户说「登不上」「Key 配不上」时，客服手里只有导出的反馈报告。以前账号请求失败只记一句中文原话，
 * 看不出这一次走的是直连还是 CF、服务器回了什么状态码、服务端该拿什么去查这一次请求（三线路 7b）。
 * 这里给一次请求的回应、失败和结果挂上这几样，记日志的那一层（ipc.ts）再取出来记。
 *
 * 挂在 WeakMap 里，不加在错误对象的字段上：错误会交给渲染层、被测试按字段比对，多一个可枚举字段就改了
 * 它们的样子；WeakMap 跟着对象一起回收，日志以外的地方也看不见。只挂下面这几样，都不是秘密：不带
 * 地址、令牌、Key、密码（I13）。
 */
import type { RelayEndpointId } from './relay-sites'

export interface RequestDiagnostics {
  /** 这一次实际走的线路：direct 是直连，primary 是默认线路（CF）。直连没走通、改走默认线路重发的记 primary。 */
  line?: RelayEndpointId
  /** 服务回的 HTTP 状态码；连不上、没等到回应时没有。 */
  status?: number
  /** new-api 每个回应都带的请求编号（回应头 X-Oneapi-Request-Id，rc.24 起全局中间件加的），服务端按它查这一次。 */
  requestId?: string
  /** 走 CF 时 CF 给这一次请求的编号（回应头 cf-ray）；CF 自己拦下、没到 new-api 时只有它。 */
  cfRay?: string
}

const notes = new WeakMap<object, RequestDiagnostics>()

// 两个编号都是服务端生成的短串（new-api 是时间加随机字母，cf-ray 是十六进制加机房代号）。认不出的不记：
// 回应头是外部可控的，不能让它往日志里塞任意长度、任意内容的一段话。
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/

function identifier(value: string | null): string | null {
  return value !== null && identifierPattern.test(value) ? value : null
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function present(diagnostics: RequestDiagnostics): RequestDiagnostics {
  return {
    ...(diagnostics.line ? { line: diagnostics.line } : {}),
    ...(diagnostics.status !== undefined ? { status: diagnostics.status } : {}),
    ...(diagnostics.requestId ? { requestId: diagnostics.requestId } : {}),
    ...(diagnostics.cfRay ? { cfRay: diagnostics.cfRay } : {}),
  }
}

/** 给回应、错误或结果补上这几样：已经挂着的留着，这次给的同名项盖过去。 */
export function noteRequestDiagnostics(target: unknown, diagnostics: RequestDiagnostics | null | undefined): void {
  if (!isObject(target) || !diagnostics) return
  const merged = { ...notes.get(target), ...present(diagnostics) }
  if (Object.keys(merged).length) notes.set(target, merged)
}

/** 把 from 身上的诊断挂到 to 上，返回 to：换了个错误或结果对象往外交时用。 */
export function carryRequestDiagnostics<T>(from: unknown, to: T): T {
  noteRequestDiagnostics(to, requestDiagnosticsOf(from))
  return to
}

/** 一次请求的诊断：先在它自己身上找，没有就顺着 cause 往里找（RealmAccountError 把原始失败挂在 cause 上）。 */
export function requestDiagnosticsOf(target: unknown): RequestDiagnostics | null {
  let current = target
  for (let depth = 0; depth < 4 && isObject(current); depth += 1) {
    const found = notes.get(current)
    if (found) return { ...found }
    current = 'cause' in current ? current.cause : undefined
  }
  return null
}

/** 从回应上读：线路是按线路发请求的那一层（relay-line-fetch.ts）先挂上的，状态码和两个编号读回应本身。 */
export function responseDiagnostics(response: Response): RequestDiagnostics {
  const requestId = identifier(response.headers.get('x-oneapi-request-id'))
  const cfRay = identifier(response.headers.get('cf-ray'))
  return {
    ...notes.get(response),
    // 被拒的跳转（opaqueredirect）状态码是 0，那不是服务回的。
    ...(response.status > 0 ? { status: response.status } : {}),
    ...(requestId ? { requestId } : {}),
    ...(cfRay ? { cfRay } : {}),
  }
}
