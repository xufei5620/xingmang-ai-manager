import { describe, expect, it } from 'vitest';
import type { PlatformNotificationKind } from '../../../electron/platform/contract';
import { notificationOptions } from './business';

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
