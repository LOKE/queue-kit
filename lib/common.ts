export interface Logger {
  error: (message: string) => void;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || err.message;
  }
  return "Unknown error";
}

export type MessageHandler<T> = (message: T) => Promise<void>;

export interface AbortSignal {
  aborted: boolean;
  addEventListener: (
    event: "abort",
    handler: () => void,
    opts: { once: boolean }
  ) => void;
}
