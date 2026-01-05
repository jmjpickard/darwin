import { EventEmitter } from 'events';
import { createConnection, Socket } from 'net';
import { randomUUID } from 'crypto';
import { Logger } from './logger.js';
import {
  TERMINAL_PROXY_VERSION,
  createNdjsonParser,
  encodeNdjson,
  getDefaultTerminalProxySocketPath,
} from './terminal-proxy-protocol.js';

type ProxyMessage = {
  op?: unknown;
  [key: string]: unknown;
};

export interface TerminalProxyClientOptions {
  socketPath?: string;
  token?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface TerminalProxySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

type ExitEvent = { exitCode: number | null; signal?: string | null };

export interface TerminalProxyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: ExitEvent) => void): void;
  onError(callback: (error: Error) => void): void;
  close(): void;
}

class ProxyTerminalProcess extends EventEmitter implements TerminalProxyProcess {
  private closed = false;
  private exitEmitted = false;

  constructor(
    private socket: Socket,
    private sessionId: string,
    private send: (message: unknown) => void
  ) {
    super();
  }

  onData(callback: (data: string) => void): void {
    this.on('data', callback);
  }

  onExit(callback: (event: ExitEvent) => void): void {
    this.on('exit', callback);
  }

  onError(callback: (error: Error) => void): void {
    this.on('error', callback);
  }

  write(data: string): void {
    this.send({
      op: 'write',
      session: this.sessionId,
      data_b64: Buffer.from(data, 'utf8').toString('base64'),
    });
  }

  resize(cols: number, rows: number): void {
    this.send({ op: 'resize', session: this.sessionId, cols, rows });
  }

  kill(signal?: string): void {
    this.send({ op: 'signal', session: this.sessionId, signal: signal || 'SIGTERM' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
  }

  handleMessage(message: ProxyMessage): void {
    const op = asString(message.op);
    const session = asString(message.session);
    if (session && session !== this.sessionId) return;

    if (op === 'data') {
      const dataB64 = asString(message.data_b64);
      if (!dataB64) return;
      const data = Buffer.from(dataB64, 'base64').toString('utf8');
      this.emit('data', data);
      return;
    }

    if (op === 'exit') {
      if (this.exitEmitted) return;
      this.exitEmitted = true;
      const exitCode = asNumber(message.code);
      const signal = asString(message.signal) ?? null;
      this.emit('exit', { exitCode: exitCode ?? null, signal });
      this.close();
      return;
    }

    if (op === 'error') {
      const messageText = asString(message.message) || 'Terminal proxy error';
      this.emit('error', new Error(messageText));
    }
  }

  handleSocketClose(): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.emit('exit', { exitCode: null, signal: 'socket_closed' });
  }
}

export async function spawnProxyTerminal(
  clientOptions: TerminalProxyClientOptions,
  spawnOptions: TerminalProxySpawnOptions
): Promise<TerminalProxyProcess> {
  const logger = clientOptions.logger ?? new Logger('TerminalProxy');
  const socketPath = clientOptions.socketPath || getDefaultTerminalProxySocketPath();
  const timeoutMs = clientOptions.timeoutMs ?? 5000;

  const socket = createConnection(socketPath);
  socket.setNoDelay(true);

  await awaitConnect(socket, socketPath, timeoutMs);

  const pending = new Map<string, { resolve: (message: ProxyMessage) => void; reject: (error: Error) => void }>();
  let helloResolve: (() => void) | null = null;
  let helloReject: ((error: Error) => void) | null = null;
  let process: ProxyTerminalProcess | null = null;
  const pendingMessages: ProxyMessage[] = [];

  const send = (message: unknown) => {
    socket.write(encodeNdjson(message));
  };

  const handleMessage = (message: unknown) => {
    const parsed = message as ProxyMessage;
    const op = asString(parsed.op);
    if (!op) return;

    if (op === 'hello_ok' && helloResolve) {
      helloResolve();
      helloResolve = null;
      helloReject = null;
      return;
    }

    if (op === 'spawned') {
      const id = asString(parsed.id);
      if (!id) return;
      const handler = pending.get(id);
      if (!handler) return;
      pending.delete(id);
      handler.resolve(parsed);
      return;
    }

    if (op === 'error') {
      const id = asString(parsed.id);
      const messageText = asString(parsed.message) || 'Terminal proxy error';
      const error = new Error(messageText);

      if (id) {
        const handler = pending.get(id);
        if (handler) {
          pending.delete(id);
          handler.reject(error);
          return;
        }
      }

      if (helloReject) {
        helloReject(error);
        helloResolve = null;
        helloReject = null;
        return;
      }

      if (process) {
        process.emit('error', error);
        return;
      }

      logger.error(`Proxy error before session: ${error.message}`);
      return;
    }

    if (!process) {
      pendingMessages.push(parsed);
      return;
    }

    process.handleMessage(parsed);
  };

  const parser = createNdjsonParser(handleMessage, (error) => {
    logger.warn(`NDJSON parse error: ${error.message}`);
  });

  socket.on('data', parser);
  socket.on('close', () => {
    process?.handleSocketClose();
  });
  socket.on('error', (error) => {
    if (process) {
      process.emit('error', error);
    } else {
      logger.error(`Proxy socket error: ${error.message}`);
    }
  });

  await handshake(send, timeoutMs, clientOptions.token, () => {
    return new Promise<void>((resolve, reject) => {
      helloResolve = resolve;
      helloReject = reject;
    });
  });

  const spawnId = randomUUID();
  const spawnPromise = new Promise<ProxyMessage>((resolve, reject) => {
    pending.set(spawnId, { resolve, reject });
  });

  send({
    op: 'spawn',
    id: spawnId,
    cmd: spawnOptions.command,
    args: spawnOptions.args,
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    cols: spawnOptions.cols,
    rows: spawnOptions.rows,
  });

  const spawnResponse = await withTimeout(
    spawnPromise,
    timeoutMs,
    `Timed out waiting for spawn response from terminal proxy at ${socketPath}`
  );

  const sessionId = asString(spawnResponse.session);
  if (!sessionId) {
    throw new Error('Terminal proxy spawn response missing session id');
  }

  process = new ProxyTerminalProcess(socket, sessionId, send);
  pendingMessages.forEach((message) => process?.handleMessage(message));

  return process;
}

async function awaitConnect(socket: Socket, socketPath: string, timeoutMs: number): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off('error', onError);
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    }),
    timeoutMs,
    `Timed out connecting to terminal proxy at ${socketPath}`
  );
}

async function handshake(
  send: (message: unknown) => void,
  timeoutMs: number,
  token: string | undefined,
  waitForHello: () => Promise<void>
): Promise<void> {
  const helloPromise = waitForHello();
  send({ op: 'hello', version: TERMINAL_PROXY_VERSION, token });
  await withTimeout(helloPromise, timeoutMs, 'Timed out waiting for terminal proxy handshake');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
