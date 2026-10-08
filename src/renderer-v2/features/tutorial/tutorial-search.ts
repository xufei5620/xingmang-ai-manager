import type { TutorialTopic } from '../../registry/tutorials'

/** 把一篇教程能被搜到的文字拼起来：标题、导语、关键词和每一步的全部说明。 */
export function tutorialSearchText(topic: TutorialTopic) {
  return [topic.title, topic.lead, ...topic.keywords, ...(topic.reminders ?? []), ...topic.steps.flatMap(step => [
    step.title, step.detail, step.where ?? '', step.expected ?? '', step.tip ?? '', step.example ?? '', ...(step.bullets ?? []),
    ...(step.extra ?? []).flatMap(note => [note.title, note.detail]),
  ])].join(' ').toLocaleLowerCase()
}

export function searchWords(query: string) {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

/** 教程页和顶部搜索共用：输入的每个词都要在这篇教程里出现。 */
export function tutorialMatchesSearch(topic: TutorialTopic, query: string) {
  const text = tutorialSearchText(topic)
  return searchWords(query).every(word => text.includes(word))
}

/** 一段文字里有没有任何一个搜索词：补充说明只展开含词的那几条。 */
export function textHasSearchWord(text: string, words: readonly string[]) {
  const lower = text.toLocaleLowerCase()
  return words.some(word => lower.includes(word))
}

/**
 * 把一段文字切成命中、没命中交替的几段，给命中的字加底色。按小写比较，切出来的仍是原文的字；
 * 同一处被几个词同时盖住时合成一段，免得一个字被拆进两个标记里。
 */
export function splitSearchHits(text: string, words: readonly string[]): Array<{ text: string; hit: boolean }> {
  // 逐个字转小写、转完变长的字（比如土耳其语的 İ）保持原样，位置才和原文一一对上。
  const lower = text.split('').map(unit => { const low = unit.toLocaleLowerCase(); return low.length === 1 ? low : unit }).join('')
  const covered = new Array<boolean>(text.length).fill(false)
  for (const word of words) {
    if (!word) continue
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length))
      for (let index = at; index < at + word.length && index < text.length; index += 1) covered[index] = true
  }
  const parts: Array<{ text: string; hit: boolean }> = []
  for (let index = 0; index < text.length; index += 1) {
    const last = parts[parts.length - 1]
    if (last && last.hit === covered[index]) last.text += text[index]
    else parts.push({ text: text[index], hit: covered[index] })
  }
  return parts
}
