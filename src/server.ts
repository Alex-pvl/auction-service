import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { createClient } from "redis";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { registerApiRoutes } from "./routes/api.js";
import { startAuctionLifecycleManager, shutdownAuctionLifecycle } from "./services/auction-lifecycle.js";
import { createWebSocketServer, shutdownWebSocketServer } from "./services/websocket.js";
import { shutdownBots } from "./services/bots.js";
import { setRedisClient } from "./services/cache.js";

const PORT = Number(process.env.PORT ?? 3000);
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017/auction_service";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const app = express();
app.use(cors());
app.use(express.json());

// Логирование для диагностики
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | Headers: ${JSON.stringify(req.headers)}`);
  next();
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

registerApiRoutes(app, redis);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

let httpServer: ReturnType<typeof createServer> | null = null;
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
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => {
          console.log("HTTP server closed");
          resolve();
        });
        setTimeout(() => {
          console.warn("HTTP server close timeout, forcing...");
          resolve();
        }, 5000);
      });
    }
    
    await shutdownWebSocketServer();
    await shutdownBots();
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
  await redis.connect();
  setRedisClient(redis);
  httpServer = createServer(app);
  createWebSocketServer(httpServer);
  await startAuctionLifecycleManager(redis);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`server listening on 0.0.0.0:${PORT}`);
    console.log(`WebSocket server available at ws://localhost:${PORT}/ws`);
  });
  
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
