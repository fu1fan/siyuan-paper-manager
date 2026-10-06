/** URLs documented by each mirror operator; no third-party GitHub proxy. */
export const USTC_UV_RELEASE = "https://mirrors.ustc.edu.cn/github-release/astral-sh/uv/LatestRelease";
export const DOWNLOAD_PRESETS = [
  { id: "tuna", label: "清华 TUNA（仅 Python 包）", values: { pdf2zhIndexUrl: "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple" } },
  { id: "bfsu", label: "北京外国语大学（仅 Python 包）", values: { pdf2zhIndexUrl: "https://mirrors.bfsu.edu.cn/pypi/web/simple" } },
  { id: "ustc", label: "中国科学技术大学（包、Python、uv）", values: {
    pdf2zhIndexUrl: "https://mirrors.ustc.edu.cn/pypi/simple",
    pdf2zhPythonMirror: "https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone",
    pdf2zhUvInstallerUrl: USTC_UV_RELEASE,
    pdf2zhUvDownloadUrl: USTC_UV_RELEASE,
    pdf2zhUvGithubUrl: "",
  } },
  { id: "default", label: "恢复默认（清空全部自定义源）", values: {
    pdf2zhIndexUrl: "", pdf2zhPythonMirror: "", pdf2zhUvInstallerUrl: "", pdf2zhUvDownloadUrl: "", pdf2zhUvGithubUrl: "",
  } },
] as const;

export function uvInstallerScriptUrl(directory: string | undefined, windows: boolean): string {
  const base = (directory?.trim() || "https://astral.sh/uv").replace(/\/+$/, "");
  const name = base === USTC_UV_RELEASE ? "uv-installer" : "install";
  return `${base}/${name}.${windows ? "ps1" : "sh"}`;
}
