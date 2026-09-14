/** Normalize an unknown thrown value into text for logging and user-facing messages. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
