import { renderTemplateText } from "../src/core/template-engine";
import { KernelClient } from "../src/core/kernel";
import { TemplateService } from "../src/core/templates";
import { paper } from "./fixtures";

describe("fallback template engine", () => {
  it("renders fields, conditions, ranges, and super-block markers", () => {
    const template = `{{{row\n{{if .title}}# {{.title}}{{else}}none{{end}}\n{{range .items}}- {{.name}}{{end}}\n}}}`;
    expect(renderTemplateText(template, { title: "标题", items: [{ name: "A" }, { name: "B" }] }))
      .toContain("# 标题\n- A- B");
  });

  it("supports current scalar values", () => {
    expect(renderTemplateText("{{range .tags}}[{{.}}]{{end}}", { tags: ["a", "b"] })).toBe("[a][b]");
  });

  it("reports malformed templates", () => {
    expect(() => renderTemplateText("{{if .x}}missing", { x: true })).toThrow(/缺少/);
  });
});

describe("template capability mode", () => {
  it("preserves the browser receiver when KernelClient calls fetch", async () => {
    const receiverFetch = function(this: unknown): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("template body", { status: 200 }));
    } as typeof fetch;
    const kernel = new KernelClient(undefined, receiverFetch);

    await expect(kernel.readPluginFile("/data/plugins/test/template.md"))
      .resolves.toBe("template body");
  });

  it("adopts unmarked SiYuan 3.8 super blocks as meta and note containers", async () => {
    const attrs = new Map<string, Record<string, string>>();
    const post = vi.fn(async (endpoint: string, payload: Record<string, unknown>) => {
      if (endpoint === "/api/query/sql") {
        const stmt = String(payload.stmt);
        if (stmt.includes("FROM blocks WHERE")) return [{ id: "meta-old" }, { id: "note-old" }];
        return [];
      }
      if (endpoint === "/api/attr/setBlockAttrs") {
        attrs.set(String(payload.id), payload.attrs as Record<string, string>);
        return null;
      }
      if (endpoint === "/api/attr/getBlockAttrs") return attrs.get(String(payload.id)) ?? {};
      throw new Error(endpoint);
    });
    const service = new TemplateService(new KernelClient(post as any));

    await expect(service.ensureSections("doc", paper())).resolves.toEqual({
      meta: "meta-old",
      note: "note-old",
    });
    expect(attrs.get("meta-old")?.["custom-section"]).toBe("meta");
    expect(attrs.get("note-old")?.["custom-section"]).toBe("note");
  });

  it("uses the packaged renderer without calling the restricted native template API", async () => {
    const modes: string[] = [];
    const post = vi.fn(async (endpoint: string) => { throw new Error(endpoint); });
    const service = new TemplateService(new KernelClient(post as any), {
      loadTemplate: async () => "{{{row\n# {{.title}}\n}}}\n{: custom-section=\"meta\"}",
      onModeChange: (mode) => modes.push(mode),
    });
    const first = await service.renderBuiltin("paper-meta", paper());
    const second = await service.renderBuiltin("paper-meta", paper());
    expect(service.getMode()).toBe("builtin");
    expect(first).toContain("# 示例论文 Example Paper");
    expect(second).toBe(first);
    expect(modes).toEqual(["builtin"]);
    expect(post).not.toHaveBeenCalled();
  });
});
