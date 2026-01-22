import { User } from "../storage/mongo.js";
import type { User as UserType } from "../models/types.js";
import { getUserBalanceFromRedis, setUserBalanceInRedis, adjustUserBalanceInRedis } from "./redis-bids.js";

export type UserCreateInput = Omit<UserType, "_id">;

export async function getUserByTgId(tgId: number) {
  const user = await User.findOne({ tg_id: tgId }).lean();
  if (user) {
    const redisBalance = await getUserBalanceFromRedis(tgId);
    if (redisBalance !== 0 || user.balance === 0) {
      if (Math.abs(user.balance - redisBalance) > 0.01) {
        await User.updateOne({ tg_id: tgId }, { $set: { balance: redisBalance } });
        user.balance = redisBalance;
      }
    }
  }
  return user;
}

export async function createUser(input: UserCreateInput) {
  const doc = await User.create(input);
  await setUserBalanceInRedis(input.tg_id, input.balance);
  return doc.toObject();
}

export async function ensureUserByTgId(tgId: number) {
  const existing = await getUserByTgId(tgId);
  if (existing) return existing;
  const newUser = await createUser({
    tg_id: tgId,
    username: `tg_${tgId}`,
    balance: 0,
  });
  return newUser;
}

export async function adjustUserBalanceByTgId(tgId: number, delta: number) {
  const newBalance = await adjustUserBalanceInRedis(tgId, delta);
  
  User.findOneAndUpdate(
    { tg_id: tgId },
    { $inc: { balance: delta } },
    { new: true }
  ).lean().catch((err) => {
    console.error("Error updating user balance in MongoDB:", err);
  });
  
  const user = await User.findOne({ tg_id: tgId }).lean();
  if (user) {
    user.balance = newBalance;
  }
  return user;
}
