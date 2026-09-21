import { providerIds, type ProviderId } from '../../../electron/catalog';
import catalog from '../../../bundled-catalog/curated-extensions.json';

/**
 * 「星芒精选」的唯一真相源是随包的 bundled-catalog/curated-extensions.json，构建期由
 * Vite 内联进渲染 bundle——与 bundled-skills 一样是随包内容，不需要服务端、也不需要
 * 新增 IPC 通道。入选标准与复核周期见 docs/CURATED-EXTENSIONS.md。
 *
 * 这个模块只做两件事：把 JSON 收窄成带联合类型的结构，以及按页面与当前工具筛选。
 * 安装本身仍走 pages-management.tsx 既有的那一条提交路径（mutateProviderExtension /
 * addMcpServer），精选不另开一条，免得绕过主进程对命令与参数的校验。
 */

export const curatedRisks = ['local-fs-write', 'browser', 'remote-exec', 'network', 'third-party'] as const;
export type CuratedRisk = (typeof curatedRisks)[number];
export const curatedRuntimes = ['node', 'python', 'none'] as const;
export type CuratedRuntime = (typeof curatedRuntimes)[number];
export const curatedNetworkNeeds = ['none', 'npm-first-run', 'always'] as const;
export type CuratedNetworkNeed = (typeof curatedNetworkNeeds)[number];
export const curatedKinds = ['mcp', 'skill', 'plugin'] as const;
export type CuratedKind = (typeof curatedKinds)[number];

export interface CuratedInput {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
}
export type CuratedInstall =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string };
export interface CuratedExtension {
  id: string;
  kind: CuratedKind;
  name: string;
  summary: string;
  publisher: string;
  homepage: string;
  providers: ProviderId[];
  install: CuratedInstall;
  inputs: CuratedInput[];
  runtime: CuratedRuntime;
  network: CuratedNetworkNeed;
  requiresAccount: boolean;
  risks: CuratedRisk[];
  riskNote: string;
  pinnedVersion: string | null;
  verifiedAt: string;
  note: string | null;
}

// 面向用户的一句话，风险标签与说明都上屏，所以措辞不留内部代号。
export const curatedRiskLabels: Record<CuratedRisk, { label: string; detail: string }> = {
  'local-fs-write': { label: '会改你的文件', detail: '能在你指定的位置新建、修改和删除文件。' },
  browser: { label: '会操作浏览器', detail: '能自己打开网页并在上面点击、输入。' },
  'remote-exec': { label: '内容会发到对方服务器', detail: '请求由提供方在他们的服务器上处理，不在你电脑上。' },
  network: { label: '需要联网', detail: '断网时这一项用不了。' },
  'third-party': { label: '第三方维护', detail: '由该软件的作者维护，不随本应用一起更新。' },
};
export const curatedNetworkLabels: Record<CuratedNetworkNeed, string | null> = {
  none: null,
  'npm-first-run': '第一次使用时需要联网下载，之后就不用了',
  always: '每次使用都需要联网',
};
export const curatedRuntimeLabels: Record<CuratedRuntime, string> = {
  node: '在你电脑上运行，用的是本应用装好的 Node.js',
  python: '在你电脑上运行，需要 Python',
  none: '不在你电脑上装东西',
};
// 预置第三方扩展等于替它们背书，所以确认框里这句免责说明是固定文案，不按条目变。
export const curatedDisclaimer = '这些都是第三方软件，由它们各自的作者维护和更新，不随本应用一起发布。装之前请先看清它要哪些权限。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? [...(value as string[])] : null;
}
function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (providerIds as readonly string[]).includes(value);
}
function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
function parseInstall(value: unknown): CuratedInstall | null {
  if (!isRecord(value)) return null;
  if (value.type === 'http') {
    const url = text(value.url);
    return url && url.startsWith('https://') ? { type: 'http', url } : null;
  }
  if (value.type !== 'stdio') return null;
  const command = text(value.command);
  const args = stringArray(value.args);
  if (!command || !args || !isRecord(value.env)) return null;
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string') return null;
    env[name] = entry;
  }
  return { type: 'stdio', command, args, env };
}
function parseInput(value: unknown): CuratedInput | null {
  if (!isRecord(value)) return null;
  const key = text(value.key);
  const label = text(value.label);
  const placeholder = text(value.placeholder);
  const hint = text(value.hint);
  return key && label && placeholder && hint ? { key, label, placeholder, hint } : null;
}

/**
 * 清单是随包的静态数据，坏了应该在 curated-extensions.test.ts 里当场红，而不是让用户
 * 看到白屏：所以这里逐条校验、丢掉不合格的条目，而不是在模块加载时抛错。
 */
export function parseCuratedExtensions(raw: unknown): CuratedExtension[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  const parsed: CuratedExtension[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) continue;
    const id = text(entry.id);
    const kind = oneOf(curatedKinds, entry.kind);
    const name = text(entry.name);
    const summary = text(entry.summary);
    const publisher = text(entry.publisher);
    const homepage = text(entry.homepage);
    const runtime = oneOf(curatedRuntimes, entry.runtime);
    const network = oneOf(curatedNetworkNeeds, entry.network);
    const riskNote = text(entry.riskNote);
    const verifiedAt = text(entry.verifiedAt);
    const install = parseInstall(entry.install);
    const providers = Array.isArray(entry.providers) ? entry.providers.filter(isProviderId) : null;
    const risks = Array.isArray(entry.risks)
      ? entry.risks.map(risk => oneOf(curatedRisks, risk)).filter((risk): risk is CuratedRisk => risk !== null)
      : null;
    const inputs = Array.isArray(entry.inputs) ? entry.inputs.map(parseInput) : null;
    if (
      !id || !kind || !name || !summary || !publisher || !homepage || !runtime || !network || !riskNote
      || !verifiedAt || !install || !providers || providers.length === 0 || !risks || !inputs
      || inputs.some(input => input === null) || risks.length !== (entry.risks as unknown[]).length
      || providers.length !== (entry.providers as unknown[]).length
      || typeof entry.requiresAccount !== 'boolean'
      || !(entry.pinnedVersion === null || typeof entry.pinnedVersion === 'string')
      || !(entry.note === null || typeof entry.note === 'string')
    ) continue;
    parsed.push({
      id, kind, name, summary, publisher, homepage, providers, install,
      inputs: inputs as CuratedInput[],
      runtime, network, requiresAccount: entry.requiresAccount, risks, riskNote,
      pinnedVersion: entry.pinnedVersion, verifiedAt, note: entry.note,
    });
  }
  return parsed;
}

export const curatedExtensions = parseCuratedExtensions(catalog);
export const curatedCatalogVersion = typeof catalog.version === 'number' ? catalog.version : 0;
export const curatedCatalogUpdatedAt = typeof catalog.updatedAt === 'string' ? catalog.updatedAt : '';

/** 页面只展示当前 tab 的类别、且当前工具支持的那几条。 */
export function curatedItemsFor(kind: CuratedKind, provider: ProviderId): CuratedExtension[] {
  return curatedExtensions.filter(item => item.kind === kind && item.providers.includes(provider));
}

/**
 * 确认框里必须原样列出「将要执行的确切命令」，所以这里只拼展示文本，不做转义也不
 * 交给 shell——真正的执行仍是主进程的 execFile + argv 数组（I1）。
 */
export function curatedCommandText(item: CuratedExtension): string {
  if (item.install.type === 'http') return item.install.url;
  const environment = Object.entries(item.install.env).map(([name, value]) => `${name}=${value}`);
  return [...environment, item.install.command, ...item.install.args].join(' ');
}

/** 带占位符的条目走「预填表单让用户补路径」那条路，不直接安装。 */
export function curatedNeedsInput(item: CuratedExtension): boolean {
  return item.inputs.length > 0;
}
