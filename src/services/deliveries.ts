import { Deliveries, Auction } from "../storage/mongo.js";
import type { Deliveries as DeliveriesType, DeliveryStatus } from "../models/types.js";
import mongoose from "mongoose";

const DELIVERY_PROCESSING_DELAY_MS = 5 * 1000;

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
