-- Lua script for getting user place in round
-- KEYS[1] = round_bids:auction_id:round_id (sorted set)
-- ARGV[1] = user_id
-- Returns: place (1-based) or 0 if not found

local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if rank == false then
    return 0
end

return rank + 1
