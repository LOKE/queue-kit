import test, { ExecutionContext } from "ava";
import { connect } from "amqplib";
import { ulid } from "ulid";
import { AbortController } from "node-abort-controller";

import { RabbitHelper } from "./rabbit";

const noopLogger = {
  error: () => undefined,
};

async function setup(t: ExecutionContext<unknown>) {
  const conn = await connect(process.env.RABBIT_URL || "amqp://localhost");
  t.teardown(async () => {
    await conn.close();
  });

  const exchangeName = `loke-queue.test-${ulid()}`;

  const rabbit = new RabbitHelper({
    amqpConnection: conn,
    logger: noopLogger,
    exchangeName,
  });

  await rabbit.assertExchange();
  t.teardown(async () => {
    await rabbit.usingChannel(async (ch) => ch.deleteExchange(exchangeName));
  });

  return rabbit;
}

async function setupWorkQueue(
  t: ExecutionContext<unknown>,
  rabbit: RabbitHelper
) {
  const queueName = `loke-queue.test-${ulid()}`;

  await rabbit.assertWorkQueue(queueName);
  t.teardown(async () =>
    rabbit.usingChannel(async (ch) => ch.deleteQueue(queueName))
  );

  return queueName;
}

test("handleQueue", async (t) => {
  const rabbit = await setup(t);
  const queueName = await setupWorkQueue(t, rabbit);

  await rabbit.bindQueue(queueName, "thing.*");

  const ac = new AbortController();
  const seen = new Set();
  let handleCount = 0;

  const doneP = rabbit.handleQueue<{ id: string }>({
    queueName,
    handler: async (msg) => {
      handleCount++;
      if (handleCount % 2 === 1) {
        throw new Error("oops");
      }
      seen.add(msg.body.id);
      if (seen.size >= 10) {
        ac.abort();
      }
    },
    maxConcurrent: 5,
    // Node types seem messed up
    signal: ac.signal,
  });

  await Promise.all(
    new Array(10).fill(null).map((_, i) =>
      rabbit.publish("thing." + i, {
        id: i,
      })
    )
  );

  await doneP;

  t.is(seen.size, 10);
});

test("handleQueue - max concurrency", async (t) => {
  const rabbit = await setup(t);
  const queueName = await setupWorkQueue(t, rabbit);

  await rabbit.bindQueue(queueName, "thing.*");

  const ac = new AbortController();
  const seen = new Set();
  const n = 2500;
  let concurrent = 0;

  const doneP = rabbit.handleQueue<{ id: string }>({
    queueName,
    handler: async (msg) => {
      concurrent++;

      t.assert(concurrent <= 20);

      seen.add(msg.body.id);
      if (seen.size >= n) {
        ac.abort();
      }
      await new Promise((r) => setTimeout(r, Math.random() * 2 + 2));

      concurrent--;
    },
    maxConcurrent: 20,
    // Node types seem messed up
    signal: ac.signal,
  });

  await Promise.all(
    new Array(n).fill(null).map((_, i) =>
      rabbit.publish("thing." + i, {
        id: i,
      })
    )
  );

  await doneP;

  t.is(seen.size, n);
});

test("onceListener", async (t) => {
  const rabbit = await setup(t);

  const l = await rabbit.onceListener({ topicPattern: "thing.*" });

  await rabbit.publish("thing.1", {
    id: 1,
  });

  const got = await l.data();

  t.deepEqual(got.body, { id: 1 });
  t.assert(got.timestamp instanceof Date);
  t.regex(got.messageId, /^[0-9A-Z]{26}$/);
});

test("onceListener - aborted", async (t) => {
  const rabbit = await setup(t);

  // Aborted before bind
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();

  const l1 = await rabbit.onceListener({
    topicPattern: "xxx",
    signal: alreadyAborted.signal,
  });
  await t.throwsAsync(l1.data(), { message: "Aborted" });

  // Aborted after bind
  const abortedAfterBind = new AbortController();

  const l2 = await rabbit.onceListener({
    topicPattern: "xxx",
    signal: abortedAfterBind.signal,
  });
  abortedAfterBind.abort();

  await t.throwsAsync(l2.data(), { message: "Aborted" });
});
