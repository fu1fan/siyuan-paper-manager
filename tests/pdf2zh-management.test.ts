import path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

function fakeRequire(results: Record<string, string>, files: string[], windows = false) {
  return (id: string): unknown => ({
    path: windows ? path.win32 : path,
    os: { homedir: () => windows ? "C:\\Users\\alice" : "/home/alice", platform: () => windows ? "win32" : process.platform },
    fs: { existsSync: (p: string) => files.includes(p) || files.some(file => file.startsWith(p + (windows ? "\\" : path.sep))), statSync: (p: string) => ({ isFile: () => files.includes(p) }), realpathSync: { native: (p: string) => p }, readdirSync: () => [] },
    child_process: { execFile: (file: string, args: string[], _opts: unknown, cb: (err: unknown, out: string, errout: string) => void) => {
      const key = [file, ...args].join(" ");
      cb(key in results ? null : { code: 1 }, results[key] ?? "", "");
    } },
  })[id];
}

beforeEach(() => vi.resetModules());

it.each([["3.10.9", "supported"], ["3.12.8", "supported"], ["3.13.2", "unsupported"], ["3.14.0", "unsupported"]])("checks published Python range: %s", async (version, support) => {
  const { scanPython, PYTHON_PROBE } = await import("../src/services/pdf2zh-deployment");
  const windows = process.platform === "win32";
  const python = windows ? "C:\\Python312\\python.exe" : "/home/alice/python3";
  const prefix = windows ? "C:\\Python312" : "/home/alice/python";
  const list = await scanPython(fakeRequire({
    [windows ? "where python" : "which -a python3"]: python,
    [`${python} -c ${PYTHON_PROBE}`]: `${version}\tarm64\t${prefix}`,
  }, [python], windows));
  expect(list[0]?.support).toBe(support);
});

it("discovers Windows conda Python at the environment root", async () => {
  const { scanPython, PYTHON_PROBE } = await import("../src/services/pdf2zh-deployment");
  const prefix = "C:\\Miniconda3\\envs\\pdf";
  const python = path.win32.join(prefix, "python.exe");
  const list = await scanPython(fakeRequire({
    "conda env list --json": JSON.stringify({ envs: [prefix] }),
    [`${python} -c ${PYTHON_PROBE}`]: `3.12.8\tAMD64\t${prefix}`,
  }, [python], true));
  expect(list.map(item => item.path)).toContain(python);
});

it("reads the upstream home .config path on Windows", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { systemConfigPath } = await import("../src/services/pdf2zh-deployment");
    expect(systemConfigPath(fakeRequire({}, [], true))).toBe("C:\\Users\\alice\\.config\\PDFMathTranslate\\config.json");
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

function deploymentStub(version = "3.12.8", platform = process.platform) {
  const spawns: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const base = fakeRequire({}, []);
  const requireFn = (id: string): unknown => id === "fs" ? fs : id === "os" ? { ...os, platform: () => platform } : id !== "child_process" ? base(id) : {
    execFile: (_file: string, args: string[], _opts: unknown, cb: (error: unknown, stdout: string, stderr: string) => void) => {
      cb(null, args[0] === "-c" ? `${version}\tx86_64\t/test/python` : "", "");
    },
    spawn: (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawns.push({ file, args, env: options.env });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      setImmediate(() => child.emit("close", 0));
      return child;
    },
  };
  return { requireFn, spawns };
}

it.each(["darwin", "linux", "win32"] as const)("bootstraps native uv on %s without Python and keeps shell profiles unchanged", async platform => {
  const { installUv, deploymentPaths } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub("3.12.8", platform);
  const paths = deploymentPaths(requireFn);
  expect((await installUv({ pdf2zhUvInstallerUrl: "https://mirror.test/uv", pdf2zhUvGithubUrl: "https://mirror.test/github" }, requireFn)).code).toBe(0);
  expect(spawns).toHaveLength(2);
  expect(spawns[0]!.env.PAPER_MANAGER_UV_URL).toBe(`https://mirror.test/uv/install.${platform === "win32" ? "ps1" : "sh"}`);
  expect(spawns[1]!.env.UV_UNMANAGED_INSTALL).toBe(paths.uvBin);
  expect(spawns[1]!.env.UV_NO_MODIFY_PATH).toBe("1");
  expect(spawns[1]!.env.UV_INSTALLER_GITHUB_BASE_URL).toBe("https://mirror.test/github");
  expect(fs.existsSync(spawns[1]!.env.PAPER_MANAGER_UV_SCRIPT!)).toBe(false);
  expect(spawns.some(call => call.args.includes("pip") || call.args.includes("venv"))).toBe(false);
});

it("isolates both install and uninstall from the user's uv tool directories", async () => {
  const { installPdf2zh, uninstallPdf2zh, deploymentPaths } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub();
  const paths = deploymentPaths(requireFn);
  await installPdf2zh("/selected/python", { file: "uv", argsPrefix: [], display: "uv" }, requireFn);
  await uninstallPdf2zh(requireFn);
  expect(spawns.map(({ args }) => args)).toEqual([
    ["tool", "install", "--python", "/selected/python", "--with", "tencentcloud-sdk-python-tmt==3.1.70", "pdf2zh"],
    ["tool", "uninstall", "pdf2zh"],
  ]);
  for (const { env } of spawns) {
    expect(env.UV_TOOL_DIR).toBe(paths.tools);
    expect(env.UV_TOOL_BIN_DIR).toBe(paths.bin);
  }
});

it("rejects unsupported manually entered Python before spawning an install", async () => {
  const { installPdf2zh } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub("3.13.1");
  await expect(installPdf2zh("/selected/python", { file: "uv", argsPrefix: [], display: "uv" }, requireFn)).rejects.toThrow("3.10–3.12");
  expect(spawns).toHaveLength(0);
});

it("uses the upstream .config path even when XDG_CONFIG_HOME is customized", async () => {
  vi.stubEnv("XDG_CONFIG_HOME", "/custom/config");
  try {
    const { systemConfigPath } = await import("../src/services/pdf2zh-deployment");
    expect(systemConfigPath(fakeRequire({}, []))).toBe(path.join("/home/alice", ".config", "PDFMathTranslate", "config.json"));
  } finally { vi.unstubAllEnvs(); }
});

 it("automatically selects Python and applies custom sources to upgrades", async () => {
  const { installPdf2zh } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub("3.14.0");
  await installPdf2zh("", { file: "uv", argsPrefix: [], display: "uv" }, requireFn, undefined, {
    upgrade: true, pdf2zhIndexUrl: "https://packages.test/simple", pdf2zhPythonMirror: "https://python.test/releases/",
  });
  expect(spawns[0]!.args).toEqual(["tool", "install", "--upgrade", "--python", "3.12", "--with", "tencentcloud-sdk-python-tmt==3.1.70", "pdf2zh", "--no-config"]);
  expect(spawns[0]!.env.UV_DEFAULT_INDEX).toBe("https://packages.test/simple");
  expect(spawns[0]!.env.UV_PYTHON_INSTALL_MIRROR).toBe("https://python.test/releases");
 });

 it.each(["file:///tmp/index", "https://user:secret@example.com", "bad", "https://example.com/?token=secret"])("rejects invalid source %s before launching installers", async url => {
   const { installUv } = await import("../src/services/pdf2zh-deployment");
   const { requireFn, spawns } = deploymentStub();
   await expect(installUv({ pdf2zhIndexUrl: url }, requireFn)).rejects.toThrow("HTTP(S)");
   expect(spawns).toHaveLength(0);
 });
