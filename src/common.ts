export interface Logger {
  error: (message: string) => void;
}

export type MessageHandler<T> = (message: T) => Promise<void>;
