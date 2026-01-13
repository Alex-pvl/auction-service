import type { RedisClientType } from "redis";

let redisClient: RedisClientType<any, any, any> | null = null;

export function setRedisClient(client: RedisClientType<any, any, any>) {
  redisClient = client;
}

export async function getCachedTopBids(
  auctionId: string,
  roundId: string,
  limit: number
): Promise<any[] | null> {
  if (!redisClient) return null;
  
  try {
    const key = `top_bids:${auctionId}:${roundId}:${limit}`;
    const cached = await redisClient.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error("Error getting cached top bids:", error);
  }
  return null;
}

export async function setCachedTopBids(
  auctionId: string,
  roundId: string,
  limit: number,
  bids: any[],
  ttl: number = 5
) {
  if (!redisClient) return;
  
  try {
    const key = `top_bids:${auctionId}:${roundId}:${limit}`;
    await redisClient.setEx(key, ttl, JSON.stringify(bids));
  } catch (error) {
    console.error("Error setting cached top bids:", error);
  }
}

export async function invalidateTopBidsCache(auctionId: string, roundId: string) {
  if (!redisClient) return;
  
  try {
    const pattern = `top_bids:${auctionId}:${roundId}:*`;
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (error) {
    console.error("Error invalidating top bids cache:", error);
  }
}

export async function getCachedAuction(auctionId: string): Promise<any | null> {
  if (!redisClient) return null;
  
  try {
    const key = `auction:${auctionId}`;
    const cached = await redisClient.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error("Error getting cached auction:", error);
  }
  return null;
}

export async function setCachedAuction(
  auctionId: string,
  auction: any,
  ttl: number = 30,
) {
  if (!redisClient) return;
  
  try {
    const key = `auction:${auctionId}`;
    await redisClient.setEx(key, ttl, JSON.stringify(auction));
  } catch (error) {
    console.error("Error setting cached auction:", error);
  }
}

export async function invalidateAuctionCache(auctionId: string) {
  if (!redisClient) return;
  
  try {
    const key = `auction:${auctionId}`;
    await redisClient.del(key);
  } catch (error) {
    console.error("Error invalidating auction cache:", error);
  }
}

export async function getCachedUserPlace(
  auctionId: string,
  roundId: string,
  userId: string,
): Promise<number | null> {
  if (!redisClient) return null;
  
  try {
    const key = `user_place:${auctionId}:${roundId}:${userId}`;
    const cached = await redisClient.get(key);
    if (cached) {
      return parseInt(cached, 10);
    }
  } catch (error) {
    console.error("Error getting cached user place:", error);
  }
  return null;
}

export async function setCachedUserPlace(
  auctionId: string,
  roundId: string,
  userId: string,
  place: number | null,
  ttl: number = 5,
) {
  if (!redisClient) return;
  
  try {
    const key = `user_place:${auctionId}:${roundId}:${userId}`;
    if (place === null) {
      await redisClient.del(key);
    } else {
      await redisClient.setEx(key, ttl, place.toString());
    }
  } catch (error) {
    console.error("Error setting cached user place:", error);
  }
}

export async function invalidateUserPlaceCache(auctionId: string, roundId: string, userId?: string) {
  if (!redisClient) return;
  
  try {
    if (userId) {
      const key = `user_place:${auctionId}:${roundId}:${userId}`;
      await redisClient.del(key);
    } else {
      const pattern = `user_place:${auctionId}:${roundId}:*`;
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    }
  } catch (error) {
    console.error("Error invalidating user place cache:", error);
  }
}

export async function getCachedMinBidForRound(
  auctionId: string,
  roundIdx: number,
): Promise<number | null> {
  if (!redisClient) return null;
  
  try {
    const key = `min_bid:${auctionId}:${roundIdx}`;
    const cached = await redisClient.get(key);
    if (cached) {
      return parseFloat(cached);
    }
  } catch (error) {
    console.error("Error getting cached min bid:", error);
  }
  return null;
}

export async function setCachedMinBidForRound(
  auctionId: string,
  roundIdx: number,
  minBid: number,
  ttl: number = 60,
) {
  if (!redisClient) return;
  
  try {
    const key = `min_bid:${auctionId}:${roundIdx}`;
    await redisClient.setEx(key, ttl, minBid.toString());
  } catch (error) {
    console.error("Error setting cached min bid:", error);
  }
}
