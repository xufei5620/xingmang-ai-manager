// Splits a script built with buildPowerShellConstrainedLanguageBranch into the
// statements only a locked-down session runs and the FullLanguage lines after
// them, so each part can be checked on its own. Read as text; no PowerShell is
// started.
//
// Test-only: tsconfig.electron.json excludes *.test-support.ts, so none of this is compiled
// into dist-electron.

const branchOpening = "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {"
const branchClosing = '\n  return\n}\n'

export interface ConstrainedLanguageScriptParts {
  /** Lines before the branch. */
  head: string
  /** The statements inside the branch, still indented by two spaces. */
  branch: string
  /** Everything after the branch: what FullLanguage runs. */
  fullLanguage: string
}

export function splitConstrainedLanguageBranch(script: string): ConstrainedLanguageScriptParts {
  const opening = script.indexOf(`${branchOpening}\n`)
  if (opening < 0) throw new Error('no ConstrainedLanguage branch in this script')
  const bodyStart = opening + branchOpening.length + 1
  const closing = script.indexOf(branchClosing, bodyStart)
  if (closing < 0) throw new Error('the ConstrainedLanguage branch does not end the script')
  return {
    head: script.slice(0, opening),
    branch: script.slice(bodyStart, closing),
    fullLanguage: script.slice(closing + branchClosing.length),
  }
}
