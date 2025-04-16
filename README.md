# LOKE Queue Kit

A lib for rabbit and sqs queues

## Rabbit

Requires `amqplib` to be installed separately. If you only need RabbitMQ support you can avoid also needing to install `@aws-sdk` packages by importing from `"@loke/queue-kit/rabbit"`.

### Handling a work queue

```ts
import { RabbitHelper } from "@loke/queue-kit"; // or "@loke/queue-kit/rabbit"
import amqp from "amqplib"; // must be installed separately

async function main() {
  const amqpConnection = await amqp.connect("amqp://localhost");

  const rabbitHelper = new RabbitHelper({
    amqpConnection,
    logger: console,
  });

  await rabbitHelper.assertExchange();
  await rabbitHelper.assertWorkQueue("work-queue", { retryDelay: 1000 });
  await rabbitHelper.bindQueue("work-queue", "thing.*");

  const aborter = new AbortController();

  const doneP = (async () => {
    // We loop here in case the rabbit channel closes and we need to restart
    // the queue handler.
    while (!aborter.signal.aborted) {
      try {
        await rabbitHelper.handleQueue({
          queueName: "work-queue",
          handler: async (msg) => {
            await doWork(msg.body);
          },
          signal: aborter.signal,
        });
      } catch (err) {
        logger.error("Error with spend tracker queue", err);
      }
    }
  })();

  await stopSignal();

  aborter.abort();

  await doneP;
}

main();
```

**Breaking change in 2.x:** `assertWorkQueue` now requires a `retryDelay`
option. This is the delay between retries when a message fails to be processed.
To achieve this a dead letter queue is created and attached to the work queue
(via the default direct exchange). Because old queues can't be changed via
assertQueue, a new will need to be created.

```ts
await rabbitHelper.assertWorkQueue("new-queue", { retryDelay: 1000 });
await rabbitHelper.bindQueue("new-queue", "thing.*");
// bindings will already exist for the old-queue

const aborter = new AbortController();

const handler = async (msg) => {
  await doWork(msg.body);
};

const doneP = await Promise.all([
  rabbitHelper.handleQueue({
    queueName: "old-queue",
    handler,
    signal: aborter.signal,
  }),
  rabbitHelper.handleQueue({
    queueName: "new-queue",
    handler,
    signal: aborter.signal,
  }),
]);
```

### Handling a subscription queue

```ts
import { RabbitHelper } from "@loke/queue-kit"; // or "@loke/queue-kit/rabbit"
import amqp from "amqplib"; // must be installed separately

async function main() {
  const amqpConnection = await amqp.connect("amqp://localhost");

  const rabbitHelper = new RabbitHelper({
    amqpConnection,
    logger: console,
  });

  await rabbitHelper.assertExchange();

  const aborter = new AbortController();

  const doneP = (async () => {
    // We loop here in case the rabbit channel closes and we need to restart
    // the queue handler.
    //
    // Because this is a subscription queue, we need to create a new queue each
    // time we start the handler. This is because the queue will be deleted when
    // the channel closes. If the resource the queue is updating could have
    // become stale while the channel was closed, we need to handle that too.
    //
    // In this example we update a cache with the latest value from the queue.
    // If we loose our our connection to the queue, we need to clear the cache
    // and start again.
    while (!aborter.signal.aborted) {
      const { queue } = await rabbitHelper.createSubscriptionQueue();
      await rabbitHelper.bindQueue(queue, "thing.*");

      await clearCache();

      try {
        await rabbitHelper.handleQueue({
          queueName: queue,
          handler: async (msg) => {
            await updateCache(msg.body);
          },
          signal: aborter.signal,
        });
      } catch (err) {
        logger.error("Error with spend tracker queue", err);
      }
    }
  })();

  await stopSignal();

  aborter.abort();

  await doneP;
}

main();
```

### Publishing events

```ts
import { RabbitHelper } from "@loke/queue-kit"; // or "@loke/queue-kit/rabbit"
import amqp from "amqplib"; // must be installed separately

async function main() {
  const amqpConnection = await amqp.connect("amqp://localhost");

  const rabbitHelper = new RabbitHelper({
    amqpConnection,
    logger: console,
  });

  await rabbitHelper.publish("thing.1", {
    foo: "bar",
  });
}
```

## SQS

Requires `@aws-sdk/client-sqs` to be installed separately. If you only need SQS support you can avoid also needing to install `amqplib` by importing from `"@loke/queue-kit/sqs"`.

Handling a queue:

```ts
import { SQSHelper } from "@loke/queue-kit"; // or "@loke/queue-kit/sqs"
import { SQSClient } from "@aws-sdk/client-sqs"; // must be installed separately

async function main() {
  const sqsHelper = new SQSHelper({
    sqs: new SQSClient(),
    logger: console,
  });

  const aborter = new AbortController();

  const doneP = await sqsHelper.handleQueue({
    queueUrl: "https://queue-url",
    handler: async (msg) => {
      await doWork(msg.body);
    },
    signal: aborter.signal,
  });

  await stopSignal();

  aborter.abort();

  await doneP;
}
```

Queueing work:

```ts
import { SQSHelper } from "@loke/queue-kit"; // or "@loke/queue-kit/sqs"
import { SQSClient } from "@aws-sdk/client-sqs"; // must be installed separately

async function main() {
  const sqsHelper = new SQSHelper({
    sqs: new SQSClient(),
    logger: console,
  });

  await sqsHelper.sendToQueue("https://queue-url", {
    foo: "bar",
  });
}
```

## Metrics

```ts
import { register } from "prom-client";
import { registerMetrics } from "@loke/queue-kit"; // or "@loke/queue-kit/rabbit" or "@loke/queue-kit/sqs"

registerMetrics(register);
```
