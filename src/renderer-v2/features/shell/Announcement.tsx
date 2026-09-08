import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ElementType, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bell, Check, ExternalLink } from 'lucide-react'
import { Button, Dialog } from '../../ui'
import { readLocalPreference, writeLocalPreference } from '../app/preferences'

interface Announcement { id: string; text: string }
interface Props {
  scope: string
  read(): Promise<Announcement | null>
  open: boolean
  onClose(): void
  onOpen(): void
  onUnread(value: boolean): void
  openExternal(url: string): Promise<unknown>
  /** Official relay home used when the rich announcement exceeds the client cap. */
  noticeUrl?: string
}

interface AnnouncementError {
  message: string
  responseTooLarge: boolean
}

const announcementBlockTags = new Set([
  'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'li', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const announcementBlockElements: Record<string, ElementType> = {
  article: 'article', blockquote: 'blockquote', dd: 'dd', div: 'div', dl: 'dl', dt: 'dt',
  footer: 'footer', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', header: 'header',
  li: 'li', ol: 'ol', p: 'p', pre: 'pre', section: 'section', table: 'table', tbody: 'tbody',
  td: 'td', tfoot: 'tfoot', th: 'th', thead: 'thead', tr: 'tr', ul: 'ul',
}
const announcementSkipTags = new Set(['iframe', 'link', 'meta', 'noscript', 'object', 'script', 'style', 'svg', 'template', 'textarea'])
// Only switch to the DOMParser path for actual HTML elements. A broad
// `<[a-z]...>` check treats Markdown autolinks such as `<https://...>` as
// HTML, which makes the Markdown parser skip the whole announcement.
const announcementHtmlTagPattern = /<\s*\/?\s*(?:article|a|b|blockquote|body|br|code|dd|del|details|div|dl|dt|em|figcaption|figure|footer|h[1-6]|head|header|hr|html|i|iframe|img|input|kbd|li|link|main|meta|nav|noscript|object|ol|p|pre|section|small|span|strong|style|sub|summary|sup|svg|table|tbody|td|textarea|tfoot|th|thead|tr|u|ul)\b[^>]*>/i
const maximumAnnouncementNodes = 20_000
const maximumAnnouncementDepth = 32
const maximumNativeCssRules = 2_000
const maximumNativeCssDeclarations = 30_000
const maximumNativeCssTextLength = 4 * 1024 * 1024
const maximumNativeCssValueLength = 2 * 1024 * 1024
const maximumNativeSvgBytes = 256 * 1024
const nativeRootClassPattern = /^xm-(?:native|newapi)-[a-z0-9_-]{8,80}$/i
const nativeMarkerPattern = /^[a-z0-9._-]{1,80}$/i
const nativeHtmlTags = new Set([
  'a', 'article', 'aside', 'b', 'blockquote', 'br', 'code', 'dd', 'div', 'dl',
  'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'i', 'img', 'kbd', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])
const nativeSvgTags = new Set([
  'circle', 'clippath', 'defs', 'ellipse', 'g', 'line', 'lineargradient', 'mask',
  'path', 'polygon', 'polyline', 'radialgradient', 'rect', 'stop', 'svg',
])
const nativeDropTags = new Set([
  'audio', 'base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'meta',
  'noscript', 'object', 'script', 'select', 'source', 'template', 'textarea',
  'video',
])
const nativeSvgAttributes = new Set([
  'aria-hidden', 'class', 'clip-path', 'clip-rule', 'cx', 'cy', 'd', 'fill', 'fill-opacity',
  'fill-rule', 'focusable', 'fx', 'fy', 'gradienttransform', 'gradientunits',
  'height', 'id', 'offset', 'opacity', 'points', 'preserveaspectratio', 'r', 'refx',
  'refy', 'role', 'rx', 'ry', 'spreadmethod', 'stop-color', 'stop-opacity',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
  'transform', 'viewbox', 'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
])
const nativeHtmlAttributes = new Set([
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'class',
  'colspan', 'datetime', 'dir', 'height', 'id', 'lang', 'role', 'rowspan', 'scope',
  'title', 'width',
])
const nativeClassPattern = /^-?[_a-z][-_a-z0-9]{0,79}$/i
const nativeAttributeNamePattern = /^data-[-_a-z0-9]{1,72}$/i
const nativeAttributeValuePattern = /^[^\u0000-\u001f\u007f]{0,300}$/
const nativeIdPattern = /^[_a-z][-_:.a-z0-9]{0,127}$/i
const nativeCssPropertyPattern = /^(?:--[-_a-z0-9]{1,80}|-?[_a-z][-_a-z0-9]{0,100})$/i
const nativeCssUnsafeValuePattern = /(?:url\s*\(|image-set\s*\(|cross-fade\s*\(|(?:java|vb)script\s*:|data\s*:|https?\s*:|file\s*:|blob\s*:|@import|expression\s*\(|-moz-binding|behavior\s*:|<|>)/i
const nativeCssDataPngPattern = /url\(\s*(?:(["'])(data:image\/png;base64,[a-z0-9+/]+={0,2})\1|(data:image\/png;base64,[a-z0-9+/]+={0,2}))\s*\)/gi
const nativeSvgLocalReferencePattern = /url\(\s*#[a-z_][-_:.a-z0-9]*\s*\)/gi
const nativeIframeCsp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"
const svgNamespace = 'http://www.w3.org/2000/svg'

interface NativeSanitizerBudget {
  nodes: number
  cssRules: number
  cssDeclarations: number
}

interface NativeSanitizerContext {
  output: Document
  parser: DOMParser
  rootClass: string
  budget: NativeSanitizerBudget
}

function announcementOrigin(noticeUrl: string | undefined): string | null {
  if (!noticeUrl) return null
  try {
    const url = new URL(noticeUrl)
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

export function safeAnnouncementHref(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export function safeAnnouncementImage(value: string | null, origin: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  // Embedded SVG can contain active references. Raster data URLs are enough
  // for the relay's QR/art assets and keep the announcement inert.
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed.length <= 2_000_000 ? trimmed : null
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || url.username || url.password || !origin || url.origin !== origin) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function splitNativeSelectors(value: string): string[] {
  const selectors: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      current += character
      quote = character
      continue
    }
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    if (character === ',' && depth === 0) {
      selectors.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) selectors.push(current.trim())
  return selectors
}

export function isSafeNativeAnnouncementSelector(value: string, rootClass: string): boolean {
  if (!nativeRootClassPattern.test(rootClass) || !value || value.length > 4_096) return false
  const root = `.${rootClass}`
  const prefixes = [root, `html.dark ${root}`, `html:not(.dark) ${root}`]
  return splitNativeSelectors(value).every((selector) => prefixes.some((prefix) => {
    if (!selector.startsWith(prefix)) return false
    const next = selector.slice(prefix.length, prefix.length + 1)
    return !next || /[\s>+~.#:[(]/.test(next)
  }))
}

export function isSafeNativeAnnouncementCssValue(value: string): boolean {
  if (value.length > maximumNativeCssValueLength || value.includes('\\')) return false
  let invalidDataImage = false
  const withoutDataImages = value.replace(nativeCssDataPngPattern, (_match, _quote, quotedUrl: string | undefined, bareUrl: string | undefined) => {
    if (!safeNativePngDataUrl(quotedUrl ?? bareUrl ?? '')) invalidDataImage = true
    return ''
  })
  return !invalidDataImage && !nativeCssUnsafeValuePattern.test(withoutDataImages)
}

function sanitizeNativeClass(value: string): string {
  return value.split(/\s+/).filter((entry) => nativeClassPattern.test(entry)).slice(0, 32).join(' ')
}

function splitNativeCssDeclarations(value: string): string[] {
  const declarations: string[] = []
  let current = ''
  let depth = 0
  let quote = ''
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      current += character
      quote = character
      continue
    }
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    if (character === ';' && depth === 0) {
      if (current.trim()) declarations.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) declarations.push(current.trim())
  return declarations
}

function nativeDeclarationSeparator(value: string): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) { escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (quote) { if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (character === ':' && depth === 0) return index
  }
  return -1
}

function sanitizeNativeCssDeclarations(style: CSSStyleDeclaration, budget: NativeSanitizerBudget): string | null {
  const declarations: string[] = []
  // Iterating CSSStyleDeclaration expands `background: var(--surface)` into
  // empty longhands in Chromium. Its normalized cssText preserves the safe
  // shorthand, so split that text at top-level separators instead.
  for (const declaration of splitNativeCssDeclarations(style.cssText)) {
    if (++budget.cssDeclarations > maximumNativeCssDeclarations) return null
    const separator = nativeDeclarationSeparator(declaration)
    if (separator < 1) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const rawValue = declaration.slice(separator + 1).trim()
    const important = /\s*!important\s*$/i.test(rawValue)
    const value = important ? rawValue.replace(/\s*!important\s*$/i, '').trim() : rawValue
    if (!nativeCssPropertyPattern.test(property) || property === 'src' || !value || !isSafeNativeAnnouncementCssValue(value)) continue
    declarations.push(`${property}:${value}${important ? ' !important' : ''}`)
  }
  return declarations.join(';')
}

function sanitizeNativeInlineStyle(value: string, budget: NativeSanitizerBudget): string | null {
  if (!value || value.length > maximumNativeCssValueLength || /[<>\u0000]/.test(value)) return null
  const probe = document.createElement('span')
  probe.style.cssText = value
  return sanitizeNativeCssDeclarations(probe.style, budget)
}

function sanitizeNativeCssRules(
  rules: CSSRuleList,
  rootClass: string,
  budget: NativeSanitizerBudget,
  depth = 0,
): string | null {
  if (depth > 8) return null
  const output: string[] = []
  for (const rule of Array.from(rules)) {
    if (++budget.cssRules > maximumNativeCssRules) return null
    const styleRule = rule as CSSStyleRule
    if (typeof styleRule.selectorText === 'string' && styleRule.style) {
      if (!isSafeNativeAnnouncementSelector(styleRule.selectorText, rootClass)) continue
      const declarations = sanitizeNativeCssDeclarations(styleRule.style, budget)
      if (declarations === null) return null
      if (declarations) output.push(`${styleRule.selectorText}{${declarations}}`)
      continue
    }
    const groupingRule = rule as CSSRule & { cssRules?: CSSRuleList }
    if (!groupingRule.cssRules) continue
    const openingBrace = rule.cssText.indexOf('{')
    if (openingBrace < 0) continue
    const header = rule.cssText.slice(0, openingBrace).trim()
    if (!/^@(media|container)\s+[-_a-z0-9\s():.,/%='"\[\]]{1,300}$/i.test(header)) continue
    const nested = sanitizeNativeCssRules(groupingRule.cssRules, rootClass, budget, depth + 1)
    if (nested === null) return null
    if (nested) output.push(`${header}{${nested}}`)
  }
  return output.join('')
}

function sanitizeNativeCss(value: string, rootClass: string, budget: NativeSanitizerBudget): string | null {
  if (!value || value.length > maximumNativeCssTextLength) return null
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(value)
    return sanitizeNativeCssRules(sheet.cssRules, rootClass, budget)
  } catch {
    return null
  }
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array | null {
  const compact = value.replace(/\s+/g, '')
  if (!compact || compact.length > Math.ceil(maximumBytes / 3) * 4 + 4 || !/^[a-z0-9+/]+={0,2}$/i.test(compact)) return null
  try {
    const decoded = atob(compact)
    if (decoded.length > maximumBytes) return null
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function safeNativePngDataUrl(value: string): string | null {
  const png = /^data:image\/png;base64,([a-z0-9+/]+={0,2})$/i.exec(value.trim())
  if (!png) return null
  const bytes = decodeBase64(png[1], 1_500_000)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!bytes || bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)
    || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 && width <= 4_096 && height <= 4_096 && width * height <= 16_000_000
    ? `data:image/png;base64,${png[1]}`
    : null
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < value.length; offset += 8_192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8_192))
  }
  return btoa(binary)
}

function isSafeNativeSvgValue(value: string): boolean {
  if (value.length > 65_536 || value.includes('\\') || /[\u0000-\u001f\u007f<>]/.test(value)) return false
  const withoutLocalReferences = value.replace(nativeSvgLocalReferencePattern, '')
  return !/(?:url\s*\(|(?:java|vb)script\s*:|data\s*:|https?\s*:|file\s*:|blob\s*:|\/\/)/i.test(withoutLocalReferences)
}

function sanitizeStaticSvgElement(element: Element, budget: NativeSanitizerBudget, depth = 0): boolean {
  if (depth > maximumAnnouncementDepth || ++budget.nodes > maximumAnnouncementNodes) return false
  const tag = element.localName.toLowerCase()
  if (element.namespaceURI !== svgNamespace || !nativeSvgTags.has(tag)) return false
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    if (name === 'xmlns' && tag === 'svg' && attribute.value === svgNamespace) continue
    if (name === 'style') {
      const safeStyle = sanitizeNativeInlineStyle(attribute.value, budget)
      if (safeStyle) element.setAttribute('style', safeStyle)
      else element.removeAttribute(attribute.name)
      continue
    }
    if (!nativeSvgAttributes.has(name)
      || (name === 'id' && !nativeIdPattern.test(attribute.value))
      || !isSafeNativeSvgValue(attribute.value)) element.removeAttribute(attribute.name)
  }
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1) {
      if (!sanitizeStaticSvgElement(child as Element, budget, depth + 1)) child.remove()
    } else if (child.nodeType !== 3) child.remove()
  }
  return true
}

function sanitizeNativeSvgDataUrl(value: string, parser: DOMParser, budget: NativeSanitizerBudget): string | null {
  const match = /^data:image\/svg\+xml;base64,([a-z0-9+/=\s]+)$/i.exec(value.trim())
  if (!match) return null
  const bytes = decodeBase64(match[1], maximumNativeSvgBytes)
  if (!bytes) return null
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed = parser.parseFromString(source, 'image/svg+xml')
    const root = parsed.documentElement
    if (root.localName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror') || !sanitizeStaticSvgElement(root, budget)) return null
    root.setAttribute('xmlns', svgNamespace)
    const serialized = new XMLSerializer().serializeToString(root)
    const sanitizedBytes = new TextEncoder().encode(serialized)
    if (sanitizedBytes.length > maximumNativeSvgBytes) return null
    return `data:image/svg+xml;base64,${encodeBase64(sanitizedBytes)}`
  } catch {
    return null
  }
}

function sanitizeNativeImageDataUrl(value: string | null, parser: DOMParser, budget: NativeSanitizerBudget): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const png = safeNativePngDataUrl(trimmed.replace(/\s+/g, ''))
  if (png) return png
  return sanitizeNativeSvgDataUrl(trimmed, parser, budget)
}

function copyNativeAttributes(source: Element, target: Element, context: NativeSanitizerContext, svg: boolean): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value
    if (name.startsWith('on') || name === 'href' || name === 'src' || name === 'target' || name === 'rel') continue
    if (name === 'style') {
      const safeStyle = sanitizeNativeInlineStyle(value, context.budget)
      if (safeStyle) target.setAttribute('style', safeStyle)
      continue
    }
    if (name === 'class') {
      const safeClass = sanitizeNativeClass(value)
      if (safeClass) target.setAttribute('class', safeClass)
      continue
    }
    if (svg) {
      if (nativeSvgAttributes.has(name) && isSafeNativeSvgValue(value)) target.setAttribute(attribute.name, value)
      continue
    }
    if (name.startsWith('data-')) {
      if (name === 'data-xm-external-href') continue
      if (nativeAttributeNamePattern.test(name) && nativeAttributeValuePattern.test(value)) target.setAttribute(name, value)
      continue
    }
    if (!nativeHtmlAttributes.has(name) || !nativeAttributeValuePattern.test(value)) continue
    if (name === 'id' && !nativeIdPattern.test(value)) continue
    if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') && !/^\d{1,4}$/.test(value)) continue
    if (name === 'dir' && !/^(?:ltr|rtl|auto)$/i.test(value)) continue
    if (name === 'lang' && !/^[a-z0-9-]{1,35}$/i.test(value)) continue
    target.setAttribute(name, value)
  }
}

function cloneNativeAnnouncementNode(source: ChildNode, context: NativeSanitizerContext, depth = 0): Node[] | null {
  if (depth > maximumAnnouncementDepth || ++context.budget.nodes > maximumAnnouncementNodes) return null
  if (source.nodeType === 3) return [context.output.createTextNode(source.textContent ?? '')]
  if (source.nodeType !== 1) return []
  const element = source as Element
  const tag = element.localName.toLowerCase()
  const svg = element.namespaceURI === svgNamespace
  if (svg && !nativeSvgTags.has(tag)) return []
  if (!svg && nativeDropTags.has(tag)) return []
  if (!svg && tag === 'style') {
    const css = sanitizeNativeCss(element.textContent ?? '', context.rootClass, context.budget)
    if (css === null) return null
    if (!css) return []
    const style = context.output.createElement('style')
    copyNativeAttributes(element, style, context, false)
    style.textContent = css
    return [style]
  }
  if (!svg && !nativeHtmlTags.has(tag)) {
    const unwrapped: Node[] = []
    for (const child of Array.from(element.childNodes)) {
      const cloned = cloneNativeAnnouncementNode(child, context, depth + 1)
      if (cloned === null) return null
      unwrapped.push(...cloned)
    }
    return unwrapped
  }
  const clone = svg
    ? context.output.createElementNS(svgNamespace, element.localName)
    : context.output.createElement(tag)
  copyNativeAttributes(element, clone, context, svg)
  if (!svg && tag === 'img') {
    const src = sanitizeNativeImageDataUrl(element.getAttribute('src'), context.parser, context.budget)
    if (!src) return []
    clone.setAttribute('src', src)
    clone.setAttribute('loading', 'lazy')
    clone.setAttribute('referrerpolicy', 'no-referrer')
    const alt = (element.getAttribute('alt') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
    clone.setAttribute('alt', alt)
  }
  if (!svg && tag === 'a') {
    const href = safeAnnouncementHref(element.getAttribute('href'))
    if (href) {
      clone.setAttribute('data-xm-external-href', href)
      clone.setAttribute('role', 'link')
      clone.setAttribute('tabindex', '0')
    }
  }
  for (const child of Array.from(element.childNodes)) {
    const cloned = cloneNativeAnnouncementNode(child, context, depth + 1)
    if (cloned === null) return null
    for (const node of cloned) clone.appendChild(node)
  }
  return [clone]
}

function findNativeAnnouncementRoot(parsed: Document): { element: Element; rootClass: string } | null {
  const roots = Array.from(parsed.body.children)
  if (roots.length !== 1 || Array.from(parsed.body.childNodes).some((node) => node !== roots[0] && node.nodeType === 3 && node.textContent?.trim())) return null
  const element = roots[0]
  const marker = element.hasAttribute('data-xm-native')
    ? element.getAttribute('data-xm-native')
    : element.getAttribute('data-newapi-notice')
  if (!marker || !nativeMarkerPattern.test(marker)) return null
  const rootClass = Array.from(element.classList).find((name) => nativeRootClassPattern.test(name))
  return rootClass ? { element, rootClass } : null
}

function selectNativeAnnouncementTheme(root: Element, dark: boolean): boolean {
  const children = Array.from(root.children)
  const xmStates = children.filter((element) => element.hasAttribute('data-xm-state'))
  if (xmStates.length) {
    const wanted = dark ? 'zh-dark' : 'zh-light'
    const selected = xmStates.filter((element) => element.getAttribute('data-xm-state') === wanted)
    if (selected.length !== 1) return false
    for (const element of xmStates) {
      if (element === selected[0]) element.removeAttribute('hidden')
      else element.remove()
    }
    return true
  }
  const newApiStates = children.filter((element) => element.hasAttribute('data-newapi-theme'))
  if (!newApiStates.length) return true
  const wanted = dark ? 'dark' : 'light'
  const selected = newApiStates.filter((element) => element.getAttribute('data-newapi-theme') === wanted)
  if (selected.length !== 1) return false
  for (const element of newApiStates) {
    if (element === selected[0]) element.removeAttribute('hidden')
    else element.remove()
  }
  return true
}

export function buildNativeAnnouncementSrcDoc(text: string, dark: boolean): string | null {
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined'
    || !/\bdata-(?:xm-native|newapi-notice)\s*=/i.test(text)) return null
  try {
    const parser = new DOMParser()
    const parsed = parser.parseFromString(text, 'text/html')
    const source = findNativeAnnouncementRoot(parsed)
    if (!source || !selectNativeAnnouncementTheme(source.element, dark)) return null
    const output = document.implementation.createHTMLDocument('')
    const context: NativeSanitizerContext = {
      output,
      parser,
      rootClass: source.rootClass,
      budget: { nodes: 0, cssRules: 0, cssDeclarations: 0 },
    }
    const cloned = cloneNativeAnnouncementNode(source.element, context)
    if (!cloned || cloned.length !== 1 || cloned[0].nodeType !== 1) return null
    const cleanRoot = cloned[0] as Element
    if (!cleanRoot.classList.contains(source.rootClass)
      || (!cleanRoot.hasAttribute('data-xm-native') && !cleanRoot.hasAttribute('data-newapi-notice'))) return null
    output.documentElement.lang = (cleanRoot.getAttribute('lang') ?? 'zh-CN').slice(0, 35)
    output.documentElement.classList.toggle('dark', dark)
    output.documentElement.dataset.theme = dark ? 'dark' : 'light'
    const charset = output.createElement('meta')
    charset.setAttribute('charset', 'UTF-8')
    const csp = output.createElement('meta')
    csp.setAttribute('http-equiv', 'Content-Security-Policy')
    csp.setAttribute('content', nativeIframeCsp)
    const colorScheme = output.createElement('meta')
    colorScheme.setAttribute('name', 'color-scheme')
    colorScheme.setAttribute('content', dark ? 'dark' : 'light')
    const reset = output.createElement('style')
    reset.textContent = `html,body{box-sizing:border-box;margin:0;min-width:0;background:transparent;color-scheme:${dark ? 'dark' : 'light'}}body{overflow:auto}`
    output.head.replaceChildren(charset, csp, colorScheme, reset)
    output.body.replaceChildren(cleanRoot)
    return `<!doctype html>${output.documentElement.outerHTML}`
  } catch {
    return null
  }
}

export function announcementTextPreview(value: string): string {
  const plain = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Keep the banner useful for Markdown notices too. The full body is
    // parsed by ReactMarkdown; this bounded preview only removes syntax and
    // never attempts to interpret links or embedded content.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/(```|~~~|`|\*\*|__|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain
}

function renderAnnouncementNodes(
  nodes: readonly ChildNode[],
  openExternal: (url: string) => Promise<unknown>,
  onError: (cause: unknown) => void,
  imageOrigin: string | null,
  keyPrefix = 'notice',
  depth = 0,
  budget: { count: number } = { count: 0 },
): ReactNode[] {
  if (depth > maximumAnnouncementDepth || budget.count >= maximumAnnouncementNodes) return []
  return nodes.flatMap<ReactNode>((node, index): ReactNode[] => {
    if (++budget.count > maximumAnnouncementNodes) return []
    const key = `${keyPrefix}-${index}`
    if (node.nodeType === 3) return [node.textContent]
    if (node.nodeType !== 1) return []
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (announcementSkipTags.has(tag)) return []
    const children = renderAnnouncementNodes(
      Array.from(element.childNodes),
      openExternal,
      onError,
      imageOrigin,
      key,
      depth + 1,
      budget,
    )
    if (tag === 'br') return [<br key={key} />]
    if (tag === 'hr') return [<hr key={key} />]
    if (tag === 'a') {
      const href = safeAnnouncementHref(element.getAttribute('href'))
      if (!href) return [<span key={key}>{children}</span>]
      return [
        <a
          key={key}
          href={href}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault()
            void openExternal(href).catch(onError)
          }}
        >
          {children}
        </a>,
      ]
    }
    if (tag === 'img') {
      const alt = (element.getAttribute('alt') ?? '').trim().slice(0, 200)
      const src = safeAnnouncementImage(element.getAttribute('src'), imageOrigin)
      return src
        ? [<img key={key} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />]
        : (alt ? [<span key={key}>[图片：{alt}]</span>] : [])
    }
    if (announcementBlockTags.has(tag)) {
      const Block = announcementBlockElements[tag] ?? 'div'
      return [<Block key={key} className={`v2-announcement-${tag}`}>{children}</Block>]
    }
    if (tag === 'strong' || tag === 'b') return [<strong key={key}>{children}</strong>]
    if (tag === 'em' || tag === 'i') return [<em key={key}>{children}</em>]
    if (tag === 'code') return [<code key={key}>{children}</code>]
    return [<span key={key}>{children}</span>]
  })
}

function useAnnouncementDarkTheme(): boolean {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined
    const update = () => setDark(document.documentElement.dataset.theme === 'dark')
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    update()
    return () => observer.disconnect()
  }, [])
  return dark
}

function NativeAnnouncementFrame({
  srcDoc,
  openExternal,
  onError,
  onClose,
}: {
  srcDoc: string
  openExternal: (url: string) => Promise<unknown>
  onError: (cause: unknown) => void
  onClose?: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return undefined
    let boundDocument: Document | null = null
    const activate = (target: EventTarget | null) => {
      const closest = (target as Element | null)?.closest
      const link = typeof closest === 'function'
        ? closest.call(target, 'a[role="link"][data-xm-external-href]') as Element | null
        : null
      const href = safeAnnouncementHref(link?.getAttribute('data-xm-external-href') ?? null)
      if (href) void openExternal(href).catch(onError)
      return Boolean(href)
    }
    const click = (event: Event) => {
      event.preventDefault()
      if (activate(event.target)) event.stopPropagation()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && onClose) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (!activate(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const unbind = () => {
      boundDocument?.removeEventListener('click', click, true)
      boundDocument?.removeEventListener('keydown', keydown, true)
      boundDocument = null
    }
    const bind = () => {
      const nextDocument = frame.contentDocument
      if (!nextDocument || nextDocument === boundDocument) return
      unbind()
      boundDocument = nextDocument
      boundDocument.addEventListener('click', click, true)
      boundDocument.addEventListener('keydown', keydown, true)
    }
    frame.addEventListener('load', bind)
    bind()
    return () => {
      frame.removeEventListener('load', bind)
      unbind()
    }
  }, [srcDoc, openExternal, onError, onClose])
  return <iframe
    ref={frameRef}
    className="v2-announcement-native-frame"
    data-testid="announcement-native-frame"
    sandbox="allow-same-origin"
    referrerPolicy="no-referrer"
    srcDoc={srcDoc}
    tabIndex={0}
    title="公告正文"
  />
}

export function AnnouncementContent({
  text,
  noticeUrl,
  openExternal,
  onError,
  onClose,
}: {
  text: string
  noticeUrl?: string
  openExternal: (url: string) => Promise<unknown>
  onError: (cause: unknown) => void
  onClose?: () => void
}) {
  const dark = useAnnouncementDarkTheme()
  const nativeSrcDoc = useMemo(() => buildNativeAnnouncementSrcDoc(text, dark), [text, dark])
  if (nativeSrcDoc) return <NativeAnnouncementFrame srcDoc={nativeSrcDoc} openExternal={openExternal} onError={onError} onClose={onClose} />
  const hasHtml = announcementHtmlTagPattern.test(text)
  if (hasHtml && typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(text, 'text/html')
    return (
      <div className="v2-announcement-rich">
        {renderAnnouncementNodes(
          Array.from(parsed.body.childNodes),
          openExternal,
          onError,
          announcementOrigin(noticeUrl),
        )}
      </div>
    )
  }
  const imageOrigin = announcementOrigin(noticeUrl)
  return (
    <div className="v2-announcement-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt, src }) => {
            const safeSrc = safeAnnouncementImage(src ?? null, imageOrigin)
            return safeSrc
              ? <img src={safeSrc} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
              : <span>[图片：{alt ?? ''}]</span>
          },
          a: ({ children, href }) => {
            const safeHref = safeAnnouncementHref(href ?? null)
            return safeHref
              ? <a href={safeHref} rel="noreferrer" onClick={(event) => { event.preventDefault(); void openExternal(safeHref).catch(onError) }}>{children}</a>
              : <span>{children}</span>
          },
          input: ({ checked, type }) => type === 'checkbox'
            ? <input type="checkbox" checked={Boolean(checked)} disabled readOnly aria-hidden="true" />
            : null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Keep the transport cap meaningful while turning its expected failure mode
 * into an actionable UI state. Electron may prefix the original error with
 * "Error invoking remote method ...", so match the stable, sanitized portion
 * emitted by `readBoundedResponseText` instead of the whole message.
 */
export function formatAnnouncementError(cause: unknown): AnnouncementError {
  const raw = cause instanceof Error
    ? cause.message
    : typeof cause === 'object' && cause !== null && 'message' in cause
      ? String((cause as { message?: unknown }).message ?? '')
      : String(cause ?? '')
  // Chromium/Electron wraps rejected IPC calls with the channel name. That
  // implementation detail is useful in logs but confusing and noisy in the
  // product surface, so remove only the known wrapper and keep the payload.
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim()
  const responseTooLarge = message.includes('公告读取响应超过') && message.includes('安全上限')
  return responseTooLarge
    ? {
        responseTooLarge: true,
        message: '公告包含过大的内嵌媒体，客户端已按安全上限拦截。可打开官网查看完整公告。',
      }
    : { responseTooLarge: false, message: message || '公告读取失败' }
}

export function AnnouncementCenter({ scope, read, open, onClose, onOpen, onUnread, openExternal, noticeUrl }: Props) {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [error, setError] = useState<AnnouncementError | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [readId, setReadId] = useState(() => readLocalPreference(`xingmang-v2-notice:${scope}`))
  useEffect(() => {
    let current = true
    setAnnouncement(null); setError(null); setLoading(true)
    setReadId(readLocalPreference(`xingmang-v2-notice:${scope}`))
    void read().then((value) => { if (current) setAnnouncement(value) }).catch((cause) => { if (current) setError(formatAnnouncementError(cause)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [scope, read, attempt])
  const unread = Boolean(announcement && announcement.id !== readId)
  useEffect(() => { onUnread(unread) }, [unread, onUnread])
  function markRead() {
    if (!announcement) return
    if (!writeLocalPreference(`xingmang-v2-notice:${scope}`, announcement.id)) setError({ responseTooLarge: false, message: '本机没有保存已读状态，下次打开时可能再次提醒。' })
    setReadId(announcement.id)
  }
  const openNoticeSite = () => {
    if (!noticeUrl) return
    void openExternal(noticeUrl).catch((cause) => setError(formatAnnouncementError(cause)))
  }
  return <>
    {unread && announcement && <div className="v2-announcement-banner"><Bell size={15} /><strong>公告</strong><span>{announcementTextPreview(announcement.text) || '有一条新公告'}</span><Button size="xs" variant="ghost" onClick={onOpen}>查看</Button><Button size="xs" variant="ghost" icon={Check} aria-label="标为已读" onClick={markRead} /></div>}
    {open && <Dialog open title="公告" width={640} onClose={onClose} icon={Bell} footer={<><Button onClick={() => setAttempt((value) => value + 1)}>重新读取</Button>{announcement && <Button variant="primary" onClick={() => { markRead(); onClose() }}>标为已读</Button>}</>}>
      {loading ? <p role="status">正在读取公告</p> : error ? <div className="v2-announcement-error" role="alert"><p>{error.message}</p>{error.responseTooLarge && noticeUrl && <Button size="sm" icon={ExternalLink} onClick={openNoticeSite} testId="announcement-open-site">打开官网查看完整公告</Button>}</div> : announcement ? <AnnouncementContent text={announcement.text} noticeUrl={noticeUrl} openExternal={openExternal} onError={(cause) => setError(formatAnnouncementError(cause))} onClose={onClose} /> : <p>暂无公告</p>}
    </Dialog>}
  </>
}
