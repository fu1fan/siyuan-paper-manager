import { vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const realRequire = createRequire(import.meta.url);
let temp: string;
beforeEach(() => { vi.resetModules(); temp = fs.mkdtempSync(path.join(os.tmpdir(), "uv-tool-management-")); });
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function fixture(freeze = "pdf2zh==1.9.11\ndependency==1.2.3\n", freezeCode = 0) {
  const tools = path.join(temp, "tools"), bin = path.join(temp, "bin");
  const tool = path.join(tools, "pdf2zh");
  const win = process.platform === "win32";
  const name = win ? "pdf2zh.exe" : "pdf2zh";
  const internal = path.join(tool, win ? "Scripts" : "bin", name);
  const executable = path.join(bin, name);
  fs.mkdirSync(path.dirname(internal), { recursive: true }); fs.mkdirSync(bin);
  fs.writeFileSync(internal, "pdf2zh launcher");
  if (win) fs.copyFileSync(internal, executable); else fs.symlinkSync(internal, executable);
  fs.writeFileSync(path.join(tool, "uv-receipt.toml"), "[tool]\n");
  fs.writeFileSync(path.join(tool, "pyvenv.cfg"), "home = python\n");
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; requirements?: string }> = [];
  const requireFn = (id: string): unknown => id !== "child_process" ? realRequire(id) : {
    execFile: (_file: string, args: string[], opts: {env: NodeJS.ProcessEnv}, cb: (error: null, stdout: string, stderr: string) => void) => {
      const external = opts.env?.UV_TOOL_DIR === tools || !opts.env?.UV_TOOL_DIR;
      const out = args.includes("-ilc") ? `UV_TOOL_DIR=${tools}\0UV_TOOL_BIN_DIR=${bin}\0`
        : args[0] === "--version" ? "uv 0.12.23"
        : args[1] === "list" ? external ? "pdf2zh v1.9.11\n- pdf2zh\nother-tool v1.0" : ""
        : args[1] === "dir" ? args.includes("--bin") ? bin : tools : "";
      cb(null, out, "");
    },
    spawn: (_file: string, args: string[], opts: {env: NodeJS.ProcessEnv}) => {
      calls.push({args, env: opts.env, requirements: args.includes("-r") ? fs.readFileSync(args[args.indexOf("-r") + 1]!, "utf8") : undefined});
      const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true});
      queueMicrotask(() => {
        if (args.includes("freeze")) { child.stderr.write("Using Python at selected tool\n"); child.stdout.write(freeze); }
        child.emit("close", args.includes("freeze") ? freezeCode : 0);
      }); return child;
    },
  };
  return {tools, bin, executable, internal, tool, calls, requireFn};
}

it.each(["upgrade", "repair", "uninstall"] as const)("%s targets only the selected registered tool in its original directories", async action => {
  const f = fixture();
  const { manageUvToolPdf2zh, inspectUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  expect(await inspectUvToolPdf2zh(f.executable, f.requireFn)).toMatchObject({toolDir: f.tools, binDir: f.bin, version: "1.9.11"});
  await manageUvToolPdf2zh(f.executable, action, {}, f.requireFn);
  expect(f.calls).toHaveLength(action === "repair" ? 2 : 1);
  for (const call of f.calls) {
    expect(call.env.UV_TOOL_DIR).toBe(f.tools);
    expect(call.env.UV_TOOL_BIN_DIR).toBe(f.bin);
  }
  if (action === "repair") {
    expect(f.calls[1]!.args).toContain("--no-deps");
    expect(f.calls[1]!.requirements).toBe("pdf2zh==1.9.11\ndependency==1.2.3\n");
    expect(f.calls[1]!.args).not.toContain("upgrade");
    expect(fs.existsSync(f.calls[1]!.args[f.calls[1]!.args.indexOf("-r") + 1]!)).toBe(false);
  } else expect(f.calls[0]!.args).toEqual(action === "uninstall" ? ["tool", "uninstall", "pdf2zh"] : ["tool", "upgrade", "pdf2zh"]);
});

it("rejects an unrelated same-name pip launcher and a replaced registered launcher", async () => {
  const f = fixture();
  const { manageUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  const other = path.join(temp, path.basename(f.executable)); fs.writeFileSync(other, "pip launcher");
  await expect(manageUvToolPdf2zh(other, "uninstall", {}, f.requireFn)).rejects.toThrow("无法确认");
  fs.unlinkSync(f.executable); fs.writeFileSync(f.executable, "different launcher");
  await expect(manageUvToolPdf2zh(f.executable, "upgrade", {}, f.requireFn)).rejects.toThrow("无法确认");
  expect(f.calls).toHaveLength(0);
});

it("rechecks uv registration before a destructive operation", async () => {
  const f = fixture();
  const { inspectUvToolPdf2zh, manageUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  expect(await inspectUvToolPdf2zh(f.executable, f.requireFn)).not.toBeNull();
  fs.unlinkSync(path.join(f.tool, "uv-receipt.toml"));
  await expect(manageUvToolPdf2zh(f.executable, "uninstall", {}, f.requireFn)).rejects.toThrow("无法确认");
  expect(f.calls).toHaveLength(0);
});

it("uses the selected mirror and honours cancellation without spawning", async () => {
  const f = fixture();
  const { manageUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  const controller = new AbortController(); controller.abort();
  expect((await manageUvToolPdf2zh(f.executable, "upgrade", {signal: controller.signal}, f.requireFn)).code).not.toBe(0);
  expect(f.calls).toHaveLength(0);
  await manageUvToolPdf2zh(f.executable, "upgrade", {pdf2zhIndexUrl: "https://mirror.test/simple"}, f.requireFn);
  expect(f.calls[0]!.args).toContain("https://mirror.test/simple");
  expect(f.calls[0]!.env.UV_TOOL_DIR).toBe(f.tools);
});

it.each(["-e ./source\n", "pdf2zh @ https://example.test/source\n", "other==1.0\n"])("refuses unsafe or incomplete repair snapshots: %s", async freeze => {
  const f = fixture(freeze);
  const { manageUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  await expect(manageUvToolPdf2zh(f.executable, "repair", {}, f.requireFn)).rejects.toThrow("未执行重装");
  expect(f.calls).toHaveLength(1);
});
it("changes only the diagnosed SDK pin during explicit repair and forwards mirrors", async () => {
  const f = fixture("pdf2zh==1.9.11\ntencentcloud-sdk-python-tmt==3.9.9\nother==1.2.3\n");
  const { manageUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  await manageUvToolPdf2zh(f.executable, "repair", {repairDependency:true, pdf2zhIndexUrl:"https://mirror.test/simple"}, f.requireFn);
  expect(f.calls[1]!.requirements).toBe("pdf2zh==1.9.11\ntencentcloud-sdk-python-tmt==3.1.70\nother==1.2.3\n");
  expect(f.calls[1]!.args).toContain("https://mirror.test/simple");
});
it("does not reinstall if reading installed versions fails", async () => {
  const f = fixture("", 1);
  const { manageUvToolPdf2zh } = await import("../src/services/pdf2zh-deployment");
  await expect(manageUvToolPdf2zh(f.executable, "repair", {}, f.requireFn)).rejects.toThrow("无法读取");
  expect(f.calls).toHaveLength(1);
});
