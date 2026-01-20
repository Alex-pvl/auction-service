#!/bin/bash

MONGO_CONTAINER=$(docker ps -qf "name=mongo" | head -n 1)

if [ -z "$MONGO_CONTAINER" ]; then
  echo "Error: MongoDB container not found. Make sure docker-compose is running."
  exit 1
fi

echo "Waiting for MongoDB to be ready..."
sleep 3

echo "Checking replica set status..."
STATUS=$(docker exec $MONGO_CONTAINER mongosh --quiet --eval "rs.status().ok" 2>/dev/null || echo "0")

if [ "$STATUS" = "1" ]; then
  echo "Replica set is already initialized."
  exit 0
fi

echo "Initializing replica set 'rs0'..."
docker exec $MONGO_CONTAINER mongosh --eval "rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]})"

if [ $? -eq 0 ]; then
  echo "Replica set initialized successfully!"
  echo "Waiting for replica set to be ready..."
  sleep 2
  docker exec $MONGO_CONTAINER mongosh --quiet --eval "rs.status().ok" && echo "Replica set is ready!"
else
  echo "Failed to initialize replica set. Please check MongoDB logs."
  exit 1
fi
