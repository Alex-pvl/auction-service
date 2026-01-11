import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { createClient } from "redis";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerApiRoutes } from "./routes/api.js";

const PORT = Number(process.env.PORT ?? 3000);
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017/auction_service";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const app = express();
app.use(cors());
app.use(express.json());

const redis = createClient({ url: REDIS_URL });
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

async function start() {
  await mongoose.connect(MONGO_URL);
  await redis.connect();

  app.listen(PORT, () => {
    console.log(`server listening on ${PORT}`);
  });
}

start().catch((err) => {
  console.error("failed to start", err);
  process.exit(1);
});
