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

// New: Consciousness and Monologue
export { Monologue, getMonologue, resetMonologue } from './core/monologue.js';
export { Consciousness } from './core/consciousness.js';
export { SubAgentManager } from './core/sub-agents.js';
export { WorkspaceManager } from './core/workspace-manager.js';
export { TaskTracker, getTaskTracker, resetTaskTracker } from './core/task-tracker.js';

// Integrations
export { OpenRouterClient, getOpenRouterClient, resetOpenRouterClient } from './integrations/openrouter.js';
export { WebSearch, getWebSearch, resetWebSearch } from './integrations/web-search.js';

// Modules
export { CodeAgentModule } from './modules/code-agent.js';
export { HomeAutomationModule } from './modules/home-automation.js';
export { SchedulerModule } from './modules/scheduler.js';

// Types
export type { DarwinConfig } from './core/darwin.js';
export type { BrainConfig, Tool, ToolCall, ChatMessage, ChatResponse } from './core/brain.js';
export type { ModuleConfig, ModuleStatus } from './core/module.js';
export type { DarwinEvent, HomebaseEvent } from './core/event-bus.js';
export type { LogLevel } from './core/logger.js';
export type {
  DarwinUserConfig,
  RepoConfig,
  ConsciousnessUserConfig,
  OpenRouterUserConfig,
  WebSearchUserConfig,
  CodeAgentUserConfig,
} from './core/config.js';

// New types
export type { Thought, ThoughtType, Priority, MonologueConfig } from './core/monologue.js';
export type { ConsciousnessConfig, ConsciousnessState } from './core/consciousness.js';
export type { SubAgent, SubAgentType, SubAgentStatus, SubAgentConfig } from './core/sub-agents.js';
export type { OpenRouterConfig, ResearchResult } from './integrations/openrouter.js';
export type { WebSearchConfig, SearchResult } from './integrations/web-search.js';
export type { Workspace, CloneProgress } from './core/workspace-manager.js';
export type { TaskInfo, TaskPhase, TaskSummary } from './core/task-tracker.js';
