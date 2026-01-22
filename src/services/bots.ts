import { randomUUID } from "node:crypto";
import { Auction, Round, User } from "../storage/mongo.js";
import { getAuctionById } from "./auctions.js";
import { getMinBidForRound, createBidWithBalanceDeduction } from "./bids.js";
import { ensureUserByTgId, adjustUserBalanceByTgId } from "./users.js";
import { broadcastAuctionUpdate } from "./websocket.js";

export interface BotConfig {
  auctionId: string;
  numBots: number;
  bidsPerBot: number;
  bidAmountMin: number;
  bidAmountMax: number;
  delayBetweenBidsMs: number;
  startTgId?: number; // Начальный tg_id для ботов (по умолчанию 2000000)
}

interface Bot {
  auctionId: string;
  tgId: number;
  userId: string | null; // MongoDB user._id
  config: BotConfig;
  isActive: boolean;
}

interface ActiveBotSet {
  config: BotConfig;
  bots: Map<number, Bot>; // tgId -> Bot
}

// Хранилище активных ботов по auctionId
const activeBots = new Map<string, ActiveBotSet>();

// Отслеживание запущенных раундов для предотвращения повторного запуска
const processedRounds = new Set<string>(); // формат: "auctionId-roundIdx"

/**
 * Регистрирует ботов для аукциона
 */
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

  // Останавливаем существующих ботов для этого аукциона, если есть
  await stopBotsForAuction(config.auctionId);

  const startTgId = config.startTgId || 2000000;
  const botSet: ActiveBotSet = {
    config,
    bots: new Map(),
  };

  const botTgIds: number[] = [];

  // Создаем пользователей для ботов
  for (let i = 0; i < config.numBots; i++) {
    const tgId = startTgId + i;
    try {
      const user = await ensureUserByTgId(tgId);
      
      // Устанавливаем баланс для ботов (достаточно для всех ставок)
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

  // Если аукцион уже LIVE, проверяем текущий раунд и запускаем ботов для него
  if (auction.status === "LIVE" && botSet.bots.size > 0) {
    const currentRound = await Round.findOne({
      auction_id: config.auctionId,
      idx: auction.current_round_idx ?? 0,
    }).lean();

    if (currentRound) {
      const now = Date.now();
      const actualEndTime = currentRound.extended_until
        ? currentRound.extended_until.getTime()
        : currentRound.ended_at.getTime();

      // Если раунд еще активен, запускаем ботов для него
      if (now < actualEndTime) {
        const roundKey = `${config.auctionId}-${currentRound.idx}`;
        // Удаляем из processedRounds, чтобы можно было запустить ботов заново
        processedRounds.delete(roundKey);
        // Запускаем ботов для текущего раунда асинхронно
        runBotsForRound(config.auctionId, currentRound.idx).catch((error) => {
          console.error(
            `Error running bots for auction ${config.auctionId}, round ${currentRound.idx}:`,
            error
          );
        });
      }
    }
  }

  return {
    registered: botSet.bots.size,
    auctionId: config.auctionId,
    botTgIds,
  };
}

/**
 * Останавливает всех ботов для аукциона
 */
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
  
  // Очищаем обработанные раунды для этого аукциона
  for (const key of processedRounds) {
    if (key.startsWith(`${auctionId}-`)) {
      processedRounds.delete(key);
    }
  }

  const stopped = botSet.bots.size;
  console.log(`Stopped ${stopped} bots for auction ${auctionId}`);

  return { stopped };
}

/**
 * Получает информацию о ботах для аукциона
 */
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

/**
 * Запускает ботов для конкретного раунда
 */
export async function runBotsForRound(
  auctionId: string,
  roundIdx: number
): Promise<{
  bidsPlaced: number;
  errors: number;
}> {
  const roundKey = `${auctionId}-${roundIdx}`;
  
  // Проверяем, не запускались ли уже боты для этого раунда
  if (processedRounds.has(roundKey)) {
    console.log(`Bots already processed for auction ${auctionId}, round ${roundIdx}, skipping`);
    return { bidsPlaced: 0, errors: 0 };
  }
  
  const botSet = activeBots.get(auctionId);
  if (!botSet || botSet.bots.size === 0) {
    return { bidsPlaced: 0, errors: 0 };
  }
  
  // Помечаем раунд как обработанный
  processedRounds.add(roundKey);

  const auction = await getAuctionById(auctionId);
  if (!auction || auction.status !== "LIVE") {
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

  // Создаем задачи для ставок
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

  // Перемешиваем задачи для более реалистичного поведения
  for (let i = bidTasks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bidTasks[i], bidTasks[j]] = [bidTasks[j], bidTasks[i]];
  }

  // Выполняем ставки с задержкой
  for (const task of bidTasks) {
    if (!task.bot.isActive) continue;

    try {
      const idempotencyKey = randomUUID();
      const roundId = round._id.toString();

      await createBidWithBalanceDeduction(
        {
          auction_id: auctionId,
          round_id: roundId,
          user_id: task.bot.userId,
          amount: task.amount,
          idempotency_key: idempotencyKey,
        },
        task.bot.tgId,
        task.amount
      );

      bidsPlaced++;
      
      // Отправляем обновление вебсокета после каждой ставки бота (асинхронно, чтобы не блокировать)
      broadcastAuctionUpdate(auctionId, true).catch(error => {
        console.error(`Error broadcasting auction update after bot bid:`, error);
      });

      // Задержка между ставками
      if (botSet.config.delayBetweenBidsMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, botSet.config.delayBetweenBidsMs)
        );
      }
    } catch (error: any) {
      errors++;
      // Игнорируем некоторые ошибки (например, недостаточно баланса, раунд закончился)
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

/**
 * Очищает всех ботов (для shutdown)
 */
export function clearAllBots(): void {
  for (const botSet of activeBots.values()) {
    for (const bot of botSet.bots.values()) {
      bot.isActive = false;
    }
  }
  activeBots.clear();
  processedRounds.clear();
}
