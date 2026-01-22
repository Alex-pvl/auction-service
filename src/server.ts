import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import mongoose from "mongoose";
import { createClient } from "redis";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerApiRoutes } from "./routes/api-fastify.js";
import { startAuctionLifecycleManager, shutdownAuctionLifecycle } from "./services/auction-lifecycle.js";
import { createWebSocketServer, shutdownWebSocketServer } from "./services/websocket.js";
import { setRedisClient } from "./services/cache.js";
import { setRedisClient as setRedisBidsClient } from "./services/redis-bids.js";
import { setRedisClient as setMongoSyncClient, startMongoSync, stopMongoSync, initializeUserBalancesFromMongo } from "./services/mongo-sync.js";

const PORT = Number(process.env.PORT);
const MONGO_URL = process.env.MONGO_URL!;
const REDIS_URL = process.env.REDIS_URL!;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({
  logger: true,
  bodyLimit: 1048576,
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const json = body === '' ? {} : JSON.parse(body as string);
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});

await fastify.register(cors, {
  origin: true,
});

await fastify.register(fastifyStatic, {
  root: path.join(__dirname, "..", "public"),
  prefix: "/",
});

const redis = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("Redis reconnection failed after 10 retries");
        return new Error("Redis connection failed");
      }
      return Math.min(retries * 50, 1000);
    },
  },
});

redis.on("error", (err) => {
  console.error("redis error", err);
});

let isShuttingDown = false;
let shutdownTimeout: NodeJS.Timeout | null = null;
const SHUTDOWN_TIMEOUT_MS = 30000;

async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log("Shutdown already in progress, forcing exit...");
    process.exit(1);
    return;
  }
  
  isShuttingDown = true;
  console.log(`Received ${signal}, starting graceful shutdown...`);
  
  shutdownTimeout = setTimeout(() => {
    console.error("Shutdown timeout exceeded, forcing exit...");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  
  try {
    stopMongoSync();
    
    await fastify.close();
    console.log("Fastify server closed");
    
    await shutdownWebSocketServer();
    await shutdownAuctionLifecycle();
    
    if (redis.isOpen) {
      await Promise.race([
        redis.quit(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Redis quit timeout")), 5000)
        )
      ]).catch((error) => {
        console.warn("Redis quit error or timeout:", error);
      });
      console.log("Redis connection closed");
    }
    
    await Promise.race([
      mongoose.connection.close(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("MongoDB close timeout")), 5000)
      )
    ]).catch((error) => {
      console.warn("MongoDB close error or timeout:", error);
    });
    console.log("MongoDB connection closed");
    
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }
    
    console.log("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }
    process.exit(1);
  }
}

async function start() {
  await mongoose.connect(MONGO_URL, {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log("MongoDB connected");

  await redis.connect();
  console.log("Redis connected");
  
  setRedisClient(redis);
  setRedisBidsClient(redis);
  setMongoSyncClient(redis);
  
  await initializeUserBalancesFromMongo();
  
  startMongoSync();
  
  await registerApiRoutes(fastify);
  
  fastify.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });
  
  fastify.get("/api/health", async (_request, reply) => {
    const mongoOk = mongoose.connection.readyState === 1;
    const redisOk = redis.isOpen;
    return reply.send({ ok: mongoOk && redisOk, mongoOk, redisOk });
  });
  
  const httpServer = fastify.server;
  createWebSocketServer(httpServer);
  
  await startAuctionLifecycleManager(redis);
  
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server listening on 0.0.0.0:${PORT}`);
    console.log(`WebSocket server available at ws://localhost:${PORT}/ws`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });
  
  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    shutdown("uncaughtException").catch(() => process.exit(1));
  });
}

start().catch((err) => {
  console.error("failed to start", err);
  process.exit(1);
});
