import { Bid, Auction } from "../storage/mongo.js";
import mongoose from "mongoose";
import {
  getCachedTopBids,
  setCachedTopBids,
  invalidateTopBidsCache,
  getCachedUserPlace,
  setCachedUserPlace,
  invalidateUserPlaceCache,
  getCachedMinBidForRound,
  setCachedMinBidForRound,
} from "./cache.js";

export async function getMinBidForRound(auctionId: string, roundIdx: number): Promise<number> {
  const cached = await getCachedMinBidForRound(auctionId, roundIdx);
  if (cached !== null) {
    return cached;
  }
  
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) {
    throw new Error("Auction not found");
  }
  
  const baseMinBid = auction.min_bid;
  let minBidForRound: number;
  if (roundIdx === 0) {
    minBidForRound = baseMinBid;
  } else {
    const increasePercent = 0.05 * roundIdx;
    minBidForRound = baseMinBid * (1 + increasePercent);
  }
  minBidForRound = Math.round(minBidForRound);

  await setCachedMinBidForRound(auctionId, roundIdx, minBidForRound);
  
  return minBidForRound;
}

export type BidCreateInput = {
  auction_id: string;
  round_id: string;
  user_id: string;
  amount: number;
  idempotency_key: string;
  is_top3_sniping_bid?: boolean;
};

export async function createOrUpdateBid(input: BidCreateInput, session?: mongoose.ClientSession) {
  const existingBid = await Bid.findOne({
    auction_id: input.auction_id,
    round_id: input.round_id,
    idempotency_key: input.idempotency_key,
  }).session(session || null).lean();

  if (existingBid) {
    return existingBid;
  }

  const bid = await Bid.create([{
    ...input,
    place_id: 999999, 
  }], { session: session || undefined });
  
  await recalculatePlaces(input.auction_id, input.round_id, session);
  const updatedBid = await Bid.findById(bid[0]._id).session(session || null).lean();
  return updatedBid!;
}

export async function addToBid(
  auction_id: string,
  round_id: string,
  user_id: string,
  additional_amount: number,
  idempotency_key: string,
  session?: mongoose.ClientSession
) {
  const existingBid = await Bid.findOne({
    auction_id,
    round_id,
    user_id,
  }).session(session || null).lean();

  if (!existingBid) {
    throw new Error("Bid not found");
  }

  const existingUpdate = await Bid.findOne({
    auction_id,
    round_id,
    idempotency_key,
  }).session(session || null).lean();

  if (existingUpdate) {
    return existingUpdate;
  }

  const updatedBid = await Bid.findByIdAndUpdate(
    existingBid._id,
    {
      $inc: { amount: additional_amount },
      idempotency_key,
    },
    { new: true, session: session || undefined }
  ).lean();
  
  await recalculatePlaces(auction_id, round_id, session);
  const finalBid = await Bid.findById(existingBid._id).session(session || null).lean();
  return finalBid!;
}

export async function recalculatePlaces(auction_id: string, round_id: string, session?: mongoose.ClientSession) {
  const bids = await Bid.find({ auction_id, round_id })
    .session(session || null)
    .sort({ amount: -1, created_at: 1 })
    .lean();

  const updatePromises = bids.map((bid, index) =>
    Bid.findByIdAndUpdate(bid._id, { place_id: index + 1 }, { new: true, session: session || undefined })
  );

  await Promise.all(updatePromises);
  
  await invalidateTopBidsCache(auction_id, round_id);
  await invalidateUserPlaceCache(auction_id, round_id);
}

export async function createBidWithBalanceDeduction(
  input: BidCreateInput,
  userTgId: number,
  amount: number
) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { User } = await import("../storage/mongo.js");
    
    const user = await User.findOne({ tg_id: userTgId }).session(session).lean();
    if (!user) {
      throw new Error("User not found");
    }
    
    if (user.balance < amount) {
      throw new Error("Insufficient balance");
    }
    
    const existingBidWithKey = await Bid.findOne({
      auction_id: input.auction_id,
      round_id: input.round_id,
      idempotency_key: input.idempotency_key,
    }).session(session).lean();
    
    if (existingBidWithKey) {
      await session.commitTransaction();
      return existingBidWithKey;
    }
    
    const bid = await createOrUpdateBid(input, session);
    
    await User.updateOne(
      { tg_id: userTgId },
      { $inc: { balance: -amount } },
      { session }
    );
    
    await session.commitTransaction();
    return bid;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

export async function addToBidWithBalanceDeduction(
  auction_id: string,
  round_id: string,
  user_id: string,
  userTgId: number,
  additional_amount: number,
  idempotency_key: string
) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { User } = await import("../storage/mongo.js");
    
    const user = await User.findOne({ tg_id: userTgId }).session(session).lean();
    if (!user) {
      throw new Error("User not found");
    }
    
    if (user.balance < additional_amount) {
      throw new Error("Insufficient balance");
    }
    
    const existingBidBefore = await Bid.findOne({
      auction_id,
      round_id,
      user_id,
    }).session(session).lean();
    
    if (!existingBidBefore) {
      throw new Error("Bid not found");
    }
    
    const placeBefore = existingBidBefore.place_id;
    
    const existingUpdate = await Bid.findOne({
      auction_id,
      round_id,
      idempotency_key,
    }).session(session).lean();
    
    if (existingUpdate) {
      await session.commitTransaction();
      return existingUpdate;
    }
    
    const bid = await addToBid(auction_id, round_id, user_id, additional_amount, idempotency_key, session);
    const placeAfter = bid.place_id;
    
    if (placeBefore === 1 && placeAfter === 1) {
      throw new Error("Cannot add to bid: you are still in first place");
    }
    
    await User.updateOne(
      { tg_id: userTgId },
      { $inc: { balance: -additional_amount } },
      { session }
    );
    
    await session.commitTransaction();
    return bid;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

export async function getTopBids(auction_id: string, round_id: string, limit: number = 3) {
  const cached = await getCachedTopBids(auction_id, round_id, limit);
  if (cached !== null) {
    return cached;
  }
  
  const bids = await Bid.find({ auction_id, round_id })
    .sort({ amount: -1, created_at: 1 })
    .limit(limit)
    .lean();
  
  await setCachedTopBids(auction_id, round_id, limit, bids);
  
  return bids;
}

export async function getUserBid(auction_id: string, round_id: string, user_id: string) {
  return Bid.findOne({ auction_id, round_id, user_id }).lean();
}

export async function getUserPlace(auction_id: string, round_id: string, user_id: string) {
  const cached = await getCachedUserPlace(auction_id, round_id, user_id);
  if (cached !== null) {
    return cached;
  }
  
  const userBid = await getUserBid(auction_id, round_id, user_id);
  const place = userBid ? userBid.place_id : null;
  
  await setCachedUserPlace(auction_id, round_id, user_id, place);
  
  return place;
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
  
  const existingTransfers = await Bid.find({
    auction_id,
    round_id: next_round_id,
    idempotency_key: { $regex: `^transfer-${current_round_id}-` },
  }).lean();

  if (existingTransfers.length > 0) {
    console.log(`Bids from round ${current_round_id} to ${next_round_id} have already been transferred, skipping`);
    return { transferred: 0 };
  }
  
  const allBids = await Bid.find({ auction_id, round_id: current_round_id })
    .sort({ amount: -1, created_at: 1 })
    .lean();

  if (allBids.length === 0) {
    return { transferred: 0 };
  }
  
  const topBids = allBids.slice(0, winners_per_round);
  const winnerUserIds = new Set(topBids.map(bid => bid.user_id));
  const nonWinningBids = allBids.filter(bid => !winnerUserIds.has(bid.user_id));
  
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
      if (existingBid.idempotency_key?.startsWith(`transfer-${current_round_id}-`)) {
        console.log(`Bid for user ${user_id} already transferred from round ${current_round_id}, skipping`);
        continue;
      }
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
