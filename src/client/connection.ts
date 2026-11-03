import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcNotification,
  type RpcResponse,
} from '../shared/protocol.ts';
import { resolveConnection, type ConnectionConfig } from './config.ts';
import { MelvorError } from './errors.ts';

export interface ConnectOptions extends Partial<ConnectionConfig> {
  /** Shown in the in-game panel. Defaults to the script file name. */
  name?: string;
  /** Give up connecting after this many ms (default 5000). */
  timeoutMs?: number;
}

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; method: string; callSite: Error };

/** JSON-RPC over WebSocket to the game. Low level: most scripts use `Melvor` instead. */
export class Connection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(n: RpcNotification) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | null = null;
  private background = false;
  private holds: () => number = () => 0;

  private constructor(private ws: WebSocket) {
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', (code, reason) => this.onClose(`connection closed (${code}${reason.length ? `: ${reason}` : ''})`));
    ws.on('error', (err) => this.onClose(`connection error: ${err.message}`));
  }

  static open(opts: ConnectOptions = {}): Promise<Connection> {
    const cfg = resolveConnection(opts);
    const url = `ws://${cfg.host}:${cfg.port}/ws?token=${encodeURIComponent(cfg.token)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: opts.timeoutMs ?? 5000 });
      const fail = (msg: string) => {
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        reject(new MelvorError('DISCONNECTED', msg));
      };
      ws.once('open', () => {
        ws.removeAllListeners();
        resolve(new Connection(ws));
      });
      ws.once('unexpected-response', (_req, res) => {
        fail(
          res.statusCode === 403
            ? `The game refused the connection (bad token). The token in ~/.melvor-scripting/config.json must match the running game; restart the game if you edited it.`
            : `Unexpected HTTP ${res.statusCode} from ${cfg.host}:${cfg.port}`,
        );
      });
      ws.once('error', (err: Error & { code?: string }) => {
        fail(
          err.code === 'ECONNREFUSED'
            ? `Can't reach the game at ${cfg.host}:${cfg.port}. Is Melvor Idle running with the "Melvor Script" mod enabled and a character loaded?`
            : `Connection failed: ${err.message}`,
        );
      });
    });
  }

  get closed() {
    return this.closedReason !== null;
  }

  call<M extends MethodName>(method: M, ...args: ParamsOf<M> extends void ? [] : [ParamsOf<M>]): Promise<ResultOf<M>> {
    if (this.closedReason) return Promise.reject(new MelvorError('DISCONNECTED', this.closedReason));
    const id = this.nextId++;
    const params = args[0];
    // Errors arrive asynchronously; keep the caller's stack so failures point at the script line.
    const callSite = new Error();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, callSite });
      this.updateRef();
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          this.pending.delete(id);
          this.updateRef();
          reject(new MelvorError('DISCONNECTED', err.message));
        }
      });
    });
  }

  /**
   * @internal Background mode: the connection alone doesn't keep the process alive. It still
   * does while a call is pending or `holds()` > 0 (event listeners the script registered).
   * Used by run() once main() returns, so a script ends when nothing is left scheduled.
   */
  setBackground(on: boolean, holds?: () => number) {
    this.background = on;
    if (holds) this.holds = holds;
    this.updateRef();
  }

  /** @internal */
  updateRef() {
    const socket = (this.ws as unknown as { _socket?: { ref?(): void; unref?(): void } })._socket;
    if (!socket) return;
    if (this.background && this.pending.size === 0 && this.holds() === 0) socket.unref?.();
    else socket.ref?.();
  }

  /** Fire-and-forget call: errors are ignored. */
  cast<M extends MethodName>(method: M, ...args: ParamsOf<M> extends void ? [] : [ParamsOf<M>]): void {
    this.call(method, ...args).catch(() => {});
  }

  onNotification(fn: (n: RpcNotification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: (reason: string) => void): () => void;
  onClose(reason: string): void;
  onClose(arg: string | ((reason: string) => void)): (() => void) | void {
    if (typeof arg === 'function') {
      this.closeListeners.add(arg);
      return () => this.closeListeners.delete(arg);
    }
    if (this.closedReason) return;
    this.closedReason = arg;
    for (const p of this.pending.values()) p.reject(new MelvorError('DISCONNECTED', `${p.method}: ${arg}`));
    this.pending.clear();
    for (const fn of this.closeListeners) fn(arg);
  }

  close(): Promise<void> {
    if (this.closedReason) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close(1000, 'client done');
      setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000).unref();
    });
  }

  private onMessage(text: string) {
    let msg: RpcResponse & RpcNotification;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.updateRef();
      if (msg.error) {
        const err = new MelvorError(msg.error.code, msg.error.message, msg.error.data);
        err.stack = `${err.name}: ${err.message}\n${(p.callSite.stack ?? '').split('\n').slice(1).join('\n')}`;
        p.reject(err);
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') for (const fn of this.listeners) fn(msg);
  }
}

export { PROTOCOL_VERSION };
