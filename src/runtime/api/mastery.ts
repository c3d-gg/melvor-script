/**
 * Mastery: read per-action mastery, and spend mastery pool XP (the game's "Spend Mastery XP" menu).
 * Spending is a menu action, so like banking it's free: no cooldown.
 */
import type { MasteryInfo } from '../../shared/protocol.ts';
import { RpcError, safe, type GameObject } from '../env.ts';
import { allObjects, resolveAction, resolveSkill } from '../lookup.ts';
import { hasMastery, masteryInfo, maxMasteryLevel } from '../mastery.ts';
import { assertUnlocked } from '../skills.ts';
import { num, type ApiContext } from './context.ts';

const fmt = (n: number) => Math.ceil(n).toLocaleString('en-US');

export function registerMastery(api: ApiContext) {
  const { rpc, env } = api;

  const masterySkill = (id: unknown): GameObject => {
    const skill = resolveSkill(env.game, id);
    if (!hasMastery(skill)) throw new RpcError('UNSUPPORTED', `${skill.name} has no mastery`);
    return skill;
  };

  rpc.register('mastery.get', (p: { skill: string; actions?: string[] }) => {
    const skill = masterySkill(p.skill);
    const actions = Array.isArray(p.actions)
      ? p.actions.map((id) => resolveAction(skill, id))
      : allObjects(skill.actions);
    const out: Record<string, MasteryInfo> = {};
    for (const a of actions) out[a.id] = masteryInfo(env, skill, a);
    return out;
  });

  rpc.register(
    'mastery.spendPool',
    (p: { skill: string; action: string; levels?: number; allowCheckpointLoss?: boolean }) => {
      const skill = masterySkill(p.skill);
      const action = resolveAction(skill, p.action);
      const levels = p.levels === undefined ? 1 : num(p.levels, 'levels', { min: 1, int: true });
      const exp = env.classes.exp;
      if (typeof exp?.levelToXP !== 'function' || typeof skill.exchangePoolXPForActionXP !== 'function')
        throw new RpcError('UNSUPPORTED', "This game version's mastery pool isn't supported");
      assertUnlocked(skill, action);

      // Same sums as SkillWithMastery.levelUpMasteryWithPoolXP, minus its confirmation popup.
      const before = masteryInfo(env, skill, action);
      const cap = maxMasteryLevel(skill);
      if (before.level >= cap) throw new RpcError('FAILED', `${action.name} is already mastery level ${cap}`);
      const target = Math.min(cap, before.level + levels);
      const xpToAdd = exp.levelToXP(target) + 1 - before.xp;
      const realm = action.realm;
      const pool = safe(() => skill.getMasteryPoolXP(realm) as number, 0);
      if (pool < xpToAdd)
        throw new RpcError(
          'FAILED',
          `${action.name} mastery ${target} needs ${fmt(xpToAdd)} pool XP; the pool has ${fmt(pool)}`,
          { needed: Math.ceil(xpToAdd), pool },
        );
      if (!p.allowCheckpointLoss && safe(() => (skill.getPoolBonusChange(realm, -xpToAdd) as number) < 0, false))
        throw new RpcError(
          'FAILED',
          `Spending ${fmt(xpToAdd)} pool XP would drop ${skill.name}'s mastery pool below a checkpoint and lose its bonus. ` +
            'Pass { allowCheckpointLoss: true } to spend it anyway.',
          { needed: Math.ceil(xpToAdd), pool },
        );

      skill.exchangePoolXPForActionXP(action, xpToAdd);
      api.flushState();
      return { ...masteryInfo(env, skill, action), spent: Math.ceil(xpToAdd) };
    },
  );
}
