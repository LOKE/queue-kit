import { Counter, Histogram, Registry } from "prom-client";

export const messagesReceivedCounter = new Counter({
  name: "queue_messages_received_total",
  help: "Total number of messages received from the queue",
  labelNames: ["queue", "provider"],
});
export const messagesFailedCounter = new Counter({
  name: "queue_messages_failed_total",
  help: "Total number of messages failed to handle",
  labelNames: ["queue", "provider"],
});
export const messagesQueuedCounter = new Counter({
  name: "queue_messages_queued_total",
  help: "Total number of messages published to the queue",
  labelNames: ["queue", "provider"],
});
export const messageHandlerDuration = new Histogram({
  name: "queue_message_handler_duration_ms",
  help: "Queue message handler processing time in milliseconds.",
  labelNames: ["queue", "provider"],
});

export function registerMetrics(registry: Pick<Registry, "registerMetric">) {
  registry.registerMetric(messagesReceivedCounter);
  registry.registerMetric(messagesFailedCounter);
  registry.registerMetric(messagesQueuedCounter);
  registry.registerMetric(messageHandlerDuration);
}
