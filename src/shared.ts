export const MAX_JOURNAL_SIZE = 8 << 20;

export function formatErrorWithStack(error: unknown): string {
  if (error instanceof Error) {
    return error.toString() + (error.stack ? "\n" + error.stack : "");
  }
  return String(error);
}
