import { DOWNLOAD_PRESETS, USTC_UV_RELEASE, uvInstallerScriptUrl } from "../src/services/download-presets";
import { downloadEnvironment, validateDownloadSources } from "../src/services/pdf2zh-deployment";
import { normalizeSettings } from "../src/types/settings";
import { createRequire } from "node:module";

it("maps the USTC installer names separately from the official installer directory", () => {
  expect(uvInstallerScriptUrl(USTC_UV_RELEASE + "/", false)).toBe(`${USTC_UV_RELEASE}/uv-installer.sh`);
  expect(uvInstallerScriptUrl(USTC_UV_RELEASE, true)).toBe(`${USTC_UV_RELEASE}/uv-installer.ps1`);
  expect(uvInstallerScriptUrl("https://example.com/scripts", true)).toBe("https://example.com/scripts/install.ps1");
});

it("keeps package-only presets scoped and round-trips the full USTC preset", () => {
  for (const preset of DOWNLOAD_PRESETS) validateDownloadSources(preset.values);
  expect(Object.keys(DOWNLOAD_PRESETS[0].values)).toEqual(["pdf2zhIndexUrl"]);
  expect(Object.keys(DOWNLOAD_PRESETS[1].values)).toEqual(["pdf2zhIndexUrl"]);
  const preset = DOWNLOAD_PRESETS.find(item => item.id === "ustc")!;
  expect(normalizeSettings(preset.values)).toMatchObject(preset.values);
});

it("uses a direct release URL ahead of the generic GitHub mirror", async () => {
  const env = await downloadEnvironment({pdf2zhUvDownloadUrl: USTC_UV_RELEASE, pdf2zhUvGithubUrl: "https://example.com/github"}, createRequire(import.meta.url));
  expect(env.UV_DOWNLOAD_URL).toBe(USTC_UV_RELEASE);
  expect(env.UV_INSTALLER_GITHUB_BASE_URL).toBe("https://example.com/github");
});
