/**
 * Names the environment variables a PowerShell profile sets, for the Windows
 * diagnostics page (深查 Shell差异 SH-5). Tutorials from other relay services
 * tell people to put `$env:ANTHROPIC_API_KEY = '…'` in their `$PROFILE`; a
 * terminal the customer opens then hands that key to the CLI, while the window
 * Xingmang opens starts with `-NoProfile` and never sees it.
 *
 * Like shell-startup-exports.ts it only reads: nothing is run, dot-sourced
 * files are not followed, and a value built from anything but the home
 * directory comes back unknown. It errs towards reporting the same way: every
 * assignment counts wherever it sits (inside a function, an `if`), and a later
 * `Remove-Item Env:…` does not take one back.
 *
 * Three forms are recognised, names compared case-insensitively as Windows does:
 * `$env:NAME = …` (and `${env:NAME}`, and the compound `+=` and the like, whose
 * value is unknown); `[Environment]::SetEnvironmentVariable('NAME', …)`; and
 * `Set-Item` / `New-Item` (and their aliases `si` / `ni`) on an `Env:` path.
 */

import type { ShellStartupExport } from './shell-startup-exports'

type Token =
  /** value null = it expands something other than the home directory. */
  | { kind: 'string'; value: string | null }
  /** The name after `$`, braces removed: `env:PATH`, `HOME`, `null`. */
  | { kind: 'variable'; name: string }
  | { kind: 'word'; text: string }
  | { kind: 'operator'; text: string }
  /** A newline, `;`, `|`, `&&`, `||`, `{` or `}`: nothing carries across it. */
  | { kind: 'end' }

const assignmentOperators = new Set(['=', '+=', '-=', '*=', '/=', '%=', '??='])
// PowerShell takes the typographic quotes a web page or a word processor puts in
// as quotes too, and a profile pasted from a tutorial is full of them.
const singleQuotes = new Set(["'", '‘', '’', '‚', '‛'])
const doubleQuotes = new Set(['"', '“', '”', '„'])
const wordStop = new Set([' ', '\t', '\r', '\n', ';', '|', '(', ')', '{', '}', '[', ']', ',', '='])
const homeVariables = new Set(['home', 'env:userprofile', 'env:home'])
const setItemCommands = new Set(['set-item', 'si', 'new-item', 'ni'])

interface Scan {
  text: string
  index: number
  tokens: Token[]
  home: string
}

function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/** The name after `$`: `env:NAME`, `global:x`, `HOME`, or the one-character `$?`, `$_`, `$$`, `$^`. */
function readVariableName(scan: Scan): string | null {
  const { text } = scan
  if (text[scan.index] === '{') {
    let name = ''
    let index = scan.index + 1
    while (index < text.length && text[index] !== '}') {
      // A backtick escapes the next character inside `${…}`.
      if (text[index] === '`' && index + 1 < text.length) index += 1
      name += text[index]
      index += 1
    }
    scan.index = index + 1
    return name
  }
  let index = scan.index
  let name = ''
  while (isNameChar(text[index])) name += text[index++]
  if (name && text[index] === ':' && isNameChar(text[index + 1])) {
    name += ':'
    index += 1
    while (isNameChar(text[index])) name += text[index++]
  }
  if (!name && '?_$^'.includes(text[index] ?? '\0')) name = text[index++]
  if (!name) return null
  scan.index = index
  return name
}

/** Skips `(…)` from the opening parenthesis at scan.index, strings and nesting included. */
function skipParentheses(scan: Scan): void {
  const { text } = scan
  let depth = 0
  while (scan.index < text.length) {
    const char = text[scan.index]
    if (char === '`') {
      scan.index += 2
      continue
    }
    if (singleQuotes.has(char) || doubleQuotes.has(char)) {
      const quote = singleQuotes.has(char) ? singleQuotes : doubleQuotes
      scan.index += 1
      while (scan.index < text.length && !quote.has(text[scan.index])) scan.index += text[scan.index] === '`' ? 2 : 1
      scan.index += 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) {
      scan.index += 1
      return
    }
    scan.index += 1
  }
}

/**
 * The body of a double-quoted string or here-string: backtick escapes, `$name`
 * and `$(…)`. Only the home directory is expanded; any other variable, a
 * subexpression or an escape that stands for a control character makes the
 * value unknown, which still counts as set.
 */
function expandDoubleQuoted(body: string, home: string): string | null {
  const scan: Scan = { text: body, index: 0, tokens: [], home }
  let result = ''
  while (scan.index < body.length) {
    const char = body[scan.index]
    if (char === '`') {
      const next = body[scan.index + 1]
      if (next === undefined) return null
      if ('0abefnrtuv'.includes(next)) return null
      result += next
      scan.index += 2
      continue
    }
    if (char === '$') {
      scan.index += 1
      if (body[scan.index] === '(') return null
      const name = readVariableName(scan)
      if (name === null) {
        result += '$'
        continue
      }
      if (!homeVariables.has(name.toLowerCase())) return null
      result += home
      continue
    }
    result += char
    scan.index += 1
  }
  return result
}

function readSingleQuoted(scan: Scan): void {
  const { text } = scan
  let index = scan.index + 1
  let value = ''
  while (index < text.length) {
    if (singleQuotes.has(text[index])) {
      // Two quotes in a row stand for one.
      if (singleQuotes.has(text[index + 1] ?? '')) {
        value += "'"
        index += 2
        continue
      }
      break
    }
    value += text[index]
    index += 1
  }
  scan.index = index + 1
  scan.tokens.push({ kind: 'string', value })
}

function readDoubleQuoted(scan: Scan): void {
  const { text } = scan
  let index = scan.index + 1
  let body = ''
  while (index < text.length) {
    const char = text[index]
    if (char === '`' && index + 1 < text.length) {
      body += char + text[index + 1]
      index += 2
      continue
    }
    if (char === '$' && text[index + 1] === '(') {
      const start = index
      const inner: Scan = { text, index: index + 1, tokens: [], home: scan.home }
      skipParentheses(inner)
      body += text.slice(start, inner.index)
      index = inner.index
      continue
    }
    if (doubleQuotes.has(char)) {
      if (doubleQuotes.has(text[index + 1] ?? '')) {
        body += '`"'
        index += 2
        continue
      }
      break
    }
    body += char
    index += 1
  }
  scan.index = index + 1
  scan.tokens.push({ kind: 'string', value: expandDoubleQuoted(body, scan.home) })
}

/** `@'…'@` and `@"…"@`: the closing marker sits at the start of its own line. */
function readHereString(scan: Scan): boolean {
  const { text } = scan
  const quote = text[scan.index + 1]
  const lineEnd = text.indexOf('\n', scan.index + 2)
  if (lineEnd === -1 || text.slice(scan.index + 2, lineEnd).trim() !== '') return false
  const closing = new RegExp(`\\n[ \\t]*${quote === "'" ? "'" : '"'}@`, 'g')
  closing.lastIndex = lineEnd
  const match = closing.exec(text)
  const end = match ? match.index : text.length
  const body = text.slice(lineEnd + 1, end).replace(/\r$/, '')
  scan.index = match ? match.index + match[0].length : text.length
  scan.tokens.push({ kind: 'string', value: quote === "'" ? body : expandDoubleQuoted(body, scan.home) })
  return true
}

function tokenize(text: string, home: string): Token[] {
  const scan: Scan = { text, index: 0, tokens: [], home }
  const end = (): void => {
    if (scan.tokens[scan.tokens.length - 1]?.kind !== 'end') scan.tokens.push({ kind: 'end' })
  }
  while (scan.index < text.length) {
    const char = text[scan.index]
    const next = text[scan.index + 1]
    if (char === '`' && (next === '\n' || (next === '\r' && text[scan.index + 2] === '\n'))) {
      // A backtick at the end of a line continues the statement on the next one.
      scan.index += next === '\r' ? 3 : 2
    } else if (char === ' ' || char === '\t' || char === '\r' || char === '﻿') {
      scan.index += 1
    } else if (char === '<' && next === '#') {
      const close = text.indexOf('#>', scan.index + 2)
      scan.index = close === -1 ? text.length : close + 2
    } else if (char === '#') {
      const lineEnd = text.indexOf('\n', scan.index)
      scan.index = lineEnd === -1 ? text.length : lineEnd
    } else if (char === '\n' || char === ';' || char === '{' || char === '}') {
      end()
      scan.index += 1
    } else if ((char === '|' || char === '&') && next === char) {
      end()
      scan.index += 2
    } else if (char === '|') {
      end()
      scan.index += 1
    } else if (char === '@' && (next === "'" || next === '"') && readHereString(scan)) {
      continue
    } else if (singleQuotes.has(char)) {
      readSingleQuoted(scan)
    } else if (doubleQuotes.has(char)) {
      readDoubleQuoted(scan)
    } else if (char === '$') {
      scan.index += 1
      if (text[scan.index] === '(') {
        skipParentheses(scan)
        scan.tokens.push({ kind: 'word', text: '$(…)' })
        continue
      }
      const name = readVariableName(scan)
      scan.tokens.push(name === null ? { kind: 'word', text: '$' } : { kind: 'variable', name })
    } else if (char === ':' && next === ':') {
      scan.tokens.push({ kind: 'operator', text: '::' })
      scan.index += 2
    } else if (char === '?' && next === '?' && text[scan.index + 2] === '=') {
      scan.tokens.push({ kind: 'operator', text: '??=' })
      scan.index += 3
    } else if ('+-*/%'.includes(char) && next === '=') {
      scan.tokens.push({ kind: 'operator', text: `${char}=` })
      scan.index += 2
    } else if ('()[],='.includes(char)) {
      scan.tokens.push({ kind: 'operator', text: char })
      scan.index += 1
    } else {
      let word = ''
      while (scan.index < text.length && !wordStop.has(text[scan.index]) && !(word && text.startsWith('::', scan.index))) {
        word += text[scan.index]
        scan.index += 1
      }
      scan.tokens.push({ kind: 'word', text: word })
    }
  }
  end()
  return scan.tokens
}

function isOperator(token: Token | undefined, text: string): boolean {
  return token?.kind === 'operator' && token.text === text
}

function isWord(token: Token | undefined, pattern: RegExp): boolean {
  return token?.kind === 'word' && pattern.test(token.text)
}

function isBoundary(token: Token | undefined): boolean {
  return token === undefined || token.kind === 'end' || (token.kind === 'operator' && (token.text === ')' || token.text === ','))
}

/** One value standing alone: a string, `$null`, a number or the home directory. Anything else is unknown. */
function singleValue(tokens: readonly Token[], position: number, home: string): string | null {
  const token = tokens[position]
  if (!isBoundary(tokens[position + 1])) return null
  if (token?.kind === 'string') return token.value
  if (token?.kind === 'variable') {
    const name = token.name.toLowerCase()
    if (name === 'null') return ''
    return homeVariables.has(name) ? home : null
  }
  if (token?.kind === 'word' && /^-?\d+$/.test(token.text)) return token.text
  return null
}

/**
 * A command argument: in argument mode a bare word is a string of its own, and the
 * next parameter may follow straight after it.
 */
function argumentValue(token: Token | undefined, home: string): string | null {
  if (token?.kind === 'string') return token.value
  if (token?.kind === 'word') return token.text.startsWith('$') ? null : token.text
  if (token?.kind === 'variable') {
    const name = token.name.toLowerCase()
    if (name === 'null') return ''
    return homeVariables.has(name) ? home : null
  }
  return null
}

function envDriveName(text: string): string | null {
  return /^env:[\\/]?([A-Za-z_][A-Za-z0-9_]*)$/i.exec(text)?.[1] ?? null
}

/** The text of a word or a literal string; null for anything that expands. */
function literalText(token: Token | undefined): string | null {
  if (token?.kind === 'word') return token.text
  if (token?.kind === 'string') return token.value
  return null
}

/** `Set-Item [-Path] Env:NAME [-Value] …`, `New-Item -Path Env: -Name NAME -Value …`. */
function setItemExport(tokens: readonly Token[], start: number, home: string): { name: string; value: string | null } | null {
  const named = new Map<string, number>()
  const positional: number[] = []
  for (let position = start; position < tokens.length && tokens[position].kind !== 'end'; position += 1) {
    const token = tokens[position]
    if (token.kind === 'word' && /^-[A-Za-z]+$/.test(token.text)) {
      const parameter = token.text.slice(1).toLowerCase()
      if (parameter === 'force' || parameter === 'passthru' || parameter === 'whatif' || parameter === 'confirm') continue
      named.set(parameter, position + 1)
      position += 1
      continue
    }
    positional.push(position)
  }
  const pathAt = named.get('path') ?? named.get('literalpath') ?? named.get('pspath') ?? positional[0]
  const valueAt = named.get('value') ?? positional[named.has('path') || named.has('literalpath') || named.has('pspath') ? 0 : 1]
  const pathText = pathAt === undefined ? null : literalText(tokens[pathAt])
  if (pathText === null) return null
  let name = envDriveName(pathText)
  if (name === null && /^env:[\\/]?$/i.test(pathText)) {
    const nameAt = named.get('name')
    const given = nameAt === undefined ? null : literalText(tokens[nameAt])
    name = given !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(given) ? given : null
  }
  if (name === null) return null
  return { name, value: valueAt === undefined ? null : argumentValue(tokens[valueAt], home) }
}

/** The arguments of a call that starts with `(` at `open`, split on top-level commas. */
function callArguments(tokens: readonly Token[], open: number): number[][] {
  const args: number[][] = [[]]
  let depth = 0
  for (let position = open; position < tokens.length; position += 1) {
    const token = tokens[position]
    if (token.kind === 'end') break
    if (token.kind === 'operator' && (token.text === '(' || token.text === '[')) {
      depth += 1
      if (depth === 1) continue
    } else if (token.kind === 'operator' && (token.text === ')' || token.text === ']')) {
      depth -= 1
      if (depth === 0) break
    } else if (depth === 1 && token.kind === 'operator' && token.text === ',') {
      args.push([])
      continue
    }
    args[args.length - 1].push(position)
  }
  return args
}

/**
 * Every assignment to one of `names` in the profile, in file order, each name
 * as given in `names`; a name set twice comes back twice. Only reads `text`.
 */
export function parsePowerShellProfileExports(
  text: string,
  names: readonly string[],
  home: string,
): ShellStartupExport[] {
  const wanted = new Map(names.map((name) => [name.toUpperCase(), name]))
  const tokens = tokenize(text, home)
  const found: ShellStartupExport[] = []
  const record = (name: string, value: string | null): void => {
    const canonical = wanted.get(name.toUpperCase())
    if (canonical) found.push({ name: canonical, value })
  }
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position]
    const following = tokens[position + 1]
    if (token.kind === 'variable' && following?.kind === 'operator' && assignmentOperators.has(following.text)) {
      const name = /^env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(token.name)?.[1]
      if (name) record(name, following.text === '=' || following.text === '??=' ? singleValue(tokens, position + 2, home) : null)
      continue
    }
    if (
      isWord(token, /^(system\.)?environment$/i)
      && isOperator(tokens[position + 1], ']')
      && isOperator(tokens[position + 2], '::')
      && isWord(tokens[position + 3], /^setenvironmentvariable$/i)
      && isOperator(tokens[position + 4], '(')
    ) {
      const [nameArg = [], valueArg = []] = callArguments(tokens, position + 4)
      const name = nameArg.length === 1 ? literalText(tokens[nameArg[0]]) : null
      if (name !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        record(name, valueArg.length === 1 ? singleValue(tokens, valueArg[0], home) : null)
      }
      continue
    }
    const atStatementStart = position === 0 || tokens[position - 1].kind === 'end'
    if (atStatementStart && token.kind === 'word' && setItemCommands.has(token.text.toLowerCase())) {
      const exported = setItemExport(tokens, position + 1, home)
      if (exported) record(exported.name, exported.value)
    }
  }
  return found
}
