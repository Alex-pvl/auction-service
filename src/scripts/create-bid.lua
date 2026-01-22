-- Lua script for atomically creating a bid
-- KEYS[1] = user_balance:tg_id
-- KEYS[2] = bid:auction_id:round_id:user_id
-- KEYS[3] = idempotency:key
-- KEYS[4] = round_bids:auction_id:round_id (sorted set)
-- ARGV[1] = tg_id
-- ARGV[2] = amount
-- ARGV[3] = idempotency_key
-- ARGV[4] = auction_id
-- ARGV[5] = round_id
-- ARGV[6] = user_id
-- ARGV[7] = timestamp (for tie-breaking)
-- Returns: {success, balance_after, error_message}

local idempotency = redis.call('GET', KEYS[3])
if idempotency then
    return {1, 0, 'already_processed', idempotency}
end

local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[2])

if balance < amount then
    return {0, balance, 'insufficient_balance'}
end

local new_balance = balance - amount
redis.call('SET', KEYS[1], new_balance)

local existing_bid = redis.call('GET', KEYS[2])
if existing_bid then
    redis.call('SET', KEYS[1], balance)
    return {0, balance, 'bid_exists'}
end

local bid_data = cjson.encode({
    auction_id = ARGV[4],
    round_id = ARGV[5],
    user_id = ARGV[6],
    amount = amount,
    created_at = tonumber(ARGV[7])
})

redis.call('SET', KEYS[2], bid_data)
redis.call('EXPIRE', KEYS[2], 86400)

local score = -(amount * 1000000000000) + tonumber(ARGV[7])
redis.call('ZADD', KEYS[4], score, ARGV[6])
redis.call('EXPIRE', KEYS[4], 86400)

redis.call('SET', KEYS[3], '1', 'EX', 3600)

return {1, new_balance, 'success', bid_data}
