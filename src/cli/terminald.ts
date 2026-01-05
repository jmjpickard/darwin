#!/usr/bin/env tsx
/**
 * Terminal Proxy Daemon
 *
 * Exposes a local PTY over a Unix socket so Darwin can control terminals
 * from inside sandboxed environments.
 */

import { createServer, Socket } from 'net';
import { chmod, lstat, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import * as pty from 'node-pty';
import { Logger, setLogLevel } from '../core/logger.js';
import { ensureConfigDir } from '../core/config.js';
import { ensureNodePtyHelperExecutable } from '../core/terminal-pty-helper.js';
import {
  TERMINAL_PROXY_VERSION,
  createNdjsonParser,
  encodeNdjson,
  getDefaultTerminalProxySocketPath,
} from '../core/terminal-proxy-protocol.js';

type ProxyMessage = {
  op?: unknown;
  [key: string]: unknown;
};

interface Session {
  id: string;
  pty: pty.IPty;
  owner: Socket;
}

const logger = new Logger('Terminald');
const socketPath = process.env.DARWIN_TERMINAL_PROXY_SOCKET || getDefaultTerminalProxySocketPath();
const token = process.env.DARWIN_TERMINAL_PROXY_TOKEN;
const logLevel = process.env.LOG_LEVEL;
const sanitizeEnv = process.env.DARWIN_TERMINAL_PROXY_SANITIZE_ENV !== '0';
const minimalEnvRetry = process.env.DARWIN_TERMINAL_PROXY_MINIMAL_ENV !== '0';
if (logLevel === 'debug' || logLevel === 'info' || logLevel === 'warn' || logLevel === 'error') {
  setLogLevel(logLevel);
}

let activeSession: Session | null = null;
let serverClosed = false;

async function main(): Promise<void> {
  await ensureConfigDir();
  await ensureNodePtyHelperExecutable(logger);
  await removeStaleSocket(socketPath);

  const server = createServer((socket) => handleConnection(socket));

  server.on('error', (error) => {
    logger.error(`Server error: ${error.message}`);
  });

  server.listen(socketPath, async () => {
    try {
      await chmod(socketPath, 0o600);
    } catch (error) {
      logger.warn(`Failed to set socket permissions: ${(error as Error).message}`);
    }
    logger.info(`Terminal proxy listening on ${socketPath}`);
  });

  const shutdown = async (signal: string) => {
    if (serverClosed) return;
    serverClosed = true;
    logger.info(`Shutting down (${signal})`);

    if (activeSession) {
      activeSession.pty.kill();
      activeSession = null;
    }

    server.close(async () => {
      try {
        await unlink(socketPath);
      } catch {
        // Ignore cleanup errors.
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function handleConnection(socket: Socket): void {
  let authed = !token;
  const connectionId = randomUUID();

  const send = (message: unknown) => {
    socket.write(encodeNdjson(message));
  };

  const sendError = (code: string, message: string, id?: string, session?: string) => {
    send({ op: 'error', code, message, id, session });
  };

  const parser = createNdjsonParser(
    (message) => handleMessage(message as ProxyMessage),
    (error) => logger.warn(`Parse error (${connectionId}): ${error.message}`)
  );

  socket.on('data', parser);
  socket.on('error', (error) => {
    logger.warn(`Socket error (${connectionId}): ${error.message}`);
  });
  socket.on('close', () => {
    if (activeSession && activeSession.owner === socket) {
      logger.warn(`Owner disconnected; terminating session ${activeSession.id}`);
      activeSession.pty.kill();
      activeSession = null;
    }
  });

  function handleMessage(message: ProxyMessage): void {
    const op = asString(message.op);
    if (!op) return;

    if (op === 'hello') {
      const providedToken = asString(message.token);
      if (token && providedToken !== token) {
        sendError('auth_failed', 'Invalid token');
        socket.end();
        return;
      }

      authed = true;
      send({ op: 'hello_ok', version: TERMINAL_PROXY_VERSION });
      return;
    }

    if (!authed) {
      sendError('auth_required', 'Handshake required');
      return;
    }

    if (op === 'spawn') {
      const id = asString(message.id);
      if (activeSession) {
        sendError('session_active', 'A session is already running', id);
        return;
      }

      const cmd = asString(message.cmd);
      if (!cmd) {
        sendError('invalid_request', 'Missing command', id);
        return;
      }

      const args = asStringArray(message.args) ?? [];
      const cwd = asString(message.cwd) ?? process.cwd();
      const mergedEnv = {
        ...normalizeEnv(process.env as Record<string, unknown>),
        ...normalizeEnv(message.env),
      };
      const { env, stripped } = sanitizeProxyEnv(mergedEnv, sanitizeEnv);
      const cols = asNumber(message.cols) ?? 120;
      const rows = asNumber(message.rows) ?? 40;

      if (!env.TERM) env.TERM = 'xterm-256color';
      if (!env.COLORTERM) env.COLORTERM = 'truecolor';

      logger.info(`Spawn ${cmd} ${args.join(' ')}`);
      logger.debug(`CWD: ${cwd}`);
      if (stripped.length > 0) {
        logger.debug(`Stripped env vars: ${stripped.join(', ')}`);
      }

      try {
        const ptyProcess = spawnPty(cmd, args, cwd, cols, rows, env);

        const sessionId = randomUUID();
        activeSession = { id: sessionId, pty: ptyProcess, owner: socket };

        send({ op: 'spawned', id, session: sessionId, pid: ptyProcess.pid });

        ptyProcess.onData((data) => {
          send({
            op: 'data',
            session: sessionId,
            data_b64: Buffer.from(data, 'utf8').toString('base64'),
          });
        });

        ptyProcess.onExit(({ exitCode, signal }) => {
          send({
            op: 'exit',
            session: sessionId,
            code: exitCode ?? null,
            signal: signal !== undefined ? String(signal) : null,
          });
          if (activeSession?.id === sessionId) {
            activeSession = null;
          }
        });
      } catch (error) {
        const firstError = formatSpawnError(error);
        if (minimalEnvRetry) {
          const minimalEnv = buildMinimalEnv(env);
          if (!isSameEnv(env, minimalEnv)) {
            logger.warn(`Retrying spawn with minimal env after error: ${firstError}`);
            try {
              const ptyProcess = spawnPty(cmd, args, cwd, cols, rows, minimalEnv);

              const sessionId = randomUUID();
              activeSession = { id: sessionId, pty: ptyProcess, owner: socket };

              send({ op: 'spawned', id, session: sessionId, pid: ptyProcess.pid });

              ptyProcess.onData((data) => {
                send({
                  op: 'data',
                  session: sessionId,
                  data_b64: Buffer.from(data, 'utf8').toString('base64'),
                });
              });

              ptyProcess.onExit(({ exitCode, signal }) => {
                send({
                  op: 'exit',
                  session: sessionId,
                  code: exitCode ?? null,
                  signal: signal !== undefined ? String(signal) : null,
                });
                if (activeSession?.id === sessionId) {
                  activeSession = null;
                }
              });
              return;
            } catch (retryError) {
              const retryDetails = formatSpawnError(retryError);
              logger.error(`Spawn failed after minimal env retry: ${retryDetails}`);
              sendError('spawn_failed', `${firstError}; retry: ${retryDetails}`, id);
              return;
            }
          }
        }

        logger.error(`Spawn failed: ${firstError}`);
        sendError('spawn_failed', firstError, id);
      }

      return;
    }

    const session = asString(message.session);
    if (!activeSession || !session || activeSession.id !== session) {
      sendError('invalid_session', 'Session not found');
      return;
    }

    if (activeSession.owner !== socket) {
      sendError('not_owner', 'Session is owned by another connection', undefined, session);
      return;
    }

    if (op === 'write') {
      const dataB64 = asString(message.data_b64);
      const dataRaw = dataB64 ? Buffer.from(dataB64, 'base64').toString('utf8') : asString(message.data);
      if (!dataRaw) {
        sendError('invalid_request', 'Missing data', undefined, session);
        return;
      }
      activeSession.pty.write(dataRaw);
      return;
    }

    if (op === 'resize') {
      const cols = asNumber(message.cols);
      const rows = asNumber(message.rows);
      if (!cols || !rows) {
        sendError('invalid_request', 'Missing cols/rows', undefined, session);
        return;
      }
      activeSession.pty.resize(cols, rows);
      return;
    }

    if (op === 'signal') {
      const signal = asString(message.signal) || 'SIGTERM';
      activeSession.pty.kill(signal);
      return;
    }

    if (op === 'close') {
      activeSession.pty.kill();
      activeSession = null;
      return;
    }

    sendError('unknown_op', `Unknown op: ${op}`);
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) {
      throw new Error(`Path exists and is not a socket: ${path}`);
    }
    await unlink(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return;
    throw error;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    output.push(item);
  }
  return output;
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      output[key] = raw;
    } else if (raw !== undefined && raw !== null) {
      output[key] = String(raw);
    }
  }
  return output;
}

function sanitizeProxyEnv(
  env: Record<string, string>,
  enabled: boolean
): { env: Record<string, string>; stripped: string[] } {
  if (!enabled) {
    return { env, stripped: [] };
  }

  const stripped: string[] = [];
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (shouldStripEnvKey(key)) {
      stripped.push(key);
      continue;
    }
    cleaned[key] = value;
  }

  return { env: cleaned, stripped };
}

function shouldStripEnvKey(key: string): boolean {
  if (key.includes('DYLD_')) return true;
  if (key.startsWith('__XPC_DYLD_')) return true;
  if (key.startsWith('__XPC_LD_')) return true;
  if (key === 'LD_PRELOAD') return true;
  if (key === 'LD_LIBRARY_PATH') return true;
  if (key === 'LD_AUDIT') return true;
  return false;
}

function spawnPty(
  cmd: string,
  args: string[],
  cwd: string,
  cols: number,
  rows: number,
  env: Record<string, string>
): pty.IPty {
  return pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
}

function formatSpawnError(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(err.code);
  if (typeof err.errno === 'number') parts.push(`errno=${err.errno}`);
  if (err.syscall) parts.push(err.syscall);
  return parts.join(' ');
}

function buildMinimalEnv(env: Record<string, string>): Record<string, string> {
  const keep = [
    'PATH',
    'HOME',
    'SHELL',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'COLORTERM',
    'TMPDIR',
  ];
  const minimal: Record<string, string> = {};
  for (const key of keep) {
    if (env[key]) minimal[key] = env[key];
  }
  if (!minimal.PATH) {
    minimal.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return minimal;
}

function isSameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

main().catch((error) => {
  logger.error(`Terminal proxy failed: ${error.message}`);
  process.exit(1);
});
