import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import type { NodeRequire } from "../src/core/env";

const FAILURE = "ImportError: cannot import name 'TextTranslateRequest' from 'tencentcloud.tmt.v20180321.models'";
beforeEach(() => vi.resetModules());

function fixture(platform: string, options: { external?: boolean; isolated?: boolean; fail?: boolean; probeFailsAfterRepair?: boolean } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32" ? "C:\\Users\\Test User" : "/home/Test User";
  const base = platform === "win32" ? process.env.LOCALAPPDATA || paths.join(home, "AppData", "Local")
    : platform === "darwin" ? paths.join(home, "Library", "Application Support") : process.env.XDG_DATA_HOME || paths.join(home, ".local", "share");
  const root = options.external ? paths.join(home, ".local", "share", "uv", "tools", "pdf2zh")
    : paths.join(base, "siyuan-paper-manager", "pdf2zh", "tools", "pdf2zh");
  const binDir = options.external ? paths.join(home, ".local", "bin") : paths.join(base, "siyuan-paper-manager", "pdf2zh", "bin");
  const exe = paths.join(binDir, platform === "win32" ? "pdf2zh.exe" : "pdf2zh");
  const python = paths.join(root, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  let probeCount = 0;
  const requireFn: NodeRequire = id => ({
    path: paths,
    os: { platform: () => platform, homedir: () => home },
    fs: {
      existsSync: (p: string) => [exe, python, paths.join(root, "pyvenv.cfg")].includes(p),
      realpathSync: { native: (p: string) => p },
    },
    child_process: {
      execFile: (file: string, args: string[], _opts: Record<string, unknown>, done: (err: unknown, out: string, stderr: string) => void) => {
        if (args[0] === "--help") {
          const failure = ++probeCount === 1 || options.probeFailsAfterRepair;
          return done(failure ? { code: 1 } : null, "", failure ? FAILURE : "");
        }
        if (args[0] === "--version") return done(null, "uv 0.11.28", "");
        if (args[0] === "tool") return done(null, args.includes("--bin") ? paths.join(home, ".local", "bin") : paths.join(home, ".local", "share", "uv", "tools"), "");
        if (file === python) return done(null, `${root}\n${options.isolated === false ? "False" : "True"}\n1.9.11`, "");
        done({ code: 1 }, "", "");
      },
      spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ file, args, options: opts });
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
        setImmediate(() => { if (options.fail) child.stderr.write("download failed"); child.emit("close", options.fail ? 1 : 0); });
        return child;
      },
    },
  })[id];
  return { requireFn, exe, python, calls };
}

it.each(["win32", "darwin", "linux"])("repairs only the SDK inside a %s managed environment with spaces", async platform => {
  const { repairPdf2zhDependency } = await import("../src/services/pdf2zh-deployment");
  const f = fixture(platform);
  expect(await repairPdf2zhDependency(f.exe, FAILURE, f.requireFn)).toBe(true);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.args).toEqual(["pip", "install", "--python", f.python, "tencentcloud-sdk-python-tmt==3.1.70"]);
  expect(f.calls[0]?.options).toMatchObject({ shell: false });
});

it.each(["win32", "darwin", "linux"])("locates an existing external uv installation on %s", async platform => {
  const { repairPdf2zhDependency } = await import("../src/services/pdf2zh-deployment");
  const f = fixture(platform, { external: true });
  expect(await repairPdf2zhDependency(f.exe, FAILURE, f.requireFn)).toBe(true);
  expect(f.calls[0]?.args).toContain(f.python);
});

it("does not mutate an unrelated error or an unconfirmed system Python", async () => {
  const { repairPdf2zhDependency } = await import("../src/services/pdf2zh-deployment");
  expect(await repairPdf2zhDependency("anything", "authentication failed", () => { throw new Error("must not inspect"); })).toBe(false);
  const f = fixture("linux", { isolated: false });
  await expect(repairPdf2zhDependency(f.exe, FAILURE, f.requireFn)).rejects.toThrow("无法确认");
  expect(f.calls).toHaveLength(0);
});

it("merges concurrent repairs of the same executable", async () => {
  const { repairPdf2zhDependency } = await import("../src/services/pdf2zh-deployment");
  const f = fixture("darwin");
  await Promise.all([repairPdf2zhDependency(f.exe, FAILURE, f.requireFn), repairPdf2zhDependency(f.exe, FAILURE, f.requireFn)]);
  expect(f.calls).toHaveLength(1);
});

it("reports dependency download failures", async () => {
  const { repairPdf2zhDependency } = await import("../src/services/pdf2zh-deployment");
  const f = fixture("linux", { fail: true });
  await expect(repairPdf2zhDependency(f.exe, FAILURE, f.requireFn)).rejects.toThrow("download failed");
});

it.each([false, true])("verifies startup after repair and never loops: failure=%s", async probeFailsAfterRepair => {
  const { probePdf2zh } = await import("../src/services/environment-check");
  const f = fixture("darwin", { probeFailsAfterRepair });
  const result = await probePdf2zh(f.exe, f.requireFn, 15_000, { autoRepair: true });
  expect(result.ok).toBe(!probeFailsAfterRepair);
  expect(result.detail).toContain(probeFailsAfterRepair ? "仍无法启动" : "已自动修复");
  expect(f.calls).toHaveLength(1);
});
