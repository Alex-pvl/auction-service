import { Bid, Round, Auction, User } from "../storage/mongo.js";
import type { Bid as BidType } from "../models/types.js";
import mongoose from "mongoose";

export async function getMinBidForRound(auctionId: string, roundIdx: number): Promise<number> {
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) {
    throw new Error("Auction not found");
  }
  
  const baseMinBid = auction.min_bid;
  if (roundIdx === 0) {
    return baseMinBid;
  }
  const increasePercent = 0.05 * roundIdx;
  const minBidForRound = baseMinBid * (1 + increasePercent);
  return Math.round(minBidForRound * 100) / 100;
}

export type BidCreateInput = {
  auction_id: string;
  round_id: string;
  user_id: string;
  amount: number;
  idempotency_key: string;
  is_top3_sniping_bid?: boolean;
};

export async function createOrUpdateBid(input: BidCreateInput) {
  const existingBid = await Bid.findOne({
    auction_id: input.auction_id,
    round_id: input.round_id,
    idempotency_key: input.idempotency_key,
  }).lean();

  if (existingBid) {
    return existingBid;
  }

  const bid = await Bid.create({
    ...input,
    place_id: 999999, 
  });
  await recalculatePlaces(input.auction_id, input.round_id);
  const updatedBid = await Bid.findById(bid._id).lean();
  return updatedBid!;
}

export async function addToBid(
  auction_id: string,
  round_id: string,
  user_id: string,
  additional_amount: number,
  idempotency_key: string
) {
  const existingBid = await Bid.findOne({
    auction_id,
    round_id,
    user_id,
  }).lean();

  if (!existingBid) {
    throw new Error("Bid not found");
  }

  const existingUpdate = await Bid.findOne({
    auction_id,
    round_id,
    idempotency_key,
  }).lean();

  if (existingUpdate) {
    return existingUpdate;
  }

  const updatedBid = await Bid.findByIdAndUpdate(
    existingBid._id,
    {
      $inc: { amount: additional_amount },
      idempotency_key,
    },
    { new: true }
  ).lean();
  
  await recalculatePlaces(auction_id, round_id);
  const finalBid = await Bid.findById(existingBid._id).lean();
  return finalBid!;
}

export async function recalculatePlaces(auction_id: string, round_id: string) {
  const bids = await Bid.find({ auction_id, round_id })
    .sort({ amount: -1, created_at: 1 })
    .lean();

  const updatePromises = bids.map((bid, index) =>
    Bid.findByIdAndUpdate(bid._id, { place_id: index + 1 }, { new: true })
  );

  await Promise.all(updatePromises);
}

export async function getTopBids(auction_id: string, round_id: string, limit: number = 3) {
  return Bid.find({ auction_id, round_id })
    .sort({ amount: -1, created_at: 1 })
    .limit(limit)
    .lean();
}

export async function getUserBid(auction_id: string, round_id: string, user_id: string) {
  return Bid.findOne({ auction_id, round_id, user_id }).lean();
}

export async function getUserPlace(auction_id: string, round_id: string, user_id: string) {
  const userBid = await getUserBid(auction_id, round_id, user_id);
  if (!userBid) return null;
  return userBid.place_id;
}

export async function getAllBidsInRound(auction_id: string, round_id: string) {
  return Bid.find({ auction_id, round_id })
    .sort({ amount: -1, created_at: 1 })
    .lean();
}

export async function isUserInTop3(auction_id: string, round_id: string, user_id: string) {
  const top3 = await getTopBids(auction_id, round_id, 3);
  return top3.some((bid) => bid.user_id === user_id);
}

export async function transferBidsToNextRound(
  auction_id: string,
  current_round_id: string,
  next_round_id: string,
  winners_per_round: number
) {
  
  const allBids = await Bid.find({ auction_id, round_id: current_round_id })
    .sort({ amount: -1, created_at: 1 })
    .lean();

  if (allBids.length === 0) {
    return { transferred: 0 };
  }
  
  const nonWinningBids = allBids.slice(winners_per_round);
  if (nonWinningBids.length === 0) {
    return { transferred: 0 };
  }
  
  const userBidsMap = new Map<string, typeof nonWinningBids[0] & { totalAmount: number }>();

  for (const bid of nonWinningBids) {
    const existing = userBidsMap.get(bid.user_id);
    if (existing) {
      
      existing.totalAmount += bid.amount;
    } else {
      
      userBidsMap.set(bid.user_id, {
        ...bid,
        totalAmount: bid.amount,
      });
    }
  }
  
  const existingBidsInNextRound = await Bid.find({
    auction_id,
    round_id: next_round_id,
    user_id: { $in: Array.from(userBidsMap.keys()) },
  }).lean();

  const existingBidsMap = new Map(
    existingBidsInNextRound.map((bid) => [bid.user_id, bid])
  );
  
  const bulkOps: any[] = [];
  const now = new Date();

  for (const [user_id, bidData] of userBidsMap) {
    const existingBid = existingBidsMap.get(user_id);
    if (existingBid) {
      bulkOps.push({
        updateOne: {
          filter: { _id: existingBid._id },
          update: {
            $inc: { amount: bidData.totalAmount },
            $set: { updated_at: now },
          },
        },
      });
    } else {
      bulkOps.push({
        insertOne: {
          document: {
            auction_id,
            round_id: next_round_id,
            user_id,
            amount: bidData.totalAmount,
            place_id: 999999, 
            idempotency_key: `transfer-${current_round_id}-${user_id}-${Date.now()}`,
            is_top3_sniping_bid: false,
            created_at: now,
            updated_at: now,
          },
        },
      });
    }
  }
  
  if (bulkOps.length > 0) {
    await Bid.bulkWrite(bulkOps, { ordered: false });
    await recalculatePlaces(auction_id, next_round_id);
  }

  return { transferred: userBidsMap.size };
}
