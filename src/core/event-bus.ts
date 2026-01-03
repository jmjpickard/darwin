/**
 * Event Bus - Inter-module communication via events
 */

import { EventEmitter } from 'events';

export interface DarwinEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

// Keep the old name as alias for backwards compatibility during transition
export type HomebaseEvent = DarwinEvent;

type EventHandler = (event: DarwinEvent) => void | Promise<void>;

export class EventBus extends EventEmitter {
  private history: DarwinEvent[] = [];
  private maxHistory = 100;

  /**
   * Publish an event to the bus
   */
  publish(source: string, type: string, data: Record<string, unknown>): void {
    const event: DarwinEvent = {
      source,
      type,
      data,
      timestamp: new Date(),
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    this.emit(`${source}:${type}`, event);
    this.emit('*', event);
  }

  /**
   * Subscribe to events from a specific source and type
   */
  subscribe(source: string, type: string, handler: EventHandler): void {
    this.on(`${source}:${type}`, handler);
  }

  /**
   * Subscribe to all events
   */
  subscribeToAll(handler: EventHandler): void {
    this.on('*', handler);
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(source: string, type: string, handler: EventHandler): void {
    this.off(`${source}:${type}`, handler);
  }

  /**
   * Get recent event history
   */
  getHistory(limit?: number): DarwinEvent[] {
    const count = limit ?? this.maxHistory;
    return this.history.slice(-count);
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.history = [];
  }
}

// Singleton instance
export const eventBus = new EventBus();
