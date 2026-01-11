import mongoose from "mongoose";
import type {
  Auction as AuctionType,
  Bid as BidType,
  Deliveries as DeliveriesType,
  User as UserType,
  Round as RoundType,
} from "../models/types.js";

const auctionStatuses = ["DRAFT", "LIVE", "FINISHED", "DELETED"] as const;
const deliveryStatuses = ["PENDING", "DELIVERED", "FAILED"] as const;

const auctionSchema = new mongoose.Schema<AuctionType>(
  {
    name: { type: String, default: null },
    creator_id: { type: Number, required: true },
    item_name: { type: String, required: true },
    min_bid: { type: Number, required: true },
    winners_count_total: { type: Number, required: true },
    rounds_count: { type: Number, required: true },
    winners_per_round: { type: Number, required: true },
    first_round_duration_ms: { type: Number, default: null },
    round_duration_ms: { type: Number, required: true },
    status: { type: String, enum: auctionStatuses, required: true },
    current_round_idx: { type: Number, required: true },
    remaining_items_count: { type: Number, required: true },
    start_datetime: { type: Date, required: true },
    planned_end_datetime: { type: Date, required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

const bidSchema = new mongoose.Schema<BidType>(
  {
    auction_id: { type: String, required: true },
    round_id: { type: String, required: true },
    user_id: { type: String, required: true },
    amount: { type: Number, required: true },
    place_id: { type: Number, required: true },
    idempotency_key: { type: String, required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

const roundSchema = new mongoose.Schema<RoundType>({
  auction_id: { type: String, required: true },
  idx: { type: Number, required: true },
  started_at: { type: Date, required: true },
  ended_at: { type: Date, required: true },
});

const userSchema = new mongoose.Schema<UserType>({
  username: { type: String, required: true },
  balance: { type: Number, required: true },
});

const deliveriesSchema = new mongoose.Schema<DeliveriesType>(
  {
    auction_id: { type: String, required: true },
    round_id: { type: String, required: true },
    winner_user_id: { type: String, required: true },
    item_name: { type: String, required: true },
    status: { type: String, enum: deliveryStatuses, required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
  },
  { timestamps: true }
);

export const Auction = mongoose.model<AuctionType>("Auction", auctionSchema);
export const Bid = mongoose.model<BidType>("Bid", bidSchema);
export const Round = mongoose.model<RoundType>("Round", roundSchema);
export const User = mongoose.model<UserType>("User", userSchema);
export const Deliveries = mongoose.model<DeliveriesType>("Deliveries", deliveriesSchema);
export const Item = mongoose.model("Item", itemSchema);
