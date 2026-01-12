import { ObjectId } from "mongoose";

export type AutcionStatus = "DRAFT" | "RELEASED" | "LIVE" | "FINISHED" | "DELETED";
export type RoundStatus = "UPCOMING" | "ACTIVE" | "SETTLING" | "FINISHED";
export type DeliveryStatus = "PENDING" | "DELIVERED" | "FAILED";

export interface Auction {
    _id: ObjectId;
    name: string | null;
    creator_id: number;
    item_name: string;
    min_bid: number;
    winners_count_total: number;
    rounds_count: number;
    winners_per_round: number;
    first_round_duration_ms: number | null;
    round_duration_ms: number;
    status: AutcionStatus;
    current_round_idx: number;
    remaining_items_count: number;
    start_datetime: Date;
    planned_end_datetime: Date;
    created_at: Date;
    updated_at: Date;
}

export interface Bid {
    _id: ObjectId;
    auction_id: string;
    round_id: string;
    user_id: string;
    amount: number;
    place_id: number;
    created_at: Date;
    updated_at: Date;
    idempotency_key: string;
}

export interface Round {
    _id: ObjectId;
    auction_id: string;
    idx: number;
    started_at: Date;
    ended_at: Date;
}

export interface User {
    _id: ObjectId;
    tg_id: number;
    username: string;
    balance: number;
}

export interface Deliveries {
    _id: ObjectId;
    auction_id: string;
    round_id: string;
    winner_user_id: string;
    item_name: string;
    status: DeliveryStatus;
    created_at: Date;
    updated_at: Date;
}
