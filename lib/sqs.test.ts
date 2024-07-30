import test from "ava";
import { SQSClient } from "@aws-sdk/client-sqs";
import { ulid } from "ulid";

import { SQS, SQSData, SQSHelper } from "./sqs";

const noopLogger = {
  error: () => undefined,
};

function setup() {
  if (process.env.SQS_QUEUE_URL) {
    const queueUrl = new URL(process.env.SQS_QUEUE_URL);
    const region = queueUrl.hostname.split(".")[1];
    return {
      queueUrl: process.env.SQS_QUEUE_URL,
      sqs: new SQSHelper({
        sqs: new SQSClient({ region: region }),
        logger: noopLogger,
      }),
    };
  } else {
    return {
      queueUrl: "https://example.com/fake-queue",
      sqs: new SQSHelper({ sqs: new MockSQS(), logger: noopLogger }),
    };
  }
}

test("handleQueue - abort shouldn't drop messages", async (t) => {
  const { sqs, queueUrl } = setup();

  let doneCount = 0;
  const n = 100;

  for (let i = 0; i < n; i++) {
    sqs.sendToQueue(queueUrl, { id: i });
  }

  let aborter = new AbortController();

  const done = new Set();

  await sqs.handleQueue<{ id: number }>({
    queueUrl,
    handler: async (msg: SQSData<{ id: number }>) => {
      if (done.size > n / 2) {
        aborter.abort();
      }
      done.add(msg.body.id);
      doneCount++;
    },
    maxConcurrent: 5,
    signal: aborter.signal,
  });

  aborter = new AbortController();

  await sqs.handleQueue<{ id: number }>({
    queueUrl,
    handler: async (msg: SQSData<{ id: number }>) => {
      done.add(msg.body.id);
      doneCount++;
      if (done.size == n) {
        aborter.abort();
      }
    },
    maxConcurrent: 5,
    signal: aborter.signal,
  });

  t.is(done.size, n);
  t.is(doneCount, n);
});

test.serial("handleQueue - with failing", async (t) => {
  const { sqs, queueUrl } = await setup();

  const ac = new AbortController();
  const seen = new Set();
  let handleCount = 0;
  let doneCount = 0;

  const doneP = sqs.handleQueue<{ id: string }>({
    queueUrl,
    handler: async (msg) => {
      handleCount++;
      if (handleCount % 2 === 1) {
        throw new Error("oops");
      }
      doneCount++;
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
      sqs.sendToQueue(queueUrl, {
        id: i,
      })
    )
  );

  await doneP;

  t.is(seen.size, 10);
  t.is(doneCount, 10);
});

test.serial("handleQueue - max concurrency", async (t) => {
  const { sqs, queueUrl } = await setup();

  const ac = new AbortController();
  const seen = new Set();
  const n = 250;
  let concurrent = 0;

  const doneP = sqs.handleQueue<{ id: string }>({
    queueUrl,
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
      sqs.sendToQueue(queueUrl, {
        id: i,
      })
    )
  );

  await doneP;

  t.is(seen.size, n);
});

interface MockRawMessage {
  MessageId: string;
  Body?: string;
  ReceiptHandle: string;
  Visibility: boolean;
}

class MockSQS implements SQS {
  private queues: { [key: string]: MockRawMessage[] } = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(arg: { input: any }) {
    switch (arg.constructor.name) {
      case "ReceiveMessageCommand":
        return this.receiveMessage(arg.input);
      case "ChangeMessageVisibilityCommand":
        return this.changeMessageVisibility(arg.input);
      case "DeleteMessageCommand":
        return this.deleteMessage(arg.input);
      case "SendMessageCommand":
        return this.sendMessage(arg.input);
      default:
        throw new Error("command not implemented");
    }
  }

  private async changeMessageVisibility(args: {
    ReceiptHandle: string;
    QueueUrl: string;
    VisibilityTimeout: number;
  }) {
    const queue = this.getQueue(args.QueueUrl);
    const msg = queue.find((m) => m.ReceiptHandle === args.ReceiptHandle);
    if (msg) {
      msg.Visibility = true;
    }
  }

  private async deleteMessage(args: {
    ReceiptHandle: string;
    QueueUrl: string;
  }) {
    const queue = this.getQueue(args.QueueUrl);
    const i = queue.findIndex((m) => m.ReceiptHandle === args.ReceiptHandle);
    if (i >= 0) {
      queue.splice(i, 1);
    }
  }

  private async receiveMessage(args: {
    MaxNumberOfMessages: number;
    QueueUrl: string;
    WaitTimeSeconds: number;
  }) {
    const nextMessages: MockRawMessage[] = [];
    const queue = this.getQueue(args.QueueUrl);

    let i = 0;
    while (nextMessages.length < args.MaxNumberOfMessages && i < queue.length) {
      const msg = queue[i];
      if (msg.Visibility) {
        nextMessages.push(msg);
        msg.Visibility = false;
      }
      i++;
    }

    if (nextMessages.length === 0) {
      return await new Promise<{ Messages: undefined }>((resolve) =>
        setTimeout(() => resolve({ Messages: undefined }), 10)
      );
    }

    return { Messages: nextMessages };
  }

  private async sendMessage(args: { QueueUrl: string; MessageBody: string }) {
    const id = ulid();

    this.getQueue(args.QueueUrl).push({
      MessageId: id,
      Body: args.MessageBody,
      ReceiptHandle: "rh-" + id,
      Visibility: true,
    });
  }

  private getQueue(queueUrl: string) {
    if (!this.queues[queueUrl]) {
      this.queues[queueUrl] = [];
    }
    return this.queues[queueUrl];
  }
}
