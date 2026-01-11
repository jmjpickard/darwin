import { spawn, ChildProcess } from 'child_process';
import { DarwinModule, ModuleConfig } from '../core/module.js';
import { DarwinBrain } from '../core/brain.js';

interface CodeAgentConfig extends ModuleConfig {
  repos?: Array<{ path: string; name: string }>;
}

export class CodeAgentModule extends DarwinModule {
  readonly name = 'code-agent';
  readonly description = 'Spawns ralph.sh for PRD execution';

  private ralphProcess: ChildProcess | null = null;
  private outputBuffer: string[] = [];
  private outputHandlers = new Set<(line: string) => void>();
  private pauseCheck: (() => boolean) | null = null;
  protected config: CodeAgentConfig;

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = config as CodeAgentConfig;
  }

  async init(): Promise<void> {
    this.registerTool(
      'start_prd',
      'Start ralph.sh to work through PRD items',
      { type: 'object', properties: { maxIterations: { type: 'number' } }, required: [] },
      async (args) => this.startRalph(args.maxIterations as number | undefined)
    );
    this.registerTool(
      'get_status',
      'Get ralph.sh status and recent output',
      { type: 'object', properties: {}, required: [] },
      async () => this.getStatus()
    );
    this.registerTool(
      'stop_prd',
      'Stop ralph.sh process',
      { type: 'object', properties: {}, required: [] },
      async () => this.stopRalph()
    );
    this.registerTool(
      'list_repos',
      'List configured repositories',
      { type: 'object', properties: {}, required: [] },
      async () => ({ repos: this.config.repos || [] })
    );
    this._healthy = true;
  }

  async start(): Promise<void> {
    this._status = 'running';
  }

  async stop(): Promise<void> {
    this.stopRalph();
    this._status = 'stopped';
  }

  // Methods required by repl.ts
  setPauseCheck(fn: () => boolean): void {
    this.pauseCheck = fn;
  }

  getCurrentSession(): { taskId: string } | null {
    return this.ralphProcess ? { taskId: 'ralph' } : null;
  }

  getOutputBuffer(): string[] {
    return [...this.outputBuffer];
  }

  onOutput(handler: (line: string) => void): void {
    this.outputHandlers.add(handler);
  }

  offOutput(handler: (line: string) => void): void {
    this.outputHandlers.delete(handler);
  }

  private startRalph(maxIterations?: number): { started: boolean; cwd: string } | { error: string } {
    if (this.ralphProcess) {
      return { error: 'Ralph is already running' };
    }

    const cwd = this.config.repos?.[0]?.path || process.cwd();
    const args = maxIterations ? [String(maxIterations)] : [];

    this.ralphProcess = spawn('./ralph.sh', args, { cwd, shell: true });
    this.outputBuffer = [];

    this.ralphProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.outputBuffer.push(line);
      this.outputHandlers.forEach((h) => h(line));
    });

    this.ralphProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.outputBuffer.push(line);
      this.outputHandlers.forEach((h) => h(line));
    });

    this.ralphProcess.on('close', () => {
      this.ralphProcess = null;
    });

    return { started: true, cwd };
  }

  private getStatus(): { running: boolean; buffer: string[] } {
    return {
      running: !!this.ralphProcess,
      buffer: this.outputBuffer.slice(-20),
    };
  }

  private stopRalph(): { stopped: boolean; reason?: string } {
    if (this.ralphProcess) {
      this.ralphProcess.kill();
      this.ralphProcess = null;
      return { stopped: true };
    }
    return { stopped: false, reason: 'not running' };
  }
}
