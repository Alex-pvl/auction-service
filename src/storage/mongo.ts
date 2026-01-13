import mongoose from "mongoose";
import type {
  Auction as AuctionType,
  Bid as BidType,
  Deliveries as DeliveriesType,
  User as UserType,
  Round as RoundType,
} from "../models/types.js";

const auctionStatuses = ["DRAFT", "RELEASED", "LIVE", "FINISHED", "DELETED"] as const;
const deliveryStatuses = ["PENDING", "DELIVERED", "FAILED"] as const;

const auctionSchema = new mongoose.Schema(
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

auctionSchema.index({ status: 1, start_datetime: 1 });
auctionSchema.index({ status: 1 });
auctionSchema.index({ creator_id: 1 });

const bidSchema = new mongoose.Schema(
  {
    auction_id: { type: String, required: true },
    round_id: { type: String, required: true },
    user_id: { type: String, required: true },
    amount: { type: Number, required: true },
    place_id: { type: Number, required: true },
    idempotency_key: { type: String, required: true },
    is_top3_sniping_bid: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

bidSchema.index({ auction_id: 1, round_id: 1, amount: -1 });
bidSchema.index({ auction_id: 1, round_id: 1, user_id: 1 });
bidSchema.index({ idempotency_key: 1 }, { unique: true });
bidSchema.index({ auction_id: 1, round_id: 1 });

const roundSchema = new mongoose.Schema({
  auction_id: { type: String, required: true },
  idx: { type: Number, required: true },
  started_at: { type: Date, required: true },
  ended_at: { type: Date, required: true },
  extended_until: { type: Date, default: null },
});

roundSchema.index({ auction_id: 1, idx: 1 }, { unique: true });
roundSchema.index({ auction_id: 1 });
const userSchema = new mongoose.Schema({
  tg_id: { type: Number, required: true, unique: true },
  username: { type: String, required: true },
  balance: { type: Number, required: true, default: 0 },
});

userSchema.index({ username: 1 });

const deliveriesSchema = new mongoose.Schema(
  {
    auction_id: { type: String, required: true },
    round_id: { type: String, required: true },
    winner_user_id: { type: String, required: true },
    item_name: { type: String, required: true },
    status: { type: String, enum: deliveryStatuses, required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

deliveriesSchema.index({ auction_id: 1 });
deliveriesSchema.index({ winner_user_id: 1 });
deliveriesSchema.index({ status: 1 });
deliveriesSchema.index({ auction_id: 1, round_id: 1, winner_user_id: 1 }, { unique: true });

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
