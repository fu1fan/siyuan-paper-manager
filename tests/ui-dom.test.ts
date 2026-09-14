import { creatorLines, dialogFooter, escapeHtml, parseCreatorLines } from "../src/ui/dom";

describe("escapeHtml", () => {
  it("escapes every character that could break out of markup or an attribute", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`))
      .toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("renders nullish values as empty text instead of \"null\"", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(0)).toBe("0");
  });
});

describe("creator line round-trip", () => {
  it("formats one creator per line and parses it back unchanged", () => {
    const creators = [{ family: "张", given: "三" }, { family: "Smith", given: "John A." }];
    expect(creatorLines(creators)).toBe("张, 三\nSmith, John A.");
    expect(parseCreatorLines(creatorLines(creators))).toEqual([
      { family: "张", given: "三", creatorType: "author" },
      { family: "Smith", given: "John A.", creatorType: "author" },
    ]);
  });

  it("treats a comma-free name as a surname so single-token Chinese names survive", () => {
    expect(parseCreatorLines("欧阳明")).toEqual([{ family: "欧阳明", given: "", creatorType: "author" }]);
  });

  it("keeps commas inside the given name and drops blank lines", () => {
    expect(parseCreatorLines("Doe, John, Jr.\n\n  Smith ,  Jane  \n")).toEqual([
      { family: "Doe", given: "John, Jr.", creatorType: "author" },
      { family: "Smith", given: "Jane", creatorType: "author" },
    ]);
  });

  it("omits an empty given name when formatting", () => {
    expect(creatorLines([{ family: "张", given: "" }])).toBe("张");
  });
});

describe("dialog footer", () => {
  it("emits the shared wrapper with an optional attribute on the actions container", () => {
    expect(dialogFooter()).toBe('<div class="paper-manager-dialog-footer"><div class="paper-manager-actions"></div></div>');
    expect(dialogFooter("data-actions")).toBe('<div class="paper-manager-dialog-footer"><div class="paper-manager-actions" data-actions></div></div>');
  });
});
