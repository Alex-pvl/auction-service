-- Lua script for atomically adding to existing bid
-- KEYS[1] = user_balance:tg_id
-- KEYS[2] = bid:auction_id:round_id:user_id
-- KEYS[3] = idempotency:key
-- KEYS[4] = round_bids:auction_id:round_id (sorted set)
-- ARGV[1] = tg_id
-- ARGV[2] = additional_amount
-- ARGV[3] = idempotency_key
-- ARGV[4] = auction_id
-- ARGV[5] = round_id
-- ARGV[6] = user_id
-- ARGV[7] = timestamp
-- Returns: {success, balance_after, new_amount, error_message}

local idempotency = redis.call('GET', KEYS[3])
if idempotency then
    local existing_bid = redis.call('GET', KEYS[2])
    if existing_bid then
        local bid = cjson.decode(existing_bid)
        return {1, 0, bid.amount, 'already_processed', existing_bid}
    end
    return {0, 0, 0, 'already_processed_no_bid'}
end

local existing_bid_raw = redis.call('GET', KEYS[2])
if not existing_bid_raw then
    return {0, 0, 0, 'bid_not_found'}
end

local existing_bid = cjson.decode(existing_bid_raw)
local current_amount = tonumber(existing_bid.amount)
local additional_amount = tonumber(ARGV[2])

local balance = tonumber(redis.call('GET', KEYS[1]) or '0')

if balance < additional_amount then
    return {0, balance, current_amount, 'insufficient_balance'}
end

local new_balance = balance - additional_amount
redis.call('SET', KEYS[1], new_balance)

local new_amount = current_amount + additional_amount
existing_bid.amount = new_amount
existing_bid.updated_at = tonumber(ARGV[7])

local updated_bid_data = cjson.encode(existing_bid)
redis.call('SET', KEYS[2], updated_bid_data)
redis.call('EXPIRE', KEYS[2], 86400)

local score = -(new_amount * 1000000000000) + tonumber(ARGV[7])
redis.call('ZADD', KEYS[4], score, ARGV[6])
redis.call('EXPIRE', KEYS[4], 86400)

redis.call('SET', KEYS[3], '1', 'EX', 3600)

return {1, new_balance, new_amount, 'success', updated_bid_data}
