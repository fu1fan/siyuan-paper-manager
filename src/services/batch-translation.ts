import { translationSource } from "./attachments";
import type { LibraryPaperRecord } from "./library-service";
import { errorMessage } from "../core/errors";

export function translationBlockReason(record: LibraryPaperRecord): string | undefined {
  if (record.loadError) return record.loadError;
  if (record.paper.translation.mono || record.paper.translation.dual) return "已有译文";
  try { translationSource(record.paper); }
  catch (error) { return errorMessage(error); }
  return undefined;
}

export function matchesTranslationPaper(record: LibraryPaperRecord, query: string, project: string): boolean {
  if (project === "unassigned" && record.projectNames.length) return false;
  if (project.startsWith("project:") && !record.projectNames.includes(project.slice(8))) return false;
  const c = record.paper.canonical;
  const text = [c.title, c.abstract, c.date, c.journal, c.doi, record.paper.citekey, record.notes,
    ...record.projectNames, ...c.tags, ...c.creators.map(author => `${author.family} ${author.given}`),
  ].join(" ").toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}
