#!/bin/bash

for exchange in $(rabbitmqadmin -f bash list exchanges); do
    if [[ $exchange == loke-queue.* ]]; then
        rabbitmqadmin delete exchange name="$exchange"
    fi
done

for queue in $(rabbitmqadmin -f bash list queues); do
    if [[ $queue == loke-queue.* ]]; then
        rabbitmqadmin delete queue name="$queue"
    fi
done
