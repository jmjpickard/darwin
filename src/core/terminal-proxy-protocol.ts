import { join } from 'path';
import { getConfigDir } from './config.js';

export const TERMINAL_PROXY_VERSION = 1;
const DEFAULT_SOCKET_NAME = 'terminald.sock';

export function getDefaultTerminalProxySocketPath(): string {
  return join(getConfigDir(), DEFAULT_SOCKET_NAME);
}

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function createNdjsonParser(
  onMessage: (message: unknown) => void,
  onError: (error: Error) => void
): (chunk: Buffer | string) => void {
  let buffer = '';

  return (chunk: Buffer | string) => {
    buffer += chunk.toString();

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        onMessage(message);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
}
