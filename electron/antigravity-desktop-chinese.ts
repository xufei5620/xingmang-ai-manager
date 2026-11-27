import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isRecord } from './input-guards'

// Antigravity 桌面端显示中文：星芒自己的换字脚本，加一份随包的中文词表。
//
// 谷歌的 Antigravity 桌面端没有中文界面。词表（bundled-catalog/antigravity-zh-CN/zh-CN.json）原样拷自开源
// 插件 yuhuan-dev/antigravity-usage-monitor 的发布 tag，一个字节不改，许可是 GPL-3.0（LICENSE 同目录）。
// 星芒是专有软件，所以只把这份词表当数据读：换字的脚本是这里自己写的，不用也不抄那个插件的代码，插件本身
// 也不装（它的更新不核签名、会改快捷方式和注册表、面板按谷歌官方价折算费用，2026-11-26 读码评估过）。
//
// 这个文件只管两件事：读出并核对随包词表，把它连同换字脚本拼成一段交给 Antigravity 窗口执行的代码。
// 怎么带着本机调试口打开 Antigravity、怎么核对口是谁占着、什么时候把这段代码送进去，在 antigravity-desktop-cdp.ts。

/** 随包那份词表从哪来。换版本时整份照拷、几项一起改，测试按 sha256 钉住。 */
export const bundledAntigravityChineseSource = Object.freeze({
  repository: 'yuhuan-dev/antigravity-usage-monitor',
  tag: 'v1.5.6',
  commit: '15ca28144c5ca314049e531b09d1befa75474a9f',
  path: 'host-i18n/dist/packs/zh-CN.json',
  version: '1.0.3',
  sha256: '7d7c53e762864e1be8f49528365361b6b6f7e158702348b23f2739ef570e4453',
})

export const BUNDLED_ANTIGRAVITY_CHINESE_RELATIVE_PATH = ['bundled-catalog', 'antigravity-zh-CN', 'zh-CN.json'] as const

/** 随包词表在哪：打包版在 app.asar 里，开发版在仓库根目录下（同 Codex 型号名单）。 */
export function resolveBundledAntigravityChinesePackPath(appPath: string): string {
  return path.join(path.resolve(appPath), ...BUNDLED_ANTIGRAVITY_CHINESE_RELATIVE_PATH)
}

/**
 * 两档：light 保留「Agent、Skill、Terminal」这类常见英文词，deep 连这些也翻。客户大多不熟这些词，
 * 默认 deep（yoyo 2026-11-26「反重力默认中文」，确认时写明的就是深度）。
 */
export type AntigravityChineseDepth = 'light' | 'deep'

export interface AntigravityChinesePattern {
  source: string
  flags: '' | 'i'
  replace: string
  /** 区分大小写的句式里一定会出现的一小段原文：先看有没有它，没有就不跑正则。 */
  hint?: string
}

export interface AntigravityChineseLayer {
  exact: Record<string, string>
  patterns: AntigravityChinesePattern[]
}

export interface AntigravityChinesePack {
  version: string
  base: AntigravityChineseLayer
  modes: Record<AntigravityChineseDepth, AntigravityChineseLayer>
  /** 读的时候丢掉的条目数（长度超限、正则写法危险或编译不过）。照原样拷的词表应当是 0。 */
  rejected: number
}

export interface AntigravityChineseDictionary {
  version: string
  depth: AntigravityChineseDepth
  exact: Record<string, string>
  patterns: AntigravityChinesePattern[]
}

// 词表是外部来的数据，就算随包也按外部输入收（I5）：每一条的长度、总条数都有上限，句式必须首尾锚定，
// 不收嵌套重复这种会让正则卡死的写法。1.0.3 的实际规模是 4319 + 978 条词条、802 + 129 条句式。
const maximumPackBytes = 4 * 1024 * 1024
const maximumExactEntries = 20_000
const maximumPatterns = 3_000
const maximumKeyLength = 1_000
const maximumValueLength = 1_500
const maximumPatternSourceLength = 360
const maximumReplaceLength = 800
const maximumHintLength = 120
// `(a+)+`、`(.*x)*` 这类：括号里有重复、括号外又重复，碰上特定输入会回溯到卡死整个窗口。
const nestedQuantifierPattern = /\([^)]*[+*][^)]*\)[+*{]/
const depths: readonly AntigravityChineseDepth[] = ['light', 'deep']

function sanitizeExactMap(raw: unknown, counter: { rejected: number }): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    const cleanKey = key.trim()
    const cleanValue = typeof value === 'string' ? value.trim() : ''
    if (!cleanKey || !cleanValue || cleanKey.length > maximumKeyLength || cleanValue.length > maximumValueLength) {
      counter.rejected += 1
      continue
    }
    out[cleanKey] = cleanValue
  }
  return out
}

function sanitizePattern(raw: unknown): AntigravityChinesePattern | null {
  if (!isRecord(raw)) return null
  const { source, flags, replace, hint } = raw
  if (typeof source !== 'string' || source.length > maximumPatternSourceLength || !source.startsWith('^') || !source.endsWith('$')) return null
  if (nestedQuantifierPattern.test(source)) return null
  const cleanFlags = flags === undefined ? '' : flags
  if (cleanFlags !== '' && cleanFlags !== 'i') return null
  if (typeof replace !== 'string' || !replace || replace.length > maximumReplaceLength) return null
  try {
    new RegExp(source, cleanFlags)
  } catch {
    return null
  }
  const pattern: AntigravityChinesePattern = { source, flags: cleanFlags, replace }
  // 只给区分大小写的句式留提示：不分大小写时原文大小写可能和提示不一样，按提示筛会漏。
  if (cleanFlags === '' && typeof hint === 'string' && hint && hint.length <= maximumHintLength) pattern.hint = hint
  return pattern
}

function sanitizePatterns(raw: unknown, counter: { rejected: number }): AntigravityChinesePattern[] {
  if (!Array.isArray(raw)) return []
  const out: AntigravityChinesePattern[] = []
  for (const item of raw) {
    const pattern = sanitizePattern(item)
    if (pattern) out.push(pattern)
    else counter.rejected += 1
  }
  return out
}

function sanitizeLayer(raw: unknown, counter: { rejected: number }): AntigravityChineseLayer {
  const layer = isRecord(raw) ? raw : {}
  return { exact: sanitizeExactMap(layer.exact, counter), patterns: sanitizePatterns(layer.patterns, counter) }
}

/** 把词表文本读成结构；格式不认识（不是这一种词表、语言不对、条数超限）时抛错，调用方当作没有中文可放。 */
export function parseAntigravityChinesePack(text: string): AntigravityChinesePack {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('随包的 Antigravity 中文词表无法读取')
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.locale !== 'zh-CN' || typeof raw.version !== 'string' || !isRecord(raw.modes)) {
    throw new Error('随包的 Antigravity 中文词表格式不对')
  }
  const counter = { rejected: 0 }
  const base = sanitizeLayer(raw.base, counter)
  const modes = {
    light: sanitizeLayer(raw.modes.light, counter),
    deep: sanitizeLayer(raw.modes.deep, counter),
  }
  const exactCount = Object.keys(base.exact).length + depths.reduce((sum, depth) => sum + Object.keys(modes[depth].exact).length, 0)
  const patternCount = base.patterns.length + depths.reduce((sum, depth) => sum + modes[depth].patterns.length, 0)
  if (exactCount === 0 || exactCount > maximumExactEntries || patternCount > maximumPatterns) {
    throw new Error('随包的 Antigravity 中文词表条数异常')
  }
  return { version: raw.version, base, modes, rejected: counter.rejected }
}

/** 读随包词表并按 sha256 核对；对不上说明包被改过或拷错了，宁可不放中文。 */
export async function readBundledAntigravityChinesePack(filePath: string): Promise<AntigravityChinesePack> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size > maximumPackBytes) throw new Error('随包的 Antigravity 中文词表大小异常')
  const bytes = await fs.readFile(filePath)
  if (bytes.byteLength > maximumPackBytes) throw new Error('随包的 Antigravity 中文词表大小异常')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== bundledAntigravityChineseSource.sha256) throw new Error('随包的 Antigravity 中文词表与发布时不一致')
  return parseAntigravityChinesePack(bytes.toString('utf8'))
}

/** 按档位合成一份要用的词表：档位里的词条盖过公共部分，档位里的句式排在前面先试。 */
export function buildAntigravityChineseDictionary(pack: AntigravityChinesePack, depth: AntigravityChineseDepth = 'deep'): AntigravityChineseDictionary {
  const mode = pack.modes[depth]
  return {
    version: pack.version,
    depth,
    exact: { ...pack.base.exact, ...mode.exact },
    patterns: [...mode.patterns, ...pack.base.patterns],
  }
}

// 这些地方里的字一律不碰：客户和 AI 写的内容、代码、终端、编辑器、文件名、图标字体（图标字体靠
// 「settings」这样的英文字排出图形，换成中文图标就没了）。名字来自 Antigravity 2.x 窗口里的实际结构。
const protectedAreaSelectors = [
  '[data-xingmang-i18n-ignore]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[data-markdown-root]',
  '[data-md-table]',
  '[data-diff-type]',
  '[data-line-number]',
  '[data-uri]',
  '.monaco-editor',
  '.cm-editor',
  '.ProseMirror',
  '.xterm',
  '.markdown-body',
  '.katex',
  '.md-math-display',
  '.code-block',
  '.diff-line',
  '.view-lines',
  '.shiki',
  '.hljs',
  '.agy-sidebar-row',
  '.codicon',
  '.google-symbols',
  '[class*="material-symbols-"]',
  '[data-testid="user-message-content"]',
  '[data-testid="user-message-bubble"]',
  '[data-testid="planner-response-text"]',
  '[data-testid="progress-update-response-text"]',
  '[data-testid="ask-question-option-text"]',
  '[data-testid="browser-subagent-thinking"]',
  '[data-testid="file-title-name"]',
  '[data-testid="breadcrumb-segment"]',
  '[data-testid="vcs-commit-message"]',
  '[data-testid="comment-card-text"]',
  '[data-testid="transcript-line-text"]',
  '[data-testid="terminal-surface"]',
  '[data-testid="setup-script-output"]',
]

// 这些标签里面的文字不碰（代码、脚本、输入框里已经填的字）；它们自己的提示文字（placeholder、title）照翻。
const protectedTextTags = ['script', 'style', 'noscript', 'template', 'code', 'pre', 'textarea', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'iframe']

/**
 * 在 Antigravity 窗口里跑的换字脚本。只改文字节点的内容和 placeholder、title、aria-label 三个属性，
 * 不增删任何元素（界面是 React 管的，动元素会和它打架）；词表里的字只当文字写进去，不会被当成代码。
 * 自己写下的值记在 WeakMap 里，React 原地换回英文时能认出来再翻一次，不会把自己的改动再翻一遍。
 * 同一页面再放一次时先停掉上一份，换成新词表。
 */
const antigravityChineseRuntimeSource = String.raw`((dictionary) => {
  const stateKey = Symbol.for("xingmang.antigravityChinese");
  const previous = globalThis[stateKey];
  if (previous && typeof previous.dispose === "function") {
    try { previous.dispose(); } catch {}
  }
  const exact = new Map(Object.entries(dictionary.exact));
  const patterns = [];
  for (const item of dictionary.patterns) {
    try { patterns.push({ regex: new RegExp(item.source, item.flags), replace: item.replace, hint: item.hint || "" }); } catch {}
  }
  const protectedArea = dictionary.protectedAreaSelector;
  const protectedText = dictionary.protectedTextSelector;
  const attributeNames = ["placeholder", "title", "aria-label"];
  const maximumMatchLength = 1500;
  const writtenText = new WeakMap();
  const writtenAttributes = new WeakMap();
  const state = { runtimeVersion: 1, version: dictionary.version, depth: dictionary.depth, translated: 0, dispose: null };

  const translateValue = (value) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maximumMatchLength || !/[A-Za-z]/.test(trimmed)) return null;
    let result = exact.get(trimmed);
    if (result === undefined) {
      for (const pattern of patterns) {
        if (pattern.hint && !trimmed.includes(pattern.hint)) continue;
        if (pattern.regex.test(trimmed)) {
          result = trimmed.replace(pattern.regex, pattern.replace);
          break;
        }
      }
    }
    if (result === undefined || result === trimmed) return null;
    const start = value.indexOf(trimmed);
    return value.slice(0, start) + result + value.slice(start + trimmed.length);
  };

  const inProtectedArea = (element) => {
    try { return element.closest(protectedArea) !== null; } catch { return true; }
  };

  const translateText = (node) => {
    const value = node.nodeValue;
    if (!value || writtenText.get(node) === value) return;
    const parent = node.parentElement;
    if (!parent || inProtectedArea(parent)) return;
    try { if (parent.closest(protectedText) !== null) return; } catch { return; }
    const next = translateValue(value);
    if (next === null) return;
    writtenText.set(node, next);
    node.nodeValue = next;
    state.translated += 1;
  };

  const translateAttribute = (element, name) => {
    const value = element.getAttribute(name);
    if (!value) return;
    let written = writtenAttributes.get(element);
    if (written && written.get(name) === value) return;
    const next = translateValue(value);
    if (next === null) return;
    if (!written) {
      written = new Map();
      writtenAttributes.set(element, written);
    }
    written.set(name, next);
    element.setAttribute(name, next);
    state.translated += 1;
  };

  const translateAttributes = (element) => {
    if (inProtectedArea(element)) return;
    for (const name of attributeNames) {
      if (element.hasAttribute(name)) translateAttribute(element, name);
    }
  };

  const translateTree = (root) => {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateText(root);
      return;
    }
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (inProtectedArea(root)) return;
      translateAttributes(root);
    } else if (root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          try { if (node.matches(protectedArea)) return NodeFilter.FILTER_REJECT; } catch { return NodeFilter.FILTER_REJECT; }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) translateText(node);
      else translateAttributes(node);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") translateText(record.target);
      else if (record.type === "attributes") {
        if (record.target.nodeType === Node.ELEMENT_NODE && record.attributeName && !inProtectedArea(record.target)) {
          translateAttribute(record.target, record.attributeName);
        }
      } else {
        for (const node of record.addedNodes) translateTree(node);
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributeNames });
  state.dispose = () => observer.disconnect();
  try {
    Object.defineProperty(globalThis, stateKey, { value: state, configurable: true, writable: true });
  } catch {}
  translateTree(document);
  return JSON.stringify({ runtimeVersion: state.runtimeVersion, version: state.version, depth: state.depth, translated: state.translated });
})`

export interface AntigravityChineseInjectionResult {
  runtimeVersion: number
  version: string
  depth: AntigravityChineseDepth
  translated: number
}

/**
 * 拼出交给 Antigravity 窗口执行的整段代码（CDP Runtime.evaluate 或 Page.addScriptToEvaluateOnNewDocument）。
 * 词表经 JSON.stringify 嵌进去：JSON 本身就是合法的 JS 字面量，词表里的字只会成为字符串，执行不了。
 */
export function buildAntigravityChineseInjection(dictionary: AntigravityChineseDictionary): string {
  const payload = {
    version: dictionary.version,
    depth: dictionary.depth,
    exact: dictionary.exact,
    patterns: dictionary.patterns,
    protectedAreaSelector: protectedAreaSelectors.join(', '),
    protectedTextSelector: protectedTextTags.join(', '),
  }
  return `${antigravityChineseRuntimeSource}(${JSON.stringify(payload)})`
}

/** 读回窗口执行后的结果；不是这段脚本回的样子就当没放成。 */
export function parseAntigravityChineseInjectionResult(value: unknown): AntigravityChineseInjectionResult | null {
  if (typeof value !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { runtimeVersion, version, depth, translated } = parsed
  if (runtimeVersion !== 1 || typeof version !== 'string' || (depth !== 'light' && depth !== 'deep')) return null
  if (typeof translated !== 'number' || !Number.isInteger(translated) || translated < 0) return null
  return { runtimeVersion, version, depth, translated }
}
