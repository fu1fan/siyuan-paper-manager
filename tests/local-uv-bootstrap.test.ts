import { vi } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DOWNLOAD_PRESETS } from "../src/services/download-presets";
import { installUv, deploymentPaths } from "../src/services/pdf2zh-deployment";

it.skipIf(process.env.PAPER_MANAGER_LIVE_UV !== "1")("downloads and starts standalone uv in a temporary managed directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paper-manager-live-"));
  vi.stubEnv("LOCALAPPDATA", path.join(root, "Local"));
  vi.stubEnv("XDG_DATA_HOME", path.join(root, "share"));
  const realRequire = createRequire(import.meta.url);
  const requireFn = (id: string) => id === "os" ? { ...os, homedir: () => root } : realRequire(id);
  try {
    const options = process.env.PAPER_MANAGER_LIVE_UV_MIRROR === "ustc" ? DOWNLOAD_PRESETS.find(preset => preset.id === "ustc")!.values : {};
    const result = await installUv(options, requireFn, line => console.log(line));
    expect(result.code, result.stderr).toBe(0);
    const uv = deploymentPaths(requireFn).uv;
    expect(execFileSync(uv, ["--version"], { encoding: "utf8" })).toMatch(/^uv /);
    expect(fs.existsSync(path.join(root, ".zshrc"))).toBe(false);
  } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
