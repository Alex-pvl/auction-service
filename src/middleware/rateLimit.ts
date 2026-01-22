import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

export async function registerRateLimiters(fastify: FastifyInstance) {
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return;
  }

  await fastify.register(rateLimit, {
    max: 300,
    timeWindow: 60000,
    keyGenerator: (request) => {
      const userId = request.headers["x-user-id"];
      if (userId) {
        return `user:${userId}`;
      }
      const ip = request.ip || request.socket.remoteAddress || "unknown";
      return `ip:${ip}`;
    },
  });
}

export function createRateLimiter() {
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return async (_req: any, _res: any, next: any) => next();
  }
  
  return async (request: any, reply: any, next: any) => {
    const userId = request.headers["x-user-id"];
    const key = userId ? `user:${userId}` : `ip:${request.ip || request.socket.remoteAddress || "unknown"}`;
    
    const rateLimitStore = (global as any).rateLimitStore || new Map();
    (global as any).rateLimitStore = rateLimitStore;
    
    const now = Date.now();
    const windowMs = 60000;
    const max = 100;
    
    const record = rateLimitStore.get(key) || { count: 0, resetTime: now + windowMs };
    
    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }
    
    if (record.count >= max) {
      return reply.code(429).send({ error: "Too many requests" });
    }
    
    record.count++;
    rateLimitStore.set(key, record);
    next();
  };
}

export function createStrictRateLimiter() {
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return async (_req: any, _res: any, next: any) => next();
  }
  
  return async (request: any, reply: any, next: any) => {
    const userId = request.headers["x-user-id"];
    const key = userId ? `user:${userId}` : `ip:${request.ip || request.socket.remoteAddress || "unknown"}`;
    
    const rateLimitStore = (global as any).rateLimitStore || new Map();
    (global as any).rateLimitStore = rateLimitStore;
    
    const now = Date.now();
    const windowMs = 60000;
    const max = 20;
    
    const record = rateLimitStore.get(key) || { count: 0, resetTime: now + windowMs };
    
    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }
    
    if (record.count >= max) {
      return reply.code(429).send({ error: "Too many requests" });
    }
    
    record.count++;
    rateLimitStore.set(key, record);
    next();
  };
}

export function createBidRateLimiter() {
  if (process.env.DISABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "test") {
    return async (_req: any, _res: any, next: any) => next();
  }
  
  return async (request: any, reply: any, next: any) => {
    const userId = request.headers["x-user-id"];
    if (!userId) {
      return reply.code(400).send({ error: "X-User-Id header is required for bids" });
    }
    
    const key = `bid:user:${userId}`;
    
    const rateLimitStore = (global as any).rateLimitStore || new Map();
    (global as any).rateLimitStore = rateLimitStore;
    
    const now = Date.now();
    const windowMs = 1000;
    const max = 10;
    
    const record = rateLimitStore.get(key) || { count: 0, resetTime: now + windowMs };
    
    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }
    
    if (record.count >= max) {
      return reply.code(429).send({ error: "Too many bid requests" });
    }
    
    record.count++;
    rateLimitStore.set(key, record);
    next();
  };
}
