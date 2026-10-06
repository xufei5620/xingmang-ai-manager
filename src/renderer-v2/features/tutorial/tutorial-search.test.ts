import { describe, expect, it } from 'vitest'
import { searchWords, splitSearchHits, textHasSearchWord } from './tutorial-search'
import { readingStepAt } from './TutorialPage'

describe('tutorial search hits', () => {
  it('marks every place a search word appears without changing the original text', () => {
    const parts = splitSearchHits('Mac 上装 Python，再用 brew install python', searchWords('PYTHON brew'))
    expect(parts.map((part) => part.text).join('')).toBe('Mac 上装 Python，再用 brew install python')
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['Python', 'brew', 'python'])
  })

  it('joins overlapping words into one mark', () => {
    expect(splitSearchHits('安装报错怎么办', ['安装', '装报错'])).toEqual([{ text: '安装报错', hit: true }, { text: '怎么办', hit: false }])
  })

  it('leaves the text as one plain part when nothing matches', () => {
    expect(splitSearchHits('联系客服', ['充值'])).toEqual([{ text: '联系客服', hit: false }])
  })

  it('opens only the notes that contain one of the words', () => {
    expect(textHasSearchWord('安装报错怎么办 Windows 安装报错时按提示处理', searchWords('windows'))).toBe(true)
    expect(textHasSearchWord('刚改过配置，需要重新读取时', searchWords('windows'))).toBe(false)
  })
})

describe('tutorial reading step', () => {
  it('counts the last step whose start has passed the line under the sticky bar', () => {
    expect(readingStepAt([-900, -200, 54, 700], 60)).toBe(2)
    expect(readingStepAt([-900, -200, 120, 700], 60)).toBe(1)
  })

  it('starts on the first step before any step reaches the line', () => {
    expect(readingStepAt([300, 900], 60)).toBe(0)
  })

  it('counts the last visible step once the page cannot scroll further', () => {
    expect(readingStepAt([-600, 90, 420], 639)).toBe(2)
  })
})
