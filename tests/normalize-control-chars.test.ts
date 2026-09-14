import { cleanCanonical } from "../src/core/normalize";
import { paper } from "./fixtures";

const base = paper().canonical;

/** C0 控制字符（除 \t\n\r 外）必须整体剥掉，不能只处理首尾两个端点。 */
it("strips the whole C0 control-character range from metadata text", () => {
  const control = String.fromCharCode(1, 2, 7, 8, 11, 14, 31, 127);
  const cleaned = cleanCanonical({ ...base, title: `A${control}B`, creators: [{ family: `X${control}Y`, given: "", creatorType: "author" }] });
  expect(cleaned.title).toBe("AB");
  expect(cleaned.creators[0]!.family).toBe("XY");
  for (const char of cleaned.title + cleaned.creators[0]!.family) {
    const code = char.charCodeAt(0);
    expect(code < 0x20 || code === 0x7f).toBe(false);
  }
});

it("keeps tab, newline and carriage return in multi-line values", () => {
  const cleaned = cleanCanonical({ ...base, abstract: "line1\nline2\ttabbed" });
  expect(cleaned.abstract).toBe("line1\nline2\ttabbed");
});
