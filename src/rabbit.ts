import { Channel, Connection, Replies } from "amqplib";
import assert from "assert";
import util from "util";
import { ulid } from "ulid";

import { AbortSignal, Logger, MessageHandler } from "./common";
import {
  messagesReceivedCounter,
  messagesFailedCounter,
  messagesQueuedCounter,
  messageHandlerDuration,
} from "./metrics";
export { registerMetrics } from "./metrics";

const noop = () => undefined;

export interface RabbitData<T> {
  messageId: string;
  routingKey: string;
  timestamp: Date;
  body: T;
}

export class RabbitHelper {
  private amqpConn: Connection;
  private logger: Logger;
  private exchangeName: string;
  // Tested having a channel pool, made no difference to performance
  private useChan: Promise<Channel> | null = null;

  constructor(opts: {
    /** The amqplib connection */
    amqpConnection: Connection;
    /** The exchange name to publish to, defaults to "pubsub" */
    exchangeName?: string;
    /** Logger used for reporting errors */
    logger: Logger;
  }) {
    const { exchangeName = "pubsub" } = opts;

    this.amqpConn = opts.amqpConnection;
    this.logger = opts.logger;
    this.exchangeName = exchangeName;
  }

  /**
   * onceListener returns a listener that will resolve message data once
   */
  async onceListener<M>(args: {
    /** The topic pattern to match */
    topicPattern: string;
    /** An optional signal use for aborting the operation */
    signal?: AbortSignal;
  }): Promise<{ data: () => Promise<RabbitData<M>> }> {
    const ch = await this.amqpConn.createChannel();

    try {
      await ch.prefetch(1);

      const q = await ch.assertQueue("", {
        exclusive: true,
        autoDelete: true,
        durable: false,
      });
      await ch.bindQueue(q.queue, this.exchangeName, args.topicPattern);

      let resolve: (data: RabbitData<M>) => void;
      let reject: (err: unknown) => void = noop;
      const dataP = new Promise<RabbitData<M>>((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
      }).finally(() => {
        ch.close();
      });

      assert(reject !== noop);

      await ch.consume(
        q.queue,
        (msg) => {
          if (!msg) {
            reject(new Error("No message received"));
          } else {
            resolve({
              messageId: msg.properties.messageId,
              routingKey: msg.fields.routingKey,
              timestamp: new Date(msg.properties.timestamp * 1000),
              body: JSON.parse(msg.content.toString("utf8")),
            });
          }
        },
        {
          // Don't think we need to ack for a once off
          noAck: true,
          exclusive: true,
        }
      );

      if (args.signal) {
        if (args.signal.aborted) {
          reject(new Error("Aborted"));
        } else {
          args.signal.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true }
          );
        }
      }

      return { data: () => dataP };
    } catch (err) {
      ch.close();
      throw err;
    }
  }

  async handleQueue<T>(args: {
    queueName: string;
    maxConcurrent?: number;
    signal: AbortSignal;
    handler: MessageHandler<RabbitData<T>>;
  }): Promise<void> {
    const inProgress = new Set<Promise<void>>();
    const ch = await this.amqpConn.createChannel();

    try {
      await ch.prefetch(args.maxConcurrent || 20);

      const { consumerTag } = await ch.consume(args.queueName, async (msg) => {
        if (!msg) return;

        messagesReceivedCounter.inc({ queue: args.queueName });
        const end = messageHandlerDuration.startTimer({
          queue: args.queueName,
          provider: "rabbit",
        });

        const death = msg.properties.headers?.["x-death"]?.find(
          (d) => d.queue === args.queueName
        );

        // As far as I can tell, the TO routing key is always the first one, and
        // the CC are the ones that follow
        const routingKey = death
          ? death["routing-keys"][0]
          : msg.fields.routingKey;

        const task = args
          .handler({
            messageId: msg.properties.messageId,
            routingKey,
            timestamp: new Date(msg.properties.timestamp * 1000),
            body: JSON.parse(msg.content.toString("utf8")),
          })
          .then(
            () => ch.ack(msg),
            (err: unknown) => {
              messagesFailedCounter.inc({
                queue: args.queueName,
                provider: "rabbit",
              });
              this.logger.error(
                util.format(
                  "Error handling message message_id=%j routing_key=%s deaths=%s: %s",
                  msg.properties.messageId,
                  routingKey,
                  death?.count ?? 0,
                  err
                )
              );
              // TODO: when do we want to requeue? Nacking with requeue=false
              // sends to dead letter queue
              ch.nack(msg, false, false);
            }
          );

        task.finally(() => {
          end();
          inProgress.delete(task);
        });
        inProgress.add(task);
      });

      if (!args.signal.aborted) {
        await new Promise<void>((resolve) => {
          args.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }

      await ch.cancel(consumerTag);

      await Promise.all(inProgress);
    } finally {
      await ch.close();
    }
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    return this.usingChannel(async (ch) => {
      ch.publish(
        this.exchangeName,
        topic,
        Buffer.from(JSON.stringify(payload)),
        {
          messageId: ulid(),
          contentType: "application/json",
          contentEncoding: "utf-8",
          timestamp: unixTime(),
        }
      );
    });
  }

  async sendToQueue(queue: string, payload: unknown) {
    return this.usingChannel(async (ch) => {
      ch.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), {
        messageId: ulid(),
        contentType: "application/json",
        contentEncoding: "utf-8",
        timestamp: unixTime(),
      });
      messagesQueuedCounter.inc({ queue, provider: "rabbit" });
    });
  }

  /**
   * assets the topic exchange exists
   */
  async assertExchange(opts?: { durable?: boolean }): Promise<void> {
    return this.usingChannel(async (ch) => {
      await ch.assertExchange(this.exchangeName, "topic", opts);
    });
  }

  /**
   * Asserts a work queue with a dead letter queue
   * @param queueName The name of the queue to assert
   * @param options.retryDelay The delay in milliseconds to wait before retrying
   * a nacked message
   */
  async assertWorkQueue(
    queueName: string,
    options: { retryDelay: number }
  ): Promise<Replies.AssertQueue> {
    return this.usingChannel(async (ch) => {
      if (options.retryDelay <= 0) {
        throw new Error("retryDelay must be greater than 0");
      }
      const deadLetterQueue = `${queueName}-retry`;

      await ch.assertQueue(deadLetterQueue, {
        durable: true,
        deadLetterExchange: "",
        deadLetterRoutingKey: queueName,
        messageTtl: options.retryDelay,
      });

      // Use the default exchange (empty string) to send messages directly to
      // the queue
      return await ch.assertQueue(queueName, {
        durable: true,
        deadLetterExchange: "",
        deadLetterRoutingKey: deadLetterQueue,
      });
    });
  }

  async createSubscriptionQueue(): Promise<Replies.AssertQueue> {
    return this.usingChannel(async (ch) => {
      return await ch.assertQueue("", { exclusive: true, autoDelete: true });
    });
  }

  async bindQueue(queueName: string, topicPattern: string): Promise<void> {
    return this.usingChannel(async (ch) => {
      await ch.bindQueue(queueName, this.exchangeName, topicPattern);
    });
  }

  async unbindQueue(queueName: string, topicPattern: string): Promise<void> {
    return this.usingChannel(async (ch) => {
      await ch.unbindQueue(queueName, this.exchangeName, topicPattern);
    });
  }

  async usingChannel<T>(fn: (ch: Channel) => Promise<T>): Promise<T> {
    let ch: Channel;
    if (!this.useChan) {
      this.useChan = Promise.resolve(this.amqpConn.createChannel());
      ch = await this.useChan;
      ch.once("close", () => {
        this.useChan = null;
      });
    } else {
      ch = await this.useChan;
    }

    return await fn(ch);
  }
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}
