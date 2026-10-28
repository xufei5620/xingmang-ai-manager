import { describe, expect, it } from 'vitest'
import { compileAssetSheetPrompt, compileShotImagePrompt } from './drama-compile'
import { danyinTwoShotFixture } from './drama-parse'
import { dramaShotBlockedReason, dramaShotGate, markDramaShotStale } from './drama-gate'
import type { DramaAssetData, DramaShotData } from './drama-model'

function assetFromCharacter(index = 0): DramaAssetData {
  const row = danyinTwoShotFixture.characters[index]
  return {
    assetKind: 'character',
    name: row.name,
    elementId: row.elementId,
    appearance: row.appearance,
    locked: false,
  }
}

describe('drama compile and gate', () => {
  it('wraps character assets in the multi-view sheet contract', () => {
    const prompt = compileAssetSheetPrompt(assetFromCharacter())
    expect(prompt).toContain('生成角色的多视图')
    expect(prompt).toContain('脖子到鞋')
    expect(prompt).toContain(danyinTwoShotFixture.characters[0].appearance)
  })

  it('compiles a shot prompt that lists reference duties without rewriting faces', () => {
    const shot: DramaShotData = {
      shotId: 's01',
      action: danyinTwoShotFixture.shots[0].action,
      framing: danyinTwoShotFixture.shots[0].framing,
      camera: danyinTwoShotFixture.shots[0].camera,
      dialogue: danyinTwoShotFixture.shots[0].dialogue,
    }
    const prompt = compileShotImagePrompt({
      bible: { stylePrompt: '3D漫剧写实厚涂风。', genreAvoid: ['现代路人'] },
      assets: [assetFromCharacter()],
      shot,
    })
    expect(prompt).toContain('仅锁定「虞晚」的身份')
    expect(prompt).toContain('不重写五官')
    expect(prompt).toContain('现代路人')
  })

  it('blocks generation until every referenced asset is locked', () => {
    const unlocked = [assetFromCharacter()]
    expect(dramaShotGate(unlocked)).toBe('blocked')
    expect(dramaShotBlockedReason(unlocked)).toContain('请先封板角色「虞晚」的定妆图')
    expect(dramaShotGate([{ ...unlocked[0], locked: true }])).toBe('ready')
    expect(markDramaShotStale('ready', true)).toBe('stale')
  })
})
