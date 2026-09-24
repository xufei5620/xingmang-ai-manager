// Tests used to prove properties of generated PowerShell by handing the text to a real
// powershell.exe, and the cold start of Windows PowerShell on a busy windows-latest runner kept
// outlasting the test budget (#452's first run, then the process probe in #457's). What those
// checks proved is a property of the generated text: user data only ever appears inside
// single-quoted literals or arrives through the environment, and the brackets around it still
// close. This scanner applies PowerShell's own quoting rules to that text, so the property is
// checked on every platform without starting a process.
//
// Test-only: tsconfig.electron.json excludes *.test-support.ts, so none of this is compiled
// into dist-electron.

// PowerShell accepts the typographic quotes as quote characters too (CharTraits.IsSingleQuote
// and IsDoubleQuote), so the scanner must, or a stray U+2019 would pass unnoticed.
const singleQuotes = '\'‘’‚‛'
const doubleQuotes = '"“”„'

export interface PowerShellScan {
  /** Everything outside string literals, each literal replaced by an empty pair of quotes. */
  code: string
  /** Decoded values of the single-quoted (verbatim) literals, in order. */
  literals: string[]
  /** Raw bodies of the double-quoted (expandable) strings, in order. */
  expandable: string[]
  unterminated: boolean
}

export function scanPowerShell(script: string): PowerShellScan {
  const scan: PowerShellScan = { code: '', literals: [], expandable: [], unterminated: false }
  let index = 0
  while (index < script.length) {
    const char = script[index]
    if (char === '`') {
      scan.code += script.slice(index, index + 2)
      index += 2
    } else if (char === '#') {
      while (index < script.length && script[index] !== '\n') index += 1
    } else if (singleQuotes.includes(char) || doubleQuotes.includes(char)) {
      const quotes = singleQuotes.includes(char) ? singleQuotes : doubleQuotes
      let value = ''
      let closed = false
      index += 1
      while (index < script.length) {
        const next = script[index]
        if (quotes === doubleQuotes && next === '`') {
          value += script.slice(index, index + 2)
          index += 2
        } else if (quotes.includes(next) && index + 1 < script.length && quotes.includes(script[index + 1])) {
          value += script[index + 1]
          index += 2
        } else if (quotes.includes(next)) {
          index += 1
          closed = true
          break
        } else {
          value += next
          index += 1
        }
      }
      if (!closed) scan.unterminated = true
      if (quotes === singleQuotes) scan.literals.push(value)
      else scan.expandable.push(value)
      scan.code += quotes === singleQuotes ? "''" : '""'
    } else {
      scan.code += char
      index += 1
    }
  }
  return scan
}

const closingBrackets = new Map([[')', '('], [']', '['], ['}', '{']])

export function unbalancedBracket(code: string): string | null {
  const open: string[] = []
  for (const char of code) {
    if (char === '(' || char === '[' || char === '{') open.push(char)
    else if (closingBrackets.has(char) && open.pop() !== closingBrackets.get(char)) return char
  }
  return open.at(-1) ?? null
}
