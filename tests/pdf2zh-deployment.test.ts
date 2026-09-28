import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { NodeRequire } from "../src/core/env";
import { configPath, detectPdf2zh, findUv, inspectPdf2zh, PYTHON_PROBE, resolvePdf2zh, scanPython, spawnLogged, systemConfigPath } from "../src/services/pdf2zh-deployment";

/**
 * These helpers branch on the real platform and only accept Windows
 * executables as `.exe`, so expectations must be derived the same way.
 * `findUv` falls back from `uv.exe` to `uv`, so stubbing `uv` works on both.
 */
const WINDOWS = process.platform === "win32";
const PATH_LOOKUP = WINDOWS ? "where" : "which";
const PDF2ZH_BIN = WINDOWS ? "pdf2zh.exe" : "pdf2zh";

/** Builds a NodeRequire stand-in from a table of `execFile` results keyed by "cmd arg1 arg2". */
function requireWith(
  execResults: Record<string, { stdout: string; code?: number }>,
  files: string[] = [],
  options: { platform?: string; fileContents?: Record<string, string> } = {},
) {
  const calls: string[] = [];
  const lookup = (file: string, args: string[], _options: unknown, done: (error: unknown, stdout: string, stderr: string) => void) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    const result = execResults[key];
    if (!result) { done({ code: 1 }, "", ""); return; }
    done(result.code ? { code: result.code } : null, result.stdout, "");
  };
  const requireFn: NodeRequire = (id) => ({
    path: options.platform === "win32" ? path.win32 : path,
    os: { homedir: () => "/home/alice", platform: () => options.platform ?? process.platform },
    fs: {
      existsSync: (name: string) => files.includes(name),
      statSync: (name: string) => ({ isFile: () => files.includes(name) }),
      realpathSync: { native: (name: string) => name },
      readFileSync: (name: string) => options.fileContents?.[name] ?? "",
      readdirSync: () => [],
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
    expect(await resolvePdf2zh({ file: "uv", argsPrefix: [], display: "uv" }, requireFn)).toBeNull();
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

describe("locating uv after a user-site install", () => {
  const python = path.normalize("/home/alice/.pyenv/versions/3.12.4/bin/python");
  const scriptsDir = "/home/alice/.local/bin";
  const sysconfigProbe = `${python} -c import sysconfig,sys; print(sysconfig.get_path('scripts', 'nt_user' if sys.platform == 'win32' else 'posix_user'))`;

  it("finds uv in the interpreter's user scripts directory when PATH lacks it", async () => {
    const uvBin = path.join(scriptsDir, WINDOWS ? "uv.exe" : "uv");
    const { requireFn } = requireWith({ [sysconfigProbe]: { stdout: `${scriptsDir}\n` } }, [uvBin]);
    const uv = await findUv(requireFn, python);
    expect(uv).toMatchObject({ file: uvBin, argsPrefix: [] });
  });

  it("falls back to python -m uv when no executable is on disk", async () => {
    const { requireFn } = requireWith({
      [sysconfigProbe]: { stdout: `${scriptsDir}\n` },
      [`${python} -m uv --version`]: { stdout: "uv 0.5.0\n" },
    });
    const uv = await findUv(requireFn, python);
    expect(uv).toMatchObject({ file: python, argsPrefix: ["-m", "uv"] });
  });

  it("returns null when neither PATH nor the interpreter can provide uv", async () => {
    const { requireFn } = requireWith({ [sysconfigProbe]: { stdout: `${scriptsDir}\n` } });
    expect(await findUv(requireFn, python)).toBeNull();
  });
});

describe("scanning Python interpreters", () => {
  // Windows 上 python.exe 与 python3.exe 是独立文件（不是符号链接），
  // 只能靠探测返回的 sys.prefix 识别为同一安装。
  const pythonExe = path.normalize("C:\\Python312\\python.exe");
  const python3Exe = path.normalize("C:\\Python312\\python3.exe");
  const probe = (exe: string) => `${exe} -c ${PYTHON_PROBE}`;
  // 发现渠道：`python -c "import sys; print(sys.executable)"` 自报路径。
  const discovery = (entries: Record<string, string>) => Object.fromEntries(
    Object.entries(entries).map(([name, exe]) => [`${name} -c import sys; print(sys.executable)`, { stdout: `${exe}\n` }]),
  );

  it("merges python.exe and python3.exe that report the same sys.prefix", async () => {
    const { requireFn } = requireWith({
      ...discovery({ python: pythonExe, python3: python3Exe }),
      [probe(pythonExe)]: { stdout: "3.12.4\tAMD64\tC:\\Python312\n" },
      [probe(python3Exe)]: { stdout: "3.12.4\tAMD64\tC:\\Python312\n" },
    }, [pythonExe, python3Exe], { platform: "win32" });
    const progress: Array<[number, number]> = [];
    const list = await scanPython(requireFn, (done, total) => progress.push([done, total]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: pythonExe, version: "3.12.4", support: "supported" });
    expect(list[0]!.aliases).toEqual(["python.exe", "python3.exe"]);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it("marks versions above the verified range as unverified instead of disabling them", async () => {
    const { requireFn } = requireWith({
      ...discovery({ python: pythonExe }),
      [probe(pythonExe)]: { stdout: "3.14.0\tAMD64\tC:\\Python312\n" },
    }, [pythonExe], { platform: "win32" });
    const list = await scanPython(requireFn);
    expect(list[0]).toMatchObject({ version: "3.14.0", support: "unverified" });
  });

  it("keeps interpreters from different prefixes as separate candidates", async () => {
    const otherExe = path.normalize("C:\\Python311\\python.exe");
    const { requireFn } = requireWith({
      ...discovery({ python: pythonExe, python3: otherExe }),
      [probe(pythonExe)]: { stdout: "3.12.4\tAMD64\tC:\\Python312\n" },
      [probe(otherExe)]: { stdout: "3.11.9\tAMD64\tC:\\Python311\n" },
    }, [pythonExe, otherExe], { platform: "win32" });
    const list = await scanPython(requireFn);
    expect(list.map(item => item.version)).toEqual(["3.12.4", "3.11.9"]);
  });
});

describe("inspecting a uv-installed pdf2zh on any platform", () => {
  it("resolves the tool interpreter with the platform-correct executable name", async () => {
    const binDir = "/home/alice/.local/bin";
    const bin = path.join(binDir, PDF2ZH_BIN);
    const toolDir = "/home/alice/.local/share/uv/tools";
    const envCfg = path.join(toolDir, "pdf2zh", "pyvenv.cfg");
    const { requireFn } = requireWith({
      "uv --version": { stdout: "uv 0.5.0\n" },
      "uv tool list --show-paths --show-python": { stdout: "pdf2zh v1.9.6\n" },
      "uv tool dir --bin": { stdout: `${binDir}\n` },
      "uv tool dir": { stdout: `${toolDir}\n` },
    }, [bin, envCfg], { fileContents: { [envCfg]: "home = /home/alice/.pyenv/versions/3.12.4/bin\n" } });
    const installed = await inspectPdf2zh(requireFn);
    expect(installed?.pythonPath).toBe(path.join("/home/alice/.pyenv/versions/3.12.4/bin", WINDOWS ? "python.exe" : "python"));
  });
});

describe("spawnLogged", () => {
  function spawnStub(chunks: Uint8Array[], code = 0) {
    return {
      child_process: {
        execFile: (_file: string, _args: string[], _options: unknown, done: (error: unknown, stdout: string, stderr: string) => void) => done(new Error("no shell"), "", ""),
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => undefined });
          setImmediate(() => {
            for (const chunk of chunks) child.stderr.write(chunk);
            child.stderr.end();
            child.emit("close", code, null);
          });
          return child;
        },
      },
    };
  }

  it("streams lines split on \\r and \\n and keeps multibyte characters split across chunks intact", async () => {
    const bytes = new TextEncoder().encode("第一行中文\r第二行 50%\n");
    // 「中」是 3 字节序列，从中间切开，模拟跨 chunk 的 UTF-8 字符。
    const cut = 10;
    const requireFn: NodeRequire = (id) => (spawnStub([bytes.slice(0, cut), bytes.slice(cut)]) as Record<string, unknown>)[id];
    const lines: string[] = [];
    const result = await spawnLogged("uv", ["tool", "install", "pdf2zh"], { requireFn, onLine: line => lines.push(line) });
    expect(result.code).toBe(0);
    expect(lines).toEqual(["第一行中文", "第二行 50%"]);
    expect(result.stdout).not.toContain("�");
  });

  it("returns the log tail as stderr for error messages", async () => {
    const requireFn: NodeRequire = (id) => (spawnStub([new TextEncoder().encode("boom: network unreachable\n")], 1) as Record<string, unknown>)[id];
    const result = await spawnLogged("uv", ["--version"], { requireFn });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("network unreachable");
  });
});
