const state = {
  user: null,
  currentAuctionId: null,
  ws: null,
};
async function apiRequest(path, options = {}) {
  const baseUrl = window.location.origin;
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.user?.tg_id && { "X-User-Id": String(state.user.tg_id) }),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function showPage(pageId) {
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.remove("active");
  });
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.remove("active");
  });
  const page = document.getElementById(`page-${pageId}`);
  const link = document.querySelector(`[data-page="${pageId}"]`);
  if (page) page.classList.add("active");
  if (link) link.classList.add("active");
}

function initRouter() {
  const hash = window.location.hash.slice(1) || "auth";
  showPage(hash);
  
  window.addEventListener("hashchange", () => {
    const hash = window.location.hash.slice(1) || "auth";
    showPage(hash);
  });

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const page = link.getAttribute("data-page");
      window.location.hash = page;
    });
  });
}


function updateUserInfo() {
  const userInfo = document.getElementById("user-info");
  const userName = document.getElementById("user-name");
  const userBalance = document.getElementById("user-balance");
  
  if (state.user) {
    userInfo.style.display = "flex";
    userName.textContent = state.user.username || `tg_${state.user.tg_id}`;
    userBalance.textContent = state.user.balance?.toFixed(2) || "0.00";
  } else {
    userInfo.style.display = "none";
  }
}


const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSuccess = document.getElementById("auth-success");
const authTgId = document.getElementById("auth-tg-id");
const balanceForm = document.getElementById("balance-form");
const balanceAmount = document.getElementById("balance-amount");
const balanceIncrease = document.getElementById("balance-increase");
const balanceDecrease = document.getElementById("balance-decrease");

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.style.display = "none";
  authSuccess.style.display = "none";
  
  const tgId = Number(authTgId.value);
  if (!Number.isFinite(tgId) || tgId <= 0) {
    authError.textContent = "Enter a valid Telegram ID";
    authError.style.display = "block";
    return;
  }

  try {
    const user = await apiRequest("/api/users/auth", {
      method: "POST",
      body: JSON.stringify({ tg_id: tgId }),
    });
    state.user = user;
    updateUserInfo();
    authSuccess.textContent = `Authorized as ${user.username}`;
    authSuccess.style.display = "block";
    authTgId.value = "";
  } catch (error) {
    authError.textContent = error.message || "Authorization failed";
    authError.style.display = "block";
  }
});

async function changeBalance(direction) {
  if (!state.user?.tg_id) {
    authError.textContent = "Authorize first";
    authError.style.display = "block";
    return;
  }
  const amount = Number(balanceAmount.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    authError.textContent = "Enter a valid amount";
    authError.style.display = "block";
    return;
  }
  const endpoint = direction === "increase"
    ? `/api/users/${state.user.tg_id}/balance/increase`
    : `/api/users/${state.user.tg_id}/balance/decrease`;
  try {
    const user = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify({ amount }),
    });
    state.user = user;
    updateUserInfo();
    balanceAmount.value = "";
    authSuccess.textContent = `Balance ${direction === "increase" ? "increased" : "decreased"} by ${amount}`;
    authSuccess.style.display = "block";
  } catch (error) {
    authError.textContent = error.message || "Balance update failed";
    authError.style.display = "block";
  }
}

balanceIncrease.addEventListener("click", () => changeBalance("increase"));
balanceDecrease.addEventListener("click", () => changeBalance("decrease"));


const createForm = document.getElementById("create-form");
const createError = document.getElementById("create-error");
const createSuccess = document.getElementById("create-success");
const createName = document.getElementById("create-name");
const createItem = document.getElementById("create-item");
const createMinBid = document.getElementById("create-min-bid");
const createWinners = document.getElementById("create-winners");
const createRounds = document.getElementById("create-rounds");
const createFirstRound = document.getElementById("create-first-round");
const createRoundDuration = document.getElementById("create-round-duration");
const createStartDatetime = document.getElementById("create-start-datetime");
function formatDateTimeInput(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    date = new Date();
  }
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
function parseDateTimeInput(value) {
  if (!value) return null;
  
  
  value = value.trim();
  
  
  const datetimePattern = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;
  const match = value.match(datetimePattern);
  
  if (match) {
    const [, year, month, day, hours, minutes, seconds] = match;
    
    const date = new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hours, 10),
      parseInt(minutes, 10),
      parseInt(seconds, 10)
    );
    
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  
  
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toISOString();
  }
  
  return null;
}

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  createError.style.display = "none";
  createSuccess.style.display = "none";

  if (!state.user) {
    createError.textContent = "Please authorize first";
    createError.style.display = "block";
    return;
  }

  
  const datetimeValue = createStartDatetime.value.trim();
  if (!datetimeValue) {
    createError.textContent = "Please enter start date and time";
    createError.style.display = "block";
    return;
  }
  
  const startIso = parseDateTimeInput(datetimeValue);
  if (!startIso) {
    createError.textContent = "Invalid date/time format. Use: YYYY-MM-DD HH:mm:ss (e.g., 2026-12-31 00:00:00)";
    createError.style.display = "block";
    return;
  }

  const payload = {
    name: createName.value.trim() || null,
    item_name: createItem.value.trim(),
    min_bid: Number(createMinBid.value),
    winners_count_total: Number(createWinners.value),
    rounds_count: Number(createRounds.value),
    first_round_duration_ms: createFirstRound.value ? Number(createFirstRound.value) : null,
    round_duration_ms: Number(createRoundDuration.value),
    start_datetime: startIso,
  };

  try {
    const auction = await apiRequest("/api/auctions", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    createSuccess.textContent = `Auction created! ID: ${auction._id}`;
    createSuccess.style.display = "block";
    createForm.reset();
    setDefaultStartTime();
  } catch (error) {
    createError.textContent = error.message || "Failed to create auction";
    createError.style.display = "block";
  }
});


function setDefaultStartTime() {
  const defaultDate = new Date(Date.now() + 60 * 60 * 1000);
  createStartDatetime.value = formatDateTimeInput(defaultDate);
}


createStartDatetime.addEventListener('input', function() {
  const value = this.value.trim();
  
  let formatted = value.replace(/[^\d]/g, '');
  
  if (formatted.length > 0) {
    
    let result = '';
    if (formatted.length <= 4) {
      result = formatted;
    } else if (formatted.length <= 6) {
      result = formatted.slice(0, 4) + '-' + formatted.slice(4);
    } else if (formatted.length <= 8) {
      result = formatted.slice(0, 4) + '-' + formatted.slice(4, 6) + '-' + formatted.slice(6);
    } else if (formatted.length <= 10) {
      result = formatted.slice(0, 4) + '-' + formatted.slice(4, 6) + '-' + formatted.slice(6, 8) + ' ' + formatted.slice(8);
    } else if (formatted.length <= 12) {
      result = formatted.slice(0, 4) + '-' + formatted.slice(4, 6) + '-' + formatted.slice(6, 8) + ' ' + 
               formatted.slice(8, 10) + ':' + formatted.slice(10);
    } else if (formatted.length <= 14) {
      result = formatted.slice(0, 4) + '-' + formatted.slice(4, 6) + '-' + formatted.slice(6, 8) + ' ' + 
               formatted.slice(8, 10) + ':' + formatted.slice(10, 12) + ':' + formatted.slice(12);
    } else {
      result = formatted.slice(0, 4) + '-' + formatted.slice(4, 6) + '-' + formatted.slice(6, 8) + ' ' + 
               formatted.slice(8, 10) + ':' + formatted.slice(10, 12) + ':' + formatted.slice(12, 14);
    }
    
    
    if (!value.includes('-') && !value.includes(':') && !value.includes(' ')) {
      const cursorPos = this.selectionStart;
      this.value = result;
      
      this.setSelectionRange(cursorPos, cursorPos);
    }
  }
});


createStartDatetime.addEventListener('blur', function() {
  const value = this.value.trim();
  if (value) {
    const parsed = parseDateTimeInput(value);
    if (parsed) {
      
      const date = new Date(parsed);
      this.value = formatDateTimeInput(date);
    } else {
      
      this.style.borderColor = 'var(--accent-deep)';
    }
  }
});

createStartDatetime.addEventListener('focus', function() {
  this.style.borderColor = 'var(--ink)';
});

setDefaultStartTime();


const watchForm = document.getElementById("watch-form");
const watchAuctionId = document.getElementById("watch-auction-id");
const wsStatus = document.getElementById("ws-status");
const liveContent = document.getElementById("live-content");
const liveEmpty = document.getElementById("live-empty");
const liveAuctionName = document.getElementById("live-auction-name");
const liveAuctionItem = document.getElementById("live-auction-item");
const liveAuctionStatus = document.getElementById("live-auction-status");
const liveRoundInfo = document.getElementById("live-round-info");
const liveRemainingItems = document.getElementById("live-remaining-items");
const liveTimer = document.getElementById("live-timer");
const topBidsList = document.getElementById("top-bids-list");
const userBidInfo = document.getElementById("user-bid-info");
const userBidAmount = document.getElementById("user-bid-amount");
const userBidPlace = document.getElementById("user-bid-place");
const bidForm = document.getElementById("bid-form");
const bidAmount = document.getElementById("bid-amount");
const bidIdempotency = document.getElementById("bid-idempotency");
const bidAddToExisting = document.getElementById("bid-add-to-existing");
const minBidInfo = document.getElementById("min-bid-info");

function formatTime(ms) {
  if (ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

let reconnectTimeout = null;
let shouldReconnect = true;

function connectWebSocket(auctionId) {
  if (state.ws) {
    shouldReconnect = false;
    state.ws.close();
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  }

  shouldReconnect = true;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    wsStatus.classList.remove("disconnected");
    wsStatus.classList.add("connected");
    state.ws.send(JSON.stringify({
      type: "subscribe",
      auction_id: auctionId,
      user_id: state.user?.tg_id ? String(state.user.tg_id) : undefined,
    }));
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "auction_state") {
        updateLiveAuction(data);
      } else if (data.type === "time_update") {
        updateTimer(data);
      } else if (data.type === "pong") {
        
      } else if (data.type === "error") {
        console.error("WebSocket error:", data.message);
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error);
    }
  };

  state.ws.onclose = () => {
    wsStatus.classList.remove("connected");
    wsStatus.classList.add("disconnected");
    if (shouldReconnect && state.currentAuctionId) {
      reconnectTimeout = setTimeout(() => {
        if (shouldReconnect && state.currentAuctionId) {
          connectWebSocket(state.currentAuctionId);
        }
      }, 3000);
    }
  };

  state.ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    wsStatus.classList.remove("connected");
    wsStatus.classList.add("disconnected");
  };
}

function updateTimer(data) {
  if (data.round && data.round.time_remaining_ms !== undefined) {
    const timeRemaining = data.round.time_remaining_ms || 0;
    liveTimer.textContent = formatTime(timeRemaining);
    
    if (timeRemaining < 60000) {
      liveTimer.classList.add("warning");
    } else {
      liveTimer.classList.remove("warning");
    }
  } else if (data.time_until_start_ms !== undefined) {
    const timeUntilStart = data.time_until_start_ms || 0;
    liveTimer.textContent = formatTime(timeUntilStart);
    liveTimer.classList.remove("warning");
  }
}

function updateLiveAuction(data) {
  const { auction, round, top_bids, all_bids, user_bid, user_place } = data;

  liveAuctionName.textContent = auction.name || "Untitled";
  liveAuctionItem.textContent = auction.item_name || "-";
  liveAuctionStatus.textContent = auction.status;
  liveRemainingItems.textContent = auction.remaining_items_count ?? "-";

  if (round) {
    const roundNum = round.idx + 1;
    const totalRounds = auction.rounds_count;
    liveRoundInfo.textContent = `Round ${roundNum} of ${totalRounds}`;
    
    const timeRemaining = round.time_remaining_ms || 0;
    liveTimer.textContent = formatTime(timeRemaining);
    
    if (timeRemaining < 60000) {
      liveTimer.classList.add("warning");
    } else {
      liveTimer.classList.remove("warning");
    }

    if (round.extended_until) {
      liveTimer.textContent += " (extended)";
    }
  } else {
    liveRoundInfo.textContent = "No active round";
    liveTimer.textContent = "--:--";
  }

  if (auction.min_bid !== undefined) {
    const minBid = auction.min_bid || auction.base_min_bid || 0;
    const roundNum = round ? round.idx + 1 : 1;
    minBidInfo.textContent = `Minimum bid for round ${roundNum}: ${minBid.toFixed(2)}`;
    if (!bidAddToExisting || !bidAddToExisting.checked) {
      bidAmount.min = minBid;
    } else {
      bidAmount.removeAttribute("min");
    }
  }

  const userInfoElement = document.getElementById("user-info-top");
  if (!userInfoElement) {
    const infoDiv = document.createElement("div");
    infoDiv.id = "user-info-top";
    infoDiv.className = "round-info";
    infoDiv.style.marginBottom = "12px";
    topBidsList.parentNode.insertBefore(infoDiv, topBidsList);
  }
  
  if (state.user && user_bid) {
    const userInfoTop = document.getElementById("user-info-top");
    const placeText = user_place !== null && user_place !== undefined ? `#${user_place}` : "Calculating...";
    const amountText = typeof user_bid.amount === 'number' ? user_bid.amount.toFixed(2) : user_bid.amount;
    userInfoTop.innerHTML = `
      <div style="padding: 12px; background: var(--surface); border-radius: 8px;">
        <strong>Your Telegram ID:</strong> ${state.user.tg_id} | 
        <strong>Your Bid:</strong> ${amountText} | 
        <strong>Your Place:</strong> ${placeText}
      </div>
    `;
    userInfoTop.style.display = "block";
  } else {
    const userInfoTop = document.getElementById("user-info-top");
    if (userInfoTop) {
      userInfoTop.style.display = "none";
    }
  }

  topBidsList.innerHTML = "";
  const top3Bids = top_bids ? top_bids.slice(0, 3) : [];
  if (top3Bids.length > 0) {
    top3Bids.forEach((bid, index) => {
      const bidItem = document.createElement("div");
      bidItem.className = "bid-item";
      if (index < 3) bidItem.classList.add("top3");
      if (user_bid && user_place && bid.place_id === user_place) {
        bidItem.classList.add("user-bid");
      }
      const userIdDisplay = bid.user_id || "Unknown";
      bidItem.innerHTML = `
        <div>
          <span class="bid-place">#${bid.place_id}</span>
          <span style="margin-left: 12px;">User: ${userIdDisplay}</span>
        </div>
        <div class="bid-amount">${typeof bid.amount === 'number' ? bid.amount.toFixed(2) : bid.amount}</div>
      `;
      topBidsList.appendChild(bidItem);
    });
  } else {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No bids yet";
    topBidsList.appendChild(empty);
  }

  const allBidsList = document.getElementById("all-bids-list");
  if (allBidsList) {
    allBidsList.innerHTML = "";
    if (all_bids && all_bids.length > 0) {
      all_bids.forEach((bid) => {
        const bidItem = document.createElement("div");
        bidItem.className = "bid-item";
        if (bid.place_id <= 3) bidItem.classList.add("top3");
        if (user_bid && user_place && bid.place_id === user_place) {
          bidItem.classList.add("user-bid");
        }
        const userIdDisplay = bid.user_id || "Unknown";
        bidItem.innerHTML = `
          <div>
            <span class="bid-place">#${bid.place_id}</span>
            <span style="margin-left: 12px;">User: ${userIdDisplay}</span>
          </div>
          <div class="bid-amount">${typeof bid.amount === 'number' ? bid.amount.toFixed(2) : bid.amount}</div>
        `;
        allBidsList.appendChild(bidItem);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No participants yet";
      allBidsList.appendChild(empty);
    }
  }

  if (user_bid) {
    userBidInfo.style.display = "block";
    userBidAmount.textContent = typeof user_bid.amount === 'number' ? user_bid.amount.toFixed(2) : user_bid.amount;
    if (user_place !== null && user_place !== undefined) {
      userBidPlace.textContent = `#${user_place}`;
    } else {
      userBidPlace.textContent = "Calculating...";
    }
  } else {
    userBidInfo.style.display = "none";
  }
}

watchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const auctionId = watchAuctionId.value.trim();
  if (!auctionId) return;

  try {
    const auction = await apiRequest(`/api/auctions/${auctionId}`);
    if (auction.min_bid !== undefined) {
      bidAmount.min = auction.min_bid;
      minBidInfo.textContent = `Minimum bid: ${auction.min_bid.toFixed(2)}`;
    }
  } catch (error) {
    console.error("Failed to load auction:", error);
  }

  state.currentAuctionId = auctionId;
  liveContent.style.display = "block";
  liveEmpty.style.display = "none";
  shouldReconnect = true;
  connectWebSocket(auctionId);
});

function generateIdempotencyKey() {
  bidIdempotency.value = `bid-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

bidIdempotency.addEventListener("focus", generateIdempotencyKey);

if (bidAddToExisting) {
  bidAddToExisting.addEventListener("change", () => {
    if (bidAddToExisting.checked) {
      bidAmount.removeAttribute("min");
    } else {
      const minBidText = minBidInfo.textContent;
      if (minBidText) {
        const match = minBidText.match(/[\d.]+/);
        if (match) {
          bidAmount.min = parseFloat(match[0]);
        }
      }
    }
  });
}

bidForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  
  if (!state.user) {
    alert("Please authorize first");
    return;
  }

  if (!state.currentAuctionId) {
    alert("Select an auction to watch");
    return;
  }

  const amount = Number(bidAmount.value);
  const idempotencyKey = bidIdempotency.value.trim();
  const addToExisting = bidAddToExisting.checked;

  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Enter valid amount");
    return;
  }

  if (!idempotencyKey) {
    alert("Enter idempotency key");
    return;
  }

  try {
    const response = await apiRequest(`/api/auctions/${state.currentAuctionId}/bids`, {
      method: "POST",
      body: JSON.stringify({
        amount,
        idempotency_key: idempotencyKey,
        add_to_existing: addToExisting,
      }),
    });

    bidAmount.value = "";
    generateIdempotencyKey();
    
    if (response.remaining_balance !== undefined) {
      state.user.balance = response.remaining_balance;
      updateUserInfo();
    }
  } catch (error) {
    alert(error.message || "Bid failed");
  }
});

const auctionsList = document.getElementById("auctions-list");
const auctionsError = document.getElementById("auctions-error");
const auctionsSuccess = document.getElementById("auctions-success");
const auctionDetail = document.getElementById("auction-detail");
const auctionDetailContent = document.getElementById("auction-detail-content");
const auctionDetailBack = document.getElementById("auction-detail-back");
const filterButtons = document.querySelectorAll(".filter-btn");

let currentFilter = "all";
let allAuctions = [];
let currentAuction = null;

async function loadAuctions() {
  if (!state.user) {
    auctionsError.textContent = "Please authorize first";
    auctionsError.style.display = "block";
    return;
  }

  try {
    auctionsError.style.display = "none";
    const activeAuctions = await apiRequest("/api/auctions?status=LIVE&limit=100");
    const releasedAuctions = await apiRequest("/api/auctions?status=RELEASED&limit=100");
    const finishedAuctions = await apiRequest("/api/auctions?status=FINISHED&limit=100");
    const allDrafts = await apiRequest("/api/auctions?status=DRAFT&limit=100");
    const userDrafts = allDrafts.filter(auction => auction.creator_id === state.user.tg_id);
    
    allAuctions = [
      ...activeAuctions,
      ...releasedAuctions,
      ...finishedAuctions,
      ...userDrafts
    ];
    
    renderAuctions();
  } catch (error) {
    auctionsError.textContent = error.message || "Failed to load auctions";
    auctionsError.style.display = "block";
  }
}


function renderAuctions() {
  if (!auctionsList) return;
  
  let filtered = allAuctions;
  
  if (currentFilter !== "all") {
    filtered = allAuctions.filter(auction => auction.status === currentFilter);
  }
  
  if (filtered.length === 0) {
    auctionsList.innerHTML = '<div class="empty">No auctions found</div>';
    return;
  }
  
  auctionsList.innerHTML = filtered.map(auction => {
    const startDate = new Date(auction.start_datetime).toLocaleString();
    const statusClass = auction.status;
    
    return `
      <div class="auction-card" data-auction-id="${auction._id}">
        <div class="auction-card-header">
          <h3 class="auction-card-title">${auction.name || auction.item_name || 'Untitled'}</h3>
          <span class="auction-card-status ${statusClass}">${auction.status}</span>
        </div>
        <div class="auction-card-info">
          <div><strong>Item:</strong> ${auction.item_name}</div>
          <div><strong>ID:</strong> ${auction._id}</div>
          <div><strong>Start:</strong> ${startDate}</div>
          <div><strong>Rounds:</strong> ${auction.rounds_count}</div>
          <div><strong>Winners:</strong> ${auction.winners_count_total}</div>
        </div>
        ${auction.status === "DRAFT" && auction.creator_id === state.user?.tg_id ? `
          <div class="auction-card-actions">
            <button type="button" class="edit-auction-btn" data-auction-id="${auction._id}">Edit</button>
            <button type="button" class="release-auction-btn" data-auction-id="${auction._id}">Release</button>
            <button type="button" class="delete-auction-btn secondary" data-auction-id="${auction._id}">Delete</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  
  document.querySelectorAll('.auction-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const auctionId = card.getAttribute('data-auction-id');
      showAuctionDetail(auctionId);
    });
  });
  
  document.querySelectorAll('.edit-auction-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const auctionId = btn.getAttribute('data-auction-id');
      editAuction(auctionId);
    });
  });
  
  document.querySelectorAll('.release-auction-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const auctionId = btn.getAttribute('data-auction-id');
      await releaseAuction(auctionId);
    });
  });
  
  document.querySelectorAll('.delete-auction-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const auctionId = btn.getAttribute('data-auction-id');
      await deleteAuction(auctionId);
    });
  });
}


async function showAuctionDetail(auctionId) {
  try {
    const auction = await apiRequest(`/api/auctions/${auctionId}`);
    currentAuction = auction;
    
    const startDate = new Date(auction.start_datetime).toLocaleString();
    const endDate = auction.planned_end_datetime ? new Date(auction.planned_end_datetime).toLocaleString() : 'N/A';
    
    auctionDetailContent.innerHTML = `
      <div class="auction-detail-section">
        <h3>General Information</h3>
        <div class="auction-detail-info">
          <div><strong>Name:</strong> ${auction.name || 'N/A'}</div>
          <div><strong>Item:</strong> ${auction.item_name}</div>
          <div><strong>Status:</strong> <span class="auction-card-status ${auction.status}">${auction.status}</span></div>
          <div><strong>ID:</strong> ${auction._id}</div>
        </div>
      </div>
      
      <div class="auction-detail-section">
        <h3>Settings</h3>
        <div class="auction-detail-info">
          <div><strong>Min Bid:</strong> ${auction.min_bid}</div>
          <div><strong>Winners Total:</strong> ${auction.winners_count_total}</div>
          <div><strong>Rounds Count:</strong> ${auction.rounds_count}</div>
          <div><strong>Winners Per Round:</strong> ${auction.winners_per_round}</div>
          <div><strong>Round Duration:</strong> ${auction.round_duration_ms}ms</div>
          ${auction.first_round_duration_ms ? `<div><strong>First Round Duration:</strong> ${auction.first_round_duration_ms}ms</div>` : ''}
        </div>
      </div>
      
      <div class="auction-detail-section">
        <h3>Timing</h3>
        <div class="auction-detail-info">
          <div><strong>Start Date/Time:</strong> ${startDate}</div>
          <div><strong>Planned End:</strong> ${endDate}</div>
          <div><strong>Current Round:</strong> ${auction.current_round_idx + 1} / ${auction.rounds_count}</div>
          <div><strong>Remaining Items:</strong> ${auction.remaining_items_count}</div>
        </div>
      </div>
      
      ${auction.status === "DRAFT" && auction.creator_id === state.user?.tg_id ? `
        <div class="auction-detail-section">
          <h3>Actions</h3>
          <div style="display: flex; gap: 12px; flex-wrap: wrap;">
            <button type="button" class="edit-auction-detail-btn">Edit</button>
            <button type="button" class="release-auction-detail-btn">Release</button>
            <button type="button" class="delete-auction-detail-btn secondary">Delete</button>
          </div>
        </div>
      ` : ''}
    `;
    
    
    const editBtn = auctionDetailContent.querySelector('.edit-auction-detail-btn');
    const releaseBtn = auctionDetailContent.querySelector('.release-auction-detail-btn');
    const deleteBtn = auctionDetailContent.querySelector('.delete-auction-detail-btn');
    
    if (editBtn) {
      editBtn.addEventListener('click', () => editAuction(auctionId));
    }
    if (releaseBtn) {
      releaseBtn.addEventListener('click', () => releaseAuction(auctionId));
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => deleteAuction(auctionId));
    }
    
    document.getElementById("auctions-content").style.display = "none";
    auctionDetail.style.display = "block";
  } catch (error) {
    auctionsError.textContent = error.message || "Failed to load auction details";
    auctionsError.style.display = "block";
  }
}

function editAuction(auctionId) {
  const auction = allAuctions.find(a => a._id === auctionId);
  if (!auction) {
    
    loadAuctionForEdit(auctionId);
    return;
  }
  
  window.location.hash = "edit";
  
  setTimeout(() => {
    fillEditForm(auction);
  }, 100);
}

async function loadAuctionForEdit(auctionId) {
  try {
    const auction = await apiRequest(`/api/auctions/${auctionId}`);
    window.location.hash = "edit";
    setTimeout(() => {
      fillEditForm(auction);
    }, 100);
  } catch (error) {
    if (auctionsError) {
      auctionsError.textContent = error.message || "Failed to load auction";
      auctionsError.style.display = "block";
    }
  }
}

function fillEditForm(auction) {
  const editName = document.getElementById("edit-name");
  const editItem = document.getElementById("edit-item");
  const editMinBid = document.getElementById("edit-min-bid");
  const editWinners = document.getElementById("edit-winners");
  const editRounds = document.getElementById("edit-rounds");
  const editFirstRound = document.getElementById("edit-first-round");
  const editRoundDuration = document.getElementById("edit-round-duration");
  const editStartDatetime = document.getElementById("edit-start-datetime");
  const editForm = document.getElementById("edit-form");
  
  if (editName) editName.value = auction.name || "";
  if (editItem) editItem.value = auction.item_name || "";
  if (editMinBid) editMinBid.value = auction.min_bid || "";
  if (editWinners) editWinners.value = auction.winners_count_total || "";
  if (editRounds) editRounds.value = auction.rounds_count || "";
  if (editFirstRound) editFirstRound.value = auction.first_round_duration_ms || "";
  if (editRoundDuration) editRoundDuration.value = auction.round_duration_ms || "";
  if (editStartDatetime) {
    const startDate = new Date(auction.start_datetime);
    editStartDatetime.value = formatDateTimeInput(startDate);
  }
  
  if (editForm) editForm.dataset.editId = auction._id;
}

async function releaseAuction(auctionId) {
  if (!confirm("Are you sure you want to release this auction?")) return;
  
  try {
    await apiRequest(`/api/auctions/${auctionId}/release`, {
      method: "POST",
    });
    
    auctionsSuccess.textContent = "Auction released successfully!";
    auctionsSuccess.style.display = "block";
    
    setTimeout(() => {
      auctionsSuccess.style.display = "none";
      loadAuctions();
      if (currentAuction && currentAuction._id === auctionId) {
        showAuctionDetail(auctionId);
      }
    }, 2000);
  } catch (error) {
    auctionsError.textContent = error.message || "Failed to release auction";
    auctionsError.style.display = "block";
  }
}

async function deleteAuction(auctionId) {
  if (!confirm("Are you sure you want to delete this auction? This action cannot be undone.")) return;
  
  try {
    await apiRequest(`/api/auctions/${auctionId}`, {
      method: "DELETE",
    });
    
    auctionsSuccess.textContent = "Auction deleted successfully!";
    auctionsSuccess.style.display = "block";
    
    setTimeout(() => {
      auctionsSuccess.style.display = "none";
      hideAuctionDetail();
      loadAuctions();
    }, 2000);
  } catch (error) {
    auctionsError.textContent = error.message || "Failed to delete auction";
    auctionsError.style.display = "block";
  }
}

function hideAuctionDetail() {
  document.getElementById("auctions-content").style.display = "block";
  auctionDetail.style.display = "none";
  currentAuction = null;
}

filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filterButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter');
    renderAuctions();
  });
});

if (auctionDetailBack) {
  auctionDetailBack.addEventListener('click', hideAuctionDetail);
}

function initAuctionsPage() {
  if (window.location.hash === "#auctions" || window.location.hash.slice(1) === "auctions") {
    loadAuctions();
  }
}

const originalShowPage = showPage;
showPage = function(pageId) {
  originalShowPage(pageId);
  if (pageId === "auctions") {
    loadAuctions();
  }
};

const editForm = document.getElementById("edit-form");
const editError = document.getElementById("edit-error");
const editSuccess = document.getElementById("edit-success");
const editCancelBtn = document.getElementById("edit-cancel-btn");

if (editForm) {
  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (editError) editError.style.display = "none";
    if (editSuccess) editSuccess.style.display = "none";

    if (!state.user) {
      if (editError) {
        editError.textContent = "Please authorize first";
        editError.style.display = "block";
      }
      return;
    }

    const editId = editForm.dataset.editId;
    if (!editId) {
      if (editError) {
        editError.textContent = "No auction selected for editing";
        editError.style.display = "block";
      }
      return;
    }

    const editStartDatetime = document.getElementById("edit-start-datetime");
    const datetimeValue = editStartDatetime ? editStartDatetime.value.trim() : "";
    if (!datetimeValue) {
      if (editError) {
        editError.textContent = "Please enter start date and time";
        editError.style.display = "block";
      }
      return;
    }
    
    const startIso = parseDateTimeInput(datetimeValue);
    if (!startIso) {
      if (editError) {
        editError.textContent = "Invalid date/time format. Use: YYYY-MM-DD HH:mm:ss (e.g., 2026-12-31 00:00:00)";
        editError.style.display = "block";
      }
      return;
    }

    const editName = document.getElementById("edit-name");
    const editItem = document.getElementById("edit-item");
    const editMinBid = document.getElementById("edit-min-bid");
    const editWinners = document.getElementById("edit-winners");
    const editRounds = document.getElementById("edit-rounds");
    const editFirstRound = document.getElementById("edit-first-round");
    const editRoundDuration = document.getElementById("edit-round-duration");

    const payload = {
      name: editName ? editName.value.trim() || null : null,
      item_name: editItem ? editItem.value.trim() : "",
      min_bid: editMinBid ? Number(editMinBid.value) : 0,
      winners_count_total: editWinners ? Number(editWinners.value) : 0,
      rounds_count: editRounds ? Number(editRounds.value) : 0,
      first_round_duration_ms: editFirstRound && editFirstRound.value ? Number(editFirstRound.value) : null,
      round_duration_ms: editRoundDuration ? Number(editRoundDuration.value) : 0,
      start_datetime: startIso,
    };

    try {
      const auction = await apiRequest(`/api/auctions/${editId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      
      if (editSuccess) {
        editSuccess.textContent = `Auction updated! ID: ${auction._id}`;
        editSuccess.style.display = "block";
      }
      
      editForm.reset();
      delete editForm.dataset.editId;
      
      
      setTimeout(() => {
        window.location.hash = "auctions";
        loadAuctions();
      }, 1500);
    } catch (error) {
      if (editError) {
        editError.textContent = error.message || "Failed to update auction";
        editError.style.display = "block";
      }
    }
  });
}

if (editCancelBtn) {
  editCancelBtn.addEventListener("click", () => {
    window.location.hash = "auctions";
  });
}

initRouter();
updateUserInfo();
initAuctionsPage();