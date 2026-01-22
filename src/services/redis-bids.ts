import type { RedisClientType } from "redis";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let redisClient: RedisClientType<any, any, any> | null = null;
let createBidScript: string | null = null;
let addToBidScript: string | null = null;
let getUserPlaceScript: string | null = null;

export function setRedisClient(client: RedisClientType<any, any, any>) {
  redisClient = client;
  loadLuaScripts();
}

function loadLuaScripts() {
  try {
    createBidScript = readFileSync(
      join(__dirname, "..", "scripts", "create-bid.lua"),
      "utf-8"
    );
    addToBidScript = readFileSync(
      join(__dirname, "..", "scripts", "add-to-bid.lua"),
      "utf-8"
    );
    getUserPlaceScript = readFileSync(
      join(__dirname, "..", "scripts", "get-user-place.lua"),
      "utf-8"
    );
  } catch (error) {
    console.error("Error loading Lua scripts:", error);
    throw error;
  }
}

export interface CreateBidResult {
  success: boolean;
  balance_after: number;
  error_message: string;
  bid_data?: string;
  idempotency_data?: string;
}

export interface AddToBidResult {
  success: boolean;
  balance_after: number;
  new_amount: number;
  error_message: string;
  bid_data?: string;
}

export async function createBidAtomically(
  tgId: number,
  amount: number,
  idempotencyKey: string,
  auctionId: string,
  roundId: string,
  userId: string
): Promise<CreateBidResult> {
  if (!redisClient || !createBidScript) {
    throw new Error("Redis client or Lua script not initialized");
  }

  const timestamp = Date.now();
  const keys = [
    `user_balance:${tgId}`,
    `bid:${auctionId}:${roundId}:${userId}`,
    `idempotency:${idempotencyKey}`,
    `round_bids:${auctionId}:${roundId}`,
  ];

  const args = [
    tgId.toString(),
    amount.toString(),
    idempotencyKey,
    auctionId,
    roundId,
    userId,
    timestamp.toString(),
  ];

  try {
    const result = await redisClient.eval(createBidScript, {
      keys,
      arguments: args,
    }) as [number, number, string, string?, string?];

    return {
      success: result[0] === 1,
      balance_after: result[1],
      error_message: result[2],
      bid_data: result[4],
      idempotency_data: result[3],
    };
  } catch (error: any) {
    console.error("Error executing createBid Lua script:", error);
    throw error;
  }
}

export async function addToBidAtomically(
  tgId: number,
  additionalAmount: number,
  idempotencyKey: string,
  auctionId: string,
  roundId: string,
  userId: string
): Promise<AddToBidResult> {
  if (!redisClient || !addToBidScript) {
    throw new Error("Redis client or Lua script not initialized");
  }

  const timestamp = Date.now();
  const keys = [
    `user_balance:${tgId}`,
    `bid:${auctionId}:${roundId}:${userId}`,
    `idempotency:${idempotencyKey}`,
    `round_bids:${auctionId}:${roundId}`,
  ];

  const args = [
    tgId.toString(),
    additionalAmount.toString(),
    idempotencyKey,
    auctionId,
    roundId,
    userId,
    timestamp.toString(),
  ];

  try {
    const result = await redisClient.eval(addToBidScript, {
      keys,
      arguments: args,
    }) as [number, number, number, string, string?];

    return {
      success: result[0] === 1,
      balance_after: result[1],
      new_amount: result[2],
      error_message: result[3],
      bid_data: result[4],
    };
  } catch (error: any) {
    console.error("Error executing addToBid Lua script:", error);
    throw error;
  }
}

export async function getUserPlaceFromRedis(
  auctionId: string,
  roundId: string,
  userId: string
): Promise<number | null> {
  if (!redisClient || !getUserPlaceScript) {
    return null;
  }

  try {
    const keys = [`round_bids:${auctionId}:${roundId}`];
    const args = [userId];

    const result = await redisClient.eval(getUserPlaceScript, {
      keys,
      arguments: args,
    }) as number;

    return result > 0 ? result : null;
  } catch (error) {
    console.error("Error getting user place from Redis:", error);
    return null;
  }
}

export async function getTopBidsFromRedis(
  auctionId: string,
  roundId: string,
  limit: number
): Promise<Array<{ user_id: string; amount: number }>> {
  if (!redisClient) {
    return [];
  }

  try {
    const key = `round_bids:${auctionId}:${roundId}`;
    const userIds = await redisClient.zRange(key, 0, limit - 1);

    const results: Array<{ user_id: string; amount: number }> = [];

    for (const userId of userIds) {
      const bidKey = `bid:${auctionId}:${roundId}:${userId}`;
      const bidData = await redisClient.get(bidKey);
      if (bidData) {
        try {
          const bid = JSON.parse(bidData);
          results.push({
            user_id: userId,
            amount: bid.amount,
          });
        } catch (e) {
          console.error(`Error parsing bid data for user ${userId}:`, e);
        }
      }
    }

    return results;
  } catch (error) {
    console.error("Error getting top bids from Redis:", error);
    return [];
  }
}

export async function getUserBidFromRedis(
  auctionId: string,
  roundId: string,
  userId: string
): Promise<any | null> {
  if (!redisClient) {
    return null;
  }

  try {
    const key = `bid:${auctionId}:${roundId}:${userId}`;
    const bidData = await redisClient.get(key);
    if (bidData) {
      return JSON.parse(bidData);
    }
    return null;
  } catch (error) {
    console.error("Error getting user bid from Redis:", error);
    return null;
  }
}

export async function getUserBalanceFromRedis(tgId: number): Promise<number> {
  if (!redisClient) {
    return 0;
  }

  try {
    const key = `user_balance:${tgId}`;
    const balance = await redisClient.get(key);
    return balance ? parseFloat(balance) : 0;
  } catch (error) {
    console.error("Error getting user balance from Redis:", error);
    return 0;
  }
}

export async function setUserBalanceInRedis(tgId: number, balance: number): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    const key = `user_balance:${tgId}`;
    await redisClient.set(key, balance.toString());
  } catch (error) {
    console.error("Error setting user balance in Redis:", error);
  }
}

export async function adjustUserBalanceInRedis(tgId: number, delta: number): Promise<number> {
  if (!redisClient) {
    return 0;
  }

  try {
    const key = `user_balance:${tgId}`;
    const newBalance = await redisClient.incrByFloat(key, delta);
    return typeof newBalance === 'string' ? parseFloat(newBalance) : newBalance;
  } catch (error) {
    console.error("Error adjusting user balance in Redis:", error);
    throw error;
  }
}

export async function getAllBidsForRoundFromRedis(
  auctionId: string,
  roundId: string
): Promise<Array<any>> {
  if (!redisClient) {
    return [];
  }

  try {
    const key = `round_bids:${auctionId}:${roundId}`;
    const userIds = await redisClient.zRange(key, 0, -1);

    const bids: any[] = [];

    for (const userId of userIds) {
      const bidKey = `bid:${auctionId}:${roundId}:${userId}`;
      const bidData = await redisClient.get(bidKey);
      if (bidData) {
        try {
          const bid = JSON.parse(bidData);
          bids.push(bid);
        } catch (e) {
          console.error(`Error parsing bid data for user ${userId}:`, e);
        }
      }
    }

    return bids;
  } catch (error) {
    console.error("Error getting all bids for round from Redis:", error);
    return [];
  }
}
