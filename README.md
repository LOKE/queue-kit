# LOKE Queue Kit

A lib for rabbit and sqs queues

# Rabbit

Handling a work queue

```ts
import { RabbitHelper } from "@loke/queue-kit";
import amqp from "amqplib";

async function main() {
  const amqpConnection = await amqp.connect("amqp://localhost");

  const rabbitHelper = new RabbitHelper({
    amqpConnection,
    logger: console,
  });

  await rabbitHelper.assertExchange();
  await rabbitHelper.assertWorkQueue("work-queue");
  await rabbitHelper.bindQueue("work-queue", "thing.*");

  const aborter = new AbortController();

  const doneP = await rabbitHelper.handleQueue({
    queueName: "work-queue",
    handler: async (msg) => {
      await doWork(msg.body);
    },
    signal: aborter.signal,
  });

  await stopSignal();

  aborter.abort();

  await doneP;
}

main();
```

Publishing events

```ts
import { RabbitHelper } from "@loke/queue-kit";
import amqp from "amqplib";

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

Handling a queue

```ts
import { SQSHelper } from "@loke/queue-kit";
import SQS from "aws-sdk/clients/sqs";

async function main() {
  const sqsHelper = new SQSHelper({
    sqs: new SQS(),
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

Queueing work

```ts
import { SQSHelper } from "@loke/queue-kit";
import SQS from "aws-sdk/clients/sqs";

async function main() {
  const sqsHelper = new SQSHelper({
    sqs: new SQS(),
    logger: console,
  });

  await sqsHelper.sendToQueue("https://queue-url", {
    foo: "bar",
  });
}
```
