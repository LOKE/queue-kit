import { errorMessage, Logger, MessageHandler } from "./common";

interface RawMessage {
  MessageId?: string;
  Body?: string;
  ReceiptHandle?: string;
}

export interface SQS {
  changeMessageVisibility: (args: {
    ReceiptHandle: string;
    QueueUrl: string;
    VisibilityTimeout: number;
  }) => {
    promise: () => Promise<unknown>;
  };
  deleteMessage: (args: { ReceiptHandle: string; QueueUrl: string }) => {
    promise: () => Promise<unknown>;
  };
  receiveMessage: (args: {
    MaxNumberOfMessages: number;
    QueueUrl: string;
    WaitTimeSeconds: number;
  }) => { promise: () => Promise<{ Messages?: RawMessage[] }> };
  sendMessage: (args: { QueueUrl: string; MessageBody: string }) => {
    promise: () => Promise<unknown>;
  };
}

export type SQSData<T> = { id?: string; body: T };

type SQSMessage<T> = {
  ack(): Promise<void>;
  nack(): Promise<void>;
  data: SQSData<T>;
};

export class SQSHelper {
  private sqs: SQS;
  private logger: Logger;

  constructor(opts: { sqs: SQS; logger: Logger }) {
    this.sqs = opts.sqs;
    this.logger = opts.logger;
  }

  async handleQueue<T>(args: {
    queueUrl: string;
    maxConcurrent?: number;
    signal: AbortSignal;
    handler: MessageHandler<SQSData<T>>;
  }): Promise<void> {
    const inProgress = new Set();

    while (!args.signal.aborted) {
      const maxBatchSize = (args.maxConcurrent || 20) - inProgress.size;

      const messages = await this.receiveMessages<T>(
        args.queueUrl,
        maxBatchSize
      ).catch((err) => {
        this.logger.error(`Error getting messages: ${err.stack}`);
        return [];
      });

      if (!messages.length) continue;

      messages
        .map(async (m) => {
          try {
            await args.handler(m.data);
            await m.ack();
            // ackedCount.inc(labels);
          } catch (err: unknown) {
            this.logger.error(`Error handling message: ${errorMessage(err)}`);
            m.nack().catch((err) =>
              this.logger.error(
                `Error sending message nack: ${errorMessage(err)}`
              )
            );
            // nackedCount.inc(labels);
          } finally {
            // inFlightMessages.dec(labels);
          }
        })
        .forEach((p1) => {
          const p2 = p1.finally(() => inProgress.delete(p2));
          inProgress.add(p2);
        });

      await Promise.race(inProgress);
    }

    await Promise.all(inProgress);
  }

  async sendToQueue(queueUrl: string, payload: unknown): Promise<void> {
    await this.sqs
      .sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(payload),
      })
      .promise();
  }

  private async receiveMessages<T>(
    queueUrl: string,
    max: number
  ): Promise<SQSMessage<T>[]> {
    const rawSqsMessages = await this.sqs
      .receiveMessage({
        MaxNumberOfMessages: Math.min(10, max),
        QueueUrl: queueUrl,
        WaitTimeSeconds: 20,
      })
      .promise();

    if (!rawSqsMessages.Messages) {
      return [];
    }

    return rawSqsMessages.Messages.map((m) => {
      return {
        data: {
          id: m.MessageId,
          body: JSON.parse(m.Body || "null"),
        },
        ack: async () => {
          if (!m.ReceiptHandle) return;
          await this.sqs
            .deleteMessage({
              ReceiptHandle: m.ReceiptHandle,
              QueueUrl: queueUrl,
            })
            .promise();
        },
        nack: async () => {
          if (!m.ReceiptHandle) return;
          await this.sqs
            .changeMessageVisibility({
              ReceiptHandle: m.ReceiptHandle,
              QueueUrl: queueUrl,
              VisibilityTimeout: 0,
            })
            .promise();
        },
      };
    });
  }
}
