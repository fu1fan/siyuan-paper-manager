import { renderTemplateText } from "../src/core/template-engine";
import { KernelClient } from "../src/core/kernel";
import { TemplateService } from "../src/core/templates";
import { paper } from "./fixtures";
import { readFileSync } from "node:fs";

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


it("preserves custom attributes when refreshing a metadata container", async () => {
  let attrs: Record<string, string> = { "custom-section": "meta", "custom-user-label": "keep", style: "color: red" };
  const expected = { ...attrs };
  const kernel = {
    getBlockKramdown: vi.fn(async () => ({ id: "meta", kramdown: "old content" })),
    getBlockAttrs: vi.fn(async () => ({ ...attrs })),
    updateBlock: vi.fn(async () => { attrs = {}; }),
    setBlockAttrs: vi.fn(async (_id: string, value: Record<string, string>) => { attrs = value; }),
  };
  const service = new TemplateService(kernel as unknown as KernelClient, {
    loadTemplate: async () => "{{{row\n# {{.title}}\n}}}",
  });
  await service.refreshMeta("doc", paper(), "meta");
  expect(attrs).toEqual(expected);
});

it("treats imported bibliographic Markdown and SiYuan markers as literal text", async () => {
  const service = new TemplateService(new KernelClient(), { loadTemplate: async () => "{{.title}}\n{{.abstract}}\n{{range .authors}}{{.display}}{{end}}\n{{range .tags}}{{.display}}{{end}}" });
  const data = paper();
  data.canonical.title = "![remote](https://example.org/pixel)\n# Heading";
  data.canonical.abstract = "Text\n\n    code\n- list\n}}}\n{: id=\"injected\"}\n<script>x</script>\n((20260101000000-abcdefg))";
  data.canonical.creators = [{ family: "[link](https://example.org)", given: "", creatorType: "author" }];
  data.canonical.tags = ["#tag#", "*bold*"];
  const output = await service.renderBuiltin("paper-meta", data);
  expect(output).toContain("\\!\\[remote\\]\\(https\\:\\/\\/example\\.org\\/pixel\\) \\# Heading");
  expect(output).toContain("Text\n\ncode\n\\- list\n\\}\\}\\}\n\\{\\: id\\=\\\"injected\\\"\\}");
  expect(output).toContain("\\<script\\>x\\<\\/script\\>");
  expect(output).toContain("\\#tag\\#\\*bold\\*");
  expect(output).not.toContain("\n# Heading");
  expect(output).not.toContain("\n    code");
});

it("keeps intentional DOI and source links valid without allowing destination breakout", async () => {
  const template = readFileSync(new URL("../templates/paper-meta.md", import.meta.url), "utf8");
  const service = new TemplateService(new KernelClient(), { loadTemplate: async () => template });
  const data = paper();
  data.canonical.doi = "10.1234/a(b)";
  data.canonical.url = "https://example.org/a(b)?x=1";
  const output = await service.renderBuiltin("paper-meta", data);
  expect(output).toContain("[10\\.1234\\/a\\(b\\)](https://doi.org/10.1234/a%28b%29)");
  expect(output).toContain("[访问网页](https://example.org/a%28b%29?x=1)");
});
