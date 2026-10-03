// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Dynamic Plugin Manager                            │
// │ Role: Dynamic hot-reloading Cordis plugin supervisor for Navigator. │
// │ 模块职责：Navigator Cordis 动态插件热重载与生命周期管理。              │
// └─────────────────────────────────────────────────────────────────────┘

import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context, Fiber } from '@deepseek-ai/cordis';

export interface DynamicPluginInfo {
  readonly id: string;
  readonly name: string;
  readonly modulePath: string;
  readonly loadedAt: string;
  readonly status: 'loaded' | 'failed' | 'disposed';
  readonly error?: string;
}

interface ManagedPluginEntry {
  id: string;
  name: string;
  modulePath: string;
  fiber?: Fiber;
  loadedAt: string;
  status: 'loaded' | 'failed' | 'disposed';
  error?: string;
  config?: unknown;
}

export interface DynamicPluginManagerOptions {
  readonly pluginsDir?: string;
  readonly watch?: boolean;
}

export class DynamicPluginManager {
  private readonly managed = new Map<string, ManagedPluginEntry>();
  private watcher?: FSWatcher;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly ctx: Context,
    private readonly options: DynamicPluginManagerOptions = {},
  ) {
    if (options.pluginsDir && existsSync(options.pluginsDir)) {
      this.loadDirectory(options.pluginsDir);
      if (options.watch) {
        this.startWatching(options.pluginsDir);
      }
    }
  }

  /**
   * Load or reload an individual plugin from file path.
   * 中文：从文件路径加载或重新加载单个插件，不中断现存运行中的 Session。
   */
  async loadPlugin(
    id: string,
    modulePath: string,
    config?: unknown,
  ): Promise<DynamicPluginInfo> {
    const resolvedPath = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Plugin file does not exist: ${resolvedPath}`);
    }

    // If already loaded, safely dispose previous fiber first without impacting other plugins/sessions
    const existing = this.managed.get(id);
    if (existing?.fiber) {
      try {
        await existing.fiber.dispose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.ctx.logger('navigator-plugins').warn(`Failed to cleanly dispose plugin ${id}: ${msg}`);
      }
    }

    const timestamp = new Date().toISOString();
    try {
      // Use query timestamp to bust Node ESM module resolution cache
      const cacheBustUrl = `${pathToFileURL(resolvedPath).href}?t=${Date.now()}`;
      const moduleNamespace = await import(cacheBustUrl);
      const pluginExport = moduleNamespace.default ?? moduleNamespace;

      if (!pluginExport || (typeof pluginExport !== 'function' && typeof pluginExport !== 'object')) {
        throw new Error(`Plugin at ${resolvedPath} does not export a valid Cordis plugin function or object`);
      }

      const pluginName = moduleNamespace.name ?? pluginExport.name ?? id;

      // Mount into Cordis context as an isolated fiber
      const fiber = this.ctx.plugin(pluginExport, config as never);
      await fiber;

      const entry: ManagedPluginEntry = {
        id,
        name: pluginName,
        modulePath: resolvedPath,
        fiber,
        loadedAt: timestamp,
        status: 'loaded',
        config,
      };
      this.managed.set(id, entry);
      this.ctx.emit('navigator/plugin-loaded', this.toInfo(entry));

      return this.toInfo(entry);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedEntry: ManagedPluginEntry = {
        id,
        name: id,
        modulePath: resolvedPath,
        loadedAt: timestamp,
        status: 'failed',
        error: errorMsg,
        config,
      };
      this.managed.set(id, failedEntry);
      this.ctx.logger('navigator-plugins').error(`Plugin load failed for ${id}: ${errorMsg}`);
      return this.toInfo(failedEntry);
    }
  }

  /**
   * Reload an existing loaded plugin.
   * 中文：重新加载已存在的动态插件。
   */
  async reloadPlugin(id: string): Promise<DynamicPluginInfo> {
    const entry = this.managed.get(id);
    if (!entry) {
      throw new Error(`No plugin loaded with id: ${id}`);
    }
    return this.loadPlugin(id, entry.modulePath, entry.config);
  }

  /**
   * Unload and dispose a plugin.
   * 中文：卸载并释放指定插件。
   */
  async unloadPlugin(id: string): Promise<boolean> {
    const entry = this.managed.get(id);
    if (!entry) return false;

    if (entry.fiber) {
      try {
        await entry.fiber.dispose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.ctx.logger('navigator-plugins').warn(`Error disposing plugin ${id}: ${msg}`);
      }
    }

    entry.status = 'disposed';
    entry.fiber = undefined;
    this.managed.delete(id);
    this.ctx.emit('navigator/plugin-unloaded', { id });
    return true;
  }

  /**
   * Reload all managed plugins.
   * 中文：批量重新加载所有受管插件。
   */
  async reloadAll(): Promise<DynamicPluginInfo[]> {
    const results: DynamicPluginInfo[] = [];
    for (const [id, entry] of this.managed.entries()) {
      results.push(await this.loadPlugin(id, entry.modulePath, entry.config));
    }
    return results;
  }

  /**
   * List all currently registered dynamic plugins.
   * 中文：列出当前所有动态插件。
   */
  listPlugins(): readonly DynamicPluginInfo[] {
    return Array.from(this.managed.values()).map(e => this.toInfo(e));
  }

  /**
   * Scan and load all valid plugin files in directory.
   */
  private loadDirectory(dirPath: string): void {
    if (!existsSync(dirPath)) return;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        const pluginId = entry.name.replace(/\.(mjs|js)$/, '');
        const fullPath = join(dirPath, entry.name);
        void this.loadPlugin(pluginId, fullPath).catch(err => {
          this.ctx.logger('navigator-plugins').error(`Auto-load error for ${entry.name}: ${err}`);
        });
      }
    }
  }

  /**
   * Start directory watcher with debounced reloads.
   */
  private startWatching(dirPath: string): void {
    try {
      this.watcher = watch(dirPath, (eventType, filename) => {
        if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.mjs'))) return;
        const pluginId = filename.replace(/\.(mjs|js)$/, '');
        const fullPath = join(dirPath, filename);

        const existingTimer = this.debounceTimers.get(pluginId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          this.debounceTimers.delete(pluginId);
          if (!existsSync(fullPath)) {
            void this.unloadPlugin(pluginId);
          } else {
            void this.loadPlugin(pluginId, fullPath);
          }
        }, 150);

        this.debounceTimers.set(pluginId, timer);
      });
    } catch (err: unknown) {
      this.ctx.logger('navigator-plugins').warn(`Watcher failed to start for ${dirPath}: ${err}`);
    }
  }

  /**
   * Teardown watcher and all managed plugin fibers.
   */
  async dispose(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [id, entry] of this.managed.entries()) {
      if (entry.fiber) {
        try {
          await entry.fiber.dispose();
        } catch {
          // Ignore teardown errors during global dispose
        }
      }
    }
    this.managed.clear();
  }

  private toInfo(entry: ManagedPluginEntry): DynamicPluginInfo {
    return {
      id: entry.id,
      name: entry.name,
      modulePath: entry.modulePath,
      loadedAt: entry.loadedAt,
      status: entry.status,
      error: entry.error,
    };
  }
}

export const name = 'cyrene-plugin-manager';

export function apply(ctx: Context, options?: DynamicPluginManagerOptions): void {
  const manager = new DynamicPluginManager(ctx, options);
  ctx.provide('pluginManager', manager);
  ctx.effect(() => () => { void manager.dispose(); });
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginManager: DynamicPluginManager;
  }
  interface Events {
    'navigator/plugin-loaded'(entry: DynamicPluginInfo): void;
    'navigator/plugin-unloaded'(data: { id: string }): void;
  }
}
