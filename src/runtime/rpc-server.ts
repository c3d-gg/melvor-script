import type { RpcRequest, RpcResponse } from '../shared/protocol.ts';
import { RpcError } from './env.ts';
import type { WsConnection } from './ws-server.ts';

export class ClientSession {
  name = 'client';
  helloDone = false;
  /** Token bucket for the call rate limit. */
  tokens = Infinity;
  lastRefill = Date.now();
  rateLimitedSince = 0;
  private closeHandlers: (() => void)[] = [];

  constructor(
    public readonly id: number,
    private conn: WsConnection,
  ) {}

  get isOpen() {
    return this.conn.isOpen;
  }

  notify(method: string, params?: unknown) {
    this.conn.send(JSON.stringify({ method, params }));
  }

  respond(msg: RpcResponse) {
    this.conn.send(JSON.stringify(msg));
  }

  onClose(fn: () => void) {
    this.closeHandlers.push(fn);
  }

  close(code?: number, reason?: string) {
    this.conn.close(code, reason);
  }

  /** @internal */
  fireClose() {
    for (const fn of this.closeHandlers.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error('[melvor-script] session close handler threw', e);
      }
    }
  }
}

export type Handler = (params: any, session: ClientSession) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RpcServerHooks {
  /** Called right before every response is sent (used to flush state so scripts see fresh data). */
  beforeRespond?(session: ClientSession): void;
  onSessionOpen?(session: ClientSession): void;
  onSessionClose?(session: ClientSession): void;
  /** A client started hitting the rate limit (called once per burst). */
  onRateLimited?(session: ClientSession): void;
}

/** Calls per second each client may make on average, and how many it may make in a burst. */
export interface RateLimit {
  perSecond: number;
  burst: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { perSecond: 60, burst: 120 };

export class RpcServer {
  private handlers = new Map<string, Handler>();
  readonly sessions = new Set<ClientSession>();
  private nextSessionId = 1;

  constructor(
    private hooks: RpcServerHooks = {},
    private rateLimit: RateLimit = DEFAULT_RATE_LIMIT,
  ) {}

  register(method: string, handler: Handler) {
    this.handlers.set(method, handler);
  }

  attach(conn: WsConnection): ClientSession {
    const session = new ClientSession(this.nextSessionId++, conn);
    this.sessions.add(session);
    conn.onmessage = (text) => void this.handle(session, text);
    conn.onclose = () => {
      this.sessions.delete(session);
      session.fireClose();
      this.hooks.onSessionClose?.(session);
    };
    this.hooks.onSessionOpen?.(session);
    return session;
  }

  broadcast(method: string, params?: unknown) {
    for (const s of this.sessions) if (s.helloDone) s.notify(method, params);
  }

  closeAll(reason: string) {
    for (const s of [...this.sessions]) s.close(1001, reason);
  }

  private async handle(session: ClientSession, text: string) {
    let req: RpcRequest;
    try {
      req = JSON.parse(text);
    } catch {
      return; // not even JSON: ignore
    }
    if (typeof req !== 'object' || req === null || typeof req.method !== 'string' || typeof req.id !== 'number') return;

    const handler = this.handlers.get(req.method);
    let response: RpcResponse;
    try {
      if (!handler) throw new RpcError('UNKNOWN_METHOD', `Unknown method '${req.method}'`);
      if (!session.helloDone && req.method !== 'hello') throw new RpcError('BAD_REQUEST', `Call 'hello' first`);
      this.takeToken(session);
      const result = await handler(req.params ?? {}, session);
      response = { id: req.id, result: result === undefined ? null : result };
    } catch (e) {
      response = { id: req.id, error: toErrorShape(e) };
    }
    if (!session.isOpen) return;
    try {
      this.hooks.beforeRespond?.(session);
    } catch (e) {
      console.error('[melvor-script] beforeRespond failed', e);
    }
    session.respond(response);
  }

  /** Like Adventure Land's call limit: a loop with no pacing gets refused instead of flooding the game. */
  private takeToken(session: ClientSession) {
    const { perSecond, burst } = this.rateLimit;
    const now = Date.now();
    session.tokens = Math.min(
      burst,
      (session.tokens === Infinity ? burst : session.tokens) + ((now - session.lastRefill) / 1000) * perSecond,
    );
    session.lastRefill = now;
    if (session.tokens < 1) {
      if (!session.rateLimitedSince) {
        session.rateLimitedSince = now;
        this.hooks.onRateLimited?.(session);
      }
      throw new RpcError(
        'RATE_LIMITED',
        `Too many calls (limit ${perSecond}/s). Pace your loop: check m.ready, await calls, or use a longer setInterval.`,
      );
    }
    session.tokens -= 1;
    if (session.rateLimitedSince && now - session.rateLimitedSince > 5000) session.rateLimitedSince = 0;
  }
}

function toErrorShape(e: unknown): NonNullable<RpcResponse['error']> {
  if (e instanceof RpcError) return { code: e.code, message: e.message, data: e.data };
  // Duck-typed: in NW.js, errors from Node built-ins come from a different JS context than `Error`.
  if (typeof e === 'object' && e !== null && typeof (e as Error).message === 'string') {
    return { code: 'INTERNAL', message: (e as Error).message, data: { stack: (e as Error).stack } };
  }
  return { code: 'INTERNAL', message: String(e) };
}
