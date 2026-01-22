import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createClient } from "redis";
import { handleBidRequest } from "./services/bids-redis.js";
import { getUserByTgId } from "./services/users.js";
import { Round } from "./storage/mongo.js";
import { setRedisClient } from "./services/cache.js";
import { setRedisClient as setRedisBidsClient } from "./services/redis-bids.js";
import { setRedisClient as setMongoSyncClient } from "./services/mongo-sync.js";

interface TestConfig {
  baseUrl: string;
  numUsers: number;
  bidsPerUser: number;
  concurrentBids: number;
  bidAmountMin: number;
  bidAmountMax: number;
  auctionId?: string;
  rampUpSeconds?: number;
  addToExistingRatio?: number;
}

interface RequestMetrics {
  status: number;
  responseTime: number;
  error?: string;
  bidType?: "new" | "add_to_existing";
}

interface TestResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errors: Array<{ status: number; message: string; count: number }>;
  responseTimes: number[];
  requestsPerSecond: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  newBidsCount: number;
  addToExistingBidsCount: number;
  wsConnectionsCreated: number;
  wsConnectionsFailed: number;
  testDuration: number;
}

class LoadTestRunner {
  private config: TestConfig;
  private results: RequestMetrics[] = [];
  private startTime = 0;
  private endTime = 0;
  private roundIdCache: Map<string, string> = new Map();

  constructor(config: TestConfig) {
    this.config = {
      rampUpSeconds: 0,
      addToExistingRatio: 0,
      ...config,
    };
  }

  async makeRequest(
    url: string,
    options: RequestInit
  ): Promise<{ status: number; responseTime: number; error?: string }> {
    const startTime = Date.now();
    try {
      const response = await fetch(url, options);
      const responseTime = Date.now() - startTime;
      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        return {
          status: response.status,
          responseTime,
          error: data.error || `HTTP ${response.status}`,
        };
      }

      return { status: response.status, responseTime };
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      return {
        status: 0,
        responseTime,
        error: error.message || "Network error",
      };
    }
  }

  async createUser(baseUrl: string, tgId: number, initialBalance: number): Promise<number> {
    const authResponse = await this.makeRequest(`${baseUrl}/api/users/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tg_id: tgId }),
    });

    if (authResponse.status !== 200) {
      throw new Error(`Failed to create user ${tgId}: ${authResponse.error}`);
    }

    if (initialBalance > 0) {
      const balanceResponse = await this.makeRequest(
        `${baseUrl}/api/users/${tgId}/balance/increase`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: initialBalance }),
        }
      );

      if (balanceResponse.status !== 200) {
        console.warn(`Failed to set balance for user ${tgId}, continuing...`);
      }
    }

    return tgId;
  }

  async createUsersParallel(
    baseUrl: string,
    userIds: number[],
    balancePerUser: number,
    concurrency: number = 50
  ): Promise<number[]> {
    const created: number[] = [];
    const errors: Array<{ tgId: number; error: string }> = [];

    for (let i = 0; i < userIds.length; i += concurrency) {
      const batch = userIds.slice(i, i + concurrency);
      const promises = batch.map(async (tgId) => {
        try {
          await this.createUser(baseUrl, tgId, balancePerUser);
          return { tgId, success: true };
        } catch (error: any) {
          return { tgId, success: false, error: error.message };
        }
      });

      const results = await Promise.all(promises);
      for (const result of results) {
        if (result.success) {
          created.push(result.tgId);
        } else {
          errors.push({ tgId: result.tgId, error: result.error || "Unknown error" });
        }
      }

      if ((i + concurrency) % 100 === 0) {
        process.stdout.write(`\rCreated ${created.length}/${userIds.length} users...`);
      }
    }

    if (errors.length > 0) {
      console.warn(`\n⚠️  Failed to create ${errors.length} users`);
    }

    return created;
  }

  async createLiveAuction(baseUrl: string): Promise<string> {
    console.log("Creating new auction for load test...");
    const creatorTgId = 999999;
    await this.createUser(baseUrl, creatorTgId, 0);

    const startDateTime = new Date(Date.now() + 2000);
    const auctionData = {
      item_name: `Load Test Item ${Date.now()}`,
      min_bid: 100,
      winners_count_total: 100,
      rounds_count: 5,
      first_round_duration_ms: 180000,
      round_duration_ms: 30000,
      start_datetime: startDateTime.toISOString(),
    };

    const createResponse = await fetch(`${baseUrl}/api/auctions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": String(creatorTgId),
      },
      body: JSON.stringify(auctionData),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Failed to create auction: ${errorText}`);
    }

    const createResponseBody = await createResponse.json();
    const auctionId = createResponseBody._id;
    console.log(`✓ Created auction: ${auctionId}`);

    console.log("Releasing auction...");
    const releaseResponse = await this.makeRequest(
      `${baseUrl}/api/auctions/${auctionId}/release`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": String(creatorTgId),
        },
      }
    );

    if (releaseResponse.status !== 200) {
      throw new Error(`Failed to release auction: ${releaseResponse.error}`);
    }
    console.log("✓ Auction released");

    console.log("Waiting for auction to become LIVE...");
    const maxWaitTime = 60000;
    const checkInterval = 500;
    const startWaitTime = Date.now();
    let lastStatus = "RELEASED";
    let lastProgressLog = 0;
    
    while (Date.now() - startWaitTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
      
      const auctionResponse = await fetch(`${baseUrl}/api/auctions/${auctionId}`);
      if (auctionResponse.ok) {
        const auction = await auctionResponse.json();
        const currentStatus = auction.status;
        
        if (currentStatus !== lastStatus) {
          console.log(`Status changed: ${lastStatus} → ${currentStatus}`);
          lastStatus = currentStatus;
        }
        
        if (currentStatus === "LIVE") {
          console.log(`✓ Auction ${auctionId} is now LIVE`);
          return auctionId;
        }
        
        const elapsed = Math.floor((Date.now() - startWaitTime) / 1000);
        if (elapsed > 0 && elapsed % 3 === 0 && elapsed !== lastProgressLog) {
          lastProgressLog = elapsed;
          const startTime = new Date(auction.start_datetime).getTime();
          const now = Date.now();
          const timeUntilStart = Math.max(0, startTime - now);
          
          if (timeUntilStart > 0) {
            console.log(
              `Waiting for start time... (${elapsed}s elapsed, status: ${currentStatus}, starts in ${Math.ceil(timeUntilStart / 1000)}s)`
            );
          } else {
            console.log(
              `Start time passed, waiting for status change... (${elapsed}s elapsed, status: ${currentStatus})`
            );
          }
        }
      }
    }

    const finalCheck = await fetch(`${baseUrl}/api/auctions/${auctionId}`);
    if (finalCheck.ok) {
      const auction = await finalCheck.json();
      if (auction.status === "LIVE") {
        console.log(`✓ Auction ${auctionId} is now LIVE\n`);
        return auctionId;
      }
      throw new Error(
        `Auction did not become LIVE in time (waited ${maxWaitTime / 1000}s, current status: ${auction.status})`
      );
    }

    throw new Error(
      `Auction did not become LIVE in time (waited ${maxWaitTime / 1000}s, could not fetch status)`
    );
  }

  async getRoundId(auctionId: string, roundIdx: number): Promise<string> {
    const cacheKey = `${auctionId}-${roundIdx}`;
    const cached = this.roundIdCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const round = await Round.findOne({
      auction_id: auctionId,
      idx: roundIdx,
    }).lean();

    if (!round) {
      throw new Error(`Round not found for auction ${auctionId}, round ${roundIdx}`);
    }

    const roundId = round._id.toString();
    this.roundIdCache.set(cacheKey, roundId);
    return roundId;
  }

  async placeBid(
    baseUrl: string,
    auctionId: string,
    userTgId: number,
    amount: number,
    addToExisting: boolean = false
  ): Promise<RequestMetrics> {
    const idempotencyKey = randomUUID();
    const startTime = Date.now();

    try {
      const user = await getUserByTgId(userTgId);
      if (!user) {
        return {
          status: 404,
          responseTime: Date.now() - startTime,
          error: "user not found",
          bidType: addToExisting ? "add_to_existing" : "new",
        };
      }

      const auctionResponse = await fetch(`${baseUrl}/api/auctions/${auctionId}`);
      if (!auctionResponse.ok) {
        return {
          status: auctionResponse.status,
          responseTime: Date.now() - startTime,
          error: "auction not found",
          bidType: addToExisting ? "add_to_existing" : "new",
        };
      }
      const auction = await auctionResponse.json();

      const roundId = await this.getRoundId(auctionId, auction.current_round_idx);
      const result = await handleBidRequest(
        auctionId,
        roundId,
        userTgId,
        user._id.toString(),
        amount,
        idempotencyKey,
        addToExisting
      );

      return {
        status: 200,
        responseTime: Date.now() - startTime,
        bidType: addToExisting ? "add_to_existing" : "new",
      };
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      let status = 500;
      const errorMessage = error.message || "internal server error";

      if (
        errorMessage.includes("insufficient") ||
        errorMessage.includes("cannot") ||
        errorMessage.includes("must be at least") ||
        errorMessage.includes("no existing bid")
      ) {
        status = 400;
      } else if (
        errorMessage.includes("not live") ||
        errorMessage.includes("ended") ||
        errorMessage.includes("round not found")
      ) {
        status = 409;
      } else if (errorMessage.includes("not found")) {
        status = 404;
      }

      return {
        status,
        responseTime,
        error: errorMessage,
        bidType: addToExisting ? "add_to_existing" : "new",
      };
    }
  }


  calculatePercentile(sorted: number[], percentile: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  async initializeConnections() {
    const MONGO_URL = process.env.MONGO_URL!;
    const REDIS_URL = process.env.REDIS_URL!;

    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(MONGO_URL, {
          maxPoolSize: 10,
          minPoolSize: 2,
          maxIdleTimeMS: 30000,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 45000,
        });
        console.log("✓ MongoDB connected");
      } else {
        console.log("✓ MongoDB already connected");
      }

      const redis = createClient({
        url: REDIS_URL,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error("Redis reconnection failed after 10 retries");
              return new Error("Redis connection failed");
            }
            return Math.min(retries * 50, 1000);
          },
        },
      });

      redis.on("error", (err) => {
        console.error("redis error", err);
      });

      if (!redis.isOpen) {
        await redis.connect();
        console.log("✓ Redis connected");
      } else {
        console.log("✓ Redis already connected");
      }

      setRedisClient(redis);
      setRedisBidsClient(redis);
      setMongoSyncClient(redis);
    } catch (error: any) {
      console.error("Failed to initialize connections:", error.message);
      throw new Error(`Connection initialization failed: ${error.message}`);
    }
  }

  async runLoadTest(): Promise<TestResult> {
    console.log("\n" + "=".repeat(60));
    console.log("  Auction Service Load Test");
    console.log("=".repeat(60));
    console.log(`Base URL: ${this.config.baseUrl}`);
    console.log(`Number of users: ${this.config.numUsers}`);
    console.log(`Bids per user: ${this.config.bidsPerUser}`);
    console.log(`Concurrent bids: ${this.config.concurrentBids}`);
    console.log(`Bid amount range: ${this.config.bidAmountMin} - ${this.config.bidAmountMax}`);
    console.log(`Add to existing ratio: ${this.config.addToExistingRatio}%`);
    console.log(`Ramp-up time: ${this.config.rampUpSeconds}s`);
    console.log("=".repeat(60) + "\n");

    await this.initializeConnections();

    if (!process.env.DISABLE_RATE_LIMIT && process.env.NODE_ENV !== "test") {
      console.log("⚠️  WARNING: Rate limiter is enabled!");
      console.log("   Set DISABLE_RATE_LIMIT=true to disable rate limiting for load testing");
      console.log("   Example: DISABLE_RATE_LIMIT=true npm run load-test\n");
    } else {
      console.log("✓ Rate limiter is disabled for load testing\n");
    }

    const healthCheck = await this.makeRequest(`${this.config.baseUrl}/api/health`, {
      method: "GET",
    });
    if (healthCheck.status !== 200) {
      throw new Error(`Server is not healthy: ${healthCheck.error}`);
    }
    console.log("✓ Server is healthy\n");

    const auctionId =
      this.config.auctionId || (await this.createLiveAuction(this.config.baseUrl));

    console.log("Fetching auction data...");
    const auctionResponse = await fetch(`${this.config.baseUrl}/api/auctions/${auctionId}`);
    if (!auctionResponse.ok) {
      throw new Error(`Failed to fetch auction: ${await auctionResponse.text()}`);
    }
    const auction = await auctionResponse.json();

    const auctionMinBid = auction.min_bid || this.config.bidAmountMin;
    const auctionMaxBid = auctionMinBid * 10;
    const effectiveMinBid = Math.max(auctionMinBid, this.config.bidAmountMin);
    const effectiveMaxBid =
      this.config.bidAmountMax > 0
        ? Math.min(this.config.bidAmountMax, auctionMaxBid)
        : auctionMaxBid;

    console.log(`Auction parameters:`);
    console.log(`  Min bid: ${auctionMinBid}`);
    console.log(`  Effective bid range: ${effectiveMinBid} - ${effectiveMaxBid}`);
    console.log(`  Rounds: ${auction.rounds_count || "N/A"}`);
    console.log(`  Winners per round: ${auction.winners_per_round || "N/A"}\n`);

    console.log("Creating users...");
    const userStartId = 1000000;
    const balancePerUser = effectiveMaxBid * this.config.bidsPerUser * 2;
    const userIds: number[] = [];
    for (let i = 0; i < this.config.numUsers; i++) {
      userIds.push(userStartId + i);
    }

    const createdUserIds = await this.createUsersParallel(
      this.config.baseUrl,
      userIds,
      balancePerUser,
      50
    );
    console.log(`\n✓ Created ${createdUserIds.length} users\n`);

    if (createdUserIds.length === 0) {
      throw new Error("No users were created");
    }
    interface BidTask {
      userId: number;
      amount: number;
      addToExisting: boolean;
    }

    const bidTasks: BidTask[] = [];

    for (const userId of createdUserIds) {
      let hasExistingBid = false;
      for (let i = 0; i < this.config.bidsPerUser; i++) {
        const amount =
          Math.floor(Math.random() * (effectiveMaxBid - effectiveMinBid + 1)) +
          effectiveMinBid;
        const addToExisting =
          hasExistingBid && Math.random() * 100 < this.config.addToExistingRatio!;
        bidTasks.push({ userId, amount, addToExisting });
        if (!addToExisting) {
          hasExistingBid = true;
        }
      }
    }

    for (let i = bidTasks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bidTasks[i], bidTasks[j]] = [bidTasks[j], bidTasks[i]];
    }

    console.log(`Starting load test with ${bidTasks.length} total bids...\n`);

    this.startTime = Date.now();

    if (this.config.rampUpSeconds! > 0) {
      await this.executeBidsWithRampUp(auctionId, bidTasks);
    } else {
      await this.executeBids(auctionId, bidTasks);
    }

    this.endTime = Date.now();
    const testDuration = (this.endTime - this.startTime) / 1000;

    const successfulRequests = this.results.filter((r) => r.status === 200).length;
    const failedRequests = this.results.length - successfulRequests;

    const errorMap = new Map<string, number>();
    this.results.forEach((r) => {
      if (r.status !== 200) {
        let errorMsg = r.error || "Unknown error";
        if (errorMsg.includes("WriteConflict") || errorMsg.includes("Write conflict")) {
          errorMsg = "WriteConflict (MongoDB write conflict)";
        } else if (errorMsg.includes("insufficient balance")) {
          errorMsg = "Insufficient balance";
        } else if (errorMsg.includes("auction is not live")) {
          errorMsg = "Auction is not live";
        } else if (errorMsg.includes("round has ended")) {
          errorMsg = "Round has ended";
        }
        const key = `${r.status}: ${errorMsg}`;
        errorMap.set(key, (errorMap.get(key) || 0) + 1);
      }
    });

    const errors = Array.from(errorMap.entries()).map(([key, count]) => {
      const [status, ...messageParts] = key.split(": ");
      return {
        status: parseInt(status) || 0,
        message: messageParts.join(": "),
        count,
      };
    });

    const responseTimes = this.results.map((r) => r.responseTime).sort((a, b) => a - b);
    const requestsPerSecond = this.results.length / testDuration;

    const newBidsCount = this.results.filter((r) => r.bidType === "new").length;
    const addToExistingBidsCount = this.results.filter(
      (r) => r.bidType === "add_to_existing"
    ).length;

    const result: TestResult = {
      totalRequests: this.results.length,
      successfulRequests,
      failedRequests,
      errors,
      responseTimes,
      requestsPerSecond,
      avgResponseTime:
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length || 0,
      minResponseTime: responseTimes[0] || 0,
      maxResponseTime: responseTimes[responseTimes.length - 1] || 0,
      p50: this.calculatePercentile(responseTimes, 50),
      p95: this.calculatePercentile(responseTimes, 95),
      p99: this.calculatePercentile(responseTimes, 99),
      p999: this.calculatePercentile(responseTimes, 99.9),
      newBidsCount,
      addToExistingBidsCount,
      wsConnectionsCreated: 0,
      wsConnectionsFailed: 0,
      testDuration,
    };

    this.printResults(result);

    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log("✓ MongoDB connection closed");
    }

    return result;
  }

  private async executeBids(auctionId: string, bidTasks: Array<{ userId: number; amount: number; addToExisting: boolean }>) {
    const batches: typeof bidTasks[] = [];
    for (let i = 0; i < bidTasks.length; i += this.config.concurrentBids) {
      batches.push(bidTasks.slice(i, i + this.config.concurrentBids));
    }

    for (const batch of batches) {
      const batchPromises = batch.map((task) =>
        this.placeBid(
          this.config.baseUrl,
          auctionId,
          task.userId,
          task.amount,
          task.addToExisting
        )
      );
      const batchResults = await Promise.all(batchPromises);
      this.results.push(...batchResults);

      const completed = this.results.length;
      const total = bidTasks.length;
      const percentage = ((completed / total) * 100).toFixed(1);
      const successful = this.results.filter((r) => r.status === 200).length;
      process.stdout.write(
        `\rProgress: ${completed}/${total} (${percentage}%) - ${successful} successful - ${this.results.length / ((Date.now() - this.startTime) / 1000)} req/s`
      );

      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    console.log();
  }

  private async executeBidsWithRampUp(
    auctionId: string,
    bidTasks: Array<{ userId: number; amount: number; addToExisting: boolean }>
  ) {
    const rampUpDuration = this.config.rampUpSeconds! * 1000;
    const targetConcurrency = this.config.concurrentBids;
    const batches: typeof bidTasks[] = [];
    for (let i = 0; i < bidTasks.length; i += targetConcurrency) {
      batches.push(bidTasks.slice(i, i + targetConcurrency));
    }

    const startTime = Date.now();
    let currentBatchIndex = 0;

    for (const batch of batches) {
      const elapsed = Date.now() - startTime;
      if (elapsed < rampUpDuration) {
        const progress = elapsed / rampUpDuration;
        const currentConcurrency = Math.ceil(targetConcurrency * progress);
        const currentBatch = batch.slice(0, currentConcurrency);
        if (currentBatch.length > 0) {
          const batchPromises = currentBatch.map((task) =>
            this.placeBid(
              this.config.baseUrl,
              auctionId,
              task.userId,
              task.amount,
              task.addToExisting
            )
          );
          const batchResults = await Promise.all(batchPromises);
          this.results.push(...batchResults);
        }
      } else {
        const batchPromises = batch.map((task) =>
          this.placeBid(
            this.config.baseUrl,
            auctionId,
            task.userId,
            task.amount,
            task.addToExisting
          )
        );
        const batchResults = await Promise.all(batchPromises);
        this.results.push(...batchResults);
      }

      const completed = this.results.length;
      const total = bidTasks.length;
      const percentage = ((completed / total) * 100).toFixed(1);
      const successful = this.results.filter((r) => r.status === 200).length;
      process.stdout.write(
        `\rProgress: ${completed}/${total} (${percentage}%) - ${successful} successful - ${this.results.length / ((Date.now() - this.startTime) / 1000)} req/s`
      );

      currentBatchIndex++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log();
  }

  private printResults(result: TestResult) {
    console.log("\n" + "=".repeat(60));
    console.log("  Load Test Results");
    console.log("=".repeat(60));
    console.log(`Total requests: ${result.totalRequests}`);
    console.log(
      `Successful: ${result.successfulRequests} (${((result.successfulRequests / result.totalRequests) * 100).toFixed(2)}%)`
    );
    console.log(
      `Failed: ${result.failedRequests} (${((result.failedRequests / result.totalRequests) * 100).toFixed(2)}%)`
    );
    console.log(`\nThroughput:`);
    console.log(`  Requests per second: ${result.requestsPerSecond.toFixed(2)}`);
    console.log(`  Test duration: ${result.testDuration.toFixed(2)}s`);
    console.log(`\nResponse times (ms):`);
    console.log(`  Average: ${result.avgResponseTime.toFixed(2)}`);
    console.log(`  Min: ${result.minResponseTime}`);
    console.log(`  Max: ${result.maxResponseTime}`);
    console.log(`  p50: ${result.p50}`);
    console.log(`  p95: ${result.p95}`);
    console.log(`  p99: ${result.p99}`);
    console.log(`  p99.9: ${result.p999}`);
    console.log(`\nBid types:`);
    console.log(`  New bids: ${result.newBidsCount}`);
    console.log(`  Add to existing: ${result.addToExistingBidsCount}`);
    console.log(`\nNote: Using direct method calls instead of WebSocket connections for load testing`);

    if (result.errors.length > 0) {
      console.log(`\nErrors:`);
      result.errors.forEach((err) => {
        const isWriteConflict = err.message.includes("WriteConflict");
        const note = isWriteConflict
          ? " (retried automatically, may indicate high load)"
          : "";
        console.log(`  ${err.status}: ${err.message} (${err.count} times)${note}`);
      });

      const writeConflictCount = result.errors
        .filter((e) => e.message.includes("WriteConflict"))
        .reduce((sum, e) => sum + e.count, 0);

      if (writeConflictCount > 0) {
        console.log(`\nNote: ${writeConflictCount} WriteConflict errors occurred.`);
        console.log(`These are transient MongoDB errors that were automatically retried.`);
        console.log(
          `If the count is high, consider reducing CONCURRENT_BIDS or increasing MongoDB resources.`
        );
      }
    }

    console.log("=".repeat(60) + "\n");
  }
}

const config: TestConfig = {
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  numUsers: parseInt(process.env.NUM_USERS || "10000"),
  bidsPerUser: parseInt(process.env.BIDS_PER_USER || "1"),
  concurrentBids: parseInt(process.env.CONCURRENT_BIDS || "100"),
  bidAmountMin: parseInt(process.env.BID_AMOUNT_MIN || "200"),
  bidAmountMax: parseInt(process.env.BID_AMOUNT_MAX || "1000"),
  auctionId: process.env.AUCTION_ID,
  rampUpSeconds: parseInt(process.env.RAMP_UP_SECONDS || "0"),
  addToExistingRatio: parseFloat(process.env.ADD_TO_EXISTING_RATIO || "0"),
};

const runner = new LoadTestRunner(config);

runner
  .runLoadTest()
  .then(() => {
    console.log("✓ Load test completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("✗ Load test failed:", error);
    process.exit(1);
  });
