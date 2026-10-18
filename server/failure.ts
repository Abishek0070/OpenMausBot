export const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));
