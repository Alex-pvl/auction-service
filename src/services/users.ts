import { User } from "../storage/mongo.js";
import type { User as UserType } from "../models/types.js";

export type UserCreateInput = Omit<UserType, "_id">;

export async function getUserByTgId(tgId: number) {
  return User.findOne({ tg_id: tgId }).lean();
}

export async function createUser(input: UserCreateInput) {
  const doc = await User.create(input);
  return doc.toObject();
}

export async function ensureUserByTgId(tgId: number) {
  const existing = await getUserByTgId(tgId);
  if (existing) return existing;
  return createUser({
    tg_id: tgId,
    username: `tg_${tgId}`,
    balance: 0,
  });
}

export async function adjustUserBalanceByTgId(tgId: number, delta: number) {
  return User.findOneAndUpdate({ tg_id: tgId }, { $inc: { balance: delta } }, { new: true }).lean();
}
