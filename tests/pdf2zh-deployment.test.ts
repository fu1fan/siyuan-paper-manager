import path from "node:path";
import type { NodeRequire } from "../src/core/env";
import { configPath, detectPdf2zh, inspectPdf2zh, resolvePdf2zh, systemConfigPath } from "../src/services/pdf2zh-deployment";

/**
 * These helpers branch on the real platform and only accept Windows
 * executables as `.exe`, so expectations must be derived the same way.
 * `findUv` falls back from `uv.exe` to `uv`, so stubbing `uv` works on both.
 */
const WINDOWS = process.platform === "win32";
const PATH_LOOKUP = WINDOWS ? "where" : "which";
const PDF2ZH_BIN = WINDOWS ? "pdf2zh.exe" : "pdf2zh";

/** Builds a NodeRequire stand-in from a table of `execFile` results keyed by "cmd arg1 arg2". */
function requireWith(execResults: Record<string, { stdout: string; code?: number }>, files: string[] = []) {
  const calls: string[] = [];
  const lookup = (file: string, args: string[], _options: unknown, done: (error: unknown, stdout: string, stderr: string) => void) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    const result = execResults[key];
    if (!result) { done({ code: 1 }, "", ""); return; }
    done(result.code ? { code: result.code } : null, result.stdout, "");
  };
  const requireFn: NodeRequire = (id) => ({
    path, os: { homedir: () => "/home/alice" },
    fs: {
      existsSync: (name: string) => files.includes(name),
      statSync: (name: string) => ({ isFile: () => files.includes(name) }),
      realpathSync: { native: (name: string) => name },
      readFileSync: () => "",
    },
    child_process: { execFile: lookup },
  })[id];
  return { requireFn, calls };
}

describe("pdf2zh managed config paths", () => {
  it("resolves the managed config under the plugin's workspace directory", () => {
    const { requireFn } = requireWith({});
    expect(configPath("/ws", "siyuan-paper-manager", requireFn)).toBe(path.join("/ws", "data", "plugins", "siyuan-paper-manager", "pdf2zh", "config.json"));
    expect(configPath("/ws", "other-plugin", requireFn)).toContain("other-plugin");
  });

  it("resolves the upstream system config for the current platform", () => {
    const resolved = systemConfigPath(requireWith({}).requireFn);
    expect(resolved.endsWith(path.join("PDFMathTranslate", "config.json"))).toBe(true);
  });
});

describe("detecting an installed pdf2zh", () => {
  it("prefers the uv tool bin over PATH", async () => {
    const binDir = "/home/alice/.local/bin";
    const bin = path.join(binDir, PDF2ZH_BIN);
    const { requireFn } = requireWith({
      "uv --version": { stdout: "uv 0.5.0\n" },
      "uv tool dir --bin": { stdout: `${binDir}\n` },
    }, [bin]);
    expect(await detectPdf2zh(requireFn)).toBe(bin);
  });

  it("falls back to PATH when uv is absent", async () => {
    const located = path.join("/usr/local/bin", PDF2ZH_BIN);
    const { requireFn } = requireWith({ [`${PATH_LOOKUP} pdf2zh`]: { stdout: `${located}\n` } }, [located]);
    expect(await detectPdf2zh(requireFn)).toBe(located);
  });

  it("returns null when nothing is installed", async () => {
    const { requireFn } = requireWith({});
    expect(await detectPdf2zh(requireFn)).toBeNull();
  });

  it("returns null when uv is present but pdf2zh is not installed", async () => {
    const { requireFn } = requireWith({ "uv --version": { stdout: "uv 0.5.0\n" }, "uv tool dir --bin": { stdout: "/home/alice/.local/bin\n" } });
    expect(await resolvePdf2zh("uv", requireFn)).toBeNull();
  });
});

describe("inspecting a uv-installed pdf2zh", () => {
  const binDir = "/home/alice/.local/bin";
  const bin = path.join(binDir, PDF2ZH_BIN);
  it("reads the version and interpreter from the uv tool environment", async () => {
    const toolDir = "/home/alice/.local/share/uv/tools";
    const { requireFn } = requireWith({
      "uv --version": { stdout: "uv 0.5.0\n" },
      "uv tool list --show-paths --show-python": { stdout: "pdf2zh v1.9.6\n" },
      "uv tool dir --bin": { stdout: `${binDir}\n` },
      "uv tool dir": { stdout: `${toolDir}\n` },
    }, [bin]);
    expect(await inspectPdf2zh(requireFn)).toMatchObject({ executable: bin, version: "1.9.6", toolDir });
  });

  it("returns null when pdf2zh does not appear in the uv tool list", async () => {
    const { requireFn } = requireWith({ "uv --version": { stdout: "uv 0.5.0\n" }, "uv tool list --show-paths --show-python": { stdout: "other-tool v1.0.0\n" } });
    expect(await inspectPdf2zh(requireFn)).toBeNull();
  });

  it("returns null when uv itself is unavailable", async () => {
    const { requireFn } = requireWith({});
    expect(await inspectPdf2zh(requireFn)).toBeNull();
  });
});
