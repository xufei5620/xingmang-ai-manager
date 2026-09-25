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
