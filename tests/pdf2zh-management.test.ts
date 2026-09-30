import path from "node:path";
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
  const python = "/home/alice/python3";
  const list = await scanPython(fakeRequire({
    "which -a python3": python,
    [`${python} -c ${PYTHON_PROBE}`]: `${version}\tarm64\t/home/alice/python`,
  }, [python]));
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

function deploymentStub(version = "3.12.8") {
  const spawns: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const base = fakeRequire({}, []);
  const requireFn = (id: string): unknown => id !== "child_process" ? base(id) : {
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

it("bootstraps uv in an isolated venv without installing into the selected Python", async () => {
  const { installUv, deploymentPaths } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub();
  const paths = deploymentPaths(requireFn);
  expect((await installUv("/selected/venv/bin/python", requireFn)).code).toBe(0);
  expect(spawns.map(({ file, args }) => ({ file, args }))).toEqual([
    { file: "/selected/venv/bin/python", args: ["-m", "venv", paths.bootstrap] },
    { file: paths.python, args: ["-m", "pip", "install", "uv"] },
  ]);
});

it("isolates both install and uninstall from the user's uv tool directories", async () => {
  const { installPdf2zh, uninstallPdf2zh, deploymentPaths } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub();
  const paths = deploymentPaths(requireFn);
  await installPdf2zh("/selected/python", { file: "uv", argsPrefix: [], display: "uv" }, requireFn);
  await uninstallPdf2zh(requireFn);
  expect(spawns.map(({ args }) => args)).toEqual([
    ["tool", "install", "--force", "--python", "/selected/python", "--with", "tencentcloud-sdk-python-tmt==3.1.70", "pdf2zh"],
    ["tool", "uninstall", "pdf2zh"],
  ]);
  for (const { env } of spawns) {
    expect(env.UV_TOOL_DIR).toBe(paths.tools);
    expect(env.UV_TOOL_BIN_DIR).toBe(paths.bin);
  }
});

it("rejects unsupported manually entered Python before spawning an install", async () => {
  const { installUv, installPdf2zh } = await import("../src/services/pdf2zh-deployment");
  const { requireFn, spawns } = deploymentStub("3.13.1");
  await expect(installUv("/selected/python", requireFn)).rejects.toThrow("3.10–3.12");
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
