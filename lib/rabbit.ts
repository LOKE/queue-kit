import { Channel, Connection, Options, Replies } from "amqplib";
import assert from "assert";
import { ulid } from "ulid";

import { AbortSignal, errorMessage, Logger, MessageHandler } from "./common";

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

  /**
   *
   * @param opts.amqpConnection The amqplib connection
   * @param opts.logger Logger used for reporting errors
   * @param opts.exchangeName The rabbitmq exchange to use, defaults to "pubsub"
   */
  constructor(opts: {
    amqpConnection: Connection;
    /**
     * The exchange name to publish to
     */
    exchangeName?: string;
    logger: Logger;
  }) {
    const { exchangeName = "pubsub" } = opts;

    this.amqpConn = opts.amqpConnection;
    this.logger = opts.logger;
    this.exchangeName = exchangeName;
  }

  /**
   * onceListener returns a listener that will resolve message data once
   * @param args.topicPattern The topic pattern to match
   * @param args.signal An optional signal use for aborting the operation
   */
  async onceListener<M>(args: {
    topicPattern: string;
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

        const task = args
          .handler({
            messageId: msg.properties.messageId,
            routingKey: msg.fields.routingKey,
            timestamp: new Date(msg.properties.timestamp * 1000),
            body: JSON.parse(msg.content.toString("utf8")),
          })
          .then(
            () => ch.ack(msg),
            (err: unknown) => {
              this.logger.error(`Error handling message: ${errorMessage(err)}`);
              // TODO: when do we want to requeue? Nacking with requeue=false
              // sends to dead letter queue
              ch.nack(msg, false, false);
            }
          );

        task.finally(() => {
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

      const queueOptions: Options.AssertQueue = { durable: true };

      const deadLetterQueue = `${queueName}-retry`;

      // Use the default exchange (empty string) to send messages directly to
      // the queue
      queueOptions.deadLetterExchange = "";
      queueOptions.deadLetterRoutingKey = deadLetterQueue;

      await ch.assertQueue(deadLetterQueue, {
        durable: true,
        deadLetterExchange: "",
        deadLetterRoutingKey: queueName,
        messageTtl: options.retryDelay,
      });

      return await ch.assertQueue(queueName, queueOptions);
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
