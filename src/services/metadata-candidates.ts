import type { MetadataCandidate } from "../types/import";

function stable(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC").trim();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== "")
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Keep the recommended/newest candidate first; compare metadata, not object identity or title alone. */
export function uniqueMetadataCandidates(candidates: MetadataCandidate[]): MetadataCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = JSON.stringify(stable(candidate.canonical));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
