import path from "node:path";
import { createRequire } from "node:module";
import { execFile, spawn, type ExecFileException } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { NodeRequire } from "../src/core/env";
import type { KernelClient } from "../src/core/kernel";
import { resolveExecutable, TranslatorService } from "../src/services/translator";
import { probePdf2zh } from "../src/services/environment-check";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { paper } from "./fixtures";

function windowsLookup(files: string[], stdout = "", directories: string[] = []) {
  const lookup = vi.fn((_command, _args, _options, done) => done(null, stdout, ""));
  const requireFn: NodeRequire = (id) => ({
    path,
    os: { homedir: () => "C:\\Users\\Alice" },
    fs: { statSync: (name: string) => {
      if (!files.includes(name) && !directories.includes(name)) throw new Error("missing");
      return { isFile: () => files.includes(name) };
    } },
    child_process: { execFile: lookup },
  })[id];
  return { requireFn, lookup };
}

describe("Windows executable discovery", () => {
  it.each([String.raw`C:\Program Files\pdf2zh.exe`, "C:/中文 Path/pdf2zh.exe",
    String.raw`\\server\tools\pdf2zh.exe`])("accepts quoted executable %s", async (exe) => {
    const { requireFn, lookup } = windowsLookup([exe]);
    expect(await resolveExecutable(`"${exe}"`, requireFn, "win32")).toBe(exe);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("skips missing files and scripts to select an exe", async () => {
    const exe = String.raw`C:\Python\Scripts\pdf2zh.exe`;
    const { requireFn, lookup } = windowsLookup(["C:\\pdf2zh.cmd", exe], `C:\\missing.exe\r\nC:\\pdf2zh.cmd\r\n${exe}\r\n`);
    expect(await resolveExecutable("pdf2zh", requireFn, "win32")).toBe(exe);
    expect(lookup).toHaveBeenCalledWith("where.exe", ["pdf2zh"], expect.objectContaining({ shell: false, timeout: 3000 }), expect.any(Function));
  });
  it("falls back to uv's user bin even when PATH lookup fails", async () => {
    const exe = String.raw`C:\Users\Alice\.local\bin\pdf2zh.exe`;
    const { requireFn, lookup } = windowsLookup([exe]);
    lookup.mockImplementation((_c, _a, _o, done) => done(new Error("lookup failed"), "", ""));
    expect(await resolveExecutable("pdf2zh", requireFn, "win32")).toBe(exe);
  });
  it("rejects directories, missing files and batch launchers clearly", async () => {
    const { requireFn } = windowsLookup(["C:\\pdf2zh.cmd"], "C:\\pdf2zh.cmd\r\n", ["C:\\folder"]);
    await expect(resolveExecutable("C:\\folder", requireFn, "win32")).rejects.toThrow(/不是文件/);
    await expect(resolveExecutable("C:\\missing.exe", requireFn, "win32")).rejects.toThrow(/不存在/);
    await expect(resolveExecutable("C:\\pdf2zh.BAT", requireFn, "win32")).rejects.toThrow(/pdf2zh.exe/);
    await expect(resolveExecutable("pdf2zh", requireFn, "win32")).rejects.toThrow(/启动脚本/);
    await expect(resolveExecutable("pdf2zh", windowsLookup([]).requireFn, "win32")).rejects.toThrow(/未检测到/);
  });
});

describe("CLI startup probe", () => {
  it.each([
    [null, true, "启动检查通过"],
    [{ code: "ENOENT" }, false, "不存在"],
    [{ code: "EACCES", message: "denied" }, false, "启动失败"],
    [{ code: 2 }, false, "退出码 2"],
    [{ killed: true }, false, "超时"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, false, "输出超过"],
  ])("classifies %j", async (error, ok, detail) => {
    const run = vi.fn((_c, _a, _o, done) => done(error, "", "x".repeat(2000)));
    const result = await probePdf2zh("pdf2zh.exe", () => ({ execFile: run }));
    expect(result).toMatchObject({ ok });
    expect(result.detail).toContain(detail);
    expect(result.detail.length).toBeLessThan(1200);
    expect(run).toHaveBeenCalledWith("pdf2zh.exe", ["--help"], expect.objectContaining({ timeout: 15000, maxBuffer: 65536, shell: false }), expect.any(Function));
  });
  it("enforces a real child process timeout", async () => {
    const requireFn: NodeRequire = () => ({
      execFile: (_exe: string, _args: string[], options: import("node:child_process").ExecFileOptionsWithStringEncoding, done: (error: ExecFileException | null, stdout: string, stderr: string) => void) =>
        execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, done),
    });
    expect(await probePdf2zh(process.execPath, requireFn, 100)).toMatchObject({ ok: false, detail: expect.stringContaining("超时") });
  });
});

it("cancels a running real child without uploading or persisting", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paper cancel 中文 "));
  mkdirSync(path.join(root, "data", "assets"), { recursive: true });
  writeFileSync(path.join(root, "data", "assets", "input.pdf"), "%PDF-1.4\ninput");
  const fixture = fileURLToPath(new URL("./fixtures/fake-pdf2zh.mjs", import.meta.url));
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const uploadAsset = vi.fn();
  const persist = vi.fn();
  const translator = new TranslatorService({ getWorkspaceInfo: async () => ({ workspaceDir: root }), uploadAsset } as unknown as KernelClient, {
    requireFn: createRequire(import.meta.url), persist,
    readPaper: async () => paper({ attachments: [{ title: "input", mimeType: "application/pdf", assetAddress: "assets/input.pdf", sha256: "x" }] }),
    spawnProcess: (exe, args, options) => {
      const child = spawn(exe, [fixture, "--fixture-wait", ...args], options);
      child.stdout!.once("data", ready);
      return child;
    },
  });
  const outcome = translator.translate("doc", { ...DEFAULT_SETTINGS, pdf2zhPath: process.execPath });
  const rejected = expect(outcome).rejects.toThrow(/取消|中止|退出码/);
  try {
    await started;
    translator.cancel();
    await rejected;
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(translator.isRunning()).toBe(false);
  } finally {
    translator.cancel();
    rmSync(root, { recursive: true, force: true });
  }
});
