import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { KernelClient } from "../src/core/kernel";
import { TranslatorService } from "../src/services/translator";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/types/settings";
import { paper } from "./fixtures";

/**
 * pdf2zh 的 BaseTranslator.set_envs 会用配置文件中该服务的 envs 整表替换内置默认表，
 * 且只遍历替换后仍存在的键去读取 os.environ。配置缺少凭据键名时，插件注入的密钥会被
 * 忽略，pdf2zh 随即抛 KeyError: 'DEEPSEEK_API_KEY'。这组测试锁定修复后的组合：
 * 托管配置保留凭据键名（值 null），真实密钥只经由进程环境注入。
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "paper-secrets-"));
  mkdirSync(join(root, "data/assets"), { recursive: true });
  writeFileSync(join(root, "data/assets/input.pdf"), "%PDF-1.4\n");
  const input = paper({ attachments: [{ title: "原稿", mimeType: "application/pdf", assetAddress: "assets/input.pdf", sha256: "x" }] });
  const captures: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const translator = new TranslatorService({
    getWorkspaceInfo: async () => ({ workspaceDir: root }),
    uploadAsset: async () => "assets/result.pdf",
  } as unknown as KernelClient, {
    requireFn: createRequire(import.meta.url),
    readPaper: async () => input,
    persist: vi.fn(),
    getSecret: (name) => ({ deepseek: "sk-test-key", "ali-secret": "ali-value" }[name] ?? ""),
    spawnProcess: (_exe, args, options: SpawnOptions) => {
      captures.push({ args, env: options.env as NodeJS.ProcessEnv });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      const output = args[args.indexOf("-o") + 1]!;
      writeFileSync(join(output, "input-mono.pdf"), "%PDF-1.4\n");
      setImmediate(() => child.emit("close", 0, null));
      return child as unknown as ChildProcess;
    },
  });
  return { root, translator, captures, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function settingsFor(root: string, overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    pdf2zhPath: process.execPath,
    translateService: "deepseek",
    translationDual: false,
    pdf2zhConfigPath: join(root, "pdf2zh", "config.json"),
    pdf2zhConfig: { translators: [{ name: "deepseek", envs: { DEEPSEEK_MODEL: "deepseek-flash" } }] },
    pdf2zhSecretNames: { DEEPSEEK_API_KEY: "deepseek" },
    ...overrides,
  };
}

function readConfig(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

it("keeps the credential key name in the managed config and injects the value via env", async () => {
  const { root, translator, captures, cleanup } = setup();
  try {
    await translator.translate("doc", settingsFor(root), {}).catch(() => {});
    expect(captures).toHaveLength(1);
    const configPath = captures[0]!.args[captures[0]!.args.indexOf("--config") + 1]!;
    const config = readConfig(configPath);
    // 键名必须在，值保持 null，否则 pdf2zh 不会去读 os.environ。
    expect(config.translators[0].envs).toEqual({ DEEPSEEK_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: null });
    // 真实密钥不落盘，只经环境变量注入。
    expect(JSON.stringify(config)).not.toContain("sk-test-key");
    expect(captures[0]!.env.DEEPSEEK_API_KEY).toBe("sk-test-key");
  } finally { cleanup(); }
});

it("repairs an existing managed config that lacks the credential placeholder", async () => {
  const { root, translator, captures, cleanup } = setup();
  try {
    const target = join(root, "pdf2zh", "config.json");
    mkdirSync(join(root, "pdf2zh"), { recursive: true });
    // 模拟本次报错现场的旧配置：envs 只有模型名。
    writeFileSync(target, JSON.stringify({ translators: [{ name: "deepseek", envs: { DEEPSEEK_MODEL: "deepseek-flash" } }] }));
    await translator.translate("doc", settingsFor(root), {}).catch(() => {});
    expect(captures).toHaveLength(1);
    expect(readConfig(target).translators[0].envs.DEEPSEEK_API_KEY).toBeNull();
  } finally { cleanup(); }
});

it("scrubs a plaintext key that pdf2zh wrote back into the managed config", async () => {
  const { root, translator, captures, cleanup } = setup();
  try {
    const target = join(root, "pdf2zh", "config.json");
    mkdirSync(join(root, "pdf2zh"), { recursive: true });
    // pdf2zh 运行后会把从环境读到的密钥回写配置文件，下次启动前必须清空。
    writeFileSync(target, JSON.stringify({ translators: [{ name: "deepseek", envs: {
      DEEPSEEK_API_KEY: "sk-written-back", DEEPSEEK_MODEL: "deepseek-flash",
    } }] }));
    await translator.translate("doc", settingsFor(root), {}).catch(() => {});
    expect(captures).toHaveLength(1);
    expect(readConfig(target).translators[0].envs.DEEPSEEK_API_KEY).toBeNull();
    expect(JSON.stringify(readConfig(target))).not.toContain("sk-written-back");
    expect(captures[0]!.env.DEEPSEEK_API_KEY).toBe("sk-test-key");
  } finally { cleanup(); }
});

it("uses the exact pdf2zh env key name for a service whose name is not a plain uppercase join", async () => {
  const { root, translator, captures, cleanup } = setup();
  try {
    const settings = settingsFor(root, {
      translateService: "qwen-mt",
      pdf2zhConfig: { translators: [{ name: "qwen-mt", envs: {} }] },
      pdf2zhSecretNames: { ALI_API_KEY: "ali-secret" },
    });
    await translator.translate("doc", settings, {}).catch(() => {});
    const env = captures[0]!.env;
    expect(captures[0]!.args).toContain("qwen-mt");
    expect(readConfig(settings.pdf2zhConfigPath!).translators[0].envs).toEqual({ ALI_API_KEY: null });
    expect(env).not.toHaveProperty("QWEN_MT_API_KEY");
  } finally { cleanup(); }
});

it("does not add a placeholder for a keyless service", async () => {
  const { root, translator, captures, cleanup } = setup();
  try {
    const settings = settingsFor(root, {
      translateService: "google",
      pdf2zhConfig: { translators: [{ name: "google", envs: {} }] },
      pdf2zhSecretNames: {},
    });
    await translator.translate("doc", settings, {}).catch(() => {});
    expect(captures).toHaveLength(1);
    expect(readConfig(settings.pdf2zhConfigPath!).translators[0].envs).toEqual({});
  } finally { cleanup(); }
});

it("falls back to a temporary config when the managed path cannot be written", async () => {
  const { root, translator, captures, cleanup } = setup();
  try {
    // 目标路径的父级是一个文件，写入必然失败。
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    const settings = settingsFor(root, { pdf2zhConfigPath: join(blocked, "config.json") });
    await translator.translate("doc", settings, {}).catch(() => {});
    expect(captures).toHaveLength(1);
    const configPath = captures[0]!.args[captures[0]!.args.indexOf("--config") + 1]!;
    expect(configPath).not.toBe(settings.pdf2zhConfigPath);
    expect(existsSync(configPath)).toBe(true);
    expect(readConfig(configPath).translators[0].envs.DEEPSEEK_API_KEY).toBeNull();
    expect(captures[0]!.env.DEEPSEEK_API_KEY).toBe("sk-test-key");
  } finally { cleanup(); }
});
