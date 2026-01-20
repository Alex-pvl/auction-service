import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RedisClientType } from "redis";

class RedisStore {
  client: RedisClientType<any, any, any>;
  prefix: string;

  constructor(client: RedisClientType<any, any, any>, prefix: string = "rl:") {
    this.client = client;
    this.prefix = prefix;
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    const fullKey = `${this.prefix}${key}`;
    const multi = this.client.multi();
    multi.incr(fullKey);
    multi.expire(fullKey, 60);
    const results = await multi.exec();
    const hits = (results?.[0] as number) || 0;
    const ttl = await this.client.ttl(fullKey);
    const resetTime = new Date(Date.now() + (ttl * 1000));
    return {
      totalHits: hits,
      resetTime,
    };
  }

  async decrement(key: string) {
    const fullKey = `${this.prefix}${key}`;
    await this.client.decr(fullKey);
  }

  async resetKey(key: string) {
    const fullKey = `${this.prefix}${key}`;
    await this.client.del(fullKey);
  }
}

export function createRateLimiter(redis?: RedisClientType<any, any, any>) {
  // Отключаем rate limiter для нагрузочного тестирования
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return (req: any, res: any, next: any) => next();
  }
  
  const store = redis ? new RedisStore(redis) : undefined;
  
  return rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: "Too many requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    store: store as any,
    keyGenerator: (req, res) => {
      const userId = req.get("X-User-Id");
      if (userId) {
        return `user:${userId}`;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      return `ip:${ipKeyGenerator(ip)}`;
    },
  });
}

export function createStrictRateLimiter(redis?: RedisClientType<any, any, any>) {
  // Отключаем rate limiter для нагрузочного тестирования
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return (req: any, res: any, next: any) => next();
  }
  
  const store = redis ? new RedisStore(redis) : undefined;
  
  return rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: "Too many requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    store: store as any,
    keyGenerator: (req, res) => {
      const userId = req.get("X-User-Id");
      if (userId) {
        return `user:${userId}`;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      return `ip:${ipKeyGenerator(ip)}`;
    },
  });
}

export function createBidRateLimiter(redis?: RedisClientType<any, any, any>) {
  // Отключаем rate limiter для нагрузочного тестирования
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return (req: any, res: any, next: any) => next();
  }
  
  const store = redis ? new RedisStore(redis) : undefined;
  
  return rateLimit({
    windowMs: 10 * 1000,
    max: 20,
    message: "Too many bids, please slow down",
    standardHeaders: true,
    legacyHeaders: false,
    store: store as any,
    keyGenerator: (req, res) => {
      const userId = req.get("X-User-Id");
      if (userId) {
        return `bid:user:${userId}`;
      }
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      return `bid:ip:${ipKeyGenerator(ip)}`;
    },
  });
}
