import type { ActionResult, ErrorCode, FightResult } from '../shared/protocol.ts';

/** An error reported by the game (or the connection to it). */
export class MelvorError extends Error {
  constructor(
    public readonly code: ErrorCode | 'DISCONNECTED' | 'TIMEOUT',
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'MelvorError';
  }

  /** For MISSING_ITEMS errors: item/currency id -> how many more you need. */
  get missing(): Record<string, number> | undefined {
    const d = this.data as { missing?: Record<string, number> } | undefined;
    return d?.missing;
  }
}

/** Thrown by skill actions that ended before completing (bank full, out of materials, cancelled...). */
export class ActionStoppedError extends MelvorError {
  constructor(
    public readonly result: ActionResult,
    skillName = result.skill,
  ) {
    super(
      'FAILED',
      `${skillName} ${result.status} after ${result.completed}/${result.requested ?? '∞'} actions${result.reason ? `: ${result.reason}` : ''}`,
      result,
    );
    this.name = 'ActionStoppedError';
  }
}

/** Thrown by combat calls that ended before reaching the kill target. */
export class FightStoppedError extends MelvorError {
  constructor(public readonly result: FightResult) {
    super(
      'FAILED',
      `fight ${result.status} after ${result.kills} kills${result.reason ? `: ${result.reason}` : ''}`,
      result,
    );
    this.name = 'FightStoppedError';
  }
}
