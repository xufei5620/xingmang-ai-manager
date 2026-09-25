import { isValidElement, type ReactNode } from 'react'

export interface ChatLink { url: string; host: string; showHost: boolean }

// Model output can point anywhere, so a chat link is never opened: it can only
// be copied, and only when it is a web address. The host comes from URL
// parsing, so `https://xm.solov.cc@evil.example` shows evil.example, the place
// the address really leads.
export function inspectChatLink(href: string | undefined, label: string): ChatLink | null {
  if (!href) return null
  let parsed: URL
  try { parsed = new URL(href) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname
  if (!host) return null
  const text = label.trim().toLowerCase()
  return { url: parsed.href, host, showHost: !text.includes(host.toLowerCase()) }
}

export function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children)
  return ''
}
