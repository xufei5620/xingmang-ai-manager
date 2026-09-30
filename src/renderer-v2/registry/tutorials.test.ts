import { describe, expect, it } from 'vitest';
import { accountTabs, settingsGroups, updateFailureLabels, updateLabels, updatesTutorialTopic } from './business';
import { macKeychainTutorialTitle, tutorialTopics, updateDiskCleanupDetail, updateDiskCleanupTitle, type TutorialStep } from './tutorials';

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

  it('tells a full-disk user where to clean up next to the toolbox update step', () => {
    const extra = step(updatesTutorialTopic, '打开工具箱更新').extra ?? [];
    const entry = extra.find((item) => item.title === updateDiskCleanupTitle);
    expect(entry?.detail).toBe(updateDiskCleanupDetail);
    expect(updateDiskCleanupDetail).toContain('系统设置 → 通用 → 储存空间');
    expect(updateDiskCleanupDetail).toContain('设置 → 系统 → 存储');
  });
});

// 第二十一批 6：教程曾经还在教手动四步更新、一个永远按不动的加速模式开关。
// 这里把教程里的按钮名钉在界面真正用的那份文案上，改了界面忘改教程会红。
describe('tutorial wording that follows the current app', () => {
  it('describes automatic updates with the labels the settings and update page use', () => {
    const update = step('safety', '打开工具箱更新');
    const text = JSON.stringify(update);
    expect(update.detail).toContain('自动装上');
    expect(text).toContain(`「${settingsGroups.find((group) => group.value === 'startup')?.label}」`);
    expect(text).toContain('「自动更新」');
    expect(text).toContain(`「${updateFailureLabels.install.retry}」`);
    expect(update.expected).toContain(`「${updateLabels['not-available']}」`);
    expect(text).toContain('「退回更新前的版本」');
    expect(text).not.toContain('区分两种更新入口');
  });

  it('never teaches the acceleration mode switch that is not open to customers', () => {
    expect(JSON.stringify(tutorialTopics)).not.toMatch(/TUN/i);
  });
});
