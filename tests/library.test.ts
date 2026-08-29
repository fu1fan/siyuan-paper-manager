import { metadataFieldValue } from "../src/services/library-service";
import { paper } from "./fixtures";

describe("library database projection", () => {
  it("projects canonical fields into SiYuan AV values", () => {
    const value = metadataFieldValue("authors", paper());
    expect(value.text?.content).toBe("张, 三");
    expect(metadataFieldValue("tags", paper()).mSelect?.map((item) => item.content)).toEqual(["测试", "paper"]);
    expect(metadataFieldValue("url", paper({ canonical: { ...paper().canonical, url: "https://example.com" } })).url?.content)
      .toBe("https://example.com");
  });
});
