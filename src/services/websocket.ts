import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import mongoose from "mongoose";
import { Auction, Round } from "../storage/mongo.js";
import { getUserBid, getUserPlace, getTopBids } from "./bids.js";
import { handleBidRequest } from "./bids-redis.js";
import { getUserByTgId } from "./users.js";
import { getAuctionById } from "./auctions.js";

interface AuctionSubscription {
  auctionId: string;
  userId?: string;
  ws: WebSocket;
}

const subscriptions = new Map<WebSocket, AuctionSubscription>();
const lastAuctionStates = new Map<string, {
  topBidsHash: string;
  bidsCount: number;
  roundEndTime: number;
  timeRemaining: number;
  lastUpdate: number;
}>();

const auctionsPendingUpdate = new Set<string>();

let wss: WebSocketServer | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;
let auctionUpdateInterval: NodeJS.Timeout | null = null;

export function createWebSocketServer(httpServer: Server) {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    console.log("WebSocket client connected");
    ws.on("message", async (message: string) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "subscribe") {
          const { auction_id, user_id } = data;
          if (!auction_id) {
            ws.send(JSON.stringify({ type: "error", message: "auction_id is required" }));
            return;
          }
          subscriptions.set(ws, {
            auctionId: auction_id,
            userId: user_id,
            ws,
          });
          await sendAuctionState(ws, auction_id, user_id);
        } else if (data.type === "unsubscribe") {
          subscriptions.delete(ws);
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (data.type === "bid") {
          await handleBidMessage(ws, data);
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
        ws.send(JSON.stringify({ type: "error", message: "invalid message format" }));
      }
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (error) {
          console.error("Error sending ping:", error);
          clearInterval(pingInterval);
          subscriptions.delete(ws);
        }
      } else {
        clearInterval(pingInterval);
      }
    }, 10000);

    ws.on("close", () => {
      clearInterval(pingInterval);
      subscriptions.delete(ws);
      console.log("WebSocket client disconnected");
    });

    ws.on("error", (error: Error) => {
      console.error("WebSocket error:", error);
      clearInterval(pingInterval);
      subscriptions.delete(ws);
    });

    ws.on("pong", () => {
    });
  });

  timeUpdateInterval = setInterval(() => {
    broadcastTimeUpdates();
  }, 100);

  auctionUpdateInterval = setInterval(() => {
    processPendingAuctionUpdates();
    broadcastAllActiveAuctions();
  }, 100);

  return wss;
}

async function processPendingAuctionUpdates() {
  if (auctionsPendingUpdate.size === 0) {
    return;
  }

  const auctionIds = Array.from(auctionsPendingUpdate);
  auctionsPendingUpdate.clear();

  for (const auctionId of auctionIds) {
    const hasSubscribers = Array.from(subscriptions.values()).some(
      (sub) => sub.auctionId === auctionId && sub.ws.readyState === WebSocket.OPEN
    );

    if (hasSubscribers) {
      await broadcastAuctionUpdate(auctionId).catch(error => {
        console.error(`Error processing pending update for auction ${auctionId}:`, error);
      });
    }
  }
}

export async function shutdownWebSocketServer(): Promise<void> {
  console.log("Shutting down WebSocket server...");
  
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
    timeUpdateInterval = null;
  }
  
  if (auctionUpdateInterval) {
    clearInterval(auctionUpdateInterval);
    auctionUpdateInterval = null;
  }
  
  const closePromises: Promise<void>[] = [];
  for (const [ws, sub] of subscriptions.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      closePromises.push(
        new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close(1001, "Server shutting down");
        })
      );
    }
  }
  
  await Promise.all(closePromises);
  subscriptions.clear();
  
  if (wss) {
    await new Promise<void>((resolve) => {
      wss!.close(() => {
        console.log("WebSocket server closed");
        resolve();
      });
    });
    wss = null;
  }
  
  lastAuctionStates.clear();
  auctionsPendingUpdate.clear();
  console.log("WebSocket server shutdown complete");
}

async function sendAuctionState(ws: WebSocket, auctionId: string, userId?: string) {
  try {
    if (!mongoose.Types.ObjectId.isValid(auctionId)) {
      ws.send(JSON.stringify({ type: "error", message: "invalid auction id format" }));
      return;
    }
    const auction = await Auction.findById(auctionId).lean();
    if (!auction) {
      ws.send(JSON.stringify({ type: "error", message: "auction not found" }));
      return;
    }

    if (auction.status === "RELEASED") {
      const now = Date.now();
      const startTime = auction.start_datetime.getTime();
      const timeUntilStart = Math.max(0, startTime - now);
      
      ws.send(JSON.stringify({
        type: "auction_state",
        auction: {
          id: auction._id.toString(),
          name: auction.name,
          item_name: auction.item_name,
          status: auction.status,
          current_round_idx: auction.current_round_idx,
          rounds_count: auction.rounds_count,
          remaining_items_count: auction.remaining_items_count,
          start_datetime: auction.start_datetime.toISOString(),
          time_until_start_ms: timeUntilStart,
        },
        round: null,
        top_bids: [],
        all_bids: [],
        user_bid: null,
        user_place: null,
      }));
      return;
    }

    const currentRound = await Round.findOne({
      auction_id: auctionId,
      idx: auction.current_round_idx,
    }).lean();

    if (!currentRound) {
      ws.send(JSON.stringify({
        type: "auction_state",
        auction: {
          id: auction._id.toString(),
          name: auction.name,
          item_name: auction.item_name,
          status: auction.status,
          current_round_idx: auction.current_round_idx,
          rounds_count: auction.rounds_count,
        },
        round: null,
        top_bids: [],
        all_bids: [],
        user_bid: null,
        user_place: null,
      }));
      return;
    }

    const roundId = currentRound._id.toString();
    const now = Date.now();
    const roundEndTime = currentRound.extended_until
      ? currentRound.extended_until.getTime()
      : currentRound.ended_at.getTime();
    const timeRemaining = Math.max(0, roundEndTime - now);

    const topBids = await getTopBids(auctionId, roundId, 10);
    const { getAllBidsInRound } = await import("./bids.js");
    const allBids = await getAllBidsInRound(auctionId, roundId);
    
    const { User } = await import("../storage/mongo.js");
    const uniqueUserIds = [...new Set([...topBids.map(b => b.user_id), ...allBids.map(b => b.user_id)])];
    const users = await User.find({ 
      _id: { $in: uniqueUserIds.map(id => new mongoose.Types.ObjectId(id)) } 
    }).select('_id tg_id').lean();
    
    const userIdToTgIdMap = new Map<string, number>();
    for (const user of users) {
      userIdToTgIdMap.set(user._id.toString(), user.tg_id);
    }
    
    let userBid = null;
    let userPlace = null;
    if (userId) {
      const user = await User.findOne({ tg_id: Number(userId) }).lean();
      if (user) {
        userBid = await getUserBid(auctionId, roundId, user._id.toString());
        userPlace = userBid ? await getUserPlace(auctionId, roundId, user._id.toString()) : null;
      }
    }

    const { getMinBidForRound } = await import("./bids.js");
    const minBidForRound = await getMinBidForRound(auctionId, auction.current_round_idx);
    
    ws.send(JSON.stringify({
      type: "auction_state",
      auction: {
        id: auction._id.toString(),
        name: auction.name,
        item_name: auction.item_name,
        status: auction.status,
        current_round_idx: auction.current_round_idx,
        rounds_count: auction.rounds_count,
        remaining_items_count: auction.remaining_items_count,
        min_bid: minBidForRound,
        base_min_bid: auction.min_bid,
      },
      round: {
        idx: currentRound.idx,
        started_at: currentRound.started_at.toISOString(),
        ended_at: currentRound.ended_at.toISOString(),
        extended_until: currentRound.extended_until?.toISOString() || null,
        time_remaining_ms: timeRemaining,
      },
      top_bids: topBids.map((bid) => ({
        user_id: userIdToTgIdMap.get(bid.user_id) || bid.user_id,
        amount: bid.amount,
        place_id: bid.place_id,
      })),
      all_bids: allBids.map((bid) => ({
        user_id: userIdToTgIdMap.get(bid.user_id) || bid.user_id,
        amount: bid.amount,
        place_id: bid.place_id,
      })),
      user_bid: userBid ? {
        amount: userBid.amount,
        place_id: userBid.place_id,
      } : null,
      user_place: userPlace,
    }));
  } catch (error) {
    console.error("Error sending auction state:", error);
    ws.send(JSON.stringify({ type: "error", message: "failed to get auction state" }));
  }
}

async function broadcastTimeUpdates() {
  const auctionIds = new Set<string>();
  
  for (const sub of subscriptions.values()) {
    auctionIds.add(sub.auctionId);
  }

  for (const auctionId of auctionIds) {
    if (!mongoose.Types.ObjectId.isValid(auctionId)) {
      continue;
    }
    const auction = await Auction.findById(auctionId).lean();
    if (!auction) continue;
    
    const now = Date.now();
    const subscribers = Array.from(subscriptions.values()).filter(
      (sub) => sub.auctionId === auctionId
    );
    
    if (auction.status === "RELEASED") {
      const startTime = auction.start_datetime.getTime();
      const timeUntilStart = Math.max(0, startTime - now);
      
      for (const sub of subscribers) {
        if (sub.ws.readyState === WebSocket.OPEN) {
          try {
            sub.ws.send(JSON.stringify({
              type: "time_update",
              auction_id: auctionId,
              time_until_start_ms: timeUntilStart,
            }));
          } catch (error) {
            console.error("Error sending time update:", error);
            try {
              sub.ws.close();
            } catch (closeError) {
            }
          }
        } else if (sub.ws.readyState === WebSocket.CLOSED || sub.ws.readyState === WebSocket.CLOSING) {
          subscriptions.delete(sub.ws);
        }
      }
      continue;
    }
    
    if (auction.status !== "LIVE") continue;
    
    const currentRound = await Round.findOne({
      auction_id: auctionId,
      idx: auction.current_round_idx,
    }).lean();

    if (!currentRound) continue;

    const roundEndTime = currentRound.extended_until
      ? currentRound.extended_until.getTime()
      : currentRound.ended_at.getTime();
    const timeRemaining = Math.max(0, roundEndTime - now);

    for (const sub of subscribers) {
      if (sub.ws.readyState === WebSocket.OPEN) {
        try {
          sub.ws.send(JSON.stringify({
            type: "time_update",
            auction_id: auctionId,
            round: {
              idx: currentRound.idx,
              time_remaining_ms: timeRemaining,
            },
          }));
        } catch (error) {
          console.error("Error sending time update:", error);
          try {
            sub.ws.close();
          } catch (closeError) {
          }
        }
      } else if (sub.ws.readyState === WebSocket.CLOSED || sub.ws.readyState === WebSocket.CLOSING) {
        subscriptions.delete(sub.ws);
      }
    }
  }
}

async function broadcastAllActiveAuctions() {
  const activeAuctionIds = new Set<string>();
  
  for (const sub of subscriptions.values()) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      activeAuctionIds.add(sub.auctionId);
    }
  }
  
  for (const auctionId of activeAuctionIds) {
    await broadcastAuctionUpdate(auctionId, false).catch(error => {
      console.error(`Error broadcasting active auction ${auctionId}:`, error);
    });
  }
}

export async function broadcastAuctionUpdate(auctionId: string, force: boolean = false) {
  if (!mongoose.Types.ObjectId.isValid(auctionId)) {
    console.warn(`Invalid auction ID format: ${auctionId}`);
    return;
  }
  
  const subscribers = Array.from(subscriptions.values()).filter(
    (sub) => sub.auctionId === auctionId && sub.ws.readyState === WebSocket.OPEN
  );
  
  if (subscribers.length === 0) {
    return;
  }

  const auction = await Auction.findById(auctionId).lean();
  if (!auction || (auction.status !== "LIVE" && auction.status !== "RELEASED")) {
    return;
  }

  const currentRound = await Round.findOne({
    auction_id: auctionId,
    idx: auction.current_round_idx,
  }).lean();

  if (!currentRound) {
    return;
  }

  const roundId = currentRound._id.toString();
  const { getTopBids, getAllBidsInRound } = await import("./bids.js");
  const topBids = await getTopBids(auctionId, roundId, 10);
  const allBids = await getAllBidsInRound(auctionId, roundId);
  
  const topBidsHash = JSON.stringify(topBids.map(b => ({ user_id: b.user_id, amount: b.amount, place_id: b.place_id })));
  const bidsCount = allBids.length;
  const lastState = lastAuctionStates.get(auctionId);
  const now = Date.now();
  
  if (!force && lastState) {
    const timeSinceLastUpdate = now - lastState.lastUpdate;
    const hasChanges = lastState.topBidsHash !== topBidsHash || lastState.bidsCount !== bidsCount;
    
    if (!hasChanges && timeSinceLastUpdate < 100) {
      return;
    }
  }

  const roundEndTime = currentRound.extended_until
    ? currentRound.extended_until.getTime()
    : currentRound.ended_at.getTime();
  const timeRemaining = Math.max(0, roundEndTime - now);
  
  lastAuctionStates.set(auctionId, {
    topBidsHash,
    bidsCount,
    roundEndTime,
    timeRemaining,
    lastUpdate: now,
  });

  const sendPromises = subscribers.map(sub => 
    sendAuctionState(sub.ws, auctionId, sub.userId).catch(error => {
      console.error("Error broadcasting to subscriber:", error);
      subscriptions.delete(sub.ws);
    })
  );
  
  await Promise.all(sendPromises);
}

async function handleBidMessage(ws: WebSocket, data: any) {
  try {
    const { auction_id, amount, idempotency_key, add_to_existing, user_id } = data;

    if (!auction_id) {
      ws.send(JSON.stringify({ type: "bid_error", error: "auction_id is required" }));
      return;
    }

    if (!user_id) {
      ws.send(JSON.stringify({ type: "bid_error", error: "user_id is required" }));
      return;
    }

    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      ws.send(JSON.stringify({ type: "bid_error", error: "amount must be positive" }));
      return;
    }

    if (!Number.isInteger(amount)) {
      ws.send(JSON.stringify({ type: "bid_error", error: "amount must be an integer (no decimal places)" }));
      return;
    }

    if (!idempotency_key || !String(idempotency_key).trim()) {
      ws.send(JSON.stringify({ type: "bid_error", error: "idempotency_key is required" }));
      return;
    }

    const userTgId = Number(user_id);
    const user = await getUserByTgId(userTgId);
    if (!user) {
      ws.send(JSON.stringify({ type: "bid_error", error: "user not found" }));
      return;
    }

    const auction = await getAuctionById(auction_id);
    if (!auction) {
      ws.send(JSON.stringify({ type: "bid_error", error: "auction not found" }));
      return;
    }

    const currentRound = await Round.findOne({
      auction_id: auction_id,
      idx: auction.current_round_idx,
    }).lean();

    if (!currentRound) {
      ws.send(JSON.stringify({ type: "bid_error", error: "round not found" }));
      return;
    }

    const roundId = currentRound._id.toString();

    try {
      const result = await handleBidRequest(
        auction_id,
        roundId,
        userTgId,
        user._id.toString(),
        amount,
        String(idempotency_key).trim(),
        Boolean(add_to_existing)
      );

      ws.send(JSON.stringify({
        type: "bid_success",
        bid: result.bid,
        place: result.place,
        remaining_balance: result.remaining_balance,
      }));
    } catch (error: any) {
      console.error("Error handling bid:", error);
      ws.send(JSON.stringify({
        type: "bid_error",
        error: error.message || "internal server error",
      }));
    }
  } catch (error: any) {
    console.error("Error processing bid message:", error);
    ws.send(JSON.stringify({
      type: "bid_error",
      error: error.message || "invalid bid message format",
    }));
  }
}
