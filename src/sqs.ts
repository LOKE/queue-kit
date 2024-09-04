import util from "util";
import { Logger, MessageHandler } from "./common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  messagesReceivedCounter,
  messagesFailedCounter,
  messagesQueuedCounter,
  messageHandlerDuration,
} from "./metrics";
export { registerMetrics } from "./metrics";

export type SQS = Pick<SQSClient, "send">;

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
          messagesReceivedCounter.inc({
            queue: args.queueUrl,
            provider: "sqs",
          });
          const end = messageHandlerDuration.startTimer({
            queue: args.queueUrl,
          });

          try {
            await args.handler(m.data);
            await m.ack();
            // ackedCount.inc(labels);
          } catch (err: unknown) {
            messagesFailedCounter.inc({
              queue: args.queueUrl,
              provider: "sqs",
            });
            this.logger.error(
              util.format(
                "Error handling message message_id=%j : %s",
                m.data.id,
                err
              )
            );

            m.nack().catch((err) =>
              this.logger.error(
                util.format("Error sending message nack: %s", err)
              )
            );
            // nackedCount.inc(labels);
          } finally {
            end();
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
    const message = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
    });
    await this.sqs.send(message);
    messagesQueuedCounter.inc({
      queue: queueUrl,
      provider: "sqs",
    });
  }

  private async receiveMessages<T>(
    queueUrl: string,
    max: number
  ): Promise<SQSMessage<T>[]> {
    const message = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(10, max),
      WaitTimeSeconds: 20,
    });

    const rawSqsMessages = await this.sqs.send(message);

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
          const message = new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: m.ReceiptHandle,
          });
          await this.sqs.send(message);
        },
        nack: async () => {
          if (!m.ReceiptHandle) return;
          const message = new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: m.ReceiptHandle,
            VisibilityTimeout: 0,
          });
          await this.sqs.send(message);
        },
      };
    });
  }
}
