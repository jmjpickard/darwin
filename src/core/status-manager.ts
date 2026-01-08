/**
 * Status Manager
 *
 * Writes Darwin status updates to ~/.darwin/status.json
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { Logger } from './logger.js';
import { getConfigDir } from './config.js';
import { DarwinStatus } from './prd-types.js';

export class StatusManager {
  private statusDir: string;
  private statusPath: string;
  private logger: Logger;

  constructor(statusDir: string = getConfigDir()) {
    this.statusDir = statusDir;
    this.statusPath = join(this.statusDir, 'status.json');
    this.logger = new Logger('StatusManager');
  }

  getStatusPath(): string {
    return this.statusPath;
  }

  async readStatus(): Promise<DarwinStatus | null> {
    try {
      const content = await readFile(this.statusPath, 'utf-8');
      return JSON.parse(content) as DarwinStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async writeStatus(status: DarwinStatus): Promise<void> {
    await this.ensureDir();
    const content = JSON.stringify(status, null, 2);
    await writeFile(this.statusPath, content, 'utf-8');
    this.logger.debug(`Wrote status to ${this.statusPath}`);
  }

  private async ensureDir(): Promise<void> {
    try {
      await access(this.statusDir);
    } catch {
      await mkdir(this.statusDir, { recursive: true });
      this.logger.debug(`Created status directory: ${this.statusDir}`);
    }
  }
}
