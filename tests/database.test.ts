import { KernelClient } from "../src/core/kernel";
import { newNodeId } from "../src/core/node-id";

describe("attribute view kernel adapter", () => {
  it("generates unique valid SiYuan node ids in the same second", () => {
    const now = new Date("2026-08-29T08:00:00Z");
    const ids = Array.from({ length: 40 }, () => newNodeId(now));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{14}-[a-z0-9]{7}$/);
  });

  it("uses bound block sources and the rendered item id for cells", async () => {
    const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const kernel = new KernelClient(async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (endpoint === "/api/av/renderAttributeView") {
        return {
          id: "av", name: "库", viewID: "view", viewType: "table",
          view: { rows: [{ id: "item-row", cells: [{ value: { block: { id: "paper-doc" } } }] }] },
        } as never;
      }
      return null as never;
    });
    await kernel.addAttributeViewBlocks("av", "av-block", [{ id: "paper-doc", content: "论文" }]);
    const rendered = await kernel.renderAttributeView("av", "av-block");
    await kernel.setAttributeViewCell("av", "title-key", rendered.view.rows![0]!.id, { text: { content: "值" } });
    expect(calls[0]?.payload.srcs).toEqual([{ id: "paper-doc", content: "论文", isDetached: false }]);
    expect(calls[2]?.payload.itemID).toBe("item-row");
  });

  it("includes the numeric reqId required by SiYuan transactions", async () => {
    const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const kernel = new KernelClient(async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      return null as never;
    });

    await kernel.setAttributeViewName("av-id", "论文文献数据库");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.endpoint).toBe("/api/transactions");
    expect(calls[0]?.payload.reqId).toEqual(expect.any(Number));
    expect(calls[0]?.payload).toMatchObject({
      app: "siyuan",
      session: "paper-manager",
      transactions: [{
        doOperations: [{ action: "setAttrViewName", id: "av-id", data: "论文文献数据库" }],
        undoOperations: [],
      }],
    });
  });
});


describe("project select presets", () => {
  it("adds unused projects while preserving existing option colors and descriptions", async () => {
    const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const kernel = new KernelClient(async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (endpoint === "/api/av/getAttributeView") return { av: { keyValues: [{
        key: { id: "projects", options: [{ name: "已有项目", color: "8", desc: "保留" }] },
      }] } } as never;
      return null as never;
    });
    await kernel.setAttributeViewSelectOptions("av", "projects", ["已有项目", "新项目", "新项目"], true);
    expect(calls[1]?.payload.transactions).toEqual([{ doOperations: [{
      action: "updateAttrViewColOptions", id: "projects", avID: "av",
      data: [{ name: "已有项目", color: "8", desc: "保留" }, { name: "新项目", color: "2", desc: "" }],
    }], undoOperations: [] }]);
    calls.length = 0;
    await kernel.setAttributeViewSelectOptions("av", "projects", ["已有项目"], true);
    expect(calls.map((call) => call.endpoint)).toEqual(["/api/av/getAttributeView"]);
  });
});
