export interface Logger {
  error: (message: string) => void;
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
