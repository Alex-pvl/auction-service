import type { Express } from "express";
import mongoose from "mongoose";
import type { RedisClientType } from "redis";
import { createRateLimiter, createStrictRateLimiter, createBidRateLimiter } from "../middleware/rateLimit.js";
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
import {
  getUserBid,
  getUserPlace,
  getTopBids,
  createBidWithBalanceDeduction,
  addToBidWithBalanceDeduction,
} from "../services/bids.js";
import { handleTop3Bid } from "../services/auction-lifecycle.js";
import { Round } from "../storage/mongo.js";
import { broadcastAuctionUpdate } from "../services/websocket.js";
import { startBotsForAuction, stopBotsForAuction } from "../services/bots.js";
import {
  getDeliveriesByUser,
  getDeliveriesByAuction,
  getDeliveriesByRound,
  getDeliveryById,
  getDeliveryStats,
} from "../services/deliveries.js";

const auctionStatuses = new Set(["DRAFT", "RELEASED", "LIVE", "FINISHED", "DELETED"]);

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
  const generalLimiter = createRateLimiter(redis);
  const strictLimiter = createStrictRateLimiter(redis);
  const bidLimiter = createBidRateLimiter(redis);

  app.get("/api/health", async (_req, res) => {
    const mongoOk = mongoose.connection.readyState === 1;
    const redisOk = redis.isOpen;
    res.json({ ok: mongoOk && redisOk, mongoOk, redisOk });
  });

  app.get("/api/auctions", generalLimiter, async (req, res) => {
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

  app.get("/api/auctions/:id", generalLimiter, async (req, res) => {
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

  app.post("/api/auctions", strictLimiter, async (req, res) => {
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

    const winnersPerRound = Math.round(winnersCountTotal / roundsCount);
    
    const auction = await createAuction({
      name,
      creator_id: creatorId!,
      item_name: itemName,
      min_bid: minBid,
      winners_count_total: winnersCountTotal,
      rounds_count: roundsCount,
      winners_per_round: winnersPerRound,
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

  app.put("/api/auctions/:id", strictLimiter, async (req, res) => {
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
    if ("winners_count_total" in body || "rounds_count" in body) {
      
      const newWinnersTotal = "winners_count_total" in body 
        ? Number(body.winners_count_total) 
        : existingAuction.winners_count_total;
      const newRoundsCount = "rounds_count" in body 
        ? Number(body.rounds_count) 
        : existingAuction.rounds_count;
      
      if (Number.isFinite(newWinnersTotal) && Number.isFinite(newRoundsCount) && newRoundsCount > 0) {
        if ("winners_count_total" in body) {
          updates.winners_count_total = newWinnersTotal;
        }
        if ("rounds_count" in body) {
          updates.rounds_count = newRoundsCount;
        }
        
        updates.winners_per_round = Math.round(newWinnersTotal / newRoundsCount);
      } else {
        if ("winners_count_total" in body && !Number.isFinite(newWinnersTotal)) {
          errors.push("winners_count_total");
        }
        if ("rounds_count" in body && !Number.isFinite(newRoundsCount)) {
          errors.push("rounds_count");
        }
      }
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
      if (Number.isFinite(value) && value >= 0) {
        updates.remaining_items_count = value;
      } else {
        errors.push("remaining_items_count must be a non-negative number");
      }
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

  app.post("/api/auctions/:id/bids", bidLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const userHeader = req.get("X-User-Id");
    const userId = userHeader ? parseTgId(userHeader) : null;
    if (!userId) {
      res.status(400).json({ error: "X-User-Id header is required" });
      return;
    }

    const user = await requireUserByTgId(userId, res);
    if (!user) return;

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    if (auction.status !== "LIVE") {
      res.status(409).json({ error: "auction is not live" });
      return;
    }

    const body = req.body ?? {};
    const amount = Number(body.amount);
    const { getMinBidForRound } = await import("../services/bids.js");
    const minBidForRound = await getMinBidForRound(id, auction.current_round_idx);
    const idempotencyKey = String(body.idempotency_key ?? "").trim();
    const isAddToExisting = Boolean(body.add_to_existing);

    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be positive" });
      return;
    }

    // Ставки должны быть целыми числами
    if (!Number.isInteger(amount)) {
      res.status(400).json({ error: "amount must be an integer (no decimal places)" });
      return;
    }

    if (!idempotencyKey) {
      res.status(400).json({ error: "idempotency_key is required" });
      return;
    }
    
    if (user.balance < amount) {
      res.status(409).json({ error: "insufficient balance" });
      return;
    }

    const currentRound = await Round.findOne({
      auction_id: id,
      idx: auction.current_round_idx,
    }).lean();

    if (!currentRound) {
      res.status(404).json({ error: "round not found" });
      return;
    }

    const roundId = currentRound._id.toString();
    const now = Date.now();
    const roundEndTime = currentRound.extended_until
      ? currentRound.extended_until.getTime()
      : currentRound.ended_at.getTime();
    
    if (now >= roundEndTime) {
      res.status(409).json({ error: "round has ended" });
      return;
    }

    try {
      const existingBid = await getUserBid(id, roundId, user._id.toString());
      if (existingBid) {
        const userPlace = await getUserPlace(id, roundId, user._id.toString());
        const winnersPerRound = Math.floor(auction.winners_per_round);
        const isFirstRound = auction.current_round_idx === 0;
        const isTop3 = userPlace !== null && userPlace <= 3;
        const canUpdateInFirstRound = isFirstRound && isTop3;
        
        if (userPlace !== null && userPlace <= winnersPerRound && !canUpdateInFirstRound) {
          res.status(409).json({ 
            error: "cannot update bid: you are already in the winning top",
            place: userPlace,
            winners_per_round: winnersPerRound
          });
          return;
        }
      }
      
      let bid;
      let isBidUpdate = false;
      if (isAddToExisting) {
        if (!existingBid) {
          res.status(404).json({ error: "no existing bid to add to" });
          return;
        }
        
        const totalAmount = existingBid.amount + amount;
        if (totalAmount < minBidForRound) {
          res.status(400).json({ 
            error: `total bid amount (${existingBid.amount.toFixed(2)} + ${amount.toFixed(2)} = ${totalAmount.toFixed(2)}) must be at least ${minBidForRound} (min bid for round ${auction.current_round_idx + 1})` 
          });
          return;
        }
        
        const userPlaceBefore = await getUserPlace(id, roundId, user._id.toString());
        if (userPlaceBefore === 1) {
          res.status(409).json({ 
            error: "cannot add to bid: you are already in first place",
            place: userPlaceBefore
          });
          return;
        }
        
        bid = await addToBidWithBalanceDeduction(
          id,
          roundId,
          user._id.toString(),
          userId,
          amount,
          idempotencyKey
        );
        isBidUpdate = true;
      } else {
        if (existingBid) {
          // При добавлении к существующей ставке проверяем, что итоговая сумма >= minBidForRound
          const totalAmount = existingBid.amount + amount;
          if (totalAmount < minBidForRound) {
            res.status(400).json({ 
              error: `total bid amount (${existingBid.amount.toFixed(2)} + ${amount.toFixed(2)} = ${totalAmount.toFixed(2)}) must be at least ${minBidForRound} (min bid for round ${auction.current_round_idx + 1})` 
            });
            return;
          }
          
          // Проверяем, не является ли пользователь топ-1
          const userPlaceBefore = await getUserPlace(id, roundId, user._id.toString());
          if (userPlaceBefore === 1) {
            res.status(409).json({ 
              error: "cannot add to bid: you are already in first place",
              place: userPlaceBefore
            });
            return;
          }
          
          bid = await addToBidWithBalanceDeduction(
            id,
            roundId,
            user._id.toString(),
            userId,
            amount,
            idempotencyKey
          );
          isBidUpdate = true;
        } else {
          // Для новой ставки проверяем, что сумма >= minBidForRound
          if (amount < minBidForRound) {
            res.status(400).json({ error: `amount must be at least ${minBidForRound} (min bid for round ${auction.current_round_idx + 1})` });
            return;
          }
          
          bid = await createBidWithBalanceDeduction({
            auction_id: id,
            round_id: roundId,
            user_id: user._id.toString(),
            amount,
            idempotency_key: idempotencyKey,
          }, userId, amount);
          isBidUpdate = false; 
        }
      }
      
      if (auction.current_round_idx === 0 && isBidUpdate) {
        const userPlace = await getUserPlace(id, roundId, user._id.toString());
        const isTop3 = userPlace !== null && userPlace <= 3;
        if (isTop3) {
          await handleTop3Bid(id, roundId, user._id.toString(), true);
        }
      }

      const place = await getUserPlace(id, roundId, user._id.toString());
      
      await broadcastAuctionUpdate(id);

      res.json({
        bid,
        place,
        remaining_balance: (await getUserByTgId(userId))?.balance ?? 0,
      });
    } catch (error: any) {
      console.error("Error creating bid:", error);
      res.status(500).json({ error: error.message || "internal server error" });
    }
  });

  app.get("/api/auctions/:id/rounds/:roundIdx/bids", generalLimiter, async (req, res) => {
    const { id, roundIdx } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const roundIdxNum = Number(roundIdx);
    if (!Number.isFinite(roundIdxNum) || roundIdxNum < 0) {
      res.status(400).json({ error: "invalid round index" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    const round = await Round.findOne({
      auction_id: id,
      idx: roundIdxNum,
    }).lean();

    if (!round) {
      res.status(404).json({ error: "round not found" });
      return;
    }

    const topBids = await getTopBids(id, round._id.toString(), 10);
    res.json(topBids);
  });

  app.get("/api/auctions/:id/my-bid", generalLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const userHeader = req.get("X-User-Id");
    const userId = userHeader ? parseTgId(userHeader) : null;
    if (!userId) {
      res.status(400).json({ error: "X-User-Id header is required" });
      return;
    }

    const user = await requireUserByTgId(userId, res);
    if (!user) return;

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    const currentRound = await Round.findOne({
      auction_id: id,
      idx: auction.current_round_idx,
    }).lean();

    if (!currentRound) {
      res.status(404).json({ error: "round not found" });
      return;
    }

    const bid = await getUserBid(id, currentRound._id.toString(), user._id.toString());
    const place = bid ? await getUserPlace(id, currentRound._id.toString(), user._id.toString()) : null;

    res.json({ bid, place });
  });

  app.get("/api/deliveries", generalLimiter, async (req, res) => {
    const userHeader = req.get("X-User-Id");
    const userId = userHeader ? parseTgId(userHeader) : null;
    
    if (!userId) {
      res.status(400).json({ error: "X-User-Id header is required" });
      return;
    }

    const user = await requireUserByTgId(userId, res);
    if (!user) return;

    const deliveries = await getDeliveriesByUser(user._id.toString());
    res.json(deliveries);
  });

  app.get("/api/deliveries/:id", generalLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const delivery = await getDeliveryById(id);
    if (!delivery) {
      res.status(404).json({ error: "not found" });
      return;
    }

    res.json(delivery);
  });

  app.get("/api/auctions/:id/deliveries", generalLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    const deliveries = await getDeliveriesByAuction(id);
    res.json(deliveries);
  });

  app.get("/api/auctions/:id/deliveries/stats", generalLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    const stats = await getDeliveryStats(id);
    res.json(stats);
  });

  app.get("/api/auctions/:id/rounds/:roundIdx/deliveries", generalLimiter, async (req, res) => {
    const { id, roundIdx } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const roundIdxNum = Number(roundIdx);
    if (!Number.isFinite(roundIdxNum) || roundIdxNum < 0) {
      res.status(400).json({ error: "invalid round index" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    const round = await Round.findOne({
      auction_id: id,
      idx: roundIdxNum,
    }).lean();

    if (!round) {
      res.status(404).json({ error: "round not found" });
      return;
    }

    const deliveries = await getDeliveriesByRound(id, round._id.toString());
    res.json(deliveries);
  });

  app.post("/api/auctions/:id/bots/stop", strictLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    stopBotsForAuction(id);
    res.json({ message: "Bots stopped for auction", auction_id: id });
  });

  app.post("/api/auctions/:id/bots/start", strictLimiter, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "invalid auction id" });
      return;
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      res.status(404).json({ error: "auction not found" });
      return;
    }

    if (auction.status !== "LIVE") {
      res.status(409).json({ error: "auction must be LIVE to start bots" });
      return;
    }

    await startBotsForAuction(id);
    res.json({ message: "Bots started for auction", auction_id: id });
  });
}
