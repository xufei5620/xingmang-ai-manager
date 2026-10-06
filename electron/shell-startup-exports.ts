/**
 * Names the variables a shell startup file (~/.zshrc and the like) leaves
 * exported, for the macOS diagnostics page (已知45). It walks words, quotes,
 * comments, here-documents and command separators the way zsh, bash and fish
 * would, and stops there: nothing is run, sourced files are not followed, and
 * a value built from anything but the home directory comes back unknown.
 *
 * It errs towards reporting. Every export of a wanted name counts, wherever
 * it sits (inside a function, an `if`, a `case`), and an `unset` or `set -e`
 * does not take one back: a helper like `use_relay() { export …; }` written
 * above `use_official() { unset …; }` reads as unset from top to bottom,
 * while the customer's terminal may well be holding the export.
 */

export type ShellStartupDialect = 'posix' | 'fish'

export interface ShellStartupExport {
  name: string
  /**
   * What this line gives it, with `$HOME`, `${HOME}` and an unquoted leading
   * `~` replaced by the home directory. null = it depends on something the
   * file does not spell out (another variable, a command), so only the name
   * can be judged.
   */
  value: string | null
}

type Piece =
  | { kind: 'text'; text: string; quoted: boolean }
  | { kind: 'home' }
  | { kind: 'unknown' }

type Word = Piece[]

interface Heredoc {
  delimiter: string
  stripTabs: boolean
}

interface Scan {
  text: string
  index: number
  dialect: ShellStartupDialect
  commands: Word[][]
  words: Word[]
  word: Word | null
  heredocs: Heredoc[]
}

interface Assignment {
  name: string
  /** `NAME+=value` adds to whatever was there before. */
  append: boolean
  value: Word
}

interface ExportState {
  wanted: ReadonlySet<string>
  home: string
  found: ShellStartupExport[]
  /** Values given without an export, for a later bare `export NAME`. */
  assigned: Map<string, string | null>
  exported: Set<string>
  /** `set -a` / `setopt allexport`: every plain assignment is exported. */
  allExport: boolean
}

const homePiece: Piece = { kind: 'home' }
const unknownPiece: Piece = { kind: 'unknown' }
const variableNamePattern = /[A-Za-z_][A-Za-z0-9_]*/y

// Words that can open a command without being the command: `then export …`,
// `{ export …; }`, `and set -gx …`.
const posixLeadingKeywords = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'builtin', 'command'])
const fishLeadingKeywords = new Set(['if', 'else', 'while', 'and', 'or', 'not', '!', 'begin', 'builtin', 'command'])

// fish's long options for `set`, as the short letter each one stands for.
const fishSetLongOptions: ReadonlyMap<string, string> = new Map([
  ['export', 'x'],
  ['unexport', 'u'],
  ['erase', 'e'],
  ['query', 'q'],
  ['names', 'n'],
  ['show', 'S'],
  ['long', 'L'],
  ['append', 'a'],
  ['prepend', 'p'],
])

function appendPiece(scan: Scan, piece: Piece): void {
  scan.word ??= []
  const last = scan.word[scan.word.length - 1]
  if (piece.kind === 'text' && last?.kind === 'text' && last.quoted === piece.quoted) last.text += piece.text
  else scan.word.push(piece.kind === 'text' ? { ...piece } : piece)
}

function endWord(scan: Scan): void {
  if (scan.word) scan.words.push(scan.word)
  scan.word = null
}

function endCommand(scan: Scan): void {
  endWord(scan)
  if (scan.words.length) scan.commands.push(scan.words)
  scan.words = []
}

function isSeparator(char: string, dialect: ShellStartupDialect): boolean {
  // In fish, parentheses are command substitutions, never separators.
  return ';&|<>'.includes(char) || (dialect === 'posix' && (char === '(' || char === ')'))
}

function readEscape(scan: Scan): void {
  const next = scan.text[scan.index + 1]
  scan.index += 2
  // A backslash before a newline joins the two lines.
  if (next === undefined || next === '\n') return
  // fish turns \n, \t, \x41 and the like into other characters; which one
  // does not matter for a variable that should hold a key, a URL or a folder.
  if (scan.dialect === 'fish' && /[A-Za-z0-9]/.test(next)) appendPiece(scan, unknownPiece)
  else appendPiece(scan, { kind: 'text', text: next, quoted: true })
}

function readSingleQuoted(scan: Scan): void {
  const { text } = scan
  let index = scan.index + 1
  let value = ''
  while (index < text.length && text[index] !== "'") {
    // sh has no escapes between single quotes; fish has exactly two.
    if (scan.dialect === 'fish' && text[index] === '\\' && (text[index + 1] === "'" || text[index + 1] === '\\')) {
      value += text[index + 1]
      index += 2
      continue
    }
    value += text[index]
    index += 1
  }
  scan.index = index + 1
  appendPiece(scan, { kind: 'text', text: value, quoted: true })
}

function quotedEnd(text: string, index: number, dialect: ShellStartupDialect): number {
  const quote = text[index]
  let cursor = index + 1
  while (cursor < text.length && text[cursor] !== quote) {
    cursor += text[cursor] === '\\' && (quote === '"' || dialect === 'fish') ? 2 : 1
  }
  return cursor + 1
}

/** Skips `(…)` or `{…}` starting at scan.index, quotes and nesting included. */
function skipBalanced(scan: Scan, open: string, close: string): void {
  const { text } = scan
  let depth = 0
  let index = scan.index
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      index = quotedEnd(text, index, scan.dialect)
      continue
    }
    if (char === open) depth += 1
    else if (char === close && --depth === 0) {
      scan.index = index + 1
      return
    }
    index += 1
  }
  scan.index = text.length
}

function skipBackticks(scan: Scan): void {
  let index = scan.index + 1
  while (index < scan.text.length && scan.text[index] !== '`') index += scan.text[index] === '\\' ? 2 : 1
  scan.index = index + 1
}

function readDollar(scan: Scan, quoted: boolean): void {
  const { text } = scan
  const next = text[scan.index + 1] ?? ''
  if (next === '(') {
    scan.index += 1
    skipBalanced(scan, '(', ')')
    appendPiece(scan, unknownPiece)
    return
  }
  if (next === '{' && scan.dialect === 'posix') {
    const start = scan.index + 2
    scan.index += 1
    skipBalanced(scan, '{', '}')
    appendPiece(scan, text.slice(start, scan.index - 1) === 'HOME' ? homePiece : unknownPiece)
    return
  }
  if (next === "'" && !quoted && scan.dialect === 'posix') {
    // $'…' quoting, with backslash escapes inside.
    let index = scan.index + 2
    while (index < text.length && text[index] !== "'") index += text[index] === '\\' ? 2 : 1
    scan.index = index + 1
    appendPiece(scan, unknownPiece)
    return
  }
  variableNamePattern.lastIndex = scan.index + 1
  const name = variableNamePattern.exec(text)?.[0]
  if (name) {
    scan.index += 1 + name.length
    appendPiece(scan, name === 'HOME' ? homePiece : unknownPiece)
    return
  }
  if (scan.dialect === 'posix' && next !== '' && '0123456789@*#?$!-'.includes(next)) {
    scan.index += 2
    appendPiece(scan, unknownPiece)
    return
  }
  // A `$` before a space, a slash or the end of the word is just a dollar sign.
  scan.index += 1
  appendPiece(scan, { kind: 'text', text: '$', quoted })
}

function readDoubleQuoted(scan: Scan): void {
  const { text } = scan
  scan.index += 1
  // An empty "" still makes a word: `export NAME=""` sets NAME to nothing.
  appendPiece(scan, { kind: 'text', text: '', quoted: true })
  while (scan.index < text.length) {
    const char = text[scan.index]
    if (char === '"') {
      scan.index += 1
      return
    }
    if (char === '\\') {
      const next = text[scan.index + 1]
      if (next === '\n') {
        scan.index += 2
        continue
      }
      if (next !== undefined && '$`"\\'.includes(next)) {
        scan.index += 2
        appendPiece(scan, { kind: 'text', text: next, quoted: true })
        continue
      }
    } else if (char === '$') {
      readDollar(scan, true)
      continue
    } else if (char === '`' && scan.dialect === 'posix') {
      skipBackticks(scan)
      appendPiece(scan, unknownPiece)
      continue
    }
    scan.index += 1
    appendPiece(scan, { kind: 'text', text: char, quoted: true })
  }
}

function readHeredocOperator(scan: Scan): void {
  const { text } = scan
  endWord(scan)
  let index = scan.index + 2
  const stripTabs = text[index] === '-'
  if (stripTabs) index += 1
  while (text[index] === ' ' || text[index] === '\t') index += 1
  let delimiter = ''
  // `\r` stays part of the word, as it does for the shell, so a file saved
  // with Windows line endings still finds its `EOF\r` line.
  while (index < text.length && !' \t\n;&|()<>'.includes(text[index])) {
    const char = text[index]
    if (char === "'" || char === '"') {
      const end = quotedEnd(text, index, scan.dialect)
      delimiter += text.slice(index + 1, end - 1)
      index = end
      continue
    }
    if (char === '\\') {
      delimiter += text[index + 1] ?? ''
      index += 2
      continue
    }
    delimiter += char
    index += 1
  }
  scan.index = index
  if (delimiter) scan.heredocs.push({ delimiter, stripTabs })
}

/**
 * A here-document's body is data, not commands, and an apostrophe in it
 * would otherwise open a quote that swallows the rest of the file.
 */
function skipHeredocBodies(scan: Scan): void {
  for (const heredoc of scan.heredocs.splice(0)) {
    while (scan.index < scan.text.length) {
      const end = scan.text.indexOf('\n', scan.index)
      const stop = end === -1 ? scan.text.length : end
      const line = scan.text.slice(scan.index, stop)
      scan.index = stop + 1
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break
    }
  }
}

function splitCommands(text: string, dialect: ShellStartupDialect): Word[][] {
  const scan: Scan = { text, index: 0, dialect, commands: [], words: [], word: null, heredocs: [] }
  while (scan.index < text.length) {
    const char = text[scan.index]
    if (char === '\\') readEscape(scan)
    else if (char === "'") readSingleQuoted(scan)
    else if (char === '"') readDoubleQuoted(scan)
    else if (char === '$') readDollar(scan, false)
    else if (char === '`' && dialect === 'posix') {
      skipBackticks(scan)
      appendPiece(scan, unknownPiece)
    } else if (char === '(' && dialect === 'fish') {
      skipBalanced(scan, '(', ')')
      appendPiece(scan, unknownPiece)
    } else if (char === '#' && scan.word === null) {
      const end = text.indexOf('\n', scan.index)
      scan.index = end === -1 ? text.length : end
    } else if (char === ' ' || char === '\t' || (char === '\r' && dialect === 'fish')) {
      // sh keeps a carriage return inside the word (a file saved with Windows
      // line endings gives `value\r`); fish reads it as a space.
      endWord(scan)
      scan.index += 1
    } else if (char === '\n') {
      endCommand(scan)
      scan.index += 1
      skipHeredocBodies(scan)
    } else if (dialect === 'posix' && text.startsWith('<<', scan.index) && !text.startsWith('<<<', scan.index)) {
      readHeredocOperator(scan)
    } else if (isSeparator(char, dialect)) {
      endCommand(scan)
      scan.index += 1
    } else {
      scan.index += 1
      appendPiece(scan, { kind: 'text', text: char, quoted: false })
    }
  }
  endCommand(scan)
  return scan.commands
}

/** The word as plain text, or null when part of it is an expansion. */
function wordText(word: Word): string | null {
  let text = ''
  for (const piece of word) {
    if (piece.kind !== 'text') return null
    text += piece.text
  }
  return text
}

function isVariableName(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
}

/**
 * `NAME=value`. A statement of its own needs NAME unquoted, or the shell
 * runs it as a command; an argument to `export` may be quoted whole.
 */
function splitAssignment(word: Word, nameMustBeUnquoted: boolean): Assignment | null {
  let name = ''
  for (const [position, piece] of word.entries()) {
    if (piece.kind !== 'text' || (nameMustBeUnquoted && piece.quoted)) return null
    const equals = piece.text.indexOf('=')
    if (equals === -1) {
      name += piece.text
      continue
    }
    name += piece.text.slice(0, equals)
    const append = name.endsWith('+')
    if (append) name = name.slice(0, -1)
    if (!isVariableName(name)) return null
    const rest = piece.text.slice(equals + 1)
    return { name, append, value: [...(rest ? [{ ...piece, text: rest }] : []), ...word.slice(position + 1)] }
  }
  return null
}

function evaluate(value: Word, home: string): string | null {
  let result = ''
  for (const [position, piece] of value.entries()) {
    if (piece.kind === 'unknown') return null
    if (piece.kind === 'home') {
      result += home
      continue
    }
    // Only an unquoted `~` that opens the value, alone or before a slash,
    // stands for the home directory; `~alex` and a quoted "~" do not.
    if (position === 0 && !piece.quoted && ((piece.text === '~' && value.length === 1) || piece.text.startsWith('~/'))) {
      result += home + piece.text.slice(1)
      continue
    }
    result += piece.text
  }
  return result
}

function assignmentValue(assignment: Assignment, home: string): string | null {
  return assignment.append ? null : evaluate(assignment.value, home)
}

function record(state: ExportState, name: string, value: string | null): void {
  state.exported.add(name)
  if (state.wanted.has(name)) state.found.push({ name, value })
}

function assign(state: ExportState, name: string, value: string | null): void {
  if (state.allExport || state.exported.has(name)) record(state, name, value)
  else state.assigned.set(name, value)
}

/** `export NAME`: the value is whatever an earlier line of this file gave it. */
function exportBareName(state: ExportState, name: string): void {
  if (state.exported.has(name)) return
  state.exported.add(name)
  if (state.assigned.has(name)) record(state, name, state.assigned.get(name) ?? null)
}

function commandWords(words: Word[], dialect: ShellStartupDialect): Word[] {
  const keywords = dialect === 'fish' ? fishLeadingKeywords : posixLeadingKeywords
  let position = 0
  while (position < words.length) {
    const text = wordText(words[position]) ?? ''
    // `function name {` opens a body whose first command may share the line.
    if (dialect === 'posix' && text === 'function') position += 2
    else if (keywords.has(text)) position += 1
    else break
  }
  return words.slice(position)
}

/** export, typeset and declare (and fish's `export` function, which takes the same form). */
function declarationCommand(head: string, args: Word[], state: ExportState): void {
  let exporting = head === 'export'
  let position = 0
  for (; position < args.length; position += 1) {
    const option = wordText(args[position])
    if (option === null || !/^[-+]./.test(option)) break
    if (option === '--') {
      position += 1
      break
    }
    // export -n takes the export away, -f and -p are about functions and
    // listing; typeset +x unexports, -f/-F deal with functions.
    if (head === 'export' ? /[nfp]/.test(option) : (option.startsWith('+') && option.includes('x')) || /f/i.test(option)) return
    if (option.startsWith('-') && option.includes('x')) exporting = true
  }
  for (const word of args.slice(position)) {
    const assignment = splitAssignment(word, false)
    if (assignment) {
      const value = assignmentValue(assignment, state.home)
      if (exporting) record(state, assignment.name, value)
      else assign(state, assignment.name, value)
      continue
    }
    const name = wordText(word)
    if (exporting && name !== null && isVariableName(name)) exportBareName(state, name)
  }
}

function allExportSwitch(head: string, args: readonly (string | null)[]): boolean | null {
  if (head === 'setopt' || head === 'unsetopt') {
    const named = args.some((arg) => arg !== null && /^(no_?)?all_?export$/i.test(arg))
    if (!named) return null
    const negated = args.some((arg) => arg !== null && /^no_?all_?export$/i.test(arg))
    return (head === 'setopt') !== negated
  }
  for (const [position, arg] of args.entries()) {
    if (arg === null) continue
    if (/^[-+][a-z]*a[a-z]*$/.test(arg)) return arg.startsWith('-')
    if ((arg === '-o' || arg === '+o') && args[position + 1] === 'allexport') return arg === '-o'
  }
  return null
}

function interpretPosix(words: Word[], state: ExportState): void {
  const head = wordText(words[0])
  if (head === 'export' || head === 'typeset' || head === 'declare') {
    declarationCommand(head, words.slice(1), state)
    return
  }
  if (head === 'set' || head === 'setopt' || head === 'unsetopt') {
    const allExport = allExportSwitch(head, words.slice(1).map(wordText))
    if (allExport !== null) state.allExport = allExport
    return
  }
  // `NAME=value` alone sets it; `NAME=value command` only hands it to that command.
  const assignments = words.map((word) => splitAssignment(word, true))
  if (!assignments.every((assignment): assignment is Assignment => assignment !== null)) return
  for (const assignment of assignments) assign(state, assignment.name, assignmentValue(assignment, state.home))
}

function setCommand(args: Word[], state: ExportState): void {
  let exporting = false
  let append = false
  let position = 0
  for (; position < args.length; position += 1) {
    const option = wordText(args[position])
    if (option === null || !option.startsWith('-') || option === '-') break
    if (option === '--') {
      position += 1
      break
    }
    const flags = option.startsWith('--') ? fishSetLongOptions.get(option.slice(2)) ?? '' : option.slice(1)
    // Erasing, querying and listing set nothing; -u keeps the value at home.
    if (/[equnSL]/.test(flags)) return
    if (flags.includes('x')) exporting = true
    if (/[ap]/.test(flags)) append = true
  }
  const name = position < args.length ? wordText(args[position]) : null
  if (name === null || !isVariableName(name)) return
  const values = args.slice(position + 1)
  // Several words make a list; fish exports it joined, which no key, URL or folder is.
  const value = append || values.length > 1 ? null : values.length === 0 ? '' : evaluate(values[0], state.home)
  if (exporting) record(state, name, value)
  else assign(state, name, value)
}

function interpretFish(words: Word[], state: ExportState): void {
  const head = wordText(words[0])
  // fish ships `export NAME=value` as a function for people coming from bash.
  if (head === 'export') declarationCommand(head, words.slice(1), state)
  else if (head === 'set') setCommand(words.slice(1), state)
}

/**
 * Every export of one of `names` in the file, in file order; a name exported
 * twice comes back twice. Only reads `text`: nothing is executed.
 */
export function parseShellStartupExports(
  text: string,
  dialect: ShellStartupDialect,
  names: readonly string[],
  home: string,
): ShellStartupExport[] {
  const state: ExportState = {
    wanted: new Set(names),
    home,
    found: [],
    assigned: new Map(),
    exported: new Set(),
    allExport: false,
  }
  for (const command of splitCommands(text, dialect)) {
    const words = commandWords(command, dialect)
    if (!words.length) continue
    if (dialect === 'fish') interpretFish(words, state)
    else interpretPosix(words, state)
  }
  return state.found
}
