import { Deliveries, Auction, Round, Bid } from "../storage/mongo.js";
import type { Deliveries as DeliveriesType, DeliveryStatus } from "../models/types.js";
import mongoose from "mongoose";

const DELIVERY_PROCESSING_DELAY_MS = 1000;

export async function createDeliveriesForWinners(
  auctionId: string,
  roundId: string,
  winnerBids: Array<{ user_id: string }>,
  itemName: string
): Promise<DeliveriesType[]> {
  if (winnerBids.length === 0) {
    return [];
  }

  const auction = await Auction.findById(auctionId).lean();
  if (!auction) {
    throw new Error(`Auction ${auctionId} not found`);
  }

  if (auction.remaining_items_count <= 0) {
    console.log(`No items remaining for auction ${auctionId}, skipping delivery creation`);
    return [];
  }

  const deliveries: DeliveriesType[] = [];
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const bid of winnerBids) {
      const existingDelivery = await Deliveries.findOne({
        auction_id: auctionId,
        round_id: roundId,
        winner_user_id: bid.user_id,
      }).session(session).lean();

      if (existingDelivery) {
        console.log(`Delivery already exists for user ${bid.user_id} in round ${roundId}`);
        continue;
      }

      const delivery = await Deliveries.create([{
        auction_id: auctionId,
        round_id: roundId,
        winner_user_id: bid.user_id,
        item_name: itemName,
        status: "PENDING",
      }], { session });

      deliveries.push(delivery[0].toObject());
    }

    await session.commitTransaction();
    console.log(`Created ${deliveries.length} deliveries for auction ${auctionId}, round ${roundId}`);

    for (const delivery of deliveries) {
      scheduleDeliveryProcessing(delivery._id.toString());
    }

    return deliveries;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

function scheduleDeliveryProcessing(deliveryId: string) {
  setTimeout(async () => {
    try {
      await processDelivery(deliveryId);
    } catch (error) {
      console.error(`Error processing delivery ${deliveryId}:`, error);
    }
  }, DELIVERY_PROCESSING_DELAY_MS);
}

async function processDelivery(deliveryId: string): Promise<void> {
  const delivery = await Deliveries.findById(deliveryId).lean();
  if (!delivery) {
    console.warn(`Delivery ${deliveryId} not found`);
    return;
  }

  if (delivery.status !== "PENDING") {
    console.log(`Delivery ${deliveryId} is already processed (status: ${delivery.status})`);
    return;
  }

  const newStatus: DeliveryStatus = "DELIVERED";
  await Deliveries.findByIdAndUpdate(deliveryId, {
    status: newStatus,
    updated_at: new Date(),
  });

  console.log(
    `Delivery ${deliveryId} processed: ${newStatus} for user ${delivery.winner_user_id}, item: ${delivery.item_name}`
  );
}

export async function getDeliveriesByUser(userId: string): Promise<DeliveriesType[]> {
  return Deliveries.find({ winner_user_id: userId })
    .sort({ created_at: -1 })
    .lean();
}

export async function getDeliveriesByAuction(auctionId: string): Promise<DeliveriesType[]> {
  return Deliveries.find({ auction_id: auctionId })
    .sort({ created_at: -1 })
    .lean();
}

export async function getDeliveriesByRound(
  auctionId: string,
  roundId: string
): Promise<DeliveriesType[]> {
  return Deliveries.find({ auction_id: auctionId, round_id: roundId })
    .sort({ created_at: -1 })
    .lean();
}

export async function getDeliveriesByUserAndAuction(
  userId: string,
  auctionId: string
): Promise<DeliveriesType[]> {
  return Deliveries.find({ winner_user_id: userId, auction_id: auctionId })
    .sort({ created_at: 1 })
    .lean();
}

export async function getUserWonItemsWithNumbers(
  userId: string,
  auctionId: string
): Promise<Array<{ item_name: string; item_no: number; bid_amount: number }>> {
  const userDeliveries = await Deliveries.find({ 
    winner_user_id: userId, 
    auction_id: auctionId 
  }).lean();

  if (userDeliveries.length === 0) {
    return [];
  }

  const allDeliveries = await Deliveries.find({ auction_id: auctionId }).lean();
  
  const rounds = await Round.find({ auction_id: auctionId })
    .sort({ idx: 1 })
    .lean();
  
  const roundMap = new Map(rounds.map(r => [r._id.toString(), r.idx]));

  const roundIds = [...new Set(allDeliveries.map(d => d.round_id))];
  const userIds = [...new Set(allDeliveries.map(d => d.winner_user_id))];
  
  const allBids = await Bid.find({
    auction_id: auctionId,
    round_id: { $in: roundIds },
    user_id: { $in: userIds },
  }).lean();
  
  const bidMap = new Map<string, typeof allBids[0]>();
  allBids.forEach(bid => {
    const key = `${bid.round_id}:${bid.user_id}`;
    bidMap.set(key, bid);
  });

  const deliveriesWithInfo = allDeliveries.map((delivery) => {
    const roundIdx = roundMap.get(delivery.round_id) ?? 999;
    
    const key = `${delivery.round_id}:${delivery.winner_user_id}`;
    const bid = bidMap.get(key);
    const placeId = bid?.place_id ?? 0;
    
    return {
      delivery,
      roundIdx,
      placeId,
    };
  });

  deliveriesWithInfo.sort((a, b) => {
    if (a.roundIdx !== b.roundIdx) {
      return a.roundIdx - b.roundIdx;
    }
    return a.placeId - b.placeId;
  });

  const deliveryItemNoMap = new Map<string, number>();
  deliveriesWithInfo.forEach((item, index) => {
    deliveryItemNoMap.set(item.delivery._id.toString(), index + 1);
  });

  const result = userDeliveries
    .map((delivery) => {
      const itemNo = deliveryItemNoMap.get(delivery._id.toString()) ?? 0;
      
      const key = `${delivery.round_id}:${delivery.winner_user_id}`;
      const bid = bidMap.get(key);
      const bidAmount = bid?.amount ?? 0;
      
      return {
        item_name: delivery.item_name,
        item_no: itemNo,
        bid_amount: bidAmount,
      };
    })
    .filter(item => item.item_no > 0)
    .sort((a, b) => a.item_no - b.item_no);

  return result;
}

export async function getDeliveryById(deliveryId: string): Promise<DeliveriesType | null> {
  return Deliveries.findById(deliveryId).lean();
}

export async function getDeliveryStats(auctionId: string): Promise<{
  total: number;
  pending: number;
  delivered: number;
  failed: number;
}> {
  const deliveries = await Deliveries.find({ auction_id: auctionId }).lean();
  
  return {
    total: deliveries.length,
    pending: deliveries.filter(d => d.status === "PENDING").length,
    delivered: deliveries.filter(d => d.status === "DELIVERED").length,
    failed: deliveries.filter(d => d.status === "FAILED").length,
  };
}

export async function processPendingDeliveries(): Promise<void> {
  const pendingDeliveries = await Deliveries.find({ status: "PENDING" }).lean();
  
  for (const delivery of pendingDeliveries) {
    const timeSinceCreation = Date.now() - delivery.created_at.getTime();
    if (timeSinceCreation >= DELIVERY_PROCESSING_DELAY_MS) {
      await processDelivery(delivery._id.toString());
    }
  }
}
