import { access, chmod } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';
import { Logger } from './logger.js';

const require = createRequire(import.meta.url);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSpawnHelperPath(): Promise<string | null> {
  let entry: string;
  try {
    entry = require.resolve('node-pty');
  } catch {
    return null;
  }

  const libDir = dirname(entry);
  const platformDir = `prebuilds/${process.platform}-${process.arch}`;
  const candidates = [
    resolve(libDir, '..', 'build/Release', 'spawn-helper'),
    resolve(libDir, '..', 'build/Debug', 'spawn-helper'),
    resolve(libDir, '..', platformDir, 'spawn-helper'),
    resolve(libDir, 'build/Release', 'spawn-helper'),
    resolve(libDir, 'build/Debug', 'spawn-helper'),
    resolve(libDir, platformDir, 'spawn-helper'),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function ensureNodePtyHelperExecutable(logger: Logger): Promise<void> {
  const helperPath = await findSpawnHelperPath();
  if (!helperPath) {
    logger.warn('node-pty spawn-helper not found for permission check');
    return;
  }

  try {
    await access(helperPath, fsConstants.X_OK);
    return;
  } catch {
    // Fallthrough to chmod.
  }

  try {
    await chmod(helperPath, 0o755);
    logger.info(`Updated spawn-helper permissions: ${helperPath}`);
  } catch (error) {
    logger.warn(`Failed to chmod spawn-helper: ${(error as Error).message}`);
  }
}
