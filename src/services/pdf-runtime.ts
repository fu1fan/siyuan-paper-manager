import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PLUGIN_NAME } from "../constants";

/** Use the same installed PDF.js version for API, worker, and CJK character maps. */
export function pdfDocumentOptions(): Partial<DocumentInitParameters> {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return {};
  const base = new URL(`/plugins/${PLUGIN_NAME}/pdfjs/`, location.href).href;
  pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  return {
    cMapUrl: `${base}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`,
  };
}
