/** Reading mastery off the game's SkillWithMastery (skill.js): per-action levels and the per-realm pools. */
import type { MasteryInfo, MasteryPoolState } from '../shared/protocol.ts';
import { safe, type GameObject, type RuntimeEnv } from './env.ts';
import { idOf } from './lookup.ts';

export function hasMastery(skill: GameObject): boolean {
  return safe(() => skill.hasMastery === true && typeof skill.getMasteryLevel === 'function', false);
}

export function maxMasteryLevel(skill: GameObject): number {
  return safe(() => skill.masteryLevelCap as number, 99);
}

export function masteryInfo(env: RuntimeEnv, skill: GameObject, action: GameObject): MasteryInfo {
  const level = safe(() => skill.getMasteryLevel(action) as number, 1);
  const xp = safe(() => skill.getMasteryXP(action) as number, 0);
  const xpToNext =
    level < maxMasteryLevel(skill)
      ? safe(() => Math.max(0, Math.ceil(env.classes.exp.levelToXP(level + 1) - xp)), 0)
      : 0;
  return { level, xp, xpToNext };
}

/** realm id -> pool, for every realm the skill has mastery actions in. Undefined without mastery. */
export function masteryPools(skill: GameObject): Record<string, MasteryPoolState> | undefined {
  if (!hasMastery(skill)) return undefined;
  const out: Record<string, MasteryPoolState> = {};
  for (const realm of safe(() => skill.getRealmsWithMastery() as GameObject[], [])) {
    const id = idOf(realm);
    if (!id) continue;
    out[id] = {
      xp: safe(() => skill.getMasteryPoolXP(realm) as number, 0),
      cap: safe(() => skill.getMasteryPoolCap(realm) as number, 0),
      percent: safe(() => Math.floor((skill.getMasteryPoolProgress(realm) as number) * 100) / 100, 0),
    };
  }
  return out;
}
