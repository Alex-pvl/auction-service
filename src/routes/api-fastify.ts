import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { registerRateLimiters } from "../middleware/rateLimit.js";
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
  getUserBidRedis,
  getUserPlaceRedis,
  getTopBidsRedis,
} from "../services/bids-redis.js";
import { getTopBids, getUserBid, getUserPlace } from "../services/bids.js";
import { Round } from "../storage/mongo.js";
import {
  getDeliveriesByUser,
  getDeliveriesByAuction,
  getDeliveriesByRound,
  getDeliveryById,
  getDeliveryStats,
  getUserWonItemsWithNumbers,
} from "../services/deliveries.js";
import {
  registerBotsForAuction,
  stopBotsForAuction,
  getBotsForAuction,
} from "../services/bots.js";

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

export async function registerApiRoutes(fastify: FastifyInstance) {
  await registerRateLimiters(fastify);

  fastify.get<{ Querystring: { limit?: string; status?: string } }>("/api/auctions", async (request, reply) => {
    const query = request.query || {};
    const limitRaw = Number(query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const status = query.status ? String(query.status).toUpperCase() : undefined;
    if (status && !auctionStatuses.has(status)) {
      return reply.code(400).send({ error: "invalid status" });
    }

    const auctions = await listAuctions(limit, status as any);
    return reply.send(auctions);
  });

  fastify.get("/api/auctions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid id" });
    }

    const auction = await getAuctionById(id);
    if (!auction || auction.status === "DELETED") {
      return reply.code(404).send({ error: "not found" });
    }

    const userId = request.headers["x-user-id"]
      ? parseTgId(request.headers["x-user-id"])
      : null;

    if (auction.status === "DRAFT" && userId) {
      const user = await getUserByTgId(userId);
      if (!user) {
        return reply.code(404).send({ error: "user not found" });
      }
      if (user.tg_id !== auction.creator_id) {
        return reply.code(403).send({ error: "creator_id mismatch" });
      }
    }

    const response: any = { ...auction };

    if (userId) {
      const user = await getUserByTgId(userId);
      if (user) {
        const wonItems = await getUserWonItemsWithNumbers(user._id.toString(), id);
        response.user_won_items = wonItems.map(
          (item) => `${item.item_name} #${item.item_no} (${item.bid_amount.toFixed(2)})`
        );
      } else {
        response.user_won_items = [];
      }
    } else {
      response.user_won_items = [];
    }

    return reply.send(response);
  });

  fastify.post("/api/auctions", async (request, reply) => {
    const body = request.body as any ?? {};
    const errors: string[] = [];
    const creatorId = request.headers["x-user-id"]
      ? parseTgId(request.headers["x-user-id"])
      : null;

    const nameRaw = body.name;
    const name =
      nameRaw === undefined || nameRaw === null ? null : String(nameRaw).trim() || null;
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
      return reply.code(400).send({ error: "invalid fields", fields: errors });
    }

    const firstRoundDuration = firstRoundDurationMs ?? roundDurationMs;
    const totalDurationMs =
      firstRoundDuration + Math.max(roundsCount - 1, 0) * roundDurationMs;
    const plannedEndDateTime = new Date(startDateTime.getTime() + totalDurationMs);

    const creatorUser = await getUserByTgId(creatorId!);
    if (!creatorUser) {
      return reply.code(404).send({ error: "user not found" });
    }

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

    return reply.code(201).send(auction);
  });

  fastify.put("/api/auctions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid id" });
    }

    const creatorId = request.headers["x-user-id"]
      ? parseTgId(request.headers["x-user-id"])
      : null;
    if (!creatorId) {
      return reply.code(400).send({ error: "user_id header is required" });
    }

    const creatorUser = await getUserByTgId(creatorId);
    if (!creatorUser) {
      return reply.code(404).send({ error: "user not found" });
    }

    const existingAuction = await getAuctionById(id);
    if (!existingAuction) {
      return reply.code(404).send({ error: "not found" });
    }
    if (existingAuction.status !== "DRAFT") {
      return reply.code(409).send({ error: "only DRAFT auctions can be updated" });
    }
    if (existingAuction.creator_id !== creatorId) {
      return reply.code(403).send({ error: "creator_id mismatch" });
    }

    const body = request.body as any ?? {};
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
      return reply.code(400).send({ error: "unsupported fields", fields: extraFields });
    }

    if ("name" in body) {
      const nameRaw = body.name;
      updates.name =
        nameRaw === undefined || nameRaw === null ? null : String(nameRaw).trim() || null;
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
      const newWinnersTotal =
        "winners_count_total" in body
          ? Number(body.winners_count_total)
          : existingAuction.winners_count_total;
      const newRoundsCount =
        "rounds_count" in body ? Number(body.rounds_count) : existingAuction.rounds_count;

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
    if ("start_datetime" in body) {
      const value = toDate(body.start_datetime);
      if (!isValidDate(value) || value.getTime() < Date.now()) {
        errors.push("start_datetime");
      }
    }

    if (errors.length) {
      return reply.code(400).send({ error: "invalid fields", fields: errors });
    }
    if (!Object.keys(updates).length) {
      return reply.code(400).send({ error: "no fields to update" });
    }

    const auction = await updateAuction(id, updates);
    if (!auction) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.send(auction);
  });

  fastify.delete("/api/auctions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid id" });
    }

    const existingAuction = await getAuctionById(id);
    if (!existingAuction) {
      return reply.code(404).send({ error: "not found" });
    }
    if (existingAuction.status !== "DRAFT") {
      return reply.code(409).send({ error: "only DRAFT auctions can be deleted" });
    }

    const auction = await softDeleteAuction(id);
    if (!auction) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.send(auction);
  });

  fastify.post<{ Params: { id: string } }>("/api/auctions/:id/release", {
    schema: {
      body: false,
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid id" });
    }

    const creatorId = request.headers["x-user-id"]
      ? parseTgId(request.headers["x-user-id"])
      : null;
    if (!creatorId) {
      return reply.code(400).send({ error: "user_id header is required" });
    }

    const creatorUser = await getUserByTgId(creatorId);
    if (!creatorUser) {
      return reply.code(404).send({ error: "user not found" });
    }

    const existingAuction = await getAuctionById(id);
    if (!existingAuction) {
      return reply.code(404).send({ error: "not found" });
    }
    if (existingAuction.creator_id !== creatorId) {
      return reply.code(403).send({ error: "creator_id mismatch" });
    }
    if (existingAuction.status !== "DRAFT") {
      return reply.code(409).send({ error: "only DRAFT auctions can be released" });
    }

    const auction = await releaseAuction(id);
    if (!auction) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.send(auction);
  });

  fastify.post("/api/users/auth", async (request, reply) => {
    const body = request.body as any;
    const tgId = parseTgId(body?.tg_id);
    if (!tgId) {
      return reply.code(400).send({ error: "tg_id is required" });
    }

    const user = await ensureUserByTgId(tgId);
    return reply.send(user);
  });

  fastify.post("/api/users/:tgId/balance/increase", async (request, reply) => {
    const { tgId } = request.params as { tgId: string };
    const tgIdNum = parseTgId(tgId);
    if (!tgIdNum) {
      return reply.code(400).send({ error: "invalid tg_id" });
    }

    const body = request.body as any;
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "amount must be positive" });
    }

    const user = await getUserByTgId(tgIdNum);
    if (!user) {
      return reply.code(404).send({ error: "not found" });
    }

    const updated = await adjustUserBalanceByTgId(tgIdNum, amount);
    return reply.send(updated);
  });

  fastify.post("/api/users/:tgId/balance/decrease", async (request, reply) => {
    const { tgId } = request.params as { tgId: string };
    const tgIdNum = parseTgId(tgId);
    if (!tgIdNum) {
      return reply.code(400).send({ error: "invalid tg_id" });
    }

    const body = request.body as any;
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "amount must be positive" });
    }

    const user = await getUserByTgId(tgIdNum);
    if (!user) {
      return reply.code(404).send({ error: "not found" });
    }
    if (user.balance < amount) {
      return reply.code(409).send({ error: "insufficient balance" });
    }

    const updated = await adjustUserBalanceByTgId(tgIdNum, -amount);
    return reply.send(updated);
  });

  fastify.get("/api/auctions/:id/rounds/:roundIdx/bids", async (request, reply) => {
    const { id, roundIdx } = request.params as { id: string; roundIdx: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const roundIdxNum = Number(roundIdx);
    if (!Number.isFinite(roundIdxNum) || roundIdxNum < 0) {
      return reply.code(400).send({ error: "invalid round index" });
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      return reply.code(404).send({ error: "auction not found" });
    }

    const round = await Round.findOne({
      auction_id: id,
      idx: roundIdxNum,
    }).lean();

    if (!round) {
      return reply.code(404).send({ error: "round not found" });
    }

    let topBids;
    try {
      topBids = await getTopBidsRedis(id, round._id.toString(), 10);
      if (topBids.length === 0) {
        topBids = await getTopBids(id, round._id.toString(), 10);
      }
    } catch (e) {
      topBids = await getTopBids(id, round._id.toString(), 10);
    }

    return reply.send(topBids);
  });

  fastify.get("/api/auctions/:id/my-bid", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const userId = request.headers["x-user-id"]
      ? parseTgId(request.headers["x-user-id"])
      : null;
    if (!userId) {
      return reply.code(400).send({ error: "X-User-Id header is required" });
    }

    const user = await getUserByTgId(userId);
    if (!user) {
      return reply.code(404).send({ error: "user not found" });
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      return reply.code(404).send({ error: "auction not found" });
    }

    const currentRound = await Round.findOne({
      auction_id: id,
      idx: auction.current_round_idx,
    }).lean();

    if (!currentRound) {
      return reply.code(404).send({ error: "round not found" });
    }

    let bid, place;
    try {
      bid = await getUserBidRedis(id, currentRound._id.toString(), user._id.toString());
      place = bid ? await getUserPlaceRedis(id, currentRound._id.toString(), user._id.toString()) : null;
      if (!bid) {
        bid = await getUserBid(id, currentRound._id.toString(), user._id.toString());
        place = bid ? await getUserPlace(id, currentRound._id.toString(), user._id.toString()) : null;
      }
    } catch (e) {
      bid = await getUserBid(id, currentRound._id.toString(), user._id.toString());
      place = bid ? await getUserPlace(id, currentRound._id.toString(), user._id.toString()) : null;
    }

    return reply.send({ bid, place });
  });

  fastify.get("/api/deliveries", async (request, reply) => {
    const userId = request.headers["x-user-id"]
      ? parseTgId(request.headers["x-user-id"])
      : null;

    if (!userId) {
      return reply.code(400).send({ error: "X-User-Id header is required" });
    }

    const user = await getUserByTgId(userId);
    if (!user) {
      return reply.code(404).send({ error: "user not found" });
    }

    const deliveries = await getDeliveriesByUser(user._id.toString());
    return reply.send(deliveries);
  });

  fastify.get("/api/deliveries/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid id" });
    }

    const delivery = await getDeliveryById(id);
    if (!delivery) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.send(delivery);
  });

  fastify.get("/api/auctions/:id/deliveries", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      return reply.code(404).send({ error: "auction not found" });
    }

    const deliveries = await getDeliveriesByAuction(id);
    return reply.send(deliveries);
  });

  fastify.get("/api/auctions/:id/deliveries/stats", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      return reply.code(404).send({ error: "auction not found" });
    }

    const stats = await getDeliveryStats(id);
    return reply.send(stats);
  });

  fastify.get("/api/auctions/:id/rounds/:roundIdx/deliveries", async (request, reply) => {
    const { id, roundIdx } = request.params as { id: string; roundIdx: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const roundIdxNum = Number(roundIdx);
    if (!Number.isFinite(roundIdxNum) || roundIdxNum < 0) {
      return reply.code(400).send({ error: "invalid round index" });
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      return reply.code(404).send({ error: "auction not found" });
    }

    const round = await Round.findOne({
      auction_id: id,
      idx: roundIdxNum,
    }).lean();

    if (!round) {
      return reply.code(404).send({ error: "round not found" });
    }

    const deliveries = await getDeliveriesByRound(id, round._id.toString());
    return reply.send(deliveries);
  });

  fastify.post("/api/auctions/:id/bots/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const auction = await getAuctionById(id);
    if (!auction) {
      return reply.code(404).send({ error: "auction not found" });
    }

    if (auction.status !== "RELEASED" && auction.status !== "LIVE") {
      return reply.code(409).send({
        error: "bots can only be registered for RELEASED or LIVE auctions",
      });
    }

    const body = request.body as any ?? {};
    const numBots = Number(body.num_bots ?? 10);
    const bidsPerBot = Number(body.bids_per_bot ?? 1);
    const bidAmountMin = Number(body.bid_amount_min ?? auction.min_bid);
    const bidAmountMax = Number(body.bid_amount_max ?? auction.min_bid * 10);
    const delayBetweenBidsMs = Number(body.delay_between_bids_ms ?? 100);
    const startTgId = body.start_tg_id ? Number(body.start_tg_id) : undefined;

    if (!Number.isFinite(numBots) || numBots < 1 || numBots > 1000) {
      return reply.code(400).send({
        error: "num_bots must be between 1 and 1000",
      });
    }

    if (!Number.isFinite(bidsPerBot) || bidsPerBot < 1 || bidsPerBot > 100) {
      return reply.code(400).send({
        error: "bids_per_bot must be between 1 and 100",
      });
    }

    if (!Number.isFinite(bidAmountMin) || bidAmountMin < auction.min_bid) {
      return reply.code(400).send({
        error: `bid_amount_min must be at least ${auction.min_bid}`,
      });
    }

    if (!Number.isFinite(bidAmountMax) || bidAmountMax < bidAmountMin) {
      return reply.code(400).send({
        error: "bid_amount_max must be greater than bid_amount_min",
      });
    }

    if (
      !Number.isFinite(delayBetweenBidsMs) ||
      delayBetweenBidsMs < 0 ||
      delayBetweenBidsMs > 10000
    ) {
      return reply.code(400).send({
        error: "delay_between_bids_ms must be between 0 and 10000",
      });
    }

    try {
      const result = await registerBotsForAuction({
        auctionId: id,
        numBots,
        bidsPerBot,
        bidAmountMin,
        bidAmountMax,
        delayBetweenBidsMs,
        startTgId,
      });

      return reply.send(result);
    } catch (error: any) {
      console.error("Error registering bots:", error);
      return reply.code(500).send({ error: error.message || "internal server error" });
    }
  });

  fastify.post("/api/auctions/:id/bots/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    try {
      const result = await stopBotsForAuction(id);
      return reply.send(result);
    } catch (error: any) {
      console.error("Error stopping bots:", error);
      return reply.code(500).send({ error: error.message || "internal server error" });
    }
  });

  fastify.get("/api/auctions/:id/bots", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send({ error: "invalid auction id" });
    }

    const botsInfo = getBotsForAuction(id);
    return reply.send(botsInfo);
  });
}
