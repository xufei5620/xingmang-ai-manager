import { describe, expect, it } from 'vitest';
import type { PlatformNotificationKind } from '../../../electron/platform/contract';
import type { UpdateFailedStep } from '../../../electron/ipc-contract';
import {
  notificationOptions,
  updateFailureFallback,
  updateFailureLabel,
  updateFailureLabels,
} from './business';

describe('renderer-v2 notification settings registry', () => {
  // 设置页是 notificationOptions.map 渲染的，所以少一条就是「主进程会发这种通知，
  // 但用户在设置里关不掉」。这张表没有 default 分支，加第五种通知漏在这里是编译错。
  it('offers one switch per notification the main process can send', () => {
    const expected: Record<PlatformNotificationKind, true> = {
      install: true,
      balance: true,
      task: true,
      cliUpdate: true,
    };
    expect([...notificationOptions.map(option => option.value)].sort())
      .toEqual(Object.keys(expected).sort());
  });

  it('describes the CLI update reminder in the customer’s own words', () => {
    const option = notificationOptions.find(entry => entry.value === 'cliUpdate');
    expect(option?.label).toBe('工具有新版本');
    // 站点名、内部代号不进面向用户的文案（双站点对用户无感）。
    expect(`${option?.label} ${option?.description}`).not.toMatch(/solov|new-api|relay|CLI/i);
  });
});

describe('renderer-v2 update failure labels', () => {
  // 更新页的提示和首页那条浮动气泡读的是同一张表；分成两份写，就会出现气泡说
  // 「检查更新失败」而页面还写着「重新下载」这种自相矛盾的组合。
  it('gives every failed step its own title and a retry that repeats that step', () => {
    const expected: Record<UpdateFailedStep, { title: string; retry: string }> = {
      check: { title: '检查更新失败', retry: '重试' },
      download: { title: '下载更新失败', retry: '重新下载' },
      install: { title: '安装更新失败', retry: '重新安装' },
    };
    for (const [step, labels] of Object.entries(expected)) {
      expect(updateFailureLabel(step as UpdateFailedStep)).toEqual(labels);
    }
    expect(Object.keys(updateFailureLabels).sort()).toEqual(Object.keys(expected).sort());
  });

  it('falls back to a step-free sentence for snapshots that predate the field', () => {
    // 旧版本升上来的快照没有 failedStep，这时候不许编一个步骤名出来。
    expect(updateFailureLabel(null)).toEqual(updateFailureFallback);
    expect(updateFailureLabel(undefined)).toEqual(updateFailureFallback);
    expect(updateFailureFallback.title).not.toContain('检查');
  });
});
