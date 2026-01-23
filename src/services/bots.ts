import { randomUUID } from "node:crypto";
import { Round } from "../storage/mongo.js";
import { getAuctionById } from "./auctions.js";
import { getMinBidForRound } from "./bids.js";
import { createBidWithBalanceDeductionRedis } from "./bids-redis.js";
import { ensureUserByTgId, adjustUserBalanceByTgId } from "./users.js";
import { broadcastAuctionUpdate } from "./websocket.js";

export interface BotConfig {
  auctionId: string;
  numBots: number;
  bidsPerBot: number;
  bidAmountMin: number;
  bidAmountMax: number;
  delayBetweenBidsMs: number;
  startTgId?: number;
}

interface Bot {
  auctionId: string;
  tgId: number;
  userId: string | null;
  config: BotConfig;
  isActive: boolean;
}

interface ActiveBotSet {
  config: BotConfig;
  bots: Map<number, Bot>;
}

const activeBots = new Map<string, ActiveBotSet>();

const processedRounds = new Set<string>();

export async function registerBotsForAuction(config: BotConfig): Promise<{
  registered: number;
  auctionId: string;
  botTgIds: number[];
}> {
  const auction = await getAuctionById(config.auctionId);
  if (!auction) {
    throw new Error("Auction not found");
  }

  if (auction.status !== "RELEASED" && auction.status !== "LIVE") {
    throw new Error("Bots can only be registered for RELEASED or LIVE auctions");
  }

  await stopBotsForAuction(config.auctionId);

  const startTgId = config.startTgId || 2000000;
  const botSet: ActiveBotSet = {
    config,
    bots: new Map(),
  };

  const botTgIds: number[] = [];

  for (let i = 0; i < config.numBots; i++) {
    const tgId = startTgId + i;
    try {
      const user = await ensureUserByTgId(tgId);
      
      const balancePerBot = config.bidAmountMax * config.bidsPerBot * 2;
      await adjustUserBalanceByTgId(tgId, balancePerBot);

      const bot: Bot = {
        auctionId: config.auctionId,
        tgId,
        userId: user._id.toString(),
        config,
        isActive: true,
      };

      botSet.bots.set(tgId, bot);
      botTgIds.push(tgId);
    } catch (error: any) {
      console.error(`Failed to create bot user ${tgId}:`, error.message);
    }
  }

  activeBots.set(config.auctionId, botSet);

  console.log(
    `Registered ${botSet.bots.size} bots for auction ${config.auctionId}`
  );

  if (botSet.bots.size > 0) {
    const currentRoundIdx = auction.current_round_idx ?? 0;
    const currentRound = await Round.findOne({
      auction_id: config.auctionId,
      idx: currentRoundIdx,
    }).lean();

    if (currentRound) {
      const now = Date.now();
      const actualEndTime = currentRound.extended_until
        ? currentRound.extended_until.getTime()
        : currentRound.ended_at.getTime();

      if (now < actualEndTime) {
        const roundKey = `${config.auctionId}-${currentRoundIdx}`;
        processedRounds.delete(roundKey);
        const delay = currentRoundIdx === 0 ? 100 : 50;
        console.log(`Registered bots for auction ${config.auctionId}, round ${currentRoundIdx}, starting in ${delay}ms`);
        setTimeout(() => {
          runBotsForRound(config.auctionId, currentRoundIdx).catch((error) => {
            console.error(
              `Error running bots for auction ${config.auctionId}, round ${currentRoundIdx}:`,
              error
            );
          });
        }, delay);
      } else {
        console.log(`Round ${currentRoundIdx} for auction ${config.auctionId} has already ended, skipping bot start`);
      }
    } else if (currentRoundIdx === 0) {
      console.log(`Round 0 not found for auction ${config.auctionId}, waiting for round creation...`);
      setTimeout(async () => {
        const round = await Round.findOne({
          auction_id: config.auctionId,
          idx: 0,
        }).lean();
        
        if (round) {
          const now = Date.now();
          const actualEndTime = round.extended_until
            ? round.extended_until.getTime()
            : round.ended_at.getTime();

          if (now < actualEndTime) {
            const roundKey = `${config.auctionId}-0`;
            processedRounds.delete(roundKey);
            console.log(`Round 0 found for auction ${config.auctionId}, starting bots`);
            runBotsForRound(config.auctionId, 0).catch((error) => {
              console.error(
                `Error running bots for auction ${config.auctionId}, round 0:`,
                error
              );
            });
          } else {
            console.log(`Round 0 for auction ${config.auctionId} has already ended, skipping bot start`);
          }
        } else {
          console.log(`Round 0 still not found for auction ${config.auctionId} after wait`);
        }
      }, 500);
    }
  }

  return {
    registered: botSet.bots.size,
    auctionId: config.auctionId,
    botTgIds,
  };
}

export async function stopBotsForAuction(auctionId: string): Promise<{
  stopped: number;
}> {
  const botSet = activeBots.get(auctionId);
  if (!botSet) {
    return { stopped: 0 };
  }

  for (const bot of botSet.bots.values()) {
    bot.isActive = false;
  }

  activeBots.delete(auctionId);
  
  for (const key of processedRounds) {
    if (key.startsWith(`${auctionId}-`)) {
      processedRounds.delete(key);
    }
  }

  const stopped = botSet.bots.size;
  console.log(`Stopped ${stopped} bots for auction ${auctionId}`);

  return { stopped };
}

export function getBotsForAuction(auctionId: string): {
  numBots: number;
  config: BotConfig | null;
} {
  const botSet = activeBots.get(auctionId);
  if (!botSet) {
    return { numBots: 0, config: null };
  }

  return {
    numBots: botSet.bots.size,
    config: botSet.config,
  };
}

export function clearProcessedRound(auctionId: string, roundIdx: number): void {
  const roundKey = `${auctionId}-${roundIdx}`;
  processedRounds.delete(roundKey);
}

export async function runBotsForRound(
  auctionId: string,
  roundIdx: number
): Promise<{
  bidsPlaced: number;
  errors: number;
}> {
  const roundKey = `${auctionId}-${roundIdx}`;
  
  if (processedRounds.has(roundKey)) {
    console.log(`Bots already processed for auction ${auctionId}, round ${roundIdx}, skipping`);
    return { bidsPlaced: 0, errors: 0 };
  }
  
  const botSet = activeBots.get(auctionId);
  if (!botSet || botSet.bots.size === 0) {
    console.log(`No active bots found for auction ${auctionId}, round ${roundIdx}`);
    return { bidsPlaced: 0, errors: 0 };
  }
  
  processedRounds.add(roundKey);

  const auction = await getAuctionById(auctionId);
  if (!auction) {
    console.log(`Auction ${auctionId} not found, skipping bots for round ${roundIdx}`);
    return { bidsPlaced: 0, errors: 0 };
  }

  const round = await Round.findOne({
    auction_id: auctionId,
    idx: roundIdx,
  }).lean();

  if (!round) {
    console.warn(`Round ${roundIdx} not found for auction ${auctionId}`);
    return { bidsPlaced: 0, errors: 0 };
  }

  const now = Date.now();
  const actualEndTime = round.extended_until
    ? round.extended_until.getTime()
    : round.ended_at.getTime();

  if (now >= actualEndTime) {
    console.log(`Round ${roundIdx} for auction ${auctionId} has already ended, skipping bots`);
    return { bidsPlaced: 0, errors: 0 };
  }

  const minBidForRound = await getMinBidForRound(auctionId, roundIdx);
  const effectiveMinBid = Math.max(minBidForRound, botSet.config.bidAmountMin);
  const auctionMaxBid = auction.min_bid * 10;
  const effectiveMaxBid =
    botSet.config.bidAmountMax > 0
      ? Math.min(botSet.config.bidAmountMax, auctionMaxBid)
      : auctionMaxBid;

  if (effectiveMinBid > effectiveMaxBid) {
    console.warn(
      `Invalid bid range for bots: ${effectiveMinBid} > ${effectiveMaxBid}`
    );
    return { bidsPlaced: 0, errors: 0 };
  }

  console.log(
    `Running ${botSet.bots.size} bots for auction ${auctionId}, round ${roundIdx}`
  );

  let bidsPlaced = 0;
  let errors = 0;

  const bidTasks: Array<{
    bot: Bot;
    amount: number;
  }> = [];

  for (const bot of botSet.bots.values()) {
    if (!bot.isActive || !bot.userId) continue;

    for (let i = 0; i < botSet.config.bidsPerBot; i++) {
      const amount =
        Math.floor(
          Math.random() * (effectiveMaxBid - effectiveMinBid + 1)
        ) + effectiveMinBid;
      bidTasks.push({ bot, amount });
    }
  }

  for (let i = bidTasks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bidTasks[i], bidTasks[j]] = [bidTasks[j], bidTasks[i]];
  }

  for (const task of bidTasks) {
    if (!task.bot.isActive) continue;

    try {
      const idempotencyKey = randomUUID();
      const roundId = round._id.toString();

      await createBidWithBalanceDeductionRedis(
        auctionId,
        roundId,
        task.bot.userId!,
        task.bot.tgId,
        task.amount,
        idempotencyKey
      );

      bidsPlaced++;
      
      broadcastAuctionUpdate(auctionId, true).catch(error => {
        console.error(`Error broadcasting auction update after bot bid:`, error);
      });

      if (botSet.config.delayBetweenBidsMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, botSet.config.delayBetweenBidsMs)
        );
      }
    } catch (error: any) {
      errors++;
      if (
        !error.message?.includes("insufficient balance") &&
        !error.message?.includes("round has ended") &&
        !error.message?.includes("auction is not live")
      ) {
        console.error(
          `Error placing bid for bot ${task.bot.tgId}:`,
          error.message
        );
      }
    }
  }

  console.log(
    `Bots completed for auction ${auctionId}, round ${roundIdx}: ${bidsPlaced} bids placed, ${errors} errors`
  );

  return { bidsPlaced, errors };
}

export function clearAllBots(): void {
  for (const botSet of activeBots.values()) {
    for (const bot of botSet.bots.values()) {
      bot.isActive = false;
    }
  }
  activeBots.clear();
  processedRounds.clear();
}
