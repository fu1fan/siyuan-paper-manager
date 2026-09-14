export type ConnectorState =
  | { state: "stopped" }
  | { state: "listening"; port: number }
  | { state: "error"; message: string };

export interface TranslationBatchStatus {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  tasks: Array<{ docId: string; title?: string; citekey?: string; progress?: number; message?: string }>;
  errors: string[];
}

export type TranslationState = (
  | { state: "idle" }
  | { state: "running"; docId: string; progress?: number; message?: string; title?: string; citekey?: string; queued?: number; active?: number }
  | { state: "success"; docId: string; elapsedMs: number }
  | { state: "error"; docId?: string; message: string }) & { batch?: TranslationBatchStatus };

export interface PluginStatus {
  connector: ConnectorState;
  translation: TranslationState;
  templateMode: "unknown" | "builtin";
}
