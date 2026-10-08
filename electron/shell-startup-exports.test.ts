import { describe, expect, it } from 'vitest'
import { parseShellStartupExports } from './shell-startup-exports'

const home = '/Users/alex'
const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL']

function posix(text: string) {
  return parseShellStartupExports(text, 'posix', names, home)
}

function fish(text: string) {
  return parseShellStartupExports(text, 'fish', names, home)
}

describe('parseShellStartupExports', () => {
  it('finds the plain export line a relay tutorial adds', () => {
    expect(posix('export ANTHROPIC_API_KEY=sk-relay\n')).toEqual([{ name: 'ANTHROPIC_API_KEY', value: 'sk-relay' }])
  })

  it('removes quotes and escapes the way the shell does', () => {
    expect(posix([
      'export ANTHROPIC_API_KEY="sk-double"',
      "export GEMINI_API_KEY='sk-single'",
      'export GOOGLE_GEMINI_BASE_URL=https://gateway.example.com/a\\ b',
      'export CLAUDE_CONFIG_DIR="/a \\"quoted\\" \\$dir"',
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-double' },
      { name: 'GEMINI_API_KEY', value: 'sk-single' },
      { name: 'GOOGLE_GEMINI_BASE_URL', value: 'https://gateway.example.com/a b' },
      { name: 'CLAUDE_CONFIG_DIR', value: '/a "quoted" $dir' },
    ])
  })

  it('spells out the home directory and only the home directory', () => {
    expect(posix([
      'export CLAUDE_CONFIG_DIR=~/.claude',
      'export CLAUDE_CONFIG_DIR=$HOME/.claude',
      'export CLAUDE_CONFIG_DIR="${HOME}/.claude/"',
      'export CLAUDE_CONFIG_DIR=~',
      'export CLAUDE_CONFIG_DIR="~/.claude"',
      'export CLAUDE_CONFIG_DIR=~alex/.claude',
      'export CLAUDE_CONFIG_DIR=$HOMEDIR/.claude',
    ].join('\n')).map((found) => found.value)).toEqual([
      '/Users/alex/.claude',
      '/Users/alex/.claude',
      '/Users/alex/.claude/',
      '/Users/alex',
      '~/.claude',
      '~alex/.claude',
      null,
    ])
  })

  it('cannot tell a value that comes from another variable or a command', () => {
    expect(posix([
      'export ANTHROPIC_API_KEY=$(security find-generic-password -w -s "relay; key")',
      'export ANTHROPIC_API_KEY=`cat ~/.key`',
      'export CLAUDE_CONFIG_DIR=$XDG_CONFIG_HOME/claude',
      'export CLAUDE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude"',
      "export GEMINI_API_KEY=$'sk\\tkey'",
      'export GEMINI_API_KEY=$1',
      'export GEMINI_API_KEY+=-suffix',
    ].join('\n')).map((found) => found.value)).toEqual([null, null, null, null, null, null, null])
  })

  it('keeps a lone dollar sign and an empty value as they are', () => {
    expect(posix('export ANTHROPIC_API_KEY=cost$\nexport GEMINI_API_KEY=\nexport CLAUDE_CONFIG_DIR=""\n')).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'cost$' },
      { name: 'GEMINI_API_KEY', value: '' },
      { name: 'CLAUDE_CONFIG_DIR', value: '' },
    ])
  })

  it('takes several names from one line and leaves the ones it was not asked about', () => {
    expect(posix('export ANTHROPIC_BASE_URL=https://gateway.example.com ANTHROPIC_API_KEY=sk-a GEMINI_API_KEY=sk-b')).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-a' },
      { name: 'GEMINI_API_KEY', value: 'sk-b' },
    ])
  })

  it('follows a value set first and exported afterwards, and a change after the export', () => {
    expect(posix([
      'ANTHROPIC_API_KEY=sk-first',
      'export ANTHROPIC_API_KEY',
      'ANTHROPIC_API_KEY=sk-second',
      'export GEMINI_API_KEY',
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-first' },
      { name: 'ANTHROPIC_API_KEY', value: 'sk-second' },
    ])
  })

  it('does not count a value handed to one command or kept inside an alias', () => {
    expect(posix([
      'ANTHROPIC_API_KEY=sk-once claude',
      'export ANTHROPIC_API_KEY',
      'export GEMINI_API_KEY=sk-exported',
      'GEMINI_API_KEY=sk-once gemini',
      "alias relay='CLAUDE_CONFIG_DIR=/alias claude'",
      'GOOGLE_GEMINI_BASE_URL=https://shell-only.example.com',
      '"CLAUDE_CONFIG_DIR"=/elsewhere',
    ].join('\n'))).toEqual([{ name: 'GEMINI_API_KEY', value: 'sk-exported' }])
  })

  it('skips comments but not a hash inside a word', () => {
    expect(posix([
      '# export ANTHROPIC_API_KEY=sk-commented',
      '  #export GEMINI_API_KEY=sk-commented',
      'export CLAUDE_CONFIG_DIR=/a#b # the folder',
      'echo hi # export GOOGLE_GEMINI_BASE_URL=https://commented.example.com',
    ].join('\n'))).toEqual([{ name: 'CLAUDE_CONFIG_DIR', value: '/a#b' }])
  })

  it('finds exports inside conditions, case branches, chains and functions', () => {
    expect(posix([
      'if [ -n "$ZSH_VERSION" ]; then export ANTHROPIC_API_KEY=sk-if; fi',
      'case "$TERM_PROGRAM" in Apple_Terminal) export GEMINI_API_KEY=sk-case ;; esac',
      '[ -f ~/.relay ] && export CLAUDE_CONFIG_DIR=/relay || true',
      'use_relay() {',
      '  export GOOGLE_GEMINI_BASE_URL=https://gateway.example.com',
      '}',
      'function relay_key { export ANTHROPIC_API_KEY=sk-function }',
      'while false; do export GEMINI_API_KEY=sk-loop; done',
    ].join('\n')).map((found) => found.value)).toEqual([
      'sk-if',
      'sk-case',
      '/relay',
      'https://gateway.example.com',
      'sk-function',
      'sk-loop',
    ])
  })

  it('keeps every export of a name even after an unset, since a function may hold it', () => {
    expect(posix([
      'use_relay() { export ANTHROPIC_API_KEY=sk-relay; }',
      'use_official() { unset ANTHROPIC_API_KEY; }',
    ].join('\n'))).toEqual([{ name: 'ANTHROPIC_API_KEY', value: 'sk-relay' }])
  })

  it('reads typeset and declare the way they export', () => {
    expect(posix([
      'typeset -x ANTHROPIC_API_KEY=sk-typeset',
      'declare -gx GEMINI_API_KEY=sk-declare',
      'declare CLAUDE_CONFIG_DIR=/not-exported',
      'ANTHROPIC_API_KEY=sk-still-exported',
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-typeset' },
      { name: 'GEMINI_API_KEY', value: 'sk-declare' },
      { name: 'ANTHROPIC_API_KEY', value: 'sk-still-exported' },
    ])
  })

  it('exports plain assignments only while allexport is on', () => {
    expect(posix([
      'set -a',
      'ANTHROPIC_API_KEY=sk-set-a',
      'set +a',
      'GEMINI_API_KEY=sk-after-set-a',
      'setopt ALL_EXPORT',
      'CLAUDE_CONFIG_DIR=/setopt',
      'unsetopt allexport',
      'set -o allexport',
      'GOOGLE_GEMINI_BASE_URL=https://set-o.example.com',
      'set +o allexport',
      'GEMINI_API_KEY=sk-after-set-o',
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-set-a' },
      { name: 'CLAUDE_CONFIG_DIR', value: '/setopt' },
      { name: 'GOOGLE_GEMINI_BASE_URL', value: 'https://set-o.example.com' },
    ])
    expect(posix('setopt allexport\nsetopt no_all_export\nGEMINI_API_KEY=sk-off')).toEqual([])
  })

  it('ignores export forms that take the export away or only list', () => {
    expect(posix([
      'export -n ANTHROPIC_API_KEY=sk-unexported',
      'export -f GEMINI_API_KEY',
      'export -p',
      'typeset +x CLAUDE_CONFIG_DIR=/unexported',
    ].join('\n'))).toEqual([])
  })

  it('accepts a quoted argument to export and stops reading options after --', () => {
    expect(posix('export "ANTHROPIC_API_KEY=sk-quoted" -- \nexport -- GEMINI_API_KEY=sk-dashes')).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-quoted' },
      { name: 'GEMINI_API_KEY', value: 'sk-dashes' },
    ])
  })

  it('joins continued lines and keeps quoted text across lines', () => {
    expect(posix('export \\\n  ANTHROPIC_API_KEY=sk-continued\nexport GEMINI_API_KEY="sk-\nsplit"\n')).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-continued' },
      { name: 'GEMINI_API_KEY', value: 'sk-\nsplit' },
    ])
  })

  it('treats a here-document body as data, apostrophes included', () => {
    expect(posix([
      "cat > ~/.relay-notes <<'EOF'",
      "it's not a command: export ANTHROPIC_API_KEY=sk-in-heredoc",
      'EOF',
      'cat <<-NOTES; export GEMINI_API_KEY=sk-after-operator',
      '\texport CLAUDE_CONFIG_DIR=/in-heredoc',
      '\tNOTES',
      'export GOOGLE_GEMINI_BASE_URL=https://after.example.com',
    ].join('\n'))).toEqual([
      { name: 'GEMINI_API_KEY', value: 'sk-after-operator' },
      { name: 'GOOGLE_GEMINI_BASE_URL', value: 'https://after.example.com' },
    ])
  })

  it('keeps a carriage return as part of the value, as the shell does', () => {
    expect(posix('export CLAUDE_CONFIG_DIR=~/.claude\r\nexport ANTHROPIC_API_KEY=sk-crlf\r\n')).toEqual([
      { name: 'CLAUDE_CONFIG_DIR', value: '/Users/alex/.claude\r' },
      { name: 'ANTHROPIC_API_KEY', value: 'sk-crlf\r' },
    ])
  })

  it('does not throw on a file cut off in the middle of a quote', () => {
    expect(posix('export ANTHROPIC_API_KEY="sk-unterminated')).toEqual([{ name: 'ANTHROPIC_API_KEY', value: 'sk-unterminated' }])
    expect(posix("export GEMINI_API_KEY='sk")).toEqual([{ name: 'GEMINI_API_KEY', value: 'sk' }])
    expect(posix('export CLAUDE_CONFIG_DIR=$(dirname')).toEqual([{ name: 'CLAUDE_CONFIG_DIR', value: null }])
    expect(posix('cat <<EOF\nexport ANTHROPIC_API_KEY=sk')).toEqual([])
    expect(posix('export GEMINI_API_KEY=\\')).toEqual([{ name: 'GEMINI_API_KEY', value: '' }])
  })

  describe('fish', () => {
    it('reads set with an export flag in every spelling', () => {
      expect(fish([
        'set -gx ANTHROPIC_API_KEY sk-gx',
        'set -Ux GEMINI_API_KEY sk-universal',
        'set --export --global CLAUDE_CONFIG_DIR ~/.claude',
        'set -x GOOGLE_GEMINI_BASE_URL "$HOME/relay"',
      ].join('\n'))).toEqual([
        { name: 'ANTHROPIC_API_KEY', value: 'sk-gx' },
        { name: 'GEMINI_API_KEY', value: 'sk-universal' },
        { name: 'CLAUDE_CONFIG_DIR', value: '/Users/alex/.claude' },
        { name: 'GOOGLE_GEMINI_BASE_URL', value: '/Users/alex/relay' },
      ])
    })

    it('skips erasing, querying and listing, and an unexported set', () => {
      expect(fish([
        'set -gx ANTHROPIC_API_KEY sk-exported',
        'set -e ANTHROPIC_API_KEY',
        'set --erase ANTHROPIC_API_KEY',
        'if set -q ANTHROPIC_API_KEY; echo set; end',
        'set --names',
        'set -gu ANTHROPIC_API_KEY https://unexported.example.com',
        'set -g GEMINI_API_KEY sk-not-exported',
      ].join('\n'))).toEqual([{ name: 'ANTHROPIC_API_KEY', value: 'sk-exported' }])
    })

    it('treats an empty set as empty and a list or a command as unknown', () => {
      expect(fish([
        'set -gx ANTHROPIC_API_KEY',
        'set -gx GEMINI_API_KEY sk-a sk-b',
        'set -gx CLAUDE_CONFIG_DIR (dirname (status filename))',
        'set -gx GOOGLE_GEMINI_BASE_URL $RELAY_URL',
        'set -gxa GEMINI_API_KEY sk-appended',
      ].join('\n'))).toEqual([
        { name: 'ANTHROPIC_API_KEY', value: '' },
        { name: 'GEMINI_API_KEY', value: null },
        { name: 'CLAUDE_CONFIG_DIR', value: null },
        { name: 'GOOGLE_GEMINI_BASE_URL', value: null },
        { name: 'GEMINI_API_KEY', value: null },
      ])
    })

    it('follows fish quoting and its export function', () => {
      expect(fish([
        "set -gx ANTHROPIC_API_KEY 'sk-\\'quoted\\''",
        'export GEMINI_API_KEY=sk-export-function',
        'set -g CLAUDE_CONFIG_DIR /later-exported',
        'export CLAUDE_CONFIG_DIR',
        'and set -gx GOOGLE_GEMINI_BASE_URL https://chained.example.com # trailing note',
        '# set -gx ANTHROPIC_API_KEY sk-commented',
      ].join('\n'))).toEqual([
        { name: 'ANTHROPIC_API_KEY', value: "sk-'quoted'" },
        { name: 'GEMINI_API_KEY', value: 'sk-export-function' },
        { name: 'CLAUDE_CONFIG_DIR', value: '/later-exported' },
        { name: 'GOOGLE_GEMINI_BASE_URL', value: 'https://chained.example.com' },
      ])
    })

    it('does not mistake fish parentheses for a separator', () => {
      expect(fish('set -gx ANTHROPIC_API_KEY (cat ~/.key; echo)\n')).toEqual([{ name: 'ANTHROPIC_API_KEY', value: null }])
    })

    it('reads a carriage return as a space, as fish does', () => {
      expect(fish('set -gx CLAUDE_CONFIG_DIR ~/.claude\r\n')).toEqual([{ name: 'CLAUDE_CONFIG_DIR', value: '/Users/alex/.claude' }])
    })
  })
})
