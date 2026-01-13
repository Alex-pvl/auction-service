import { randomUUID } from "node:crypto";

interface TestConfig {
  baseUrl: string;
  numUsers: number;
  bidsPerUser: number;
  concurrentBids: number;
  bidAmountMin: number;
  bidAmountMax: number;
  auctionId?: string;
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
}

async function makeRequest(
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

async function createUser(baseUrl: string, tgId: number, initialBalance: number) {
  const authResponse = await makeRequest(`${baseUrl}/api/users/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tg_id: tgId }),
  });

  if (authResponse.status !== 200) {
    throw new Error(`Failed to create user ${tgId}: ${authResponse.error}`);
  }

  if (initialBalance > 0) {
    const balanceResponse = await makeRequest(
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

async function findOrCreateLiveAuction(baseUrl: string): Promise<string> {
  const listResponse = await fetch(`${baseUrl}/api/auctions?status=LIVE&limit=1`);
  if (listResponse.ok) {
    const auctions = await listResponse.json();
    if (auctions.length > 0) {
      console.log(`Using existing LIVE auction: ${auctions[0]._id}`);
      return auctions[0]._id;
    }
  }

  console.log("No LIVE auction found, creating a new one...");
  const creatorTgId = 999999;
  await createUser(baseUrl, creatorTgId, 0);

  const startDateTime = new Date(Date.now() + 5000);
  const auctionData = {
    item_name: "Load Test Item",
    min_bid: 100,
    winners_count_total: 100,
    rounds_count: 5,
    round_duration_ms: 30000,
    start_datetime: startDateTime
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

  const releaseResponse = await makeRequest(
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

  console.log("Waiting for auction to become LIVE...");
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const auctionResponse = await fetch(`${baseUrl}/api/auctions/${auctionId}`);
    if (auctionResponse.ok) {
      const auction = await auctionResponse.json();
      if (auction.status === "LIVE") {
        console.log(`Auction ${auctionId} is now LIVE`);
        return auctionId;
      }
      if (i > 0 && i % 3 === 0) {
        console.log(`Still waiting... (${i + 1}s elapsed, status: ${auction.status})`);
      }
    }
  }

  throw new Error("Auction did not become LIVE in time (waited 20 seconds)");
}

async function placeBid(
  baseUrl: string,
  auctionId: string,
  userId: number,
  amount: number,
  maxRetries: number = 3
): Promise<{ status: number; responseTime: number; error?: string }> {
  const idempotencyKey = randomUUID();
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await makeRequest(`${baseUrl}/api/auctions/${auctionId}/bids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": String(userId),
      },
      body: JSON.stringify({
        amount,
        idempotency_key: idempotencyKey,
      }),
    });
    
    if (result.status === 200 || result.status === 400 || result.status === 409) {
      return result;
    }
    
    const isWriteConflict = result.error?.includes("WriteConflict") || 
                           result.error?.includes("Write conflict") ||
                           result.error?.includes("WriteConflict");
    
    if ((result.status === 500 || result.status === 503 || result.status === 0) && 
        attempt < maxRetries - 1) {
      const delay = 50 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    
    return result;
  }
  
  return await makeRequest(`${baseUrl}/api/auctions/${auctionId}/bids`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": String(userId),
    },
    body: JSON.stringify({
      amount,
      idempotency_key: idempotencyKey,
    }),
  });
}

function calculatePercentile(sorted: number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runLoadTest(config: TestConfig): Promise<TestResult> {
  console.log("\n=== Load Test Configuration ===");
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Number of users: ${config.numUsers}`);
  console.log(`Bids per user: ${config.bidsPerUser}`);
  console.log(`Concurrent bids: ${config.concurrentBids}`);
  console.log(`Bid amount range (from config): ${config.bidAmountMin} - ${config.bidAmountMax}`);
  console.log(`Note: Actual bid range will be determined from auction parameters`);
  
  if (!process.env.DISABLE_RATE_LIMIT && process.env.NODE_ENV !== "test") {
    console.log("\n⚠️  WARNING: Rate limiter is enabled!");
    console.log("   Set DISABLE_RATE_LIMIT=true to disable rate limiting for load testing");
    console.log("   Example: DISABLE_RATE_LIMIT=true npm run load-test\n");
  } else {
    console.log("\n✓ Rate limiter is disabled for load testing\n");
  }
  
  console.log("===============================\n");

  const healthCheck = await makeRequest(`${config.baseUrl}/api/health`, {
    method: "GET",
  });
  if (healthCheck.status !== 200) {
    throw new Error(`Server is not healthy: ${healthCheck.error}`);
  }
  console.log("✓ Server is healthy\n");

  const auctionId = config.auctionId || (await findOrCreateLiveAuction(config.baseUrl));
  console.log(`Using auction ID: ${auctionId}\n`);

  console.log("Fetching auction data...");
  const auctionResponse = await fetch(`${config.baseUrl}/api/auctions/${auctionId}`);
  if (!auctionResponse.ok) {
    throw new Error(`Failed to fetch auction: ${await auctionResponse.text()}`);
  }
  const auction = await auctionResponse.json();
  
  const auctionMinBid = auction.min_bid || config.bidAmountMin;
  const auctionMaxBid = auctionMinBid * 10; // Максимальная ставка = min_bid * 10
  const effectiveMinBid = Math.max(auctionMinBid, config.bidAmountMin);
  const effectiveMaxBid = config.bidAmountMax > 0 
    ? Math.min(config.bidAmountMax, auctionMaxBid)
    : auctionMaxBid;
  
  console.log(`Auction parameters:`);
  console.log(`  Min bid: ${auctionMinBid}`);
  console.log(`  Effective bid range: ${effectiveMinBid} - ${effectiveMaxBid}`);
  console.log(`  Rounds: ${auction.rounds_count || 'N/A'}`);
  console.log(`  Winners per round: ${auction.winners_per_round || 'N/A'}\n`);

  console.log("Stopping bots for load testing...");
  const stopBotsResponse = await makeRequest(
    `${config.baseUrl}/api/auctions/${auctionId}/bots/stop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
  if (stopBotsResponse.status === 200) {
    console.log("✓ Bots stopped\n");
  } else {
    console.warn(`⚠ Could not stop bots: ${stopBotsResponse.error}\n`);
  }

  console.log("Creating users...");
  const userIds: number[] = [];
  const userStartId = 1000000;
  const balancePerUser = effectiveMaxBid * config.bidsPerUser * 2; // Достаточно баланса для всех ставок

  for (let i = 0; i < config.numUsers; i++) {
    const tgId = userStartId + i;
    try {
      await createUser(config.baseUrl, tgId, balancePerUser);
      userIds.push(tgId);
      if ((i + 1) % 10 === 0) {
        process.stdout.write(`\rCreated ${i + 1}/${config.numUsers} users...`);
      }
    } catch (error: any) {
      console.error(`\nFailed to create user ${tgId}: ${error.message}`);
    }
  }
  console.log(`\n✓ Created ${userIds.length} users\n`);

  if (userIds.length === 0) {
    throw new Error("No users were created");
  }

  const bidTasks: Array<{
    userId: number;
    amount: number;
  }> = [];

  for (const userId of userIds) {
    for (let i = 0; i < config.bidsPerUser; i++) {
      const amount =
        Math.floor(
          Math.random() * (effectiveMaxBid - effectiveMinBid + 1)
        ) + effectiveMinBid;
      bidTasks.push({ userId, amount });
    }
  }

  for (let i = bidTasks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bidTasks[i], bidTasks[j]] = [bidTasks[j], bidTasks[i]];
  }

  console.log(`Starting load test with ${bidTasks.length} total bids...\n`);

  const results: Array<{
    status: number;
    responseTime: number;
    error?: string;
  }> = [];

  const startTime = Date.now();

  const executeBids = async () => {
    const batches: typeof bidTasks[] = [];
    for (let i = 0; i < bidTasks.length; i += config.concurrentBids) {
      batches.push(bidTasks.slice(i, i + config.concurrentBids));
    }

    for (const batch of batches) {
      const batchPromises = batch.map((task) =>
        placeBid(config.baseUrl, auctionId, task.userId, task.amount)
      );
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      const completed = results.length;
      const total = bidTasks.length;
      const percentage = ((completed / total) * 100).toFixed(1);
      process.stdout.write(
        `\rProgress: ${completed}/${total} (${percentage}%) - ${results.filter((r) => r.status === 200).length} successful`
      );
      
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };

  await executeBids();
  const endTime = Date.now();
  const totalTime = (endTime - startTime) / 1000; // в секундах

  console.log("\n\n=== Load Test Results ===");

  const successfulRequests = results.filter((r) => r.status === 200).length;
  const failedRequests = results.length - successfulRequests;

  const errorMap = new Map<string, number>();
  results.forEach((r) => {
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

  const responseTimes = results.map((r) => r.responseTime).sort((a, b) => a - b);
  const requestsPerSecond = results.length / totalTime;

  const result: TestResult = {
    totalRequests: results.length,
    successfulRequests,
    failedRequests,
    errors,
    responseTimes,
    requestsPerSecond,
    avgResponseTime:
      responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
    minResponseTime: responseTimes[0] || 0,
    maxResponseTime: responseTimes[responseTimes.length - 1] || 0,
    p50: calculatePercentile(responseTimes, 50),
    p95: calculatePercentile(responseTimes, 95),
    p99: calculatePercentile(responseTimes, 99),
  };

  console.log(`Total requests: ${result.totalRequests}`);
  console.log(`Successful: ${result.successfulRequests} (${((result.successfulRequests / result.totalRequests) * 100).toFixed(2)}%)`);
  console.log(`Failed: ${result.failedRequests} (${((result.failedRequests / result.totalRequests) * 100).toFixed(2)}%)`);
  console.log(`\nRequests per second: ${result.requestsPerSecond.toFixed(2)}`);
  console.log(`Total time: ${totalTime.toFixed(2)}s`);
  console.log(`\nResponse times (ms):`);
  console.log(`  Average: ${result.avgResponseTime.toFixed(2)}`);
  console.log(`  Min: ${result.minResponseTime}`);
  console.log(`  Max: ${result.maxResponseTime}`);
  console.log(`  p50: ${result.p50}`);
  console.log(`  p95: ${result.p95}`);
  console.log(`  p99: ${result.p99}`);

  if (result.errors.length > 0) {
    console.log(`\nErrors:`);
    result.errors.forEach((err) => {
      const isWriteConflict = err.message.includes("WriteConflict");
      const note = isWriteConflict ? " (retried automatically, may indicate high load)" : "";
      console.log(`  ${err.status}: ${err.message} (${err.count} times)${note}`);
    });
    
    const writeConflictCount = result.errors
      .filter((e) => e.message.includes("WriteConflict"))
      .reduce((sum, e) => sum + e.count, 0);
    
    if (writeConflictCount > 0) {
      console.log(`\nNote: ${writeConflictCount} WriteConflict errors occurred.`);
      console.log(`These are transient MongoDB errors that were automatically retried.`);
      console.log(`If the count is high, consider reducing CONCURRENT_BIDS or increasing MongoDB resources.`);
    }
  }

  console.log("========================\n");

  return result;
}

const config: TestConfig = {
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  numUsers: parseInt(process.env.NUM_USERS || "1000"),
  bidsPerUser: parseInt(process.env.BIDS_PER_USER || "1"),
  concurrentBids: parseInt(process.env.CONCURRENT_BIDS || "100"),
  bidAmountMin: parseInt(process.env.BID_AMOUNT_MIN || "200"),
  bidAmountMax: parseInt(process.env.BID_AMOUNT_MAX || "1000"),
  auctionId: process.env.AUCTION_ID,
};

runLoadTest(config)
  .then(() => {
    console.log("Load test completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Load test failed:", error);
    process.exit(1);
  });
