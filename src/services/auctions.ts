import { Auction } from "../storage/mongo.js";
import type { Auction as AuctionType, AutcionStatus } from "../models/types.js";
import {
  getCachedAuction,
  setCachedAuction,
  invalidateAuctionCache,
} from "./cache.js";
import { registerBotsForAuction } from "./bots.js";

export type AuctionCreateInput = Omit<AuctionType, "_id" | "created_at" | "updated_at">;
export type AuctionUpdateInput = Partial<Omit<AuctionType, "_id" | "created_at" | "updated_at">>;

export async function listAuctions(limit: number, status?: AutcionStatus) {
  const query = status ? { status } : {};
  return Auction.find(query).sort({ created_at: -1 }).limit(limit).lean();
}

export async function getAuctionById(id: string) {
  const cached = await getCachedAuction(id);
  if (cached !== null) {
    return cached;
  }
  
  const auction = await Auction.findById(id).lean();
  
  if (auction) {
    await setCachedAuction(id, auction);
  }
  
  return auction;
}

export async function createAuction(input: AuctionCreateInput) {
  return Auction.create(input);
}

export async function updateAuction(id: string, input: AuctionUpdateInput) {
  const auction = await Auction.findByIdAndUpdate(id, input, { new: true }).lean();
  if (auction) {
    await invalidateAuctionCache(id);
  }
  return auction;
}

export async function softDeleteAuction(id: string) {
  return Auction.findByIdAndUpdate(id, { status: "DELETED" }, { new: true }).lean();
}

export async function releaseAuction(id: string) {
  const auction = await Auction.findByIdAndUpdate(id, { status: "RELEASED" }, { new: true }).lean();
  if (auction) {
    await invalidateAuctionCache(id);
    
    try {
      const numBots = 5 * auction.winners_count_total;
      const bidsPerBot = 1;
      const bidAmountMin = auction.min_bid;
      const bidAmountMax = auction.min_bid * 10;
      const delayBetweenBidsMs = 100;
      
      await registerBotsForAuction({
        auctionId: id,
        numBots,
        bidsPerBot,
        bidAmountMin,
        bidAmountMax,
        delayBetweenBidsMs,
      });
      
      console.log(`Automatically registered ${numBots} bots for auction ${id}`);
    } catch (error: any) {
      console.error(`Error auto-registering bots for auction ${id}:`, error.message);
    }
  }
  return auction;
}
