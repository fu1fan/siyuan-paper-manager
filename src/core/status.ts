import type { PluginStatus } from "../types/status";

export class StatusStore {
  private value: PluginStatus = {
    connector: { state: "stopped" },
    translation: { state: "idle" },
    templateMode: "unknown",
  };
  private readonly listeners = new Set<(status: PluginStatus) => void>();

  get(): PluginStatus {
    return this.value;
  }

  update(patch: Partial<PluginStatus>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener(this.value);
  }

  subscribe(listener: (status: PluginStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
}
