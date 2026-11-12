import { describe, expect, it } from 'vitest'
import { parsePowerShellProfileExports } from './powershell-profile-exports'

const home = 'C:\\Users\\tester'
const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK']

function parse(text: string) {
  return parsePowerShellProfileExports(text, names, home)
}

describe('parsePowerShellProfileExports', () => {
  it('reads $env: assignments in either quote, with any case in the name', () => {
    expect(parse([
      "$env:ANTHROPIC_API_KEY = 'sk-single'",
      '$Env:anthropic_api_key="sk-double"',
      '${env:CLAUDE_CONFIG_DIR} = "D:\\claude"',
    ].join('\r\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-single' },
      { name: 'ANTHROPIC_API_KEY', value: 'sk-double' },
      { name: 'CLAUDE_CONFIG_DIR', value: 'D:\\claude' },
    ])
  })

  it('expands only the home folder and leaves anything else unknown', () => {
    expect(parse([
      '$env:CLAUDE_CONFIG_DIR = "$HOME\\.claude"',
      '$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude"',
      '$env:CLAUDE_CONFIG_DIR = $HOME',
      '$env:ANTHROPIC_API_KEY = "$($secret.Key)"',
      '$env:ANTHROPIC_API_KEY = $env:OTHER_KEY',
      '$env:ANTHROPIC_API_KEY = Get-Content key.txt',
      "$env:ANTHROPIC_API_KEY = 'sk-' + 'joined'",
      "$env:ANTHROPIC_API_KEY += 'more'",
    ].join('\n'))).toEqual([
      { name: 'CLAUDE_CONFIG_DIR', value: `${home}\\.claude` },
      { name: 'CLAUDE_CONFIG_DIR', value: `${home}\\.claude` },
      { name: 'CLAUDE_CONFIG_DIR', value: home },
      { name: 'ANTHROPIC_API_KEY', value: null },
      { name: 'ANTHROPIC_API_KEY', value: null },
      { name: 'ANTHROPIC_API_KEY', value: null },
      { name: 'ANTHROPIC_API_KEY', value: null },
      { name: 'ANTHROPIC_API_KEY', value: null },
    ])
  })

  it('treats $null and an empty string as clearing, and keeps a number', () => {
    expect(parse("$env:ANTHROPIC_API_KEY = $null\n$env:CLAUDE_CONFIG_DIR = ''\n$env:CLAUDE_CODE_USE_BEDROCK = 1")).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: '' },
      { name: 'CLAUDE_CONFIG_DIR', value: '' },
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
    ])
  })

  it('skips comments, block comments, strings that only mention a name and comparisons', () => {
    expect(parse([
      "# $env:ANTHROPIC_API_KEY = 'sk-commented'",
      '<#',
      "$env:ANTHROPIC_API_KEY = 'sk-in-block-comment'",
      '#>',
      "Write-Host '$env:ANTHROPIC_API_KEY = sk-in-a-string'",
      "if ($env:ANTHROPIC_API_KEY -eq 'sk-compared') { }",
      "$other = 'x'",
    ].join('\n'))).toEqual([])
  })

  it('counts an assignment inside a function, a block or after a semicolon', () => {
    expect(parse([
      "function Use-Relay { $env:ANTHROPIC_API_KEY = 'sk-function' }",
      "if (Test-Path x) { $env:CLAUDE_CONFIG_DIR = 'D:\\x' }; $env:CLAUDE_CODE_USE_BEDROCK = '1'",
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-function' },
      { name: 'CLAUDE_CONFIG_DIR', value: 'D:\\x' },
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
    ])
  })

  it('reads SetEnvironmentVariable with or without the System prefix', () => {
    expect(parse([
      "[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', 'sk-user', 'User')",
      '[System.Environment]::SetEnvironmentVariable("CLAUDE_CONFIG_DIR", $HOME, [EnvironmentVariableTarget]::Process)',
      '[Environment]::SetEnvironmentVariable($name, "sk-unknown-name")',
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-user' },
      { name: 'CLAUDE_CONFIG_DIR', value: home },
    ])
  })

  it('reads Set-Item and New-Item on the Env: drive', () => {
    expect(parse([
      "Set-Item -Path Env:ANTHROPIC_API_KEY -Value 'sk-set-item'",
      "si env:\\CLAUDE_CONFIG_DIR 'D:\\positional'",
      "New-Item -Path Env: -Name CLAUDE_CODE_USE_BEDROCK -Value '1' -Force",
      "Set-Item -Path Variable:ANTHROPIC_API_KEY -Value 'not-env'",
    ].join('\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-set-item' },
      { name: 'CLAUDE_CONFIG_DIR', value: 'D:\\positional' },
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
    ])
  })

  it('takes typographic quotes, doubled quotes, here-strings and line continuations', () => {
    expect(parse([
      '$env:ANTHROPIC_API_KEY = \u2018sk-smart\u2019',
      "$env:CLAUDE_CONFIG_DIR = 'D:\\it''s'",
      '$env:ANTHROPIC_API_KEY = @\'',
      'sk-here',
      "'@",
      "Set-Item `",
      "  -Path Env:CLAUDE_CODE_USE_BEDROCK `",
      "  -Value 'yes'",
    ].join('\r\n'))).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-smart' },
      { name: 'CLAUDE_CONFIG_DIR', value: "D:\\it's" },
      { name: 'ANTHROPIC_API_KEY', value: 'sk-here' },
      { name: 'CLAUDE_CODE_USE_BEDROCK', value: 'yes' },
    ])
  })

  it('does not let a quote inside a here-string swallow what follows', () => {
    expect(parse([
      "$note = @'",
      "it's a note with an apostrophe",
      "'@",
      "$env:ANTHROPIC_API_KEY = 'sk-after'",
    ].join('\n'))).toEqual([{ name: 'ANTHROPIC_API_KEY', value: 'sk-after' }])
  })

  it('ignores names it was not asked about', () => {
    expect(parse("$env:OPENAI_API_KEY = 'sk-other'\n$env:PATH += ';C:\\tools'")).toEqual([])
  })
})
