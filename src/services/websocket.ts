import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import mongoose from "mongoose";
import { Auction, Round } from "../storage/mongo.js";
import { getUserBid, getUserPlace, getTopBids } from "./bids.js";

interface AuctionSubscription {
  auctionId: string;
  userId?: string;
  ws: WebSocket;
}

const subscriptions = new Map<WebSocket, AuctionSubscription>();

export function createWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
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
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
        ws.send(JSON.stringify({ type: "error", message: "invalid message format" }));
      }
    });

    ws.on("close", () => {
      subscriptions.delete(ws);
      console.log("WebSocket client disconnected");
    });

    ws.on("error", (error: Error) => {
      console.error("WebSocket error:", error);
      subscriptions.delete(ws);
    });

    
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
  });
  
  setInterval(() => {
    broadcastAuctionUpdates();
  }, 1000);

  return wss;
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

async function broadcastAuctionUpdates() {
  const auctionIds = new Set<string>();
  
  for (const sub of subscriptions.values()) {
    auctionIds.add(sub.auctionId);
  }

  for (const auctionId of auctionIds) {
    if (!mongoose.Types.ObjectId.isValid(auctionId)) {
      continue;
    }
    const auction = await Auction.findById(auctionId).lean();
    if (!auction || auction.status !== "LIVE") continue;
    const subscribers = Array.from(subscriptions.values()).filter(
      (sub) => sub.auctionId === auctionId
    );
    for (const sub of subscribers) {
      if (sub.ws.readyState === WebSocket.OPEN) {
        await sendAuctionState(sub.ws, auctionId, sub.userId);
      } else {
        subscriptions.delete(sub.ws);
      }
    }
  }
}

export function broadcastAuctionUpdate(auctionId: string) {
  if (!mongoose.Types.ObjectId.isValid(auctionId)) {
    console.warn(`Invalid auction ID format: ${auctionId}`);
    return;
  }
  const subscribers = Array.from(subscriptions.values()).filter(
    (sub) => sub.auctionId === auctionId
  );
  for (const sub of subscribers) {
    if (sub.ws.readyState === WebSocket.OPEN) {
      sendAuctionState(sub.ws, auctionId, sub.userId);
    }
  }
}
