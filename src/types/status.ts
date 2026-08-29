export type ConnectorState =
  | { state: "stopped" }
  | { state: "listening"; port: number }
  | { state: "error"; message: string };

export type TranslationState =
  | { state: "idle" }
  | { state: "running"; docId: string; progress?: number; message?: string }
  | { state: "success"; docId: string; elapsedMs: number }
  | { state: "error"; docId?: string; message: string };

export interface PluginStatus {
  connector: ConnectorState;
  translation: TranslationState;
  templateMode: "unknown" | "builtin";
}
