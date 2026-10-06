import { createRequire } from "node:module";
import { inspectUvToolPdf2zh } from "../src/services/pdf2zh-deployment";
it.skipIf(!process.env.PDF2ZH_INSPECT_EXECUTABLE)("recognizes the real installed uv tool without changing it", async () => {
  const result = await inspectUvToolPdf2zh(process.env.PDF2ZH_INSPECT_EXECUTABLE!, createRequire(import.meta.url));
  expect(result).not.toBeNull();
  expect(result!.version).toBeTruthy();
  console.log({ executable: result!.executable, version: result!.version, toolDir: result!.toolDir });
});
