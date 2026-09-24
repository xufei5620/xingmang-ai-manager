import { describe, expect, it } from 'vitest';
import { accountTabs, settingsGroups } from './business';
import { macKeychainTutorialTitle, tutorialTopics, type TutorialStep } from './tutorials';

function step(topicId: string, action: string): TutorialStep {
  const found = tutorialTopics.find((topic) => topic.id === topicId)?.steps.find((entry) => entry.action === action);
  if (!found) throw new Error(`missing tutorial step ${topicId} / ${action}`);
  return found;
}

// 「在哪里」写的是用户要去的分页；按钮若只跳页，就会停在默认分页或上次看的那页。
const sectionsByPage = {
  account: accountTabs.filter((tab) => tab.value !== 'overview'),
  settings: settingsGroups.filter((group) => group.value !== 'appearance'),
} as const;

function sectionNamedIn(entry: TutorialStep): string | undefined {
  if (entry.page !== 'account' && entry.page !== 'settings') return undefined;
  const where = entry.where ?? '';
  const named = sectionsByPage[entry.page]
    .map((section) => ({ value: section.value, position: where.indexOf(section.label) }))
    .filter((section) => section.position >= 0)
    .sort((left, right) => left.position - right.position);
  return named[0]?.value;
}

describe('tutorial step targets', () => {
  it('lands the account chapter actions on the tab each step describes (Q48)', () => {
    expect(step('account', '打开个人中心').section).toBeUndefined();
    expect(step('account', '查看账号与密钥').section).toBe('keys');
    expect(step('account', '打开个人中心办理充值').section).toBe('recharge');
    expect(step('account', '查看用量与调用明细').section).toBe('usage');
  });

  it('lands the privacy step on the privacy settings group', () => {
    expect(step('safety', '查看隐私与数据设置')).toMatchObject({ page: 'settings', section: 'privacy' });
  });

  it('only names sections that exist on the target page', () => {
    for (const topic of tutorialTopics) for (const entry of topic.steps) {
      if (entry.section === undefined) continue;
      const known: readonly string[] = entry.page === 'account' ? accountTabs.map((tab) => tab.value)
        : entry.page === 'settings' ? settingsGroups.map((group) => group.value) : [];
      expect(known, `${topic.id} / ${entry.action}`).toContain(entry.section);
    }
  });

  it('declares a section whenever the step location names a non-default tab of its page', () => {
    for (const topic of tutorialTopics) for (const entry of topic.steps) {
      expect(entry.section, `${topic.id} / ${entry.action}`).toBe(sectionNamedIn(entry));
    }
  });
});

describe('mac keychain prompt help', () => {
  it('explains the keychain password prompt next to the toolbox update step', () => {
    const extra = step('safety', '打开工具箱更新').extra ?? [];
    const entry = extra.find((item) => item.title === macKeychainTutorialTitle);
    expect(entry?.detail).toContain('xingmang-ai-manager Safe Storage');
    expect(entry?.detail).toContain('始终允许');
    expect(tutorialTopics.find((topic) => topic.id === 'safety')?.keywords).toContain('钥匙串');
  });
});
