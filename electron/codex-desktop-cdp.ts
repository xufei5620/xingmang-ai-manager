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
const cdpPortOwnershipRevalidateMs = 5_000

/**
 * This is deliberately a small, mechanism-level patch. It does not replace
 * Codex assets or copy a third-party implementation; it only makes the
 * already-installed official Chinese resources visible to the running
 * Chromium page when the client has not yet applied its locale flags.
 */
const codexChineseRuntimeSource = String.raw`((documentHook) => {
  const configId = "72216192";
  const previousState = globalThis.__xingmangCodexChineseLocaleState;
  if (previousState && previousState.runtimeVersion === 3) return JSON.stringify(previousState);
  const state = {
    runtimeVersion: 3,
    configId,
    patchedClients: 0,
    patchedConfigs: 0,
    lastPatchAt: 0,
    localeReads: 0,
    documentHook,
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

  let verifyingConfig = false;
  const forceConfig = (config) => {
    if (!config || (typeof config !== "object" && typeof config !== "function")) return config;
    const previousPatch = config.__xingmangCodexChineseConfigV3;
    if (previousPatch && previousPatch.state === state && previousPatch.get === config.get && typeof config.get === "function") return config;
    let patched = false;
    if (typeof config.get === "function") {
      const originalGet = config.get;
      try {
        Object.defineProperty(config, "get", {
          configurable: true,
          writable: true,
          value: function (key, fallback) {
            if (key === "enable_i18n" || key === "locale_source") {
              if (!verifyingConfig) state.localeReads += 1;
              return key === "enable_i18n" ? true : "SYSTEM";
            }
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
        patched = patched || (config.value.enable_i18n === true && config.value.locale_source === "SYSTEM");
      }
    } catch {}
    if (patched) {
      try {
        Object.defineProperty(config, "__xingmangCodexChineseConfigV3", { value: { state, get: config.get }, configurable: true });
      } catch {}
      state.patchedConfigs += 1;
      state.lastPatchAt = Date.now();
    }
    return config;
  };

  const patchClient = (client) => {
    if (!client || (typeof client !== "object" && typeof client !== "function")) return;
    const originalDynamic = client.getDynamicConfig;
    const originalLayer = client.getLayer;
    const previousPatch = client.__xingmangCodexChineseClientV3;
    if (previousPatch && previousPatch.state === state && previousPatch.getDynamicConfig === originalDynamic && previousPatch.getLayer === originalLayer) return;
    if (typeof originalDynamic !== "function" && typeof originalLayer !== "function") return;
    let patched = false;
    try {
      if (typeof originalDynamic === "function") {
        Object.defineProperty(client, "getDynamicConfig", {
          configurable: true,
          writable: true,
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
          writable: true,
          value: function (key) {
            const result = originalLayer.apply(this, arguments);
            return String(key) === configId ? forceConfig(result) : result;
          },
        });
        patched = true;
      }
      if (patched) {
        Object.defineProperty(client, "__xingmangCodexChineseClientV3", {
          value: { state, getDynamicConfig: client.getDynamicConfig, getLayer: client.getLayer },
          configurable: true,
        });
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
      const wasVerifying = verifyingConfig;
      verifyingConfig = true;
      try {
        if (typeof client.getLayer === "function") forceConfig(client.getLayer(configId, { disableExposureLog: true }));
        if (typeof client.getDynamicConfig === "function") forceConfig(client.getDynamicConfig(configId, { disableExposureLog: true }));
      } catch {} finally { verifyingConfig = wasVerifying; }
    });
  };

  // Statsig can be published after the document hook runs. Intercept plain
  // property assignments so a synchronous first locale read cannot beat the
  // polling timer; leave existing getters/setters and sealed roots alone.
  const watched = new WeakMap();
  const watchProperty = (owner, key, onValue) => {
    if (!owner || (typeof owner !== "object" && typeof owner !== "function")) return;
    let keys = watched.get(owner);
    if (!keys) { keys = new Set(); watched.set(owner, keys); }
    if (keys.has(key)) return;
    keys.add(key);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor && (!descriptor.configurable || !descriptor.writable || descriptor.get || descriptor.set)) return;
      let value = owner[key];
      Object.defineProperty(owner, key, {
        configurable: true,
        enumerable: descriptor ? descriptor.enumerable : true,
        get: () => value,
        set: (next) => { value = next; try { onValue(next); } catch {} },
      });
      onValue(value);
    } catch {}
  };
  const watchRoot = (root) => {
    patchStatsigRoot(root);
    watchProperty(root, "firstInstance", patchStatsigRoot);
    watchProperty(root, "instance", patchStatsigRoot);
  };
  ["__STATSIG__", "statsig", "Statsig"].forEach((key) => watchProperty(globalThis, key, watchRoot));

  const patchStatsig = () => {
    try { patchStatsigRoot(globalThis.__STATSIG__); } catch {}
    try { patchStatsigRoot(globalThis.statsig); } catch {}
    try { patchStatsigRoot(globalThis.Statsig); } catch {}
  };

  patchStatsig();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    patchStatsig();
    // Keep observing during startup: clients/config objects may be replaced
    // after the SDK's asynchronous initialization or an account handshake.
    if (Date.now() - startedAt >= 20_000) {
      clearInterval(timer);
    }
  }, 50);

  return JSON.stringify({
    status: state.patchedClients > 0 && state.patchedConfigs > 0 ? "ok" : "pending",
    configId,
    enable_i18n: true,
    locale_source: "SYSTEM",
    patchedClients: state.patchedClients,
    patchedConfigs: state.patchedConfigs,
    lastPatchAt: state.lastPatchAt,
  });
})`

export const codexChineseRuntimeScript = `${codexChineseRuntimeSource}(false);`
const codexChineseNewDocumentScript = `${codexChineseRuntimeSource}(true);`

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
  resolvePortOwnerProcessIds?: (port: number) => Promise<number[]>
}

export interface CodexDesktopCdpInjectionOptions extends CodexDesktopCdpDependencies {
  /**
   * PID reported by the AppX activation manager for the Codex process that was
   * started with the debugging flag. The loopback debugging port has no
   * authentication and is handed out by an advisory allocation, so the port may
   * be held by any local process that won the bind race. Nothing is sent to the
   * port until every listener on it belongs to this process.
   */
  expectedProcessId: number | null
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

/**
 * Picks a free loopback port for the debugging flag. The allocation is only
 * advisory: the listener is closed again before Codex can bind it, so any
 * local process may win that gap. Ownership of the bound port is therefore
 * verified against the activated Codex PID before anything is sent to it.
 */
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

export type CodexDesktopCdpPortOwnership = 'unbound' | 'owned' | 'foreign'

const cdpPortOwnerScript = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$port = [int]$env:XINGMANG_CODEX_CDP_PORT
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { [string]$_.OwningProcess }`

export function parseCodexDesktopCdpPortOwners(output: string): number[] {
  const owners: number[] = []
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim()
    if (!/^\d+$/.test(value)) continue
    const processId = Number(value)
    if (Number.isInteger(processId) && processId > 0 && !owners.includes(processId)) owners.push(processId)
  }
  return owners
}

/**
 * `unbound` means nothing listens on the port yet, which is the normal state
 * while Codex is still starting. Every listener must belong to the process we
 * activated: the query filters by local port only, so a second listener on
 * another local address is a different peer answering on the same port.
 */
export function classifyCodexDesktopCdpPortOwnership(
  owners: readonly number[],
  expectedProcessId: number,
): CodexDesktopCdpPortOwnership {
  if (!owners.length) return 'unbound'
  return owners.every((owner) => owner === expectedProcessId) ? 'owned' : 'foreign'
}

export async function resolveCodexDesktopCdpPortOwners(
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<number[]> {
  assertCdpPort(port)
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShellCommand(cdpPortOwnerScript),
  ], {
    env: {
      ...trustedCommandEnvironment(baseEnv),
      XINGMANG_CODEX_CDP_PORT: String(port),
    },
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  })
  return parseCodexDesktopCdpPortOwners(stdout)
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const appActivationScript = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
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
[XingMangCodexAppActivation]::Activate($env:XINGMANG_CODEX_APP_ID, $env:XINGMANG_CODEX_ARGS)`

export function parseCodexDesktopActivationProcessId(output: string): number | null {
  const normalized = output.trim()
  if (!/^\d+$/.test(normalized)) return null
  const processId = Number(normalized)
  return Number.isInteger(processId) && processId > 0 ? processId : null
}

export async function activateCodexDesktopWithCdp(
  appUserModelId: string,
  port: number,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  try {
    return await activateCodexDesktop(appUserModelId, buildCodexDesktopCdpArguments(port), baseEnv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Codex Desktop 中文增强启动失败：${message.slice(0, 500)}`)
  }
}

/**
 * Activates the registered AppX application through the Windows activation
 * manager and returns the PID reported by AppModel.  Unlike the CDP variant,
 * this path does not add browser/debugging flags; it is used for ordinary
 * launches where we still need a reliable PID even if WMI temporarily hides
 * the packaged executable path.
 */
export async function activateCodexDesktop(
  appUserModelId: string,
  argumentsValue = '',
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  if (process.platform !== 'win32') throw new Error('Codex Desktop AppX 激活仅支持 Windows')
  const appId = validateCodexDesktopAppUserModelId(appUserModelId)
  if (argumentsValue.includes('\0') || argumentsValue.length > 2_048) {
    throw new Error('Codex Desktop 激活参数无效')
  }
  try {
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(appActivationScript),
    ], {
      env: {
        ...trustedCommandEnvironment(baseEnv),
        XINGMANG_CODEX_APP_ID: appId,
        XINGMANG_CODEX_ARGS: argumentsValue,
      },
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    })
    return parseCodexDesktopActivationProcessId(stdout)
  } catch (error) {
    const failure = error as { stderr?: unknown; message?: unknown }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
    const message = stderr || (typeof failure.message === 'string' ? failure.message.trim() : '')
    throw new Error(`Codex Desktop AppX 激活失败：${(message || 'Windows AppX 激活失败').slice(0, 500)}`)
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
  reloadState: { attempted: boolean; previousDocument: number | null },
): Promise<CdpInjectionSession> {
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
  try {
    await waitForOpen
    let commandId = 0
    const enable = await sendCdpCommand(socket, ++commandId, 'Page.enable', {})
    if (enable.error) throw new Error('CDP Page.enable 返回错误')
    const registration = await sendCdpCommand(socket, ++commandId, 'Page.addScriptToEvaluateOnNewDocument', {
      source: codexChineseNewDocumentScript,
    })
    if (registration.error) throw new Error('CDP 中文脚本注册失败')
    const applyRuntime = async () => {
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
    }
    const inspectRuntime = async () => readRendererProbeResult(await sendCdpCommand(socket, ++commandId, 'Runtime.evaluate', {
      expression: codexRendererProbeScript,
      awaitPromise: false,
      returnByValue: true,
      userGesture: false,
      allowUnsafeEvalBlockedByCSP: true,
    }))
    await applyRuntime()
    return {
      endpoint,
      close: () => { try { socket.close(1000, 'done') } catch { /* best effort */ } },
      inspect: async () => {
        let probe = await inspectRuntime()
        // A navigation can replace the document without changing its target
        // id or socket endpoint. Recover a missing hook in the live context
        // instead of repeatedly probing the same unpatched page.
        if (!probe.patchInstalled && probe.documentIdentity !== null) {
          await applyRuntime()
          probe = await inspectRuntime()
        }
        if (reloadState.previousDocument !== null) {
          // Page.reload can acknowledge before navigation begins. Reads in
          // the old document, including on a reconnected socket, must never
          // satisfy verification for the replacement document.
          if (probe.documentIdentity === null || probe.documentIdentity === reloadState.previousDocument) {
            return { ...probe, ready: false }
          }
          reloadState.previousDocument = null
        }
        if (probe.ready) return probe
        // Keep the same CDP session (and its new-document hook) alive across
        // reload. A ready renderer alone says nothing about its locale.
        // Slow document loading must not consume the only reload attempt.
        if (!reloadState.attempted && probe.rendererReady && probe.documentReady && probe.patchReady && probe.documentIdentity !== null) {
          reloadState.attempted = true
          reloadState.previousDocument = probe.documentIdentity
          const reload = await sendCdpCommand(socket, ++commandId, 'Page.reload', { ignoreCache: false })
          if (reload.error) throw new Error('CDP 中文配置重新加载失败')
          // The current execution context belongs to the old document. Do
          // not treat its successful probe as proof for the replacement
          // document; the next bounded discovery pass must observe the hook
          // and locale reads after navigation has settled.
          return {
            ...probe,
            ready: false,
            rendererReady: false,
            documentReady: false,
            patchReady: false,
          }
        }
        return probe
      },
    }
  } catch (error) {
    try { socket.close(1000, 'done') } catch { /* best effort */ }
    throw error
  }
}

interface CdpRendererProbe {
  ready: boolean
  rendererReady: boolean
  documentReady: boolean
  patchReady: boolean
  patchInstalled: boolean
  documentIdentity: number | null
}

interface CdpInjectionSession {
  endpoint: string
  inspect(): Promise<CdpRendererProbe>
  close(): void
}

const codexRendererProbeScript = String.raw`(() => {
  const text = document.body?.innerText || "";
  const state = globalThis.__xingmangCodexChineseLocaleState;
  return JSON.stringify({
    codexRendererProbe: true,
    hasBridge: Boolean(globalThis.electronBridge && typeof globalThis.electronBridge.sendMessageFromView === "function"),
    hasAppRoot: Boolean(document.querySelector("#root")),
    textLength: text.length,
    documentReady: document.readyState !== "loading",
    documentIdentity: performance.timeOrigin,
    patchInstalled: Boolean(state && state.runtimeVersion === 3),
    patchReady: Boolean(state && state.patchedClients > 0 && state.patchedConfigs > 0),
    localeReadObserved: Boolean(state && state.localeReads > 0),
    navigatorLocale: navigator.language,
  });
})();`

function readRendererProbeResult(response: CdpResponse): CdpRendererProbe {
  const unavailable = { ready: false, rendererReady: false, documentReady: false, patchReady: false, patchInstalled: false, documentIdentity: null }
  if (response.error || response.result?.exceptionDetails) return unavailable
  const value = response.result?.result?.value
  if (typeof value !== 'string') return unavailable
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const rendererReady = parsed.codexRendererProbe === true
      && parsed.hasBridge === true
      && (parsed.hasAppRoot === true || (typeof parsed.textLength === 'number' && parsed.textLength >= 40))
    const patchReady = parsed.patchReady === true && parsed.navigatorLocale === 'zh-CN'
    const documentReady = parsed.documentReady === true
    const patchInstalled = parsed.patchInstalled === true
    const documentIdentity = typeof parsed.documentIdentity === 'number' && Number.isFinite(parsed.documentIdentity) && parsed.documentIdentity > 0
      ? parsed.documentIdentity : null
    return {
      ready: rendererReady && documentReady && patchInstalled && patchReady && documentIdentity !== null && parsed.localeReadObserved === true,
      rendererReady,
      documentReady,
      patchReady,
      patchInstalled,
      documentIdentity,
    }
  } catch {
    return unavailable
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
  options: CodexDesktopCdpInjectionOptions,
): Promise<CodexDesktopCdpInjectionResult> {
  assertCdpPort(port)
  const expectedProcessId = options.expectedProcessId
  if (expectedProcessId === null || !Number.isInteger(expectedProcessId) || expectedProcessId <= 0) {
    throw new Error('未取得 Codex Desktop 进程号，无法确认调试端口归属')
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持 CDP HTTP 查询')
  const createWebSocket = options.createWebSocket ?? defaultWebSocket
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const resolvePortOwnerProcessIds = options.resolvePortOwnerProcessIds ?? resolveCodexDesktopCdpPortOwners
  let ownershipVerifiedAt = 0
  // Re-reading the TCP table costs a PowerShell start, so a confirmation is
  // reused for a short while instead of running on every discovery attempt.
  const inspectPortOwnership = async (): Promise<CodexDesktopCdpPortOwnership> => {
    if (ownershipVerifiedAt && Date.now() - ownershipVerifiedAt < cdpPortOwnershipRevalidateMs) return 'owned'
    const ownership = classifyCodexDesktopCdpPortOwnership(await resolvePortOwnerProcessIds(port), expectedProcessId)
    if (ownership === 'foreign') {
      throw new Error(`Codex Desktop 调试端口 ${port} 被其他进程占用，已取消中文增强`)
    }
    if (ownership === 'owned') ownershipVerifiedAt = Date.now()
    return ownership
  }
  let lastError: unknown = null
  let injectedTargets = 0
  const sessions = new Map<string, CdpInjectionSession>()
  const reloadStates = new Map<string, { attempted: boolean; previousDocument: number | null }>()
  let rendererFound = false
  const deadline = Date.now() + cdpDiscoveryDeadlineMs
  try {
    for (let attempt = 1; attempt <= cdpDiscoveryAttempts && Date.now() < deadline; attempt += 1) {
      // A squatted port must abort the whole injection: retrying would only
      // keep handing the payload to whoever answers on it.
      if (await inspectPortOwnership() === 'unbound') {
        lastError = new Error('Codex Desktop 调试端口尚未就绪')
        await delay(500)
        continue
      }
      try {
        const priority: Record<string, number> = { page: 0, iframe: 1, webview: 2 }
        const targets = filterCodexDesktopCdpTargets(await listTargets(port, fetchImpl), port)
          .sort((left, right) => priority[left.type.toLowerCase()]! - priority[right.type.toLowerCase()]!)
        const visibleIds = new Set(targets.map((target) => target.id))
        for (const [id, session] of sessions) {
          if (!visibleIds.has(id)) {
            session.close()
            sessions.delete(id)
          }
        }
        for (const target of targets) {
          try {
            let session = sessions.get(target.id)
            if (session && session.endpoint !== validateCodexDesktopCdpTarget(target, port)) {
              session.close()
              sessions.delete(target.id)
              session = undefined
            }
            if (!session) {
              const identity = `${target.id}:${target.webSocketDebuggerUrl}`
              const reloadState = reloadStates.get(identity) ?? { attempted: false, previousDocument: null }
              reloadStates.set(identity, reloadState)
              session = await injectTarget(target, port, createWebSocket, reloadState)
              sessions.set(target.id, session)
              injectedTargets += 1
            }
            const result = await session.inspect()
            rendererFound ||= result.rendererReady
            if (result.ready) return { injectedTargets, attempts: attempt }
          } catch (error) {
            lastError = error
            // A crashed/replaced renderer needs a fresh registration. Keeping
            // a stale target id in a set used to prevent all later retries.
            sessions.get(target.id)?.close()
            sessions.delete(target.id)
          }
        }
      } catch (error) {
        lastError = error
      }
      await delay(500)
    }
  } finally {
    for (const session of sessions.values()) session.close()
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  if (rendererFound) throw new Error(`Codex Desktop 页面已启动，但未确认中文配置生效${detail}`)
  throw new Error(`Codex Desktop 启动后未找到可注入的页面${detail}`)
}
