import { Counter, Histogram, Registry } from "prom-client";

export const messagesReceivedCounter = new Counter({
  name: "queue_handler_messages_total",
  help: "Total number of messages received from the queue",
  labelNames: ["queue", "provider"],
});
export const messagesFailedCounter = new Counter({
  name: "queue_handler_failures_total",
  help: "Total number of messages failed to handle",
  labelNames: ["queue", "provider"],
});
export const messageHandlerDuration = new Histogram({
  name: "queue_handler_duration_seconds",
  help: "Queue message handler processing time in seconds.",
  labelNames: ["queue", "provider"],
});

export const messagesQueuedCounter = new Counter({
  name: "queue_messages_queued_total",
  help: "Total number of messages published to the queue",
  labelNames: ["queue", "provider"],
});

export function registerMetrics(registry: Pick<Registry, "registerMetric">) {
  registry.registerMetric(messagesReceivedCounter);
  registry.registerMetric(messagesFailedCounter);
  registry.registerMetric(messagesQueuedCounter);
  registry.registerMetric(messageHandlerDuration);
}
