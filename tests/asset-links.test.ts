import { KernelClient } from "../src/core/kernel";
import { assetLinkTarget, safeAssetUrl } from "../src/core/normalize";

/** 捕获上传时真正提交给内核的文件名（FormData 的 file[]）。 */
function uploadedName(filename: string): Promise<string> {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const file = (init!.body as FormData).get("file[]") as File;
    return new Response(JSON.stringify({ code: 0, data: { succMap: { [file.name]: `assets/${file.name}` } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return new KernelClient(undefined, fetchImpl).uploadAsset("/assets/", new Uint8Array([1, 2, 3]), filename, "application/pdf");
}

describe("asset filenames never break Markdown link targets", () => {
  it("removes spaces and parentheses before the file is written to disk", async () => {
    const address = await uploadedName("Paper (2020) supplementary notes.pdf");
    expect(address).toBe("assets/Paper_2020_supplementary_notes.pdf");
    // 链接目标与磁盘文件名必须一致，且不含裸空格或括号。
    expect(address).not.toMatch(/[\s()]/);
  });

  it("keeps CJK filenames intact", async () => {
    expect(await uploadedName("中文论文标题-2026.pdf")).toBe("assets/中文论文标题-2026.pdf");
  });
});

describe("legacy asset links", () => {
  it("escapes only the characters that would truncate a link target", () => {
    expect(assetLinkTarget("assets/Paper (2020).pdf")).toBe("assets/Paper%20(2020).pdf");
    expect(assetLinkTarget("assets/旧文件 名.pdf")).toBe("assets/旧文件%20名.pdf");
    expect(assetLinkTarget("assets/plain.pdf")).toBe("assets/plain.pdf");
    expect(assetLinkTarget("../conf/conf.json")).toBeUndefined();
    // 新上传路径本就不含问题字符，转义后保持不变。
    expect(assetLinkTarget(safeAssetUrl("assets/Paper_2020_.pdf"))).toBe("assets/Paper_2020_.pdf");
  });
});
