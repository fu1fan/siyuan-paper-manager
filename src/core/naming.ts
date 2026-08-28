import type { PaperCanonical } from "../types/paper";

export function normalizeDoi(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[\s.,;:)\]}]+$/g, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/[\w.()/:;-]+$/i.test(normalized) ? normalized : undefined;
}

export function sanitizeDocumentName(value: string, maxLength = 120): string {
  const clean = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|#]/g, " ")
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (clean || "未命名文献").slice(0, maxLength);
}

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

export function generateCitekey(canonical: PaperCanonical): string {
  const creator = canonical.creators.find((item) => item.creatorType === "author") ?? canonical.creators[0];
  const family = transliterateKey(creator?.family || "anon") || "anon";
  const year = canonical.date?.match(/(?:19|20)\d{2}/)?.[0] ?? "nd";
  const titleToken = firstTitleToken(canonical.title);
  return `${family}${year}${titleToken}`.toLowerCase().slice(0, 64);
}

export function paperDocumentTitle(canonical: PaperCanonical, citekey: string): string {
  return sanitizeDocumentName(`${citekey} - ${canonical.title || "未命名文献"}`);
}

export function titleSimilarity(left: string, right: string): number {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  let common = 0;
  const remaining = new Map<string, number>();
  for (const gram of gramsB) remaining.set(gram, (remaining.get(gram) ?? 0) + 1);
  for (const gram of gramsA) {
    const count = remaining.get(gram) ?? 0;
    if (count > 0) {
      common += 1;
      remaining.set(gram, count - 1);
    }
  }
  return (2 * common) / (gramsA.length + gramsB.length);
}

function firstTitleToken(title: string): string {
  const normalized = title.normalize("NFKC").trim();
  const latin = normalized.match(/[\p{L}\p{N}]+/u)?.[0] ?? "paper";
  return transliterateKey(latin).slice(0, 16) || "paper";
}

function transliterateKey(value: string): string {
  return value.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(value: string): string[] {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}
