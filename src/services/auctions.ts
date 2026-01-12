import { Auction } from "../storage/mongo.js";
import type { Auction as AuctionType, AutcionStatus } from "../models/types.js";

export type AuctionCreateInput = Omit<AuctionType, "_id" | "created_at" | "updated_at">;
export type AuctionUpdateInput = Partial<Omit<AuctionType, "_id" | "created_at" | "updated_at">>;

export async function listAuctions(limit: number, status?: AutcionStatus) {
  const query = status ? { status } : {};
  return Auction.find(query).sort({ created_at: -1 }).limit(limit).lean();
}

export async function getAuctionById(id: string) {
  return Auction.findById(id).lean();
}

export async function createAuction(input: AuctionCreateInput) {
  return Auction.create(input);
}

export async function updateAuction(id: string, input: AuctionUpdateInput) {
  return Auction.findByIdAndUpdate(id, input, { new: true }).lean();
}

export async function softDeleteAuction(id: string) {
  return Auction.findByIdAndUpdate(id, { status: "DELETED" }, { new: true }).lean();
}

export async function releaseAuction(id: string) {
  return Auction.findByIdAndUpdate(id, { status: "RELEASED" }, { new: true }).lean();
}
