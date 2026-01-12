import type { Express } from "express";
import mongoose from "mongoose";
import type { RedisClientType } from "redis";
import {
  createAuction,
  getAuctionById,
  listAuctions,
  releaseAuction,
  softDeleteAuction,
  updateAuction,
} from "../services/auctions.js";
import type { AuctionUpdateInput } from "../services/auctions.js";
import {
  adjustUserBalanceByTgId,
  ensureUserByTgId,
  getUserByTgId,
} from "../services/users.js";

const auctionStatuses = new Set(["DRAFT", "LIVE", "FINISHED", "DELETED"]);

function isValidDate(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime());
}

function toDate(value: unknown) {
  return value instanceof Date ? value : new Date(String(value ?? ""));
}

function parseOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseTgId(value: unknown) {
  const tgId = Number(value);
  if (!Number.isFinite(tgId) || tgId <= 0 || !Number.isInteger(tgId)) return null;
  return tgId;
}

async function requireUserByTgId(tgId: number, res: any) {
  const user = await getUserByTgId(tgId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return null;
  }
  return user;
}

export function registerApiRoutes(app: Express, redis: RedisClientType<any, any, any>) {
  app.get("/api/health", async (_req, res) => {
    const mongoOk = mongoose.connection.readyState === 1;
    const redisOk = redis.isOpen;
    res.json({ ok: mongoOk && redisOk, mongoOk, redisOk });
  });

  app.get("/api/auctions", async (req, res) => {
    const limitRaw = Number(req.query?.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const status = req.query?.status ? String(req.query.status).toUpperCase() : undefined;
    if (status && !auctionStatuses.has(status)) {
      res.status(400).json({ error: "invalid status" });
      return;
    }

    const auctions = await listAuctions(limit, status as any);
    res.json(auctions);
  });

  app.get("/api/auctions/:id", async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction || auction.status === "DELETED") {
      res.status(404).json({ error: "not found" });
      return;
    }

    const userHeader = req.get("X-User-Id");
    const userId = userHeader ? parseTgId(userHeader) : null;

    if (auction.status === "DRAFT" && userId) {
      const user = await requireUserByTgId(userId, res);
      if (!user) return;
      if (user.tg_id !== auction.creator_id) {
        res.status(403).json({ error: "creator_id mismatch" });
        return;
      }
    }

    res.json(auction);
  });

  app.post("/api/auctions", async (req, res) => {
    const body = req.body ?? {};
    const errors: string[] = [];
    const userHeader = req.get("X-User-Id");
    const creatorId = userHeader ? parseTgId(userHeader) : null;

    const nameRaw = body.name;
    const name = nameRaw === undefined || nameRaw === null ? null : String(nameRaw).trim() || null;
    const itemName = String(body.item_name ?? "").trim();
    const minBid = Number(body.min_bid);
    const winnersCountTotal = Number(body.winners_count_total);
    const roundsCount = Number(body.rounds_count);
    const firstRoundDurationMs = parseOptionalNumber(body.first_round_duration_ms);
    const roundDurationMs = Number(body.round_duration_ms);
    const startDateTime = toDate(body.start_datetime);

    if (!creatorId) errors.push("missing X-User-Id header");
    if (!itemName) errors.push("item_name");
    if (!Number.isFinite(minBid)) errors.push("min_bid");
    if (!Number.isFinite(winnersCountTotal)) errors.push("winners_count_total");
    if (!Number.isFinite(roundsCount)) errors.push("rounds_count");
    if (
      body.first_round_duration_ms !== undefined &&
      body.first_round_duration_ms !== null &&
      firstRoundDurationMs === null
    ) {
      errors.push("first_round_duration_ms");
    }
    if (!Number.isFinite(roundDurationMs)) errors.push("round_duration_ms");
    if (!isValidDate(startDateTime) || startDateTime.getTime() < Date.now()) {
      errors.push("start_datetime");
    }

    if (errors.length) {
      res.status(400).json({ error: "invalid fields", fields: errors });
      return;
    }

    const firstRoundDuration = firstRoundDurationMs ?? roundDurationMs;
    const totalDurationMs = firstRoundDuration + Math.max(roundsCount - 1, 0) * roundDurationMs;
    const plannedEndDateTime = new Date(startDateTime.getTime() + totalDurationMs);

    const creatorUser = await requireUserByTgId(creatorId!, res);
    if (!creatorUser) return;

    const auction = await createAuction({
      name,
      creator_id: creatorId!,
      item_name: itemName,
      min_bid: minBid,
      winners_count_total: winnersCountTotal,
      rounds_count: roundsCount,
      winners_per_round: winnersCountTotal / roundsCount,
      first_round_duration_ms: firstRoundDurationMs,
      round_duration_ms: roundDurationMs,
      status: "DRAFT",
      current_round_idx: 0,
      remaining_items_count: winnersCountTotal,
      start_datetime: startDateTime,
      planned_end_datetime: plannedEndDateTime,
    });

    res.status(201).json(auction);
  });

  app.put("/api/auctions/:id", async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const userHeader = req.get("X-User-Id");
    const creatorId = userHeader ? parseTgId(userHeader) : null;
    if (!creatorId) {
      res.status(400).json({ error: "user_id header is required" });
      return;
    }

    const creatorUser = await requireUserByTgId(creatorId, res);
    if (!creatorUser) return;

    const existingAuction = await getAuctionById(id);
    if (!existingAuction) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (existingAuction.status !== "DRAFT") {
      res.status(409).json({ error: "only DRAFT auctions can be updated" });
      return;
    }
    if (existingAuction.creator_id !== creatorId) {
      res.status(403).json({ error: "creator_id mismatch" });
      return;
    }

    const body = req.body ?? {};
    const errors: string[] = [];
    const updates: AuctionUpdateInput = {};
    const allowedFields = new Set([
      "name",
      "item_name",
      "min_bid",
      "winners_count_total",
      "rounds_count",
      "first_round_duration_ms",
      "round_duration_ms",
      "start_datetime",
    ]);
    const extraFields = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (extraFields.length) {
      res.status(400).json({ error: "unsupported fields", fields: extraFields });
      return;
    }

    if ("name" in body) {
      const nameRaw = body.name;
      updates.name = nameRaw === undefined || nameRaw === null ? null : String(nameRaw).trim() || null;
    }
    if ("item_name" in body) {
      const value = String(body.item_name ?? "").trim();
      if (value) updates.item_name = value;
      else errors.push("item_name");
    }
    if ("min_bid" in body) {
      const value = Number(body.min_bid);
      if (Number.isFinite(value)) updates.min_bid = value;
      else errors.push("min_bid");
    }
    if ("winners_count_total" in body) {
      const value = Number(body.winners_count_total);
      if (Number.isFinite(value)) updates.winners_count_total = value;
      else errors.push("winners_count_total");
    }
    if ("rounds_count" in body) {
      const value = Number(body.rounds_count);
      if (Number.isFinite(value)) updates.rounds_count = value;
      else errors.push("rounds_count");
    }
    if ("first_round_duration_ms" in body) {
      const value = parseOptionalNumber(body.first_round_duration_ms);
      if (value === null && body.first_round_duration_ms !== null) {
        errors.push("first_round_duration_ms");
      } else {
        updates.first_round_duration_ms = value;
      }
    }
    if ("round_duration_ms" in body) {
      const value = Number(body.round_duration_ms);
      if (Number.isFinite(value)) updates.round_duration_ms = value;
      else errors.push("round_duration_ms");
    }
    if ("current_round_idx" in body) {
      const value = Number(body.current_round_idx);
      if (Number.isFinite(value)) updates.current_round_idx = value;
      else errors.push("current_round_idx");
    }
    if ("remaining_items_count" in body) {
      const value = Number(body.remaining_items_count);
      if (Number.isFinite(value)) updates.remaining_items_count = value;
      else errors.push("remaining_items_count");
    }
    if ("start_datetime" in body) {
      const value = toDate(body.start_datetime);
      if (!isValidDate(value) || value.getTime() < Date.now()) {
        errors.push("start_datetime");
      }
    }

    if (errors.length) {
      res.status(400).json({ error: "invalid fields", fields: errors });
      return;
    }
    if (!Object.keys(updates).length) {
      res.status(400).json({ error: "no fields to update" });
      return;
    }

    const auction = await updateAuction(id, updates);
    if (!auction) {
      res.status(404).json({ error: "not found" });
      return;
    }

    res.json(auction);
  });

  app.delete("/api/auctions/:id", async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const existingAuction = await getAuctionById(id);
    if (!existingAuction) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (existingAuction.status !== "DRAFT") {
      res.status(409).json({ error: "only DRAFT auctions can be deleted" });
      return;
    }

    const auction = await softDeleteAuction(id);
    if (!auction) {
      res.status(404).json({ error: "not found" });
      return;
    }

    res.json(auction);
  });

  app.post("/api/auctions/:id/release", async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const userHeader = req.get("X-User-Id");
    const creatorId = userHeader ? parseTgId(userHeader) : null;
    if (!creatorId) {
      res.status(400).json({ error: "user_id header is required" });
      return;
    }

    const creatorUser = await requireUserByTgId(creatorId, res);
    if (!creatorUser) return;

    const existingAuction = await getAuctionById(id);
    if (!existingAuction) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (existingAuction.creator_id !== creatorId) {
      res.status(403).json({ error: "creator_id mismatch" });
      return;
    }
    if (existingAuction.status !== "DRAFT") {
      res.status(409).json({ error: "only DRAFT auctions can be released" });
      return;
    }

    const auction = await releaseAuction(id);
    if (!auction) {
      res.status(404).json({ error: "not found" });
      return;
    }

    res.json(auction);
  });

  app.post("/api/users/auth", async (req, res) => {
    const tgId = parseTgId(req.body?.tg_id);
    if (!tgId) {
      res.status(400).json({ error: "tg_id is required" });
      return;
    }

    const user = await ensureUserByTgId(tgId);
    res.json(user);
  });

  app.post("/api/users/:tgId/balance/increase", async (req, res) => {
    const tgId = parseTgId(req.params.tgId);
    if (!tgId) {
      res.status(400).json({ error: "invalid tg_id" });
      return;
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be positive" });
      return;
    }

    const user = await getUserByTgId(tgId);
    if (!user) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const updated = await adjustUserBalanceByTgId(tgId, amount);
    res.json(updated);
  });

  app.post("/api/users/:tgId/balance/decrease", async (req, res) => {
    const tgId = parseTgId(req.params.tgId);
    if (!tgId) {
      res.status(400).json({ error: "invalid tg_id" });
      return;
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be positive" });
      return;
    }

    const user = await getUserByTgId(tgId);
    if (!user) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (user.balance < amount) {
      res.status(409).json({ error: "insufficient balance" });
      return;
    }

    const updated = await adjustUserBalanceByTgId(tgId, -amount);
    res.json(updated);
  });
}
