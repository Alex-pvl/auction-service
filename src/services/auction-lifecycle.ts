import { Auction, Round } from "../storage/mongo.js";
import type { Auction as AuctionType } from "../models/types.js";
import type { RedisClientType } from "redis";
import { getTopBids, isUserInTop3, transferBidsToNextRound } from "./bids.js";
import { stopBotsForAuction, initializeBots, createAndStartBotsForAuction } from "./bots.js";
import { broadcastAuctionUpdate } from "./websocket.js";
import { adjustUserBalanceByTgId } from "./users.js";

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
const PROCESSING_ROUNDS = new Set<string>();
const PROCESSING_AUCTIONS = new Set<string>();
let changeStream: any = null;
let bidTransferProcessorInterval: NodeJS.Timeout | null = null;
let checkTimersInterval: NodeJS.Timeout | null = null;
let deliveryProcessorInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

export async function startAuctionLifecycleManager(redis?: RedisClientType<any, any, any>) {
  console.log("Starting auction lifecycle manager (event-driven)...");
  
  if (redis) {
    redisClient = redis;
    startBidTransferProcessor();
  }
  
  await initializeBots(redis);
  
  await initializeExistingAuctions();
  
  startAuctionChangeStream();
  
  checkTimersInterval = setInterval(async () => {
    await checkTimers();
  }, 10000);
  
  startDeliveryProcessor();
}

async function startDeliveryProcessor() {
  deliveryProcessorInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    
    try {
      const { processPendingDeliveries } = await import("./deliveries.js");
      await processPendingDeliveries();
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Error in delivery processor:", error);
      }
    }
  }, 2000);
}

async function startBidTransferProcessor() {
  if (!redisClient) return;

  bidTransferProcessorInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    
    try {
      if (!redisClient || !redisClient.isOpen || isShuttingDown) {
        return;
      }
      
      const result = await redisClient.blPop(
        redisClient.commandOptions({ isolated: true }),
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
      if (!isShuttingDown) {
        console.error("Error in bid transfer processor:", error);
      }
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
  if (isShuttingDown || !redisClient || !redisClient.isOpen) {
    await processBidTransfer({ auction_id, current_round_id, next_round_id, winners_per_round });
    return;
  }

  const task = {
    auction_id,
    current_round_id,
    next_round_id,
    winners_per_round,
  };
  
  try {
    await redisClient.rPush(BID_TRANSFER_QUEUE, JSON.stringify(task));
  } catch (error) {
    if (!isShuttingDown) {
      console.error("Error queueing bid transfer, processing directly:", error);
    }
    await processBidTransfer({ auction_id, current_round_id, next_round_id, winners_per_round });
  }
}

async function initializeExistingAuctions() {
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
    await createAndStartBotsForAuction(auction._id.toString());
    await setupAuctionTimer(auction._id.toString());
  }
}

let changeStreamRetryCount = 0;
const MAX_CHANGE_STREAM_RETRIES = 3;

function startAuctionChangeStream() {
  try {
    changeStream = Auction.watch([], {
      fullDocument: "updateLookup",
    });

    changeStream.on("change", async (change: any) => {
      try {
        const auctionId = change.documentKey?._id?.toString();
        if (!auctionId) return;

        const fullDocument = change.fullDocument as AuctionType | null;

        if (change.operationType === "update" && fullDocument) {
          if (change.updateDescription?.updatedFields?.status === "LIVE") {
            await startAuction(auctionId);
          }
          else if (change.updateDescription?.updatedFields?.status === "FINISHED") {
            await finishAuction(auctionId);
          }
          else if (change.updateDescription?.updatedFields?.current_round_idx !== undefined) {
            await setupAuctionTimer(auctionId);
          }
        } else if (change.operationType === "insert" && fullDocument) {
          if (fullDocument.status === "RELEASED" && fullDocument.start_datetime.getTime() <= Date.now()) {
            await startAuction(auctionId);
          } else if (fullDocument.status === "RELEASED") {
            console.log(`New auction ${auctionId} created with status RELEASED, will start at ${fullDocument.start_datetime.toISOString()}`);
          }
        }
      } catch (error) {
        console.error("Error processing auction change stream:", error);
      }
    });

    changeStream.on("error", (error: any) => {
      const isReplicaSetError = error?.code === 40573 || 
                                error?.codeName === 'Location40573' ||
                                error?.message?.includes('replica set');
      
      if (isReplicaSetError) {
        if (changeStreamRetryCount === 0) {
          console.error("Auction change stream error: MongoDB replica set is not configured.");
          console.error("Please initialize the replica set by running:");
          console.error("  docker exec -it <mongo-container> mongosh --eval 'rs.initiate({_id: \"rs0\", members: [{_id: 0, host: \"localhost:27017\"}]})'");
          console.error("Falling back to polling-based lifecycle management.");
        }
        changeStreamRetryCount++;
        if (changeStreamRetryCount >= MAX_CHANGE_STREAM_RETRIES) {
          console.warn("Change stream unavailable. Using polling fallback (checkTimers runs every 10s).");
          return;
        }
      } else {
        console.error("Auction change stream error:", error);
      }
      
      if (!isReplicaSetError || changeStreamRetryCount < MAX_CHANGE_STREAM_RETRIES) {
        setTimeout(() => {
          startAuctionChangeStream();
        }, 5000);
      }
    });

    changeStreamRetryCount = 0;
    console.log("Auction change stream started");
  } catch (error: any) {
    const isReplicaSetError = error?.code === 40573 || 
                              error?.codeName === 'Location40573' ||
                              error?.message?.includes('replica set');
    
    if (isReplicaSetError) {
      console.error("Failed to start change stream: MongoDB replica set is not configured.");
      console.error("Please initialize the replica set. Falling back to polling-based lifecycle management.");
    } else {
      console.error("Failed to start change stream:", error);
      setTimeout(() => {
        startAuctionChangeStream();
      }, 5000);
    }
  }
}

async function setupAuctionTimer(auctionId: string) {
  const existingTimer = activeTimers.get(auctionId);
  if (existingTimer) {
    if (existingTimer.timeoutId) clearTimeout(existingTimer.timeoutId);
    if (existingTimer.intervalId) clearInterval(existingTimer.intervalId);
  }

  const auction = await Auction.findById(auctionId).lean();
  if (!auction || auction.status !== "LIVE") {
    return;
  }

  const currentRound = await Round.findOne({
    auction_id: auctionId,
    idx: auction.current_round_idx,
  }).lean();

  if (!currentRound) {
    return;
  }

  const now = Date.now();
  const actualEndTime = currentRound.extended_until
    ? currentRound.extended_until.getTime()
    : currentRound.ended_at.getTime();
  
  const timeUntilEnd = actualEndTime - now;

  if (timeUntilEnd <= 0) {
    await processRoundEnd(auctionId, auction);
    return;
  }

  const timeoutId = setTimeout(async () => {
    await processRoundEnd(auctionId, auction);
  }, timeUntilEnd);

  activeTimers.set(auctionId, {
    auctionId,
    timeoutId,
    intervalId: null,
  });

  console.log(`Timer set for auction ${auctionId}, round ${auction.current_round_idx}, ends in ${Math.round(timeUntilEnd / 1000)}s`);
}

async function processRoundEnd(auctionId: string, auction: AuctionType) {
  const currentAuction = await Auction.findById(auctionId).lean();
  if (!currentAuction || currentAuction.status !== "LIVE") {
    return;
  }
  
  const currentRound = await Round.findOne({
    auction_id: auctionId,
    idx: currentAuction.current_round_idx,
  }).lean();

  if (!currentRound) {
    return;
  }

  const now = Date.now();
  const actualEndTime = currentRound.extended_until
    ? currentRound.extended_until.getTime()
    : currentRound.ended_at.getTime();
  
  if (now < actualEndTime) {
    await setupAuctionTimer(auctionId);
    return;
  }

  const nextRoundIdx = currentAuction.current_round_idx + 1;
  const hasNextRound = nextRoundIdx < currentAuction.rounds_count;
  
  await finishRound(auctionId, currentAuction.current_round_idx, hasNextRound ? nextRoundIdx : null);
  
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
        Math.floor(currentAuction.winners_per_round)
      );
    }
    
    await setupAuctionTimer(auctionId);
    await broadcastAuctionUpdate(auctionId);
  } else {
    await finishAuction(auctionId);
  }
}

async function checkTimers() {
  const liveAuctions = await Auction.find({ status: "LIVE" }).lean();
  for (const auction of liveAuctions) {
    const timer = activeTimers.get(auction._id.toString());
    if (!timer || !timer.timeoutId) {
      await setupAuctionTimer(auction._id.toString());
    } else {
      const currentRound = await Round.findOne({
        auction_id: auction._id.toString(),
        idx: auction.current_round_idx,
      }).lean();
      
      if (currentRound) {
        const now = Date.now();
        const actualEndTime = currentRound.extended_until
          ? currentRound.extended_until.getTime()
          : currentRound.ended_at.getTime();
        
        if (now >= actualEndTime) {
          await processRoundEnd(auction._id.toString(), auction);
        }
      }
    }
  }
  
  const now = Date.now();
  const releasedAuctions = await Auction.find({
    status: "RELEASED",
    start_datetime: { $lte: new Date(now) },
  }).lean();

  for (const auction of releasedAuctions) {
    await startAuction(auction._id.toString());
  }
}

async function startAuction(auctionId: string) {
  const auction = await Auction.findById(auctionId).lean();
  if (!auction || auction.status !== "RELEASED") return;
  console.log(`Starting auction ${auctionId}`);
  await Auction.findByIdAndUpdate(auctionId, { status: "LIVE" });
  await startRound(auctionId, 0);
  await createAndStartBotsForAuction(auctionId);
  await setupAuctionTimer(auctionId);
  await broadcastAuctionUpdate(auctionId);
}

async function startRound(auctionId: string, roundIdx: number) {
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) return null;
  
  const existingRound = await Round.findOne({
    auction_id: auctionId,
    idx: roundIdx,
  });
  
  if (existingRound) {
    console.log(`Round ${roundIdx} for auction ${auctionId} already exists, skipping creation`);
    return existingRound;
  }
  
  const now = new Date();
  const isFirstRound = roundIdx === 0;
  const duration = isFirstRound && auction.first_round_duration_ms
    ? auction.first_round_duration_ms
    : auction.round_duration_ms;
  const endedAt = new Date(now.getTime() + duration);
  
  try {
    const round = await Round.create({
      auction_id: auctionId,
      idx: roundIdx,
      started_at: now,
      ended_at: endedAt,
      extended_until: null,
    });

    console.log(`Started round ${roundIdx} for auction ${auctionId}, ends at ${endedAt.toISOString()}`);
    return round;
  } catch (error: any) {
    if (error.code === 11000) {
      console.log(`Round ${roundIdx} for auction ${auctionId} was created concurrently, fetching existing round`);
      const round = await Round.findOne({
        auction_id: auctionId,
        idx: roundIdx,
      });
      return round;
    }
    throw error;
  }
}

async function finishRound(auctionId: string, roundIdx: number, nextRoundIdx: number | null) {
  const roundKey = `${auctionId}-${roundIdx}`;
  
  if (PROCESSING_ROUNDS.has(roundKey)) {
    console.log(`Round ${roundIdx} for auction ${auctionId} is already being processed, skipping`);
    return;
  }
  
  PROCESSING_ROUNDS.add(roundKey);
  
  try {
    const round = await Round.findOne({
      auction_id: auctionId,
      idx: roundIdx,
    }).lean();

    if (!round) {
      PROCESSING_ROUNDS.delete(roundKey);
      return;
    }
    
    const auction = await Auction.findById(auctionId).lean();
    if (!auction) {
      PROCESSING_ROUNDS.delete(roundKey);
      return;
    }
    
    const { getAllBidsInRound } = await import("./bids.js");
    const allBids = await getAllBidsInRound(auctionId, round._id.toString());
    
    if (allBids.length === 0) {
      console.log(`Finishing round ${roundIdx} for auction ${auctionId}, no bids - skipping item distribution`);
      PROCESSING_ROUNDS.delete(roundKey);
      return;
    }
    
    const winnersCount = Math.floor(auction.winners_per_round);
    const topBids = await getTopBids(auctionId, round._id.toString(), winnersCount);
    console.log(`Finishing round ${roundIdx} for auction ${auctionId}, winners: ${topBids.length}`);
    
    const currentAuction = await Auction.findById(auctionId).lean();
    if (!currentAuction) {
      PROCESSING_ROUNDS.delete(roundKey);
      return;
    }
    
    const itemsToDeduct = Math.min(
      topBids.length, 
      Math.max(0, currentAuction.remaining_items_count)
    );
    
    if (itemsToDeduct > 0) {
      const result = await Auction.findByIdAndUpdate(
        auctionId,
        {
          $inc: { remaining_items_count: -itemsToDeduct },
        },
        { new: true }
      );
      
      if (result && result.remaining_items_count < 0) {
        await Auction.findByIdAndUpdate(auctionId, {
          $set: { remaining_items_count: 0 },
        });
        console.warn(`Fixed negative remaining_items_count for auction ${auctionId}, set to 0`);
      }
      
      console.log(`Deducted ${itemsToDeduct} items from auction ${auctionId}, remaining: ${result?.remaining_items_count ?? 0}`);
      
      const winnersToDeliver = topBids.slice(0, itemsToDeduct);
      if (winnersToDeliver.length > 0) {
        try {
          const { createDeliveriesForWinners } = await import("./deliveries.js");
          await createDeliveriesForWinners(
            auctionId,
            round._id.toString(),
            winnersToDeliver,
            currentAuction.item_name
          );
        } catch (error) {
          console.error(`Error creating deliveries for auction ${auctionId}, round ${roundIdx}:`, error);
        }
      }
    }
  } finally {
    PROCESSING_ROUNDS.delete(roundKey);
  }
}

async function finishAuction(auctionId: string) {
  if (PROCESSING_AUCTIONS.has(auctionId)) {
    console.log(`Auction ${auctionId} is already being processed, skipping`);
    return;
  }
  
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) {
    console.error(`Auction ${auctionId} not found`);
    return;
  }
  
  if (auction.status === "FINISHED") {
    console.log(`Auction ${auctionId} is already finished, skipping`);
    return;
  }
  
  PROCESSING_AUCTIONS.add(auctionId);
  
  try {
    console.log(`Finishing auction ${auctionId}`);
    
    const lastRoundIdx = auction.rounds_count - 1;
    const lastRound = await Round.findOne({
      auction_id: auctionId,
      idx: lastRoundIdx,
    }).lean();
    
    if (lastRound) {
      const { getAllBidsInRound } = await import("./bids.js");
      const allBids = await getAllBidsInRound(auctionId, lastRound._id.toString());
      
      if (allBids.length > 0) {
        const winnersCount = Math.floor(auction.winners_per_round);
        const topBids = await getTopBids(auctionId, lastRound._id.toString(), winnersCount);
        
        const winnerUserIds = new Set(topBids.map(bid => bid.user_id));
        const losingBids = allBids.filter(bid => !winnerUserIds.has(bid.user_id));
        
        const { Bid } = await import("../storage/mongo.js");
        const { User } = await import("../storage/mongo.js");
        
        const losingUserIds = new Set(losingBids.map(bid => bid.user_id));
        const userTotalSpent = new Map<string, number>();
        const allRounds = await Round.find({ auction_id: auctionId }).sort({ idx: 1 }).lean();
        
        for (const userId of losingUserIds) {
          let totalSpent = 0;
          let maxAmountSoFar = 0;
          
          for (const round of allRounds) {
            const userBidsInRound = await Bid.find({
              auction_id: auctionId,
              round_id: round._id.toString(),
              user_id: userId,
            }).sort({ amount: -1 }).limit(1).lean();
            
            if (userBidsInRound.length > 0) {
              const bid = userBidsInRound[0];
              const currentRoundAmount = bid.amount;
              
              const isTransferred = bid.idempotency_key?.startsWith("transfer-");
              
              if (!isTransferred) {
                const increment = currentRoundAmount - maxAmountSoFar;
                if (increment > 0) {
                  totalSpent += increment;
                }
                maxAmountSoFar = currentRoundAmount;
              } else {
                if (currentRoundAmount > maxAmountSoFar) {
                  maxAmountSoFar = currentRoundAmount;
                }
              }
            }
          }
          
          if (totalSpent > 0) {
            userTotalSpent.set(userId, totalSpent);
          }
        }
        
        let returnedCount = 0;
        let totalReturned = 0;
        
        for (const [userId, amount] of userTotalSpent.entries()) {
          try {
            const user = await User.findById(userId).lean();
            if (user && user.tg_id && amount > 0) {
              await adjustUserBalanceByTgId(user.tg_id, amount);
              returnedCount++;
              totalReturned += amount;
              console.log(`Returned ${amount} to user ${user.tg_id} (user_id: ${userId})`);
            }
          } catch (error) {
            console.error(`Error returning balance to user ${userId}:`, error);
          }
        }
        
        console.log(`Returned balance to ${returnedCount} losing participants, total: ${totalReturned}`);
      }
    }
    
    await Auction.findByIdAndUpdate(auctionId, { status: "FINISHED" });
    
    const timer = activeTimers.get(auctionId);
    if (timer) {
      if (timer.timeoutId) clearTimeout(timer.timeoutId);
      if (timer.intervalId) clearInterval(timer.intervalId);
      activeTimers.delete(auctionId);
    }
    
    stopBotsForAuction(auctionId);
  } finally {
    PROCESSING_AUCTIONS.delete(auctionId);
  }
}

export async function handleTop3Bid(auctionId: string, roundId: string, userId: string, isUpdate: boolean = false) {
  const round = await Round.findById(roundId).lean();
  if (!round) return false;
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) return false;
  if (round.idx !== 0) return false;

  const inTop3 = await isUserInTop3(auctionId, roundId, userId);
  if (!inTop3) return false;

  const now = Date.now();
  const actualEndTime = round.extended_until 
    ? round.extended_until.getTime() 
    : round.ended_at.getTime();
  const timeUntilEnd = actualEndTime - now;

  if (timeUntilEnd <= ANTI_SNIPING_LAST_MINUTE_MS && timeUntilEnd > 0) {
    const { Bid } = await import("../storage/mongo.js");
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
        `Anti-sniping: Extended round ${round.idx} for auction ${auctionId} until ${new Date(newExtendedUntil).toISOString()} (top-3 user ${userId} ${isUpdate ? 'rebid' : 'bid'})`
      );
      
      await setupAuctionTimer(auctionId);
      await broadcastAuctionUpdate(auctionId);
    }

    return true;
  }

  return false;
}

export async function shutdownAuctionLifecycle(): Promise<void> {
  console.log("Shutting down auction lifecycle manager...");
  
  isShuttingDown = true;
  
  if (changeStream) {
    try {
      await changeStream.close();
      console.log("Auction change stream closed");
    } catch (error) {
      console.error("Error closing change stream:", error);
    }
    changeStream = null;
  }
  
  if (bidTransferProcessorInterval) {
    clearInterval(bidTransferProcessorInterval);
    bidTransferProcessorInterval = null;
  }
  
  if (checkTimersInterval) {
    clearInterval(checkTimersInterval);
    checkTimersInterval = null;
  }
  
  if (deliveryProcessorInterval) {
    clearInterval(deliveryProcessorInterval);
    deliveryProcessorInterval = null;
  }
  
  for (const [auctionId, timer] of activeTimers.entries()) {
    if (timer.timeoutId) {
      clearTimeout(timer.timeoutId);
    }
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
    }
    await stopBotsForAuction(auctionId);
  }
  activeTimers.clear();
  
  PROCESSING_BID_TRANSFERS.clear();
  PROCESSING_ROUNDS.clear();
  PROCESSING_AUCTIONS.clear();
  
  console.log("Auction lifecycle manager shutdown complete");
}
