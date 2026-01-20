#!/bin/bash

# Скрипт для инициализации MongoDB replica set в Docker контейнере

echo "Waiting for MongoDB to be ready..."
sleep 5

# Проверяем, инициализирован ли уже replica set
STATUS=$(docker compose exec -T mongo mongosh --quiet --eval "try { rs.status().ok } catch(e) { 0 }" 2>/dev/null || echo "0")

if [ "$STATUS" = "1" ]; then
  echo "Replica set is already initialized."
  exit 0
fi

echo "Initializing replica set 'rs0'..."
docker compose exec -T mongo mongosh --eval "
try {
  rs.initiate({
    _id: 'rs0',
    members: [
      { _id: 0, host: 'mongo:27017' }
    ]
  });
  print('Replica set initialized successfully!');
} catch (e) {
  if (e.message.includes('already initialized')) {
    print('Replica set already initialized');
  } else {
    print('Error:', e.message);
    exit(1);
  }
}
"

if [ $? -eq 0 ]; then
  echo "Waiting for replica set to be ready..."
  sleep 5
  docker compose exec -T mongo mongosh --quiet --eval "rs.status().ok" && echo "Replica set is ready!"
else
  echo "Failed to initialize replica set. Please check MongoDB logs."
  exit 1
fi
