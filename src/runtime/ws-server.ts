/**
 * Minimal RFC 6455 WebSocket server on top of Node's `http` module.
 *
 * Written dependency-free so it runs inside the game (NW.js exposes Node
 * built-ins but not npm packages) and can be unit-tested in plain Node.
 * Supports text frames, fragmentation, ping/pong and close. No extensions.
 */
import type * as HttpNs from 'node:http';
import type * as CryptoNs from 'node:crypto';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface NodeDeps {
  http: typeof HttpNs;
  crypto: typeof CryptoNs;
  Buffer: typeof Buffer;
}

export interface UpgradeRequestInfo {
  url: URL;
  headers: HttpNs.IncomingHttpHeaders;
  remoteAddress: string | undefined;
}

export interface WsServerOptions {
  host: string;
  port: number;
  /** Return null to accept, or a reason string to reject with 403. */
  authorize(req: UpgradeRequestInfo): string | null;
  onConnection(conn: WsConnection, req: UpgradeRequestInfo): void;
  /** Plain HTTP GET handler (e.g. /status). Return undefined for 404. */
  onHttp?(path: string): unknown;
}

export class WsConnection {
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  /** @internal used by WsServer to track open connections. */
  internalOnClose: (() => void) | null = null;

  private buf: Buffer;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;
  private closed = false;

  constructor(
    private socket: Socket,
    private deps: NodeDeps,
  ) {
    this.buf = deps.Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish(1006, 'socket closed'));
    socket.on('error', () => this.finish(1006, 'socket error'));
  }

  get isOpen() {
    return !this.closed;
  }

  send(text: string) {
    if (this.closed) return;
    this.writeFrame(0x1, this.deps.Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const B = this.deps.Buffer;
    const reasonBuf = B.from(reason.slice(0, 120), 'utf8');
    const payload = B.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.writeFrame(0x8, payload);
    this.socket.end();
    this.finish(code, reason);
  }

  /** Feed raw bytes (used for the `head` of an upgrade request). */
  onData(chunk: Buffer) {
    if (this.closed) return;
    this.buf = this.buf.length ? this.deps.Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.parseFrame()) {
        /* keep parsing */
      }
    } catch (e) {
      this.close(1002, e instanceof Error ? e.message : 'protocol error');
    }
  }

  private parseFrame(): boolean {
    const buf = this.buf;
    if (buf.length < 2) return false;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      if (hi !== 0) throw new Error('frame too large');
      len = lo;
      offset = 10;
    }
    if (!masked) throw new Error('client frames must be masked');
    if (len > MAX_MESSAGE_BYTES) throw new Error('frame too large');
    if (buf.length < offset + 4 + len) return false;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = this.deps.Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    this.buf = buf.subarray(offset + len);

    this.handleFrame(fin, opcode, payload);
    return !this.closed;
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer) {
    switch (opcode) {
      case 0x0: {
        // continuation
        if (this.fragmentOpcode === 0) throw new Error('unexpected continuation frame');
        this.pushFragment(payload);
        if (fin) this.flushFragments();
        return;
      }
      case 0x1:
      case 0x2: {
        if (this.fragmentOpcode !== 0) throw new Error('expected continuation frame');
        if (fin) {
          if (opcode === 0x1) this.deliver(payload);
          return;
        }
        this.fragmentOpcode = opcode;
        this.pushFragment(payload);
        return;
      }
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code === 1005 || code === 1006 ? 1000 : code);
        return;
      }
      case 0x9:
        this.writeFrame(0xa, payload);
        return;
      case 0xa:
        return;
      default:
        throw new Error(`unknown opcode ${opcode}`);
    }
  }

  private pushFragment(payload: Buffer) {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new Error('message too large');
    this.fragments.push(payload);
  }

  private flushFragments() {
    const opcode = this.fragmentOpcode;
    const data = this.deps.Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    if (opcode === 0x1) this.deliver(data);
  }

  private deliver(payload: Buffer) {
    const text = payload.toString('utf8');
    try {
      this.onmessage?.(text);
    } catch (e) {
      console.error('[melvor-script] message handler threw', e);
    }
  }

  private writeFrame(opcode: number, payload: Buffer) {
    if (this.socket.destroyed) return;
    const B = this.deps.Buffer;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = B.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = B.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = B.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(B.concat([header, payload]));
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    // end() (graceful, flushes the close frame) was already called when we initiated the close.
    if (!this.socket.destroyed && !this.socket.writableEnded) this.socket.destroy();
    this.internalOnClose?.();
    try {
      this.onclose?.(code, reason);
    } catch (e) {
      console.error('[melvor-script] close handler threw', e);
    }
  }
}

export class WsServer {
  private server: HttpNs.Server | null = null;
  private connections = new Set<WsConnection>();

  constructor(
    private deps: NodeDeps,
    private opts: WsServerOptions,
  ) {}

  get address() {
    return `${this.opts.host}:${this.opts.port}`;
  }

  listen(): Promise<void> {
    const server = this.deps.http.createServer((req, res) => this.handleHttp(req, res));
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', onError);
        server.on('error', (err) => console.error('[melvor-script] server error', err));
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const conn of this.connections) conn.close(1001, 'server shutting down');
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private handleHttp(req: HttpNs.IncomingMessage, res: HttpNs.ServerResponse) {
    // Never answer browsers: any request carrying an Origin header is refused.
    if (req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    const body = req.method === 'GET' ? this.opts.onHttp?.(path) : undefined;
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private handleUpgrade(req: HttpNs.IncomingMessage, socket: Socket, head: Buffer) {
    const reject = (status: number, message: string) => {
      socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      reject(400, 'Bad Request');
      return;
    }
    const info: UpgradeRequestInfo = {
      url: new URL(req.url ?? '/', 'ws://localhost'),
      headers: req.headers,
      remoteAddress: socket.remoteAddress,
    };
    const denied = this.opts.authorize(info);
    if (denied !== null) {
      reject(403, 'Forbidden');
      return;
    }
    const accept = this.deps.crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new WsConnection(socket, this.deps);
    this.connections.add(conn);
    conn.internalOnClose = () => this.connections.delete(conn);
    this.opts.onConnection(conn, info);
    if (head && head.length) conn.onData(head);
  }
}
