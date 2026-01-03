/**
 * Home Automation Module - Controls lights, sensors, heating via Zigbee
 *
 * Registers tools:
 * - home_lights_set: Control lights
 * - home_heating_set: Control heating
 * - home_get_sensors: Get sensor readings
 * - home_get_motion: Get recent motion events
 *
 * TODO: Integrate with zigbee2mqtt or Home Assistant API
 */

import { DarwinModule, ModuleConfig } from '../core/module.js';
import { DarwinBrain } from '../core/brain.js';
import { eventBus } from '../core/event-bus.js';

interface HomeConfig extends ModuleConfig {
  zigbee2mqttUrl?: string;
  homeAssistantUrl?: string;
  homeAssistantToken?: string;
  mockMode: boolean; // For testing without real devices
}

interface Room {
  name: string;
  lights: string[];
  sensors: string[];
  currentBrightness: number;
  currentTemperature?: number;
  lastMotion?: Date;
}

const DEFAULT_CONFIG: HomeConfig = {
  enabled: true,
  mockMode: true, // Start in mock mode
};

export class HomeAutomationModule extends DarwinModule {
  readonly name = 'HomeAutomation';
  readonly description = 'Controls lights, sensors, and heating via Zigbee/Home Assistant';

  protected override config: HomeConfig;
  private rooms: Map<string, Room> = new Map();

  constructor(brain: DarwinBrain, config: ModuleConfig) {
    super(brain, config);
    this.config = { ...DEFAULT_CONFIG, ...config } as HomeConfig;
  }

  async init(): Promise<void> {
    this.logger.info(`Mode: ${this.config.mockMode ? 'Mock' : 'Live'}`);

    // Initialize mock rooms for testing
    if (this.config.mockMode) {
      this.initMockRooms();
    }

    // Register tools
    this.registerTools();

    this._healthy = true;
  }

  async start(): Promise<void> {
    this._enabled = true;

    // Start polling sensors (in real mode)
    if (!this.config.mockMode) {
      this.startSensorPolling();
    }

    eventBus.publish('home', 'module_started', { mockMode: this.config.mockMode });
  }

  async stop(): Promise<void> {
    this._enabled = false;
    eventBus.publish('home', 'module_stopped', {});
  }

  private initMockRooms(): void {
    const mockRooms: Room[] = [
      { name: 'living_room', lights: ['main', 'lamp'], sensors: ['motion', 'temp'], currentBrightness: 0 },
      { name: 'kitchen', lights: ['ceiling'], sensors: ['motion', 'temp'], currentBrightness: 0 },
      { name: 'bedroom', lights: ['main', 'bedside'], sensors: ['motion', 'temp'], currentBrightness: 0 },
      { name: 'office', lights: ['desk', 'overhead'], sensors: ['motion', 'temp', 'co2'], currentBrightness: 80 },
      { name: 'bathroom', lights: ['main'], sensors: ['motion', 'humidity'], currentBrightness: 0 },
    ];

    for (const room of mockRooms) {
      room.currentTemperature = 18 + Math.random() * 4;
      this.rooms.set(room.name, room);
    }
  }

  private registerTools(): void {
    // Control lights
    this.registerTool(
      'home_lights_set',
      'Set lights in a room to a brightness level (0-100)',
      {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Room name (e.g., living_room, kitchen, bedroom, office)' },
          brightness: { type: 'number', description: 'Brightness 0-100 (0 = off)' },
          color: { type: 'string', description: 'Optional color (warm, cool, red, etc.)' },
        },
        required: ['room', 'brightness'],
      },
      async (args) => this.setLights(args.room as string, args.brightness as number, args.color as string | undefined)
    );

    // Set heating
    this.registerTool(
      'home_heating_set',
      'Set heating target temperature for a zone',
      {
        type: 'object',
        properties: {
          zone: { type: 'string', description: 'Zone name or "all"' },
          temperature: { type: 'number', description: 'Target temperature in Celsius' },
        },
        required: ['zone', 'temperature'],
      },
      async (args) => this.setHeating(args.zone as string, args.temperature as number)
    );

    // Get sensor readings
    this.registerTool(
      'home_get_sensors',
      'Get current sensor readings for all rooms or a specific room',
      {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Optional room name, or omit for all rooms' },
        },
      },
      async (args) => this.getSensorReadings(args.room as string | undefined)
    );

    // Get motion events
    this.registerTool(
      'home_get_motion',
      'Get recent motion detection events',
      {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'Look back this many minutes (default: 30)' },
        },
      },
      async (args) => this.getMotionEvents((args.minutes as number) || 30)
    );

    // Trigger scene
    this.registerTool(
      'home_scene',
      'Trigger a predefined scene (e.g., bedtime, movie, morning)',
      {
        type: 'object',
        properties: {
          scene: {
            type: 'string',
            enum: ['bedtime', 'morning', 'movie', 'away', 'home'],
            description: 'Scene to activate'
          },
        },
        required: ['scene'],
      },
      async (args) => this.triggerScene(args.scene as string)
    );
  }

  private async setLights(room: string, brightness: number, color?: string): Promise<{ success: boolean; message: string }> {
    this.touch();

    if (room === 'all') {
      for (const r of this.rooms.values()) {
        r.currentBrightness = brightness;
      }
      this.logger.info(`All lights set to ${brightness}%`);
      eventBus.publish('home', 'lights_changed', { room: 'all', brightness });
      return { success: true, message: `All lights set to ${brightness}%` };
    }

    const roomData = this.rooms.get(room);
    if (!roomData) {
      return { success: false, message: `Unknown room: ${room}` };
    }

    roomData.currentBrightness = brightness;
    this.logger.info(`${room} lights set to ${brightness}%${color ? ` (${color})` : ''}`);

    eventBus.publish('home', 'lights_changed', { room, brightness, color });
    return { success: true, message: `${room} lights set to ${brightness}%` };
  }

  private async setHeating(zone: string, temperature: number): Promise<{ success: boolean; message: string }> {
    this.touch();

    this.logger.info(`Heating ${zone} set to ${temperature}C`);
    eventBus.publish('home', 'heating_changed', { zone, temperature });

    return { success: true, message: `Heating ${zone} set to ${temperature}C` };
  }

  private async getSensorReadings(room?: string): Promise<Record<string, unknown>> {
    this.touch();

    if (room) {
      const roomData = this.rooms.get(room);
      if (!roomData) {
        return { error: `Unknown room: ${room}` };
      }
      return {
        room: roomData.name,
        temperature: roomData.currentTemperature,
        brightness: roomData.currentBrightness,
        lastMotion: roomData.lastMotion,
      };
    }

    const readings: Record<string, unknown> = {};
    for (const [name, data] of this.rooms) {
      readings[name] = {
        temperature: data.currentTemperature?.toFixed(1),
        brightness: data.currentBrightness,
        lastMotion: data.lastMotion,
      };
    }
    return readings;
  }

  private async getMotionEvents(minutes: number): Promise<{ room: string; timestamp: Date }[]> {
    this.touch();

    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    const events: { room: string; timestamp: Date }[] = [];

    for (const [name, data] of this.rooms) {
      if (data.lastMotion && data.lastMotion > cutoff) {
        events.push({ room: name, timestamp: data.lastMotion });
      }
    }

    return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  private async triggerScene(scene: string): Promise<{ success: boolean; actions: string[] }> {
    this.touch();
    const actions: string[] = [];

    switch (scene) {
      case 'bedtime':
        await this.setLights('all', 0);
        actions.push('All lights off');
        await this.setHeating('all', 16);
        actions.push('Heating set to 16C');
        break;

      case 'morning':
        await this.setLights('kitchen', 100);
        await this.setLights('bathroom', 100);
        actions.push('Kitchen and bathroom lights on');
        await this.setHeating('all', 20);
        actions.push('Heating set to 20C');
        break;

      case 'movie':
        await this.setLights('living_room', 10);
        actions.push('Living room dimmed to 10%');
        break;

      case 'away':
        await this.setLights('all', 0);
        await this.setHeating('all', 14);
        actions.push('All lights off, heating to 14C');
        break;

      case 'home':
        await this.setLights('living_room', 80);
        await this.setHeating('all', 20);
        actions.push('Living room on, heating to 20C');
        break;

      default:
        return { success: false, actions: [`Unknown scene: ${scene}`] };
    }

    this.logger.info(`Scene "${scene}" triggered`);
    eventBus.publish('home', 'scene_triggered', { scene, actions });

    return { success: true, actions };
  }

  /**
   * Simulate motion (for testing)
   */
  simulateMotion(room: string): void {
    const roomData = this.rooms.get(room);
    if (roomData) {
      roomData.lastMotion = new Date();
      this.logger.debug(`Motion in ${room}`);
      eventBus.publish('home', 'motion', { room, timestamp: roomData.lastMotion });
    }
  }

  /**
   * Start polling real sensors (placeholder)
   */
  private startSensorPolling(): void {
    // TODO: Implement zigbee2mqtt or Home Assistant polling
    this.logger.warn('Real sensor polling not yet implemented');
  }
}
