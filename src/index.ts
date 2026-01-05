/**
 * Darwin - Local Home Intelligence System
 *
 * Main exports for the Darwin package
 */

// Core
export { Darwin, Homebase } from './core/darwin.js';
export { DarwinBrain, HomebaseBrain } from './core/brain.js';
export { DarwinModule, HomebaseModule, ModuleLoader } from './core/module.js';
export { EventBus, eventBus } from './core/event-bus.js';
export { Logger, setLogLevel, getLogLevel } from './core/logger.js';
export {
  loadConfig,
  getConfigDir,
  getConfigPath,
  getEnabledRepos,
} from './core/config.js';
export { TerminalController } from './core/terminal-controller.js';
export {
  DEFAULT_PATTERNS,
  DANGEROUS_PATTERNS,
  containsDangerousPattern,
} from './core/terminal-types.js';

// Modules
export { CodeAgentModule } from './modules/code-agent.js';
export { HomeAutomationModule } from './modules/home-automation.js';

// Types
export type { DarwinConfig } from './core/darwin.js';
export type { BrainConfig, Tool, ToolCall, ChatMessage, ChatResponse } from './core/brain.js';
export type { ModuleConfig, ModuleStatus } from './core/module.js';
export type { DarwinEvent, HomebaseEvent } from './core/event-bus.js';
export type { LogLevel } from './core/logger.js';
export type { DarwinUserConfig, RepoConfig } from './core/config.js';
export type {
  TerminalBackend,
  TerminalState,
  TerminalAction,
  TerminalActionType,
  TerminalObservation,
  TerminalControllerConfig,
  TerminalPatterns,
  TerminalEvents,
  ActionResult,
} from './core/terminal-types.js';
