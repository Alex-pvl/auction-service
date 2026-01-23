import type { RedisClientType } from "redis";
import { Bid, User, Round } from "../storage/mongo.js";
import { getAllBidsForRoundFromRedis, getUserBalanceFromRedis } from "./redis-bids.js";

let redisClient: RedisClientType<any, any, any> | null = null;
let syncInterval: NodeJS.Timeout | null = null;
const SYNC_INTERVAL_MS = 500;
const isShuttingDown = false;

export function setRedisClient(client: RedisClientType<any, any, any>) {
  redisClient = client;
}

export function startMongoSync() {
  if (syncInterval) {
    return;
  }

  console.log("Starting MongoDB sync service...");

  syncInterval = setInterval(async () => {
    if (isShuttingDown || !redisClient) {
      return;
    }

    try {
      await syncBidsToMongo();
      await syncUserBalancesToMongo();
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Error in MongoDB sync:", error);
      }
    }
  }, SYNC_INTERVAL_MS);
}

export function stopMongoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log("MongoDB sync service stopped");
  }
}

async function syncBidsToMongo() {
  if (!redisClient) {
    return;
  }

  try {
    const { Auction } = await import("../storage/mongo.js");
    const liveAuctions = await Auction.find({ status: "LIVE" }).lean();

    for (const auction of liveAuctions) {
      const round = await Round.findOne({
        auction_id: auction._id.toString(),
        idx: auction.current_round_idx,
      }).lean();

      if (!round) {
        continue;
      }

      const roundId = round._id.toString();
      const auctionId = auction._id.toString();

      const redisBids = await getAllBidsForRoundFromRedis(auctionId, roundId);

      if (redisBids.length === 0) {
        continue;
      }

      const mongoBids = await Bid.find({
        auction_id: auctionId,
        round_id: roundId,
      }).lean();

      const mongoBidsMap = new Map(
        mongoBids.map((bid) => [bid.user_id, bid])
      );

      const bulkOps: any[] = [];

      for (const redisBid of redisBids) {
        const existingBid = mongoBidsMap.get(redisBid.user_id);

        if (existingBid) {
          if (existingBid.amount !== redisBid.amount) {
            bulkOps.push({
              updateOne: {
                filter: { _id: existingBid._id },
                update: {
                  $set: {
                    amount: redisBid.amount,
                    updated_at: new Date(redisBid.updated_at || redisBid.created_at),
                  },
                },
              },
            });
          }
        } else {
          bulkOps.push({
            insertOne: {
              document: {
                auction_id: auctionId,
                round_id: roundId,
                user_id: redisBid.user_id,
                amount: redisBid.amount,
                place_id: 0,
                idempotency_key: redisBid.idempotency_key || `sync-${Date.now()}-${redisBid.user_id}`,
                is_top3_sniping_bid: redisBid.is_top3_sniping_bid || false,
                created_at: new Date(redisBid.created_at),
                updated_at: new Date(redisBid.updated_at || redisBid.created_at),
              },
            },
          });
        }
      }

      if (bulkOps.length > 0) {
        await Bid.bulkWrite(bulkOps, { ordered: false });
        
        await recalculatePlaces(auctionId, roundId);
        
        const { invalidateTopBidsCache } = await import("./cache.js");
        await invalidateTopBidsCache(auctionId, roundId);
        
        const { broadcastAuctionUpdate } = await import("./websocket.js");
        await broadcastAuctionUpdate(auctionId, false).catch(error => {
          console.error(`Error broadcasting update after sync for auction ${auctionId}:`, error);
        });
      }
    }
  } catch (error) {
    console.error("Error syncing bids to MongoDB:", error);
  }
}

async function recalculatePlaces(auctionId: string, roundId: string) {
  try {
    const bids = await Bid.find({ auction_id: auctionId, round_id: roundId })
      .sort({ amount: -1, created_at: 1 })
      .lean();

    if (bids.length === 0) {
      return;
    }

    const bulkOps = bids.map((bid, index) => ({
      updateOne: {
        filter: { _id: bid._id },
        update: { $set: { place_id: index + 1 } },
      },
    }));

    await Bid.bulkWrite(bulkOps, { ordered: false });
    
    const { invalidateTopBidsCache } = await import("./cache.js");
    await invalidateTopBidsCache(auctionId, roundId);
  } catch (error) {
    console.error("Error recalculating places:", error);
  }
}

async function syncUserBalancesToMongo() {
  if (!redisClient) {
    return;
  }

  try {
    const pattern = "user_balance:*";
    const keys = await redisClient.keys(pattern);

    if (keys.length === 0) {
      return;
    }

    const bulkOps: any[] = [];

    for (const key of keys) {
      const tgId = parseInt(key.split(":")[1], 10);
      if (isNaN(tgId)) {
        continue;
      }

      const redisBalance = await getUserBalanceFromRedis(tgId);
      
      const user = await User.findOne({ tg_id: tgId }).lean();
      
      if (user) {
        const balanceDiff = Math.abs(user.balance - redisBalance);
        if (balanceDiff > 0.01) {
          bulkOps.push({
            updateOne: {
              filter: { tg_id: tgId },
              update: { $set: { balance: redisBalance } },
            },
          });
        }
      }
    }

    if (bulkOps.length > 0) {
      await User.bulkWrite(bulkOps, { ordered: false });
    }
  } catch (error) {
    console.error("Error syncing user balances to MongoDB:", error);
  }
}

export async function initializeUserBalancesFromMongo() {
  if (!redisClient) {
    return;
  }

  try {
    console.log("Initializing user balances from MongoDB to Redis...");
    const users = await User.find({}).lean();
    
    for (const user of users) {
      await redisClient.set(`user_balance:${user.tg_id}`, user.balance.toString());
    }
    
    console.log(`Initialized ${users.length} user balances in Redis`);
  } catch (error) {
    console.error("Error initializing user balances:", error);
  }
}
