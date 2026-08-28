export const PLUGIN_NAME = "siyuan-paper-manager";
export const PAPER_SCHEMA_VERSION = 1 as const;
export const CONNECTOR_API_VERSION = 3;
export const CONNECTOR_SESSION_TTL_MS = 30 * 60 * 1000;
export const CONNECTOR_GRACE_MS = 2_000;
export const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;

export const ATTR = {
  data: "custom-paper-data",
  citekey: "custom-paper-citekey",
  doi: "custom-paper-doi",
  attachmentPdf: "custom-paper-attachment-pdf",
  translationMono: "custom-paper-translation-mono",
  translationDual: "custom-paper-translation-dual",
  state: "custom-paper-state",
  error: "custom-paper-error",
  section: "custom-section",
  assets: "data-assets",
} as const;

export const SECTION = {
  meta: "meta",
  note: "note",
} as const;

export const SOURCE = {
  connector: "zotero-connector",
  pdf: "pdf-import",
  manual: "manual",
} as const;

export const DEFAULT_ASSETS_DIR = "/assets/";
export const DEFAULT_DEST_PATH = "/文献库";
export const DEFAULT_ZOTERO_PORT = 23119;
