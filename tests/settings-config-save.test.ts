import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as siyuan from "siyuan";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import type { PluginSettings } from "../src/types/settings";
import { SettingsPanel } from "../src/ui/settings";

const nodeRequire = createRequire(import.meta.url);
const originalWindow = (globalThis as { window?: unknown }).window;
const workspaces: string[] = [];

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function editor(value: string, visualFont?: string): { root: HTMLElement; area: { value: string } } {
  const area = { value };
  const input = { dataset: { configKey: "NOTO_FONT_PATH" }, value: visualFont };
  const root = {
    querySelector: (selector: string) => selector === "[data-config-json]" ? area
      : selector === "[data-config-tab='visual']" && visualFont !== undefined ? { dataset: { active: "true" } } : null,
    querySelectorAll: (selector: string) => selector === "[data-config-key]" && visualFont !== undefined ? [input] : [],
  } as unknown as HTMLElement;
  return { root, area };
}

function setup(workspace: string) {
  const onSave = vi.fn(async (_settings: PluginSettings) => {});
  const getWorkspaceInfo = vi.fn(async () => ({ workspaceDir: workspace }));
  const panel = new SettingsPanel("test", () => structuredClone(DEFAULT_SETTINGS),
    { getWorkspaceInfo } as never, {} as never, onSave);
  const state = panel as unknown as {
    configRoot: HTMLElement;
    scheduleSaveConfig(root: HTMLElement): void;
  };
  const callbacks = (panel.setting as unknown as {
    options: { confirmCallback: () => void; destroyCallback: () => void };
  }).options;
  return { state, callbacks, onSave, getWorkspaceInfo };
}

function managedConfig(workspace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspace, "data", "plugins", "siyuan-paper-manager", "pdf2zh", "config.json"), "utf8"));
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { window?: unknown }).window = { require: nodeRequire };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "paper-manager-settings-"));
  workspaces.push(workspace);
  return workspace;
}

it("flushes a pending JSON edit before saving settings when confirmed immediately", async () => {
  const workspace = temporaryWorkspace();
  const { state, callbacks, onSave } = setup(workspace);
  const { root } = editor('{"NOTO_FONT_PATH":"/new-font.ttf"}');
  state.configRoot = root;
  state.scheduleSaveConfig(root);

  callbacks.confirmCallback();
  callbacks.destroyCallback();
  await flushPromises();

  expect(managedConfig(workspace).NOTO_FONT_PATH).toBe("/new-font.ttf");
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    pdf2zhConfig: expect.objectContaining({ NOTO_FONT_PATH: "/new-font.ttf" }),
  }));
  await vi.advanceTimersByTimeAsync(500);
  expect(onSave).toHaveBeenCalledOnce();
});

it("flushes a pending visual edit before saving settings", async () => {
  const workspace = temporaryWorkspace();
  const { state, callbacks, onSave } = setup(workspace);
  const { root } = editor("{}", "/visual-font.ttf");
  state.configRoot = root;
  state.scheduleSaveConfig(root);

  callbacks.confirmCallback();
  callbacks.destroyCallback();
  await flushPromises();

  expect(managedConfig(workspace).NOTO_FONT_PATH).toBe("/visual-font.ttf");
  expect(onSave).toHaveBeenCalledOnce();
});

it("shows invalid JSON and does not save plugin settings", async () => {
  const workspace = temporaryWorkspace();
  const { state, callbacks, onSave } = setup(workspace);
  const messages = vi.spyOn(siyuan, "showMessage");
  const { root } = editor("{bad json");
  state.configRoot = root;
  state.scheduleSaveConfig(root);

  callbacks.confirmCallback();
  callbacks.destroyCallback();
  await flushPromises();

  expect(onSave).not.toHaveBeenCalled();
  expect(messages).toHaveBeenCalledWith(expect.stringContaining("设置保存失败"), 5000, "error");
});

it("does not let an older workspace lookup overwrite the confirmed config", async () => {
  const workspace = temporaryWorkspace();
  const { state, callbacks, onSave, getWorkspaceInfo } = setup(workspace);
  let resolveOld!: (value: { workspaceDir: string }) => void;
  getWorkspaceInfo.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const { root, area } = editor('{"NOTO_FONT_PATH":"/old.ttf"}');
  state.configRoot = root;
  state.scheduleSaveConfig(root);
  await vi.advanceTimersByTimeAsync(500);

  area.value = '{"NOTO_FONT_PATH":"/new.ttf"}';
  state.scheduleSaveConfig(root);
  callbacks.confirmCallback();
  callbacks.destroyCallback();
  await flushPromises();
  expect(managedConfig(workspace).NOTO_FONT_PATH).toBe("/new.ttf");
  expect(onSave).toHaveBeenCalledOnce();

  resolveOld({ workspaceDir: workspace });
  await flushPromises();
  expect(managedConfig(workspace).NOTO_FONT_PATH).toBe("/new.ttf");
});

it("drops a pending or in-flight automatic save when the dialog is closed", async () => {
  const workspace = temporaryWorkspace();
  const configFile = join(workspace, "data", "plugins", "siyuan-paper-manager", "pdf2zh", "config.json");
  const { state, callbacks, getWorkspaceInfo } = setup(workspace);
  const { root } = editor('{"NOTO_FONT_PATH":"/cancelled.ttf"}');
  state.configRoot = root;
  state.scheduleSaveConfig(root);
  callbacks.destroyCallback();
  await vi.advanceTimersByTimeAsync(500);
  expect(getWorkspaceInfo).not.toHaveBeenCalled();

  let resolveLookup!: (value: { workspaceDir: string }) => void;
  getWorkspaceInfo.mockImplementationOnce(() => new Promise(resolve => { resolveLookup = resolve; }));
  state.scheduleSaveConfig(root);
  await vi.advanceTimersByTimeAsync(500);
  callbacks.destroyCallback();
  resolveLookup({ workspaceDir: workspace });
  await flushPromises();
  expect(existsSync(configFile)).toBe(false);
});
