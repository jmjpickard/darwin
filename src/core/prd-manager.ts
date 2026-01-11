import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PrdItem } from './prd-types.js';

export class PrdManager {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  exists(): boolean {
    return existsSync(join(this.repoPath, 'prd.json'));
  }

  load(): PrdItem[] {
    const content = readFileSync(join(this.repoPath, 'prd.json'), 'utf-8');
    return JSON.parse(content) as PrdItem[];
  }

  getItems(): PrdItem[] {
    return this.load();
  }
}
