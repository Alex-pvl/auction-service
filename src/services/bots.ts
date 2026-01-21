import { Auction, Round, Bid } from "../storage/mongo.js";
import type { Auction as AuctionType } from "../models/types.js";
import type { RedisClientType } from "redis";
import { getTopBids, getUserBid, getUserPlace } from "./bids.js";
import { ensureUserByTgId, adjustUserBalanceByTgId } from "./users.js";
import { createOrUpdateBid, addToBid } from "./bids.js";
import { markAuctionForUpdate } from "./websocket.js";

export type BotStrategy = "aggressive" | "conservative" | "random" | "adaptive";

export interface BotConfig {
  tg_id: number;
  username: string;
  initial_balance: number;
  strategy: BotStrategy;
  min_bid_interval_ms: number; 
  max_bid_interval_ms: number; 
  bid_probability: number; 
  min_bid_multiplier: number; 
  max_bid_multiplier: number; 
}

function generateBotConfigs(count: number = 500): BotConfig[] {
  const configs: BotConfig[] = [];
  const baseTgId = 1000000;
  const strategies: BotStrategy[] = ["aggressive", "conservative", "random", "adaptive"];
  
  const strategyCounts = {
    aggressive: Math.floor(count * 0.3),
    conservative: Math.floor(count * 0.2),
    random: Math.floor(count * 0.3),
    adaptive: count - Math.floor(count * 0.3) - Math.floor(count * 0.2) - Math.floor(count * 0.3),
  };

  let tgIdCounter = baseTgId + 1;
  let botNumber = 1;
  
  for (let i = 0; i < strategyCounts.aggressive; i++) {
    configs.push({
      tg_id: tgIdCounter++,
      username: `AggressiveBot_${botNumber++}`,
      initial_balance: 8000 + Math.random() * 4000, 
      strategy: "aggressive",
      min_bid_interval_ms: 2000 + Math.random() * 2000, 
      max_bid_interval_ms: 5000 + Math.random() * 3000, 
      bid_probability: 0.6 + Math.random() * 0.2, 
      min_bid_multiplier: 1.1 + Math.random() * 0.2, 
      max_bid_multiplier: 1.8 + Math.random() * 0.4, 
    });
  }
  
  for (let i = 0; i < strategyCounts.conservative; i++) {
    configs.push({
      tg_id: tgIdCounter++,
      username: `ConservativeBot_${botNumber++}`,
      initial_balance: 12000 + Math.random() * 6000, 
      strategy: "conservative",
      min_bid_interval_ms: 8000 + Math.random() * 4000, 
      max_bid_interval_ms: 15000 + Math.random() * 5000, 
      bid_probability: 0.3 + Math.random() * 0.2, 
      min_bid_multiplier: 1.5 + Math.random() * 0.3, 
      max_bid_multiplier: 2.8 + Math.random() * 0.4, 
    });
  }
  
  for (let i = 0; i < strategyCounts.random; i++) {
    configs.push({
      tg_id: tgIdCounter++,
      username: `RandomBot_${botNumber++}`,
      initial_balance: 6000 + Math.random() * 6000, 
      strategy: "random",
      min_bid_interval_ms: 3000 + Math.random() * 4000, 
      max_bid_interval_ms: 8000 + Math.random() * 7000, 
      bid_probability: 0.4 + Math.random() * 0.3, 
      min_bid_multiplier: 1.0 + Math.random() * 0.5, 
      max_bid_multiplier: 2.0 + Math.random() * 1.0, 
    });
  }

  for (let i = 0; i < strategyCounts.adaptive; i++) {
    configs.push({
      tg_id: tgIdCounter++,
      username: `AdaptiveBot_${botNumber++}`,
      initial_balance: 10000 + Math.random() * 5000, 
      strategy: "adaptive",
      min_bid_interval_ms: 4000 + Math.random() * 3000, 
      max_bid_interval_ms: 10000 + Math.random() * 5000, 
      bid_probability: 0.5 + Math.random() * 0.2, 
      min_bid_multiplier: 1.2 + Math.random() * 0.3, 
      max_bid_multiplier: 2.5 + Math.random() * 0.6, 
    });
  }

  return configs;
}

const BOTS_COUNT = Number(process.env.BOTS_COUNT) || 500;
const BOT_CONFIGS = generateBotConfigs(BOTS_COUNT);

const activeBots = new Map<string, NodeJS.Timeout>(); 
let redisClient: RedisClientType<any, any, any> | null = null;
const BOT_BID_QUEUE = "bot_bid_queue";
const BOT_LOCK_PREFIX = "bot_lock:";
let botBidProcessorInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

export async function initializeBots(redis?: RedisClientType<any, any, any>) {
  redisClient = redis || null;
  console.log(`Initializing bot system (${BOT_CONFIGS.length} bot configs available, max ${Number(process.env.MAX_BOTS_PER_AUCTION) || 200} per auction)...`);
  
  const strategyCounts = BOT_CONFIGS.reduce((acc, bot) => {
    acc[bot.strategy] = (acc[bot.strategy] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`Bot distribution:`, strategyCounts);
  
  if (redisClient) {
    // Проверяем, открыт ли Redis, если нет - ждем
    if (redisClient.isOpen) {
      startBotBidProcessor();
    } else {
      console.log("Redis client not open yet, will start processor when Redis connects...");
      // Попробуем запустить процессор позже, когда Redis откроется
      const checkRedis = setInterval(() => {
        if (redisClient && redisClient.isOpen && !botBidProcessorInterval) {
          console.log("Redis client is now open, starting bot bid processor...");
          startBotBidProcessor();
          clearInterval(checkRedis);
        }
      }, 1000);
      
      // Остановим проверку через 30 секунд, если Redis так и не откроется
      setTimeout(() => {
        clearInterval(checkRedis);
        if (!botBidProcessorInterval && redisClient && redisClient.isOpen) {
          startBotBidProcessor();
        }
      }, 30000);
    }
  } else {
    console.log("Bot bid processor will run in direct mode (no Redis queue)");
  }
  
  console.log(`Bot system initialized. Bots will be created and started when auctions begin.`);
}

async function createBotsInDatabase() {
  console.log(`Creating ${BOT_CONFIGS.length} bot users in database...`);
  
  const { User } = await import("../storage/mongo.js");
  const batchSize = 100;
  
  for (let i = 0; i < BOT_CONFIGS.length; i += batchSize) {
    const batch = BOT_CONFIGS.slice(i, i + batchSize);
    const bulkOps: any[] = [];

    for (const config of batch) {
      bulkOps.push({
        updateOne: {
          filter: { tg_id: config.tg_id },
          update: {
            $set: {
              username: config.username, 
            },
            $setOnInsert: {
              tg_id: config.tg_id,
              balance: config.initial_balance, 
            },
          },
          upsert: true,
        },
      });
    }
    
    const balanceOps: any[] = [];
    for (const config of batch) {
      balanceOps.push({
        updateOne: {
          filter: { 
            tg_id: config.tg_id,
            balance: { $lt: config.initial_balance } 
          },
          update: {
            $set: {
              balance: config.initial_balance,
            },
          },
        },
      });
    }

    try {
      await User.bulkWrite(bulkOps, { ordered: false });
     
      if (balanceOps.length > 0) {
        await User.bulkWrite(balanceOps, { ordered: false });
      }
      console.log(`Created bots batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(BOT_CONFIGS.length / batchSize)}`);
    } catch (error) {
      console.error(`Error creating bots batch ${Math.floor(i / batchSize) + 1}:`, error);
      for (const config of batch) {
        try {
          const user = await ensureUserByTgId(config.tg_id);
          if (user.balance < config.initial_balance) {
            await adjustUserBalanceByTgId(config.tg_id, config.initial_balance - user.balance);
          }
        } catch (err) {
          console.error(`Error creating bot ${config.username}:`, err);
        }
      }
    }
  }
  
  console.log(`Bot users created in database.`);
}

export async function createAndStartBotsForAuction(auctionId: string) {
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) {
    console.warn(`Cannot create bots for auction ${auctionId}: auction not found`);
    return;
  }
  if (auction.status !== "LIVE") {
    console.warn(`Cannot create bots for auction ${auctionId}: status is ${auction.status}, expected LIVE`);
    return;
  }

  console.log(`Creating and starting bots for auction ${auctionId}...`);
  
  // Создаем ботов в базе данных
  await createBotsInDatabase();
  
  // Запускаем ботов для аукциона
  await startBotsForAuction(auctionId);
}

export async function startBotsForAuction(auctionId: string) {
  stopBotsForAuction(auctionId);
  const auction = await Auction.findById(auctionId).lean();
  if (!auction) {
    console.warn(`Cannot start bots for auction ${auctionId}: auction not found`);
    return;
  }
  if (auction.status !== "LIVE") {
    console.warn(`Cannot start bots for auction ${auctionId}: status is ${auction.status}, expected LIVE`);
    return;
  }

  console.log(`Starting bots for auction ${auctionId} (round ${auction.current_round_idx})`);
  const maxConcurrentBots = Math.min(
    BOT_CONFIGS.length, 
    Number(process.env.MAX_BOTS_PER_AUCTION) || 200
  );
  
  const shuffledBots = [...BOT_CONFIGS].sort(() => Math.random() - 0.5);
  const botsToStart = shuffledBots.slice(0, maxConcurrentBots);
  
  console.log(`Scheduling ${botsToStart.length} bots for auction ${auctionId}`);
  
  for (const config of botsToStart) {
    const initialDelay = Math.random() * 2000; 
    const interval = getBotInterval(config);
    
    const timeout = setTimeout(() => {
      scheduleBotBid(auctionId, config);
      
      const scheduleNext = () => {
        const nextInterval = getBotInterval(config);
        const nextTimeout = setTimeout(() => {
          scheduleBotBid(auctionId, config);
          scheduleNext(); 
        }, nextInterval);
        activeBots.set(`${auctionId}-${config.tg_id}-next`, nextTimeout as any);
      };
      scheduleNext();
    }, initialDelay);

    activeBots.set(`${auctionId}-${config.tg_id}-timeout`, timeout as any);
  }
  
  console.log(`Scheduled ${botsToStart.length} bots, first bids will start in 0-2 seconds`);
}

export function stopBotsForAuction(auctionId: string) {
  for (const [key, timeout] of activeBots.entries()) {
    if (key.startsWith(`${auctionId}-`)) {
      clearTimeout(timeout);
      clearInterval(timeout);
      activeBots.delete(key);
    }
  }
  
  if (redisClient && !isShuttingDown && redisClient.isOpen) {
    try {
      const maxConcurrentBots = Math.min(
        BOT_CONFIGS.length, 
        Number(process.env.MAX_BOTS_PER_AUCTION) || 200
      );
      for (let i = 0; i < maxConcurrentBots; i++) {
        const config = BOT_CONFIGS[i];
        if (config) {
          const lockKey = `${BOT_LOCK_PREFIX}${auctionId}-${config.tg_id}`;
          redisClient.del(lockKey).catch(() => {});
        }
      }
    } catch (error) {
      // do nothing
    }
  }
}

async function scheduleBotBid(auctionId: string, config: BotConfig) {
  if (isShuttingDown) {
    return;
  }
  
  const lockKey = `${BOT_LOCK_PREFIX}${auctionId}-${config.tg_id}`;
  
  if (redisClient && !isShuttingDown && redisClient.isOpen) {
    try {
      const locked = await redisClient.get(lockKey);
      if (locked) {
        return; 
      }
      await redisClient.setEx(lockKey, 5, "1");
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Redis lock error:", error);
      }
      // Продолжаем выполнение даже если блокировка не удалась
    }
  }
  
  if (isShuttingDown) {
    return;
  }
  
  if (redisClient && !isShuttingDown && redisClient.isOpen && botBidProcessorInterval) {
    try {
      await redisClient.rPush(
        BOT_BID_QUEUE,
        JSON.stringify({ auction_id: auctionId, bot_config: config })
      );
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Redis queue error:", error);
      }
      // Если очередь не работает, выполняем напрямую
      await executeBotBid(auctionId, config);
    }
  } else {
    // Выполняем напрямую если Redis недоступен или процессор не запущен
    await executeBotBid(auctionId, config);
  }
}

function startBotBidProcessor() {
  if (!redisClient) {
    console.warn("Bot bid processor not started: Redis client not available");
    return;
  }
  
  if (botBidProcessorInterval) {
    clearInterval(botBidProcessorInterval);
  }
  
  console.log("Starting bot bid processor...");
  botBidProcessorInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    
    try {
      if (!redisClient || !redisClient.isOpen || isShuttingDown) {
        return;
      }
      
      const result = await redisClient.blPop(
        redisClient.commandOptions({ isolated: true }),
        BOT_BID_QUEUE,
        1
      );
      if (!result) return;
      const task = JSON.parse(result.element);
      await executeBotBid(task.auction_id, task.bot_config);
    } catch (error) {
      if (!isShuttingDown) {
        console.error("Error in bot bid processor:", error);
      }
    }
  }, 100);
}

export async function shutdownBots(): Promise<void> {
  console.log("Shutting down bots...");
  
  isShuttingDown = true;
  
  if (botBidProcessorInterval) {
    clearInterval(botBidProcessorInterval);
    botBidProcessorInterval = null;
  }
  
  const auctionIds = new Set<string>();
  for (const key of activeBots.keys()) {
    const auctionId = key.split("-")[0];
    if (auctionId) {
      auctionIds.add(auctionId);
    }
  }
  
  for (const auctionId of auctionIds) {
    stopBotsForAuction(auctionId);
  }
  
  for (const timeout of activeBots.values()) {
    clearTimeout(timeout);
    clearInterval(timeout);
  }
  activeBots.clear();
  
  console.log("Bots shutdown complete");
}

async function executeBotBid(auctionId: string, config: BotConfig) {
  try {
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
    const roundEndTime = currentRound.extended_until
      ? currentRound.extended_until.getTime()
      : currentRound.ended_at.getTime();
    if (now >= roundEndTime) {
      return;
    }
    const botUser = await ensureUserByTgId(config.tg_id);
    const { getMinBidForRound } = await import("./bids.js");
    const minBidForRound = await getMinBidForRound(auctionId, auction.current_round_idx);
    
    if (!botUser || botUser.balance < minBidForRound) {
      return;
    }
    
    const shouldBid = await shouldBotMakeBid(
      auctionId, 
      currentRound._id.toString(), 
      config, 
      botUser._id.toString(),
      Math.floor(auction.winners_per_round)
    );
    if (!shouldBid) {
      return;
    }
    
    const bidAmount = await calculateBotBidAmount(
      auction, 
      currentRound, 
      config, 
      botUser._id.toString(),
      Math.floor(auction.winners_per_round)
    );
    
    if (!bidAmount || bidAmount < minBidForRound || bidAmount > botUser.balance) {
      return;
    }
    
    // Убеждаемся, что bidAmount - целое число
    const finalBidAmount = Math.round(bidAmount);
    if (finalBidAmount < minBidForRound || finalBidAmount > botUser.balance) {
      return;
    }

    const existingBid = await getUserBid(auctionId, currentRound._id.toString(), botUser._id.toString());
    const idempotencyKey = `bot-${config.tg_id}-${auctionId}-${currentRound._id}-${Date.now()}`;

    let bidUpdated = false;
    if (existingBid) {
      const additionalAmount = finalBidAmount - existingBid.amount;
      if (additionalAmount > 0) {
        await addToBid(
          auctionId,
          currentRound._id.toString(),
          botUser._id.toString(),
          additionalAmount,
          idempotencyKey
        );
        await adjustUserBalanceByTgId(config.tg_id, -additionalAmount);
        bidUpdated = true;
      }
    } else {
      await createOrUpdateBid({
        auction_id: auctionId,
        round_id: currentRound._id.toString(),
        user_id: botUser._id.toString(),
        amount: finalBidAmount,
        idempotency_key: idempotencyKey,
      });
      await adjustUserBalanceByTgId(config.tg_id, -finalBidAmount);
      bidUpdated = true;
    }
    
    if (bidUpdated) {
      console.log(`Bot ${config.username} placed bid ${finalBidAmount.toFixed(2)} in auction ${auctionId}`);
      // Помечаем аукцион для обновления через периодический механизм
      // вместо немедленного broadcast, чтобы не перегружать вебсокет
      markAuctionForUpdate(auctionId);
    }
  } catch (error) {
    console.error(`Error executing bot bid for ${config.username}:`, error);
  } finally {
    if (redisClient && !isShuttingDown && redisClient.isOpen) {
      try {
        const lockKey = `${BOT_LOCK_PREFIX}${auctionId}-${config.tg_id}`;
        await redisClient.del(lockKey);
      } catch (error) {
        // do nothing
      }
    }
  }
}

async function shouldBotMakeBid(
  auctionId: string,
  roundId: string,
  config: BotConfig,
  botUserId: string,
  winnersPerRound: number
): Promise<boolean> {
  const userBid = await getUserBid(auctionId, roundId, botUserId);
  const userPlace = userBid ? await getUserPlace(auctionId, roundId, botUserId) : null;
  
  if (userPlace !== null && userPlace <= winnersPerRound) {
    return false;
  }
  
  let probability = config.bid_probability;
  switch (config.strategy) {
    case "aggressive":
      probability = 0.8;
      break;
    case "conservative":
      probability = 0.3;
      break;
    case "random":
      probability = config.bid_probability;
      break;
    case "adaptive":
      if (!userPlace) {
        probability = 0.9; 
      } else {
        const distanceFromTop = userPlace - winnersPerRound;
        probability = Math.min(0.9, 0.4 + distanceFromTop * 0.1); 
      }
      break;
    default:
      probability = config.bid_probability;
  }

  return Math.random() < probability;
}

async function calculateBotBidAmount(
  auction: AuctionType,
  round: any,
  config: BotConfig,
  botUserId: string,
  winnersPerRound: number
): Promise<number> {
  const userBid = await getUserBid(auction._id.toString(), round._id.toString(), botUserId);
  const { getAllBidsInRound } = await import("./bids.js");
  const allBids = await getAllBidsInRound(auction._id.toString(), round._id.toString());
  const { getMinBidForRound } = await import("./bids.js");
  const minBidForRound = await getMinBidForRound(auction._id.toString(), round.idx);
  if (allBids.length === 0) {
    return minBidForRound;
  }
  
  // Безопасно получаем последнюю ставку из топ-N
  const lastTopBid = allBids.length >= winnersPerRound ? allBids[winnersPerRound - 1] : null;
  const currentBidAmount = userBid?.amount || 0;
  let targetAmount: number;
  
  if (lastTopBid) {
    const minAmountToBeat = lastTopBid.amount;
    const neededAmount = minAmountToBeat - currentBidAmount;
    let marginMultiplier = 1.01; 
    
    switch (config.strategy) {
      case "aggressive":
        marginMultiplier = 1.02 + Math.random() * 0.03; 
        break;
      case "conservative":
        marginMultiplier = 1.05 + Math.random() * 0.05; 
        break;
      case "random":
        marginMultiplier = 1.01 + Math.random() * 0.04; 
        break;
      case "adaptive":
        
        const userPlace = userBid ? await getUserPlace(auction._id.toString(), round._id.toString(), botUserId) : null;
        if (userPlace) {
          const distanceFromTop = userPlace - winnersPerRound;
          
          marginMultiplier = 1.02 + Math.min(0.1, distanceFromTop * 0.01);
        } else {
          marginMultiplier = 1.03 + Math.random() * 0.02;
        }
        break;
    }
    
    if (currentBidAmount > 0) {
      targetAmount = currentBidAmount + neededAmount * marginMultiplier;
    } else {
      targetAmount = minAmountToBeat * marginMultiplier;
    }
  } else {
    // Если ставок меньше чем winnersPerRound, используем минимальную ставку или немного больше
    targetAmount = minBidForRound;
  }
  
  targetAmount = Math.max(targetAmount, minBidForRound);
  const minAmount = minBidForRound * config.min_bid_multiplier;
  const maxAmount = minBidForRound * config.max_bid_multiplier;
  
  // Убеждаемся, что targetAmount находится в допустимых пределах
  if (targetAmount < minAmount) {
    targetAmount = Math.max(minAmount, minBidForRound);
  }
  
  targetAmount = Math.min(targetAmount, maxAmount);
  return Math.round(targetAmount);
}

function getBotInterval(config: BotConfig): number {
  return config.min_bid_interval_ms + 
    Math.random() * (config.max_bid_interval_ms - config.min_bid_interval_ms);
}
