import type { Plugin } from "siyuan";
import type { PluginSettings } from "../types/settings";
import { normalizeSettings } from "../types/settings";

const STORAGE_KEY = "settings.json";

export class SettingsStore {
  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<PluginSettings> {
    try {
      return normalizeSettings(await this.plugin.loadData(STORAGE_KEY));
    } catch (error) {
      console.warn("[paper-manager] 设置读取失败，使用默认值", error);
      return normalizeSettings({});
    }
  }

  async save(settings: PluginSettings): Promise<void> {
    await this.plugin.saveData(STORAGE_KEY, normalizeSettings(settings));
  }
}
