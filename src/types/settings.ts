import {
  DEFAULT_ASSETS_DIR,
  DEFAULT_ZOTERO_PORT,
} from "../constants";

export interface PluginSettings {
  zoteroPort: number;
  autoListen: boolean;
  defaultLibraryDocId: string;
  onboardingCompleted: boolean;
  assetsDir: string;
  enableCnki: boolean;
  pdf2zhPath: string;
  translateFrom: string;
  translateTo: string;
  translateService: string;
  translationDual: boolean;
  autoDeleteOldTranslations: boolean;
  pdf2zhArgs: string[];
  translationAssetsDir: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  zoteroPort: DEFAULT_ZOTERO_PORT,
  autoListen: true,
  defaultLibraryDocId: "",
  onboardingCompleted: false,
  assetsDir: DEFAULT_ASSETS_DIR,
  enableCnki: false,
  pdf2zhPath: "pdf2zh",
  translateFrom: "en",
  translateTo: "zh",
  translateService: "google",
  translationDual: true,
  autoDeleteOldTranslations: false,
  pdf2zhArgs: [],
  translationAssetsDir: DEFAULT_ASSETS_DIR,
};

export function normalizeSettings(input: unknown): PluginSettings {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const oldArgs = typeof raw.pdf2zhArgs === "string"
    ? splitArgString(raw.pdf2zhArgs)
    : Array.isArray(raw.pdf2zhArgs)
      ? raw.pdf2zhArgs.filter((value): value is string => typeof value === "string")
      : DEFAULT_SETTINGS.pdf2zhArgs;
  return {
    zoteroPort: validPort(raw.zoteroPort) ? Number(raw.zoteroPort) : DEFAULT_SETTINGS.zoteroPort,
    autoListen: bool(raw.autoListen, DEFAULT_SETTINGS.autoListen),
    defaultLibraryDocId: optionalString(raw.defaultLibraryDocId),
    onboardingCompleted: bool(raw.onboardingCompleted, DEFAULT_SETTINGS.onboardingCompleted),
    assetsDir: normalizeAssetsDir(string(raw.assetsDir, DEFAULT_SETTINGS.assetsDir)),
    enableCnki: bool(raw.enableCnki, DEFAULT_SETTINGS.enableCnki),
    pdf2zhPath: string(raw.pdf2zhPath, DEFAULT_SETTINGS.pdf2zhPath),
    translateFrom: string(raw.translateFrom, DEFAULT_SETTINGS.translateFrom),
    translateTo: string(raw.translateTo, DEFAULT_SETTINGS.translateTo),
    translateService: string(raw.translateService, DEFAULT_SETTINGS.translateService),
    translationDual: bool(raw.translationDual, DEFAULT_SETTINGS.translationDual),
    autoDeleteOldTranslations: bool(raw.autoDeleteOldTranslations, DEFAULT_SETTINGS.autoDeleteOldTranslations),
    pdf2zhArgs: oldArgs,
    translationAssetsDir: normalizeAssetsDir(
      string(raw.translationAssetsDir ?? raw.translationOutDir, DEFAULT_SETTINGS.translationAssetsDir),
    ),
  };
}

/** Shell-free argument syntax: Windows double-quote escaping plus literal single quotes. */
export function splitArgString(value: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (char === "\\") {
      let count = 1;
      while (value[i + 1] === "\\") { count += 1; i += 1; }
      if (value[i + 1] === '"') {
        current += "\\".repeat(Math.floor(count / 2));
        i += 1;
        if (count % 2) current += '"';
        else quote = quote === '"' ? null : '"';
      } else current += "\\".repeat(count);
    } else if (char === '"') {
      quote = quote === '"' ? null : '"';
    } else if (char === "'" && !quote) {
      quote = "'";
    } else if (/\s/.test(char) && !quote) {
      if (started) output.push(current);
      current = "";
      started = false;
      continue;
    } else current += char;
    started = true;
  }
  if (started) output.push(current);
  return output;
}

/** Always quote tokens so edits round-trip spaces, empty values and backslashes. */
export function serializeArgs(args: readonly string[]): string {
  return args.map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`).join(" ");
}

export function normalizeAssetsDir(value: string): string {
  const clean = value.trim().replace(/\\/g, "/").replace(/\.{2,}/g, "");
  const withLeading = clean.startsWith("/") ? clean : `/${clean}`;
  return `${withLeading.replace(/\/+$/, "") || "/assets"}/`;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validPort(value: unknown): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
