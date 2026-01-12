import { Auction, Round, Bid } from "../storage/mongo.js";
import type { Auction as AuctionType } from "../models/types.js";
import type { RedisClientType } from "redis";
import { getTopBids, isUserInTop3, recalculatePlaces, transferBidsToNextRound } from "./bids.js";
import { startBotsForAuction, stopBotsForAuction, initializeBots } from "./bots.js";

const ANTI_SNIPING_EXTENSION_MS = 30 * 1000;
const ANTI_SNIPING_LAST_MINUTE_MS = 60 * 1000;

interface AuctionTimer {
  auctionId: string;
  timeoutId: NodeJS.Timeout | null;
  intervalId: NodeJS.Timeout | null;
}

const activeTimers = new Map<string, AuctionTimer>();
let redisClient: RedisClientType<any, any, any> | null = null;
const BID_TRANSFER_QUEUE = "bid_transfer_queue";
const PROCESSING_BID_TRANSFERS = new Set<string>();

export async function startAuctionLifecycleManager(redis?: RedisClientType<any, any, any>) {
  console.log("Starting auction lifecycle manager...");
  
  if (redis) {
    redisClient = redis;
    startBidTransferProcessor();
  }
  
  await initializeBots(redis);
  await checkAndProcessAuctions();
  
  setInterval(async () => {
    await checkAndProcessAuctions();
  }, 5000);
}

async function startBidTransferProcessor() {
  if (!redisClient) return;

  setInterval(async () => {
    try {
      const result = await redisClient!.blPop(
        redisClient!.commandOptions({ isolated: true }),
        BID_TRANSFER_QUEUE,
        1
      );

      if (!result) return;

      const task = JSON.parse(result.element);
      const taskKey = `${task.auction_id}-${task.current_round_id}-${task.next_round_id}`;
      if (PROCESSING_BID_TRANSFERS.has(taskKey)) {
        return;
      }

      PROCESSING_BID_TRANSFERS.add(taskKey);
      try {
        await processBidTransfer(task);
      } catch (error) {
        console.error(`Error processing bid transfer for auction ${task.auction_id}:`, error);
      } finally {
        PROCESSING_BID_TRANSFERS.delete(taskKey);
      }
    } catch (error) {
      console.error("Error in bid transfer processor:", error);
    }
  }, 100); 
}

async function processBidTransfer(task: {
  auction_id: string;
  current_round_id: string;
  next_round_id: string;
  winners_per_round: number;
}) {
  const result = await transferBidsToNextRound(
    task.auction_id,
    task.current_round_id,
    task.next_round_id,
    task.winners_per_round
  );
  console.log(
    `Transferred ${result.transferred} bids from round ${task.current_round_id} to ${task.next_round_id} for auction ${task.auction_id}`
  );
}

async function queueBidTransfer(
  auction_id: string,
  current_round_id: string,
  next_round_id: string,
  winners_per_round: number
) {
  if (!redisClient) {
    await processBidTransfer({ auction_id, current_round_id, next_round_id, winners_per_round });
    return;
  }

  const task = {
    auction_id,
    current_round_id,
    next_round_id,
    winners_per_round,
  };
  
  await redisClient.rPush(BID_TRANSFER_QUEUE, JSON.stringify(task));
}

async function checkAndProcessAuctions() {
  const now = Date.now();
  const releasedAuctions = await Auction.find({
    status: "RELEASED",
    start_datetime: { $lte: new Date(now) },
  }).lean();

  for (const auction of releasedAuctions) {
    await startAuction(auction._id.toString());
  }
  
  const liveAuctions = await Auction.find({ status: "LIVE" }).lean();
  for (const auction of liveAuctions) {
    await processAuctionRounds(auction);
    const { startBotsForAuction } = await import("./bots.js");
    await startBotsForAuction(auction._id.toString());
  }
}

async function startAuction(auctionId: string) {
  const auction = await Auction.findById(auctionId).lean();
  if (!auction || auction.status !== "RELEASED") return;
  console.log(`Starting auction ${auctionId}`);
  await Auction.findByIdAndUpdate(auctionId, { status: "LIVE" });
  await startRound(auctionId, 0);
  await startBotsForAuction(auctionId);
}

async function processAuctionRounds(auction: AuctionType) {
  const now = Date.now();
  const auctionId = auction._id.toString();
  const currentRound = await Round.findOne({
    auction_id: auctionId,
    idx: auction.current_round_idx,
  }).lean();
  if (!currentRound) {
    if (auction.current_round_idx === 0) {
      await startRound(auctionId, 0);
    }
    return;
  }

  const actualEndTime = currentRound.extended_until 
    ? currentRound.extended_until.getTime() 
    : currentRound.ended_at.getTime();
  
  if (now >= actualEndTime) {
    const nextRoundIdx = auction.current_round_idx + 1;
    const hasNextRound = nextRoundIdx < auction.rounds_count;
    
    await finishRound(auctionId, auction.current_round_idx, hasNextRound ? nextRoundIdx : null);
    
    if (hasNextRound) {
      const nextRound = await startRound(auctionId, nextRoundIdx);
      await Auction.findByIdAndUpdate(auctionId, {
        current_round_idx: nextRoundIdx,
      });
      
      if (nextRound) {
        await queueBidTransfer(
          auctionId,
          currentRound._id.toString(),
          nextRound._id.toString(),
          Math.floor(auction.winners_per_round)
        );
      }
    } else {
      
      await finishAuction(auctionId);
    }
  } else {
    if (auction.current_round_idx === 0 && auction.first_round_duration_ms) {
      await checkAntiSniping(auctionId, currentRound);
    }
  }
}

async function startRound(auctionId: string, roundIdx: number) {
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) return null;
  const now = new Date();
  const isFirstRound = roundIdx === 0;
  const duration = isFirstRound && auction.first_round_duration_ms
    ? auction.first_round_duration_ms
    : auction.round_duration_ms;
  const endedAt = new Date(now.getTime() + duration);
  const round = await Round.create({
    auction_id: auctionId,
    idx: roundIdx,
    started_at: now,
    ended_at: endedAt,
    extended_until: null,
  });

  console.log(`Started round ${roundIdx} for auction ${auctionId}, ends at ${endedAt.toISOString()}`);
  return round;
}

async function finishRound(auctionId: string, roundIdx: number, nextRoundIdx: number | null) {
  const round = await Round.findOne({
    auction_id: auctionId,
    idx: roundIdx,
  }).lean();

  if (!round) return;
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) return;
  
  const { getAllBidsInRound } = await import("./bids.js");
  const allBids = await getAllBidsInRound(auctionId, round._id.toString());
  
  if (allBids.length === 0) {
    console.log(`Finishing round ${roundIdx} for auction ${auctionId}, no bids - skipping item distribution`);
    return;
  }
  
  const winnersCount = Math.floor(auction.winners_per_round);
  const topBids = await getTopBids(auctionId, round._id.toString(), winnersCount);
  console.log(`Finishing round ${roundIdx} for auction ${auctionId}, winners: ${topBids.length}`);
  const itemsToDeduct = Math.min(topBids.length, auction.remaining_items_count);
  if (itemsToDeduct > 0) {
    await Auction.findByIdAndUpdate(auctionId, {
      $inc: { remaining_items_count: -itemsToDeduct },
    });
  }
}

async function finishAuction(auctionId: string) {
  console.log(`Finishing auction ${auctionId}`);
  await Auction.findByIdAndUpdate(auctionId, { status: "FINISHED" });
  
  const timer = activeTimers.get(auctionId);
  if (timer) {
    if (timer.timeoutId) clearTimeout(timer.timeoutId);
    if (timer.intervalId) clearInterval(timer.intervalId);
    activeTimers.delete(auctionId);
  }
  
  stopBotsForAuction(auctionId);
}

async function checkAntiSniping(auctionId: string, round: any) {
  
}

export async function handleTop3Bid(auctionId: string, roundId: string, userId: string, isUpdate: boolean = false) {
  const round = await Round.findById(roundId).lean();
  if (!round) return false;
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) return false;
  if (round.idx !== 0) return false;

  const inTop3 = await isUserInTop3(auctionId, roundId, userId);
  if (!inTop3) return false;
  
  if (!isUpdate) return false;

  const now = Date.now();
  const actualEndTime = round.extended_until 
    ? round.extended_until.getTime() 
    : round.ended_at.getTime();
  const timeUntilEnd = actualEndTime - now;

  if (timeUntilEnd <= ANTI_SNIPING_LAST_MINUTE_MS && timeUntilEnd > 0) {
    await Bid.updateMany(
      {
        auction_id: auctionId,
        round_id: roundId,
        user_id: userId,
      },
      {
        $set: { is_top3_sniping_bid: true },
      }
    );
    
    const currentExtendedUntil = round.extended_until 
      ? round.extended_until.getTime() 
      : round.ended_at.getTime();
    
    const newExtendedUntil = Math.max(
      currentExtendedUntil,
      now + ANTI_SNIPING_EXTENSION_MS
    );

    if (newExtendedUntil > currentExtendedUntil) {
      await Round.findByIdAndUpdate(round._id, {
        extended_until: new Date(newExtendedUntil),
      });
      
      console.log(
        `Anti-sniping: Extended round ${round.idx} for auction ${auctionId} until ${new Date(newExtendedUntil).toISOString()} (top-3 user ${userId} rebid)`
      );
    }

    return true;
  }

  return false;
}

export function getAuctionTimer(auctionId: string): AuctionTimer | undefined {
  return activeTimers.get(auctionId);
}
