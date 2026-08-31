import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1'])
const maximumCdpResponseBytes = 2 * 1024 * 1024
const cdpDiscoveryTimeoutMs = 2_000
const cdpCommandTimeoutMs = 5_000
const cdpDiscoveryAttempts = 30
const cdpDiscoveryDeadlineMs = 20_000

/**
 * This is deliberately a small, mechanism-level patch. It does not replace
 * Codex assets or copy a third-party implementation; it only makes the
 * already-installed official Chinese resources visible to the running
 * Chromium page when the client has not yet applied its locale flags.
 */
export const codexChineseRuntimeScript = String.raw`(() => {
  const configId = "72216192";
  const state = globalThis.__xingmangCodexChineseLocaleState || {
    configId,
    patchedClients: 0,
    patchedConfigs: 0,
    lastPatchAt: 0,
  };
  try { globalThis.__xingmangCodexChineseLocaleState = state; } catch {}

  const locale = "zh-CN";
  const defineNavigator = (name, value) => {
    try {
      Object.defineProperty(Navigator.prototype, name, { configurable: true, get: () => value });
    } catch {
      try { Object.defineProperty(navigator, name, { configurable: true, get: () => value }); } catch {}
    }
  };
  defineNavigator("language", locale);
  defineNavigator("languages", [locale, "zh"]);

  const forceConfig = (config) => {
    if (!config || (typeof config !== "object" && typeof config !== "function")) return config;
    if (config.__xingmangCodexChineseConfig) return config;
    let patched = false;
    if (typeof config.get === "function") {
      const originalGet = config.get;
      try {
        Object.defineProperty(config, "get", {
          configurable: true,
          value: function (key, fallback) {
            if (key === "enable_i18n") return true;
            if (key === "locale_source") return "SYSTEM";
            // Preserve Statsig's optional arguments (exposure options,
            // defaults, and any future parameters) instead of narrowing the
            // call to the two arguments used by the current build.
            return originalGet.apply(this, arguments);
          },
        });
        patched = true;
      } catch {}
    }
    try {
      if (config.value && typeof config.value === "object") {
        config.value.enable_i18n = true;
        config.value.locale_source = "SYSTEM";
        patched = true;
      }
    } catch {}
    if (patched) {
      try {
        Object.defineProperty(config, "__xingmangCodexChineseConfig", { value: true, configurable: true });
      } catch {}
      state.patchedConfigs += 1;
      state.lastPatchAt = Date.now();
    }
    return config;
  };

  const patchClient = (client) => {
    if (!client || (typeof client !== "object" && typeof client !== "function")) return;
    if (client.__xingmangCodexChineseClient) return;
    const originalDynamic = client.getDynamicConfig;
    const originalLayer = client.getLayer;
    if (typeof originalDynamic !== "function" && typeof originalLayer !== "function") return;
    let patched = false;
    try {
      if (typeof originalDynamic === "function") {
        Object.defineProperty(client, "getDynamicConfig", {
          configurable: true,
          value: function (key) {
            const result = originalDynamic.apply(this, arguments);
            return String(key) === configId ? forceConfig(result) : result;
          },
        });
        patched = true;
      }
      if (typeof originalLayer === "function") {
        Object.defineProperty(client, "getLayer", {
          configurable: true,
          value: function (key) {
            const result = originalLayer.apply(this, arguments);
            return String(key) === configId ? forceConfig(result) : result;
          },
        });
        patched = true;
      }
      if (patched) {
        Object.defineProperty(client, "__xingmangCodexChineseClient", { value: true, configurable: true });
        state.patchedClients += 1;
        state.lastPatchAt = Date.now();
      }
    } catch {}
  };

  const patchStatsigRoot = (root) => {
    if (!root || (typeof root !== "object" && typeof root !== "function")) return;
    const clients = [root];
    try { clients.push(root.firstInstance); } catch {}
    try { clients.push(typeof root.instance === "function" ? root.instance() : root.instance); } catch {}
    try {
      if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
    } catch {}
    const seen = new Set();
    clients.forEach((client) => {
      if (!client || seen.has(client)) return;
      seen.add(client);
      patchClient(client);
      try {
        if (typeof client.getLayer === "function") forceConfig(client.getLayer(configId));
        if (typeof client.getDynamicConfig === "function") forceConfig(client.getDynamicConfig(configId, { disableExposureLog: true }));
      } catch {}
    });
  };

  const patchStatsig = () => {
    try { patchStatsigRoot(globalThis.__STATSIG__); } catch {}
    try { patchStatsigRoot(globalThis.statsig); } catch {}
    try { patchStatsigRoot(globalThis.Statsig); } catch {}
  };

  patchStatsig();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    patchStatsig();
    if (Date.now() - startedAt >= 20_000 || (state.patchedClients > 0 && state.patchedConfigs > 0)) {
      clearInterval(timer);
    }
  }, 50);

  // The config file is written by the trusted main process before launch. A
  // single delayed reload makes the registered new-document hook take effect
  // even when Codex initialized i18n before this page target was discoverable.
  // It is deliberately fire-and-forget: awaiting a long page promise through
  // CDP can be reported as “Promise was collected” by newer Chromium builds.
  try {
    const reloadMarker = "__xingmangCodexChineseLocaleReloadV2";
    if (sessionStorage.getItem(reloadMarker) !== locale) {
      sessionStorage.setItem(reloadMarker, locale);
      setTimeout(() => {
        if (document.readyState !== "loading") window.location.reload();
      }, 600);
    }
  } catch {}

  return JSON.stringify({
    status: state.patchedClients > 0 && state.patchedConfigs > 0 ? "ok" : "pending",
    configId,
    enable_i18n: true,
    locale_source: "SYSTEM",
    patchedClients: state.patchedClients,
    patchedConfigs: state.patchedConfigs,
    lastPatchAt: state.lastPatchAt,
  });
})();`

export interface CodexDesktopCdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl: string
}

const codexRendererTargetTypes = new Set(['page', 'iframe', 'webview'])

export interface CodexDesktopCdpInjectionResult {
  injectedTargets: number
  attempts: number
}

interface CdpResponse {
  id?: unknown
  error?: unknown
  result?: {
    exceptionDetails?: unknown
    result?: {
      value?: unknown
    }
  }
}

interface CdpSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void): void
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: any) => void): void
}

export interface CodexDesktopCdpDependencies {
  fetch?: typeof globalThis.fetch
  createWebSocket?: (url: string) => CdpSocket
  delay?: (milliseconds: number) => Promise<void>
}

function assertCdpPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Codex Desktop CDP 端口无效')
  }
  return port
}

export function isLoopbackHost(hostname: string): boolean {
  return loopbackHosts.has(hostname.toLowerCase())
}

export function validateCodexDesktopCdpPort(port: number): number {
  return assertCdpPort(port)
}

export function validateCodexDesktopCdpTarget(
  target: CodexDesktopCdpTarget,
  port: number,
): string | null {
  assertCdpPort(port)
  if (!target || !codexRendererTargetTypes.has(target.type.toLowerCase()) || !target.webSocketDebuggerUrl) return null
  if (/^(?:devtools|chrome-extension):/i.test(target.url)) return null
  let endpoint: URL
  try {
    endpoint = new URL(target.webSocketDebuggerUrl)
  } catch {
    return null
  }
  if (
    endpoint.protocol !== 'ws:'
    || !isLoopbackHost(endpoint.hostname)
    || endpoint.port !== String(port)
    || endpoint.username
    || endpoint.password
    || endpoint.hash
    || endpoint.search
    || !endpoint.pathname.startsWith('/devtools/')
  ) return null
  return endpoint.href
}

export function filterCodexDesktopCdpTargets(
  targets: readonly CodexDesktopCdpTarget[],
  port: number,
): CodexDesktopCdpTarget[] {
  return targets.filter((target) => validateCodexDesktopCdpTarget(target, port) !== null)
}

export function buildCodexDesktopCdpArguments(port: number): string {
  assertCdpPort(port)
  return [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-allow-origins=http://127.0.0.1:${port}`,
    '--lang=zh-CN',
  ].join(' ')
}

export function validateCodexDesktopAppUserModelId(value: string): string {
  const appId = value.trim()
  if (!/^OpenAI\.Codex(?:Beta)?_[A-Za-z0-9.]+!App$/i.test(appId)) {
    throw new Error('Codex Desktop 应用标识不可信')
  }
  return appId
}

export function getAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        if (!address || typeof address === 'string') {
          reject(new Error('无法分配 Codex Desktop CDP 端口'))
          return
        }
        resolve(assertCdpPort(address.port))
      })
    })
  })
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const appActivationScript = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class XingMangCodexAppActivation {
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  private class ApplicationActivationManager {}

  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
  }

  public static uint Activate(string appUserModelId, string arguments) {
    var manager = (IApplicationActivationManager)Activator.CreateInstance(typeof(ApplicationActivationManager));
    uint processId;
    var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    return processId;
  }
}
'@
[XingMangCodexAppActivation]::Activate($env:XINGMANG_CODEX_APP_ID, $env:XINGMANG_CODEX_ARGS) | Out-Null`

export async function activateCodexDesktopWithCdp(
  appUserModelId: string,
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Codex Desktop CDP 激活仅支持 Windows')
  const appId = validateCodexDesktopAppUserModelId(appUserModelId)
  const args = buildCodexDesktopCdpArguments(port)
  try {
    await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(appActivationScript),
    ], {
      env: {
        ...trustedCommandEnvironment(baseEnv),
        XINGMANG_CODEX_APP_ID: appId,
        XINGMANG_CODEX_ARGS: args,
      },
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    })
  } catch (error) {
    const failure = error as { stderr?: unknown; message?: unknown }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
    const message = stderr || (typeof failure.message === 'string' ? failure.message.trim() : '')
    throw new Error(`Codex Desktop 中文增强启动失败：${(message || 'Windows AppX 激活失败').slice(0, 500)}`)
  }
}

function defaultWebSocket(url: string): CdpSocket {
  const Constructor = (globalThis as unknown as {
    WebSocket?: new (endpoint: string) => CdpSocket
  }).WebSocket
  if (!Constructor) throw new Error('当前运行时不支持 CDP WebSocket')
  return new Constructor(url)
}

function cdpMessageText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return null
}

async function sendCdpCommand(
  socket: CdpSocket,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<CdpResponse> {
  if (socket.readyState !== 1) throw new Error('Codex Desktop CDP WebSocket 尚未连接')
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      cleanup()
      reject(new Error(`CDP 命令 ${method} 超时`))
    }, cdpCommandTimeoutMs)
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const onMessage = (event: any) => {
      const text = cdpMessageText(event?.data)
      if (!text || text.length > maximumCdpResponseBytes) return
      let value: CdpResponse
      try { value = JSON.parse(text) as CdpResponse } catch { return }
      if (value.id !== id) return
      cleanup()
      resolve(value)
    }
    const onError = () => {
      cleanup()
      reject(new Error(`CDP 命令 ${method} 连接失败`))
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`CDP 命令 ${method} 连接已关闭`))
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
    try {
      socket.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

async function injectTarget(
  target: CodexDesktopCdpTarget,
  port: number,
  createWebSocket: (url: string) => CdpSocket,
): Promise<{ ready: boolean }> {
  const endpoint = validateCodexDesktopCdpTarget(target, port)
  if (!endpoint) throw new Error('Codex Desktop CDP 页面地址未通过安全校验')
  const socket = createWebSocket(endpoint)
  const waitForOpen = new Promise<void>((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Codex Desktop CDP WebSocket 连接超时'))
    }, cdpCommandTimeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const onOpen = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('Codex Desktop CDP WebSocket 连接失败')) }
    const onClose = () => { cleanup(); reject(new Error('Codex Desktop CDP WebSocket 已关闭')) }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
  await waitForOpen
  try {
    let commandId = 0
    const enable = await sendCdpCommand(socket, ++commandId, 'Page.enable', {})
    if (enable.error) throw new Error('CDP Page.enable 返回错误')
    const registration = await sendCdpCommand(socket, ++commandId, 'Page.addScriptToEvaluateOnNewDocument', {
      source: codexChineseRuntimeScript,
    })
    if (registration.error) throw new Error('CDP 中文脚本注册失败')
    const evaluation = await sendCdpCommand(socket, ++commandId, 'Runtime.evaluate', {
      expression: codexChineseRuntimeScript,
      awaitPromise: false,
      returnByValue: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    })
    if (evaluation.error || evaluation.result?.exceptionDetails) {
      throw new Error('CDP 中文脚本执行失败')
    }
    const probe = await sendCdpCommand(socket, ++commandId, 'Runtime.evaluate', {
      expression: codexRendererProbeScript,
      awaitPromise: false,
      returnByValue: true,
      userGesture: false,
      allowUnsafeEvalBlockedByCSP: true,
    })
    return { ready: readRendererProbeResult(probe) }
  } finally {
    try { socket.close(1000, 'done') } catch { /* best effort */ }
  }
}

const codexRendererProbeScript = String.raw`(() => {
  const text = document.body?.innerText || "";
  return JSON.stringify({
    codexRendererProbe: true,
    hasBridge: Boolean(globalThis.electronBridge && typeof globalThis.electronBridge.sendMessageFromView === "function"),
    hasAppRoot: Boolean(document.querySelector("#root")),
    textLength: text.length,
  });
})();`

function readRendererProbeResult(response: CdpResponse): boolean {
  const value = response.result?.result?.value
  if (typeof value !== 'string') return false
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed.codexRendererProbe === true
      && parsed.hasBridge === true
      && (parsed.hasAppRoot === true || (typeof parsed.textLength === 'number' && parsed.textLength >= 40))
  } catch {
    return false
  }
}

async function probeTarget(
  target: CodexDesktopCdpTarget,
  port: number,
  createWebSocket: (url: string) => CdpSocket,
): Promise<boolean> {
  const endpoint = validateCodexDesktopCdpTarget(target, port)
  if (!endpoint) return false
  const socket = createWebSocket(endpoint)
  const waitForOpen = new Promise<void>((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Codex Desktop CDP WebSocket 连接超时'))
    }, cdpCommandTimeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const onOpen = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('Codex Desktop CDP WebSocket 连接失败')) }
    const onClose = () => { cleanup(); reject(new Error('Codex Desktop CDP WebSocket 已关闭')) }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
  await waitForOpen
  try {
    const response = await sendCdpCommand(socket, 1, 'Runtime.evaluate', {
      expression: codexRendererProbeScript,
      awaitPromise: false,
      returnByValue: true,
      userGesture: false,
      allowUnsafeEvalBlockedByCSP: true,
    })
    return readRendererProbeResult(response)
  } finally {
    try { socket.close(1000, 'probe-done') } catch { /* best effort */ }
  }
}

async function listTargets(
  port: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<CodexDesktopCdpTarget[]> {
  const response = await fetchImpl(`http://127.0.0.1:${assertCdpPort(port)}/json/list`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(cdpDiscoveryTimeoutMs),
  })
  if (!response.ok) throw new Error(`CDP 目标查询返回 HTTP ${response.status}`)
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > maximumCdpResponseBytes) throw new Error('CDP 目标响应过大')
  const value = JSON.parse(body) as unknown
  if (!Array.isArray(value)) throw new Error('CDP 目标响应格式无效')
  return value.filter((entry): entry is CodexDesktopCdpTarget => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const record = entry as Record<string, unknown>
    return typeof record.id === 'string'
      && typeof record.type === 'string'
      && typeof record.url === 'string'
      && typeof record.webSocketDebuggerUrl === 'string'
  })
}

export async function injectCodexDesktopChineseLocale(
  port: number,
  dependencies: CodexDesktopCdpDependencies = {},
): Promise<CodexDesktopCdpInjectionResult> {
  assertCdpPort(port)
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持 CDP HTTP 查询')
  const createWebSocket = dependencies.createWebSocket ?? defaultWebSocket
  const delay = dependencies.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastError: unknown = null
  let injectedTargets = 0
  const injectedTargetIds = new Set<string>()
  const deadline = Date.now() + cdpDiscoveryDeadlineMs
  for (let attempt = 1; attempt <= cdpDiscoveryAttempts && Date.now() < deadline; attempt += 1) {
    try {
      const targets = filterCodexDesktopCdpTargets(await listTargets(port, fetchImpl), port)
      for (const target of targets) {
        if (!injectedTargetIds.has(target.id)) {
          try {
            const result = await injectTarget(target, port, createWebSocket)
            injectedTargetIds.add(target.id)
            injectedTargets += 1
            if (result.ready) return { injectedTargets, attempts: attempt }
          } catch (error) {
            lastError = error
          }
        } else {
          try {
            if (await probeTarget(target, port, createWebSocket)) {
              return { injectedTargets, attempts: attempt }
            }
          } catch (error) {
            lastError = error
          }
        }
      }
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`Codex Desktop 启动后未找到可注入的页面${detail}`)
}
