import {
  createBidAtomically,
  addToBidAtomically,
  getUserPlaceFromRedis,
  getTopBidsFromRedis,
  getUserBidFromRedis,
  getUserBalanceFromRedis,
} from "./redis-bids.js";
import { getAuctionById } from "./auctions.js";
import { Round } from "../storage/mongo.js";
import { handleTop3Bid } from "./auction-lifecycle.js";
import { broadcastAuctionUpdate } from "./websocket.js";

export async function createBidWithBalanceDeductionRedis(
  auctionId: string,
  roundId: string,
  userId: string,
  userTgId: number,
  amount: number,
  idempotencyKey: string
) {
  const result = await createBidAtomically(
    userTgId,
    amount,
    idempotencyKey,
    auctionId,
    roundId,
    userId
  );

  if (!result.success) {
    if (result.error_message === "already_processed") {
      const existingBid = await getUserBidFromRedis(auctionId, roundId, userId);
      if (existingBid) {
        return existingBid;
      }
    }
    throw new Error(result.error_message);
  }

  if (result.bid_data) {
    try {
      return JSON.parse(result.bid_data);
    } catch (e) {
      return await getUserBidFromRedis(auctionId, roundId, userId);
    }
  }

  return await getUserBidFromRedis(auctionId, roundId, userId);
}

export async function addToBidWithBalanceDeductionRedis(
  auctionId: string,
  roundId: string,
  userId: string,
  userTgId: number,
  additionalAmount: number,
  idempotencyKey: string
) {
  const result = await addToBidAtomically(
    userTgId,
    additionalAmount,
    idempotencyKey,
    auctionId,
    roundId,
    userId
  );

  if (!result.success) {
    if (result.error_message === "already_processed") {
      const existingBid = await getUserBidFromRedis(auctionId, roundId, userId);
      if (existingBid) {
        return existingBid;
      }
    }
    throw new Error(result.error_message);
  }

  if (result.bid_data) {
    try {
      return JSON.parse(result.bid_data);
    } catch (e) {
      return await getUserBidFromRedis(auctionId, roundId, userId);
    }
  }

  return await getUserBidFromRedis(auctionId, roundId, userId);
}

export async function getUserPlaceRedis(
  auctionId: string,
  roundId: string,
  userId: string
): Promise<number | null> {
  return await getUserPlaceFromRedis(auctionId, roundId, userId);
}

export async function getTopBidsRedis(
  auctionId: string,
  roundId: string,
  limit: number = 3
) {
  const redisBids = await getTopBidsFromRedis(auctionId, roundId, limit);
  
  return redisBids.map((bid, index) => ({
    user_id: bid.user_id,
    amount: bid.amount,
    place_id: index + 1,
  }));
}

export async function getUserBidRedis(
  auctionId: string,
  roundId: string,
  userId: string
) {
  return await getUserBidFromRedis(auctionId, roundId, userId);
}

export async function handleBidRequest(
  auctionId: string,
  roundId: string,
  userTgId: number,
  userId: string,
  amount: number,
  idempotencyKey: string,
  isAddToExisting: boolean
) {
  const auction = await getAuctionById(auctionId);
  if (!auction) {
    throw new Error("auction not found");
  }

  if (auction.status !== "LIVE") {
    throw new Error("auction is not live");
  }

  const currentRound = await Round.findOne({
    auction_id: auctionId,
    idx: auction.current_round_idx,
  }).lean();

  if (!currentRound) {
    throw new Error("round not found");
  }

  const now = Date.now();
  const roundEndTime = currentRound.extended_until
    ? currentRound.extended_until.getTime()
    : currentRound.ended_at.getTime();

  if (now >= roundEndTime) {
    throw new Error("round has ended");
  }

  const balance = await getUserBalanceFromRedis(userTgId);
  if (balance < amount) {
    throw new Error("insufficient balance");
  }

  const { getMinBidForRound } = await import("./bids.js");
  const minBidForRound = await getMinBidForRound(auctionId, auction.current_round_idx);

  const existingBid = await getUserBidRedis(auctionId, roundId, userId);

  if (existingBid) {
    const userPlace = await getUserPlaceRedis(auctionId, roundId, userId);
    const winnersPerRound = Math.floor(auction.winners_per_round);
    const isFirstRound = auction.current_round_idx === 0;
    const isTop3 = userPlace !== null && userPlace <= 3;
    const canUpdateInFirstRound = isFirstRound && isTop3;

    if (userPlace !== null && userPlace <= winnersPerRound && !canUpdateInFirstRound) {
      throw new Error("cannot update bid: you are already in the winning top");
    }
  }

  let bid;
  let isBidUpdate = false;

  if (isAddToExisting) {
    if (!existingBid) {
      throw new Error("no existing bid to add to");
    }

    const totalAmount = existingBid.amount + amount;
    if (totalAmount < minBidForRound) {
      throw new Error(
        `total bid amount (${existingBid.amount.toFixed(2)} + ${amount.toFixed(2)} = ${totalAmount.toFixed(2)}) must be at least ${minBidForRound} (min bid for round ${auction.current_round_idx + 1})`
      );
    }

    const userPlaceBefore = await getUserPlaceRedis(auctionId, roundId, userId);
    if (userPlaceBefore === 1) {
      throw new Error("cannot add to bid: you are already in first place");
    }

    bid = await addToBidWithBalanceDeductionRedis(
      auctionId,
      roundId,
      userId,
      userTgId,
      amount,
      idempotencyKey
    );
    isBidUpdate = true;
  } else {
    if (existingBid) {
      const totalAmount = existingBid.amount + amount;
      if (totalAmount < minBidForRound) {
        throw new Error(
          `total bid amount (${existingBid.amount.toFixed(2)} + ${amount.toFixed(2)} = ${totalAmount.toFixed(2)}) must be at least ${minBidForRound} (min bid for round ${auction.current_round_idx + 1})`
        );
      }

      const userPlaceBefore = await getUserPlaceRedis(auctionId, roundId, userId);
      if (userPlaceBefore === 1) {
        throw new Error("cannot add to bid: you are already in first place");
      }

      bid = await addToBidWithBalanceDeductionRedis(
        auctionId,
        roundId,
        userId,
        userTgId,
        amount,
        idempotencyKey
      );
      isBidUpdate = true;
    } else {
      if (amount < minBidForRound) {
        throw new Error(
          `amount must be at least ${minBidForRound} (min bid for round ${auction.current_round_idx + 1})`
        );
      }

      bid = await createBidWithBalanceDeductionRedis(
        auctionId,
        roundId,
        userId,
        userTgId,
        amount,
        idempotencyKey
      );
      isBidUpdate = false;
    }
  }

  if (auction.current_round_idx === 0) {
    const userPlace = await getUserPlaceRedis(auctionId, roundId, userId);
    const isTop3 = userPlace !== null && userPlace <= 3;
    if (isTop3) {
      await handleTop3Bid(auctionId, roundId, userId, isBidUpdate);
    }
  }

  const place = await getUserPlaceRedis(auctionId, roundId, userId);
  const remainingBalance = await getUserBalanceFromRedis(userTgId);

  await broadcastAuctionUpdate(auctionId, true);

  return {
    bid,
    place,
    remaining_balance: remainingBalance,
  };
}
