const state = {
  meta: {},
  listings: [],
  reddit: [],
  userState: { shortlisted: [], hidden: [], notes: {} },
  activeSection: "listings",
  activeChip: "all",
  activeRedditTopic: "All",
  searchQuery: "",
  locality: "all",
  sortBy: "best-match",
  showHidden: false,
  lastKnownRound: null,
  lastKnownCount: null,
};

const STORAGE_KEY = "staymid_chennai_user_state_v1";
const IS_EMBEDDED = Boolean(window.__EMBEDDED_STAYMID_DATA__);
const IS_LOCAL_SERVER =
  location.hostname === "127.0.0.1" || location.hostname === "localhost";

function loadLocalUserState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveUserState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.userState));
  } catch {}
  if (IS_EMBEDDED || !IS_LOCAL_SERVER) return;
  try {
    await fetch("/api/user-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.userState),
    });
  } catch {}
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatInr(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "Check";
  return "₹" + n.toLocaleString("en-IN");
}

function formatRange(min, max) {
  if (min === max) return formatInr(min);
  return `${formatInr(min)}–${formatInr(max)}`;
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add("hidden"), 4500);
}

function parseAvgCommute(item) {
  const nums = (txt) => {
    const m = String(txt || "").match(/\d+/g);
    if (!m) return 40;
    const vals = m.map(Number);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  return (nums(item.commute?.jidokaMins) + nums(item.commute?.iitmMins)) / 2;
}

function matchesChip(item, chip) {
  const kit = (item.features?.kitchen || "").toLowerCase();
  const ac = (item.features?.ac || "").toLowerCase();
  const beds = (item.features?.beds || "").toLowerCase();
  const cat = (item.category || "").toLowerCase();

  switch (chip) {
    case "in-budget":
      return item.pricing?.budgetFit === "in-budget";
    case "borderline":
      return item.pricing?.budgetFit === "borderline" || item.pricing?.budgetFit === "in-budget";
    case "kitchen": {
      const ka = item.features?.kitchenAccess;
      if (ka) return ka === "full" || ka === "shared";
      return (
        kit.includes("full private kitchen") ||
        kit.includes("shared common kitchen") ||
        kit.includes("shared induction") ||
        kit.includes("dedicated kitchen")
      );
    }
    case "ac":
      return ac.startsWith("yes");
    case "beds":
      return beds.startsWith("yes");
    case "pg":
      return cat.includes("pg");
    case "flat":
      return cat.includes("1rk") || cat.includes("1bhk");
    case "coliving":
      return cat.includes("co-living");
    case "shortlisted":
      return state.userState.shortlisted.includes(item.id);
    default:
      return true;
  }
}

function getFilteredListings() {
  const q = state.searchQuery.trim().toLowerCase();
  const hiddenSet = new Set(state.userState.hidden || []);

  const filtered = state.listings.filter((item) => {
    if (!state.showHidden && hiddenSet.has(item.id)) return false;
    if (state.locality !== "all" && item.locality !== state.locality) return false;
    if (!matchesChip(item, state.activeChip)) return false;
    if (q) {
      const hay = JSON.stringify(item).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const fitRank = { "in-budget": 0, borderline: 1, stretch: 2 };
  filtered.sort((a, b) => {
    if (state.sortBy === "price-asc") {
      return (
        (a.pricing?.effectiveTotalPerPersonMin ?? 99999) -
        (b.pricing?.effectiveTotalPerPersonMin ?? 99999)
      );
    }
    if (state.sortBy === "commute-asc") {
      return parseAvgCommute(a) - parseAvgCommute(b);
    }
    if (state.sortBy === "newest") {
      return (b.addedRound || 0) - (a.addedRound || 0);
    }
    // best-match: budgetFit first, then kitchen bonus, then lower total
    const fDiff = (fitRank[a.pricing?.budgetFit] ?? 9) - (fitRank[b.pricing?.budgetFit] ?? 9);
    if (fDiff !== 0) return fDiff;
    const kA = matchesChip(a, "kitchen") ? 0 : 1;
    const kB = matchesChip(b, "kitchen") ? 0 : 1;
    if (kA !== kB) return kA - kB;
    return (
      (a.pricing?.effectiveTotalPerPersonMin ?? 99999) -
      (b.pricing?.effectiveTotalPerPersonMin ?? 99999)
    );
  });

  return filtered;
}

function renderHeaderAndKpis() {
  const total = state.listings.length;
  const inBudget = state.listings.filter((x) => x.pricing?.budgetFit === "in-budget").length;
  const hasKitchen = state.listings.filter((x) => matchesChip(x, "kitchen")).length;
  const shortlistedCount = (state.userState.shortlisted || []).filter((id) =>
    state.listings.some((x) => x.id === id)
  ).length;

  document.getElementById("kpi-total").textContent = total;
  document.getElementById("kpi-inbudget").textContent = inBudget;
  document.getElementById("kpi-kitchen").textContent = hasKitchen;
  document.getElementById("kpi-shortlisted").textContent = shortlistedCount;
  document.getElementById("tab-count-listings").textContent = total;
  document.getElementById("tab-count-reddit").textContent = state.reddit.length;
  document.getElementById("hidden-count").textContent = (state.userState.hidden || []).length;

  const round = state.meta.roundsCompleted ?? 1;
  document.getElementById("meta-round").textContent = round;
  if (state.meta.lastUpdated) {
    const dt = new Date(state.meta.lastUpdated);
    document.getElementById("meta-updated").textContent = Number.isNaN(dt.getTime())
      ? state.meta.lastUpdated
      : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const pill = document.getElementById("live-status-pill");
  const statusText = document.getElementById("live-status-text");
  const shareBtn = document.getElementById("share-html-btn");
  if (IS_EMBEDDED) {
    pill.classList.add("paused");
    statusText.textContent = `Shared Snapshot · Round ${round}`;
    if (shareBtn) shareBtn.classList.add("hidden");
  } else {
    const isPaused = String(state.meta.searchStatus || "").toUpperCase() === "STOPPED";
    pill.classList.toggle("paused", isPaused);
    if (!IS_LOCAL_SERVER) {
      statusText.textContent = isPaused
        ? `Hosted Archive · Round ${round}`
        : `GitHub Live · Round ${round}`;
      if (shareBtn) {
        shareBtn.setAttribute("href", "./share.html");
        shareBtn.setAttribute("download", `staymid-chennai-round-${round}.html`);
      }
    } else {
      statusText.textContent = isPaused
        ? `Search Stopped · Round ${round}`
        : `Live Search · Round ${round}`;
    }
  }

  document.getElementById("next-focus-line").textContent = state.meta.nextFocus
    ? `Next: ${state.meta.nextFocus}`
    : "";
}

function populateLocalities() {
  const select = document.getElementById("locality-select");
  const prev = select.value;
  const localities = Array.from(new Set(state.listings.map((x) => x.locality).filter(Boolean))).sort();
  select.innerHTML =
    `<option value="all">All Midpoint Areas (${state.listings.length})</option>` +
    localities.map((loc) => `<option value="${escapeHtml(loc)}">${escapeHtml(loc)}</option>`).join("");
  if (localities.includes(prev)) select.value = prev;
}

function fitBadgeMeta(fit) {
  if (fit === "in-budget") return { cls: "badge-fit-in-budget", label: "Fits ≤ ₹8k/Person" };
  if (fit === "borderline") return { cls: "badge-fit-borderline", label: "Borderline (₹8k–₹11k)" };
  return { cls: "badge-fit-stretch", label: "Benchmark (> ₹8k Cap)" };
}

function renderListings() {
  const grid = document.getElementById("listings-grid");
  const items = getFilteredListings();
  const shortlistedSet = new Set(state.userState.shortlisted || []);
  const hiddenSet = new Set(state.userState.hidden || []);
  const latestRound = state.meta.roundsCompleted ?? 1;

  document.getElementById("results-summary").textContent =
    `Showing ${items.length} of ${state.listings.length} verified places`;

  if (!items.length) {
    grid.innerHTML = `<div class="panel-card"><h3>No stays match your active filters</h3><p class="muted-xs">Try clearing the search query or switching back to "All Verified".</p></div>`;
    return;
  }

  grid.innerHTML = items
    .map((item) => {
      const p = item.pricing || {};
      const fit = fitBadgeMeta(p.budgetFit);
      const isStar = shortlistedSet.has(item.id);
      const isHidden = hiddenSet.has(item.id);
      const isNew = latestRound > 1 && item.addedRound === latestRound;
      const included = (item.features?.included || []).slice(0, 4);
      const missing = (item.features?.missingOrCaveat || []).slice(0, 4);

      return `
        <article class="stay-card ${isStar ? "shortlisted" : ""} ${isHidden ? "is-hidden-card" : ""}" data-id="${escapeHtml(item.id)}">
          <div class="card-badges">
            <span class="badge ${fit.cls}">${fit.label}</span>
            <span class="badge badge-cat">${escapeHtml(item.category)}</span>
            <span class="badge badge-metro">🚇 ${escapeHtml(item.metroStation)}</span>
            ${isNew ? `<span class="badge badge-new">NEW · Round ${item.addedRound}</span>` : ""}
          </div>

          <div class="card-header">
            <h3>${escapeHtml(item.name)}</h3>
            <div class="card-address">📍 ${escapeHtml(item.address)} · ${escapeHtml(item.metroWalk || "")}</div>
          </div>

          <div class="price-strip">
            <div>
              <div class="price-main">${formatRange(p.effectiveTotalPerPersonMin, p.effectiveTotalPerPersonMax)}<span class="price-sub"> /person</span></div>
              <div class="price-sub">Est. Total incl. AC EB (${formatRange(p.estimatedAcEbPerPersonMin, p.estimatedAcEbPerPersonMax)})</div>
            </div>
            <div>
              <div class="price-main">${formatRange(p.monthlyRentPerPersonMin, p.monthlyRentPerPersonMax)}<span class="price-sub"> rent</span></div>
              <div class="price-sub">Deposit: ${escapeHtml(p.deposit || "Verify")}</div>
            </div>
          </div>

          <div class="commute-strip">
            <div class="commute-pill">
              <strong>You → Jidoka: ${escapeHtml(item.commute?.jidokaMins)}</strong>
              <span>${escapeHtml(item.commute?.jidokaRoute)}</span>
            </div>
            <div class="commute-pill">
              <strong>Friend → IITM: ${escapeHtml(item.commute?.iitmMins)}</strong>
              <span>${escapeHtml(item.commute?.iitmRoute)}</span>
            </div>
          </div>

          <div class="quick-specs">
            <span class="spec-tag">❄️ AC: ${escapeHtml(item.features?.ac)}</span>
            <span class="spec-tag">🛏️ Beds: ${escapeHtml(item.features?.beds)}</span>
            <span class="spec-tag">🍳 ${escapeHtml(item.features?.kitchen)}</span>
            <span class="spec-tag">👤 ${escapeHtml(item.eligibility)}</span>
          </div>

          <div class="feature-split">
            <div class="feature-col good">
              <h4>✅ What's There</h4>
              <ul class="feature-list">
                ${included.map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
              </ul>
            </div>
            <div class="feature-col bad">
              <h4>❌ Missing / Check</h4>
              <ul class="feature-list">
                ${missing.map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
              </ul>
            </div>
          </div>

          <div class="reddit-box">
            <strong>💬 Reddit / Community Note:</strong> ${escapeHtml(item.redditSummary)}
          </div>

          <div class="card-actions">
            <a class="btn btn-primary" href="${escapeHtml(item.links?.listingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.links?.listingLabel || "Open Listing")} ↗</a>
            <a class="btn" href="${escapeHtml(item.links?.mapsUrl)}" target="_blank" rel="noopener noreferrer">Maps 📍</a>
            <button class="btn js-details" data-id="${escapeHtml(item.id)}">Details</button>
            <button class="btn btn-star ${isStar ? "active" : ""} js-star" data-id="${escapeHtml(item.id)}">${isStar ? "★ Saved" : "☆ Save"}</button>
            <button class="btn js-hide" data-id="${escapeHtml(item.id)}">${isHidden ? "Unhide" : "Hide"}</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderMetroSection() {
  const wpGrid = document.getElementById("workplaces-grid");
  const wps = state.meta.workplaces || {};
  wpGrid.innerHTML = Object.values(wps)
    .map(
      (wp) => `
      <div class="wp-card">
        <h4>${escapeHtml(wp.label)}</h4>
        <p>${escapeHtml(wp.address)}</p>
        <p><strong>Transit:</strong> ${escapeHtml(wp.nearestMetro)}</p>
        <a class="btn" href="${escapeHtml(wp.mapsUrl)}" target="_blank" rel="noopener noreferrer">Open on Google Maps 📍</a>
      </div>
    `
    )
    .join("");

  const tbody = document.getElementById("metro-table-body");
  tbody.innerHTML = (state.meta.metroMatrix || [])
    .map(
      (row) => `
      <tr>
        <td><strong>${escapeHtml(row.station)}</strong></td>
        <td><span class="badge badge-metro">${escapeHtml(row.line)}</span></td>
        <td>${escapeHtml(row.toJidoka)}</td>
        <td>${escapeHtml(row.toIITM)}</td>
        <td>${escapeHtml(row.metroFareToGuindy)}</td>
        <td>${escapeHtml(row.vibe)}</td>
      </tr>
    `
    )
    .join("");
}

function renderRedditSection() {
  const topics = ["All", ...new Set(state.reddit.map((r) => r.topic).filter(Boolean))];
  const chipRow = document.getElementById("reddit-topic-chips");
  chipRow.innerHTML = topics
    .map(
      (t) =>
        `<button class="chip ${state.activeRedditTopic === t ? "active" : ""}" data-topic="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    )
    .join("");

  const filtered = state.reddit.filter(
    (r) => state.activeRedditTopic === "All" || r.topic === state.activeRedditTopic
  );

  document.getElementById("reddit-grid").innerHTML = filtered
    .map(
      (r) => `
      <article class="reddit-card">
        <div class="reddit-card-top">
          <span>${escapeHtml(r.subreddit)}</span>
          <span>${escapeHtml(r.topic)}</span>
        </div>
        <h3>${escapeHtml(r.title)}</h3>
        <p>${escapeHtml(r.takeaway)}</p>
        <div class="reddit-tip"><strong>Tip:</strong> ${escapeHtml(r.actionableTip)}</div>
        <div>
          <a class="btn" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Open Reddit Thread ↗</a>
        </div>
      </article>
    `
    )
    .join("");
}

function renderSearchLog() {
  document.getElementById("next-focus-card").innerHTML = `
    <strong>Current Status:</strong> ${escapeHtml(state.meta.statusLabel || "Active")}<br />
    <strong>Next Search Queue:</strong> ${escapeHtml(state.meta.nextFocus || "Scanning more portals & areas...")}
  `;

  const logs = [...(state.meta.searchLog || [])].reverse();
  document.getElementById("search-log-list").innerHTML = logs
    .map(
      (entry) => `
      <div class="log-item">
        <div class="log-item-head">
          <span>Round #${escapeHtml(entry.round)} — +${escapeHtml(entry.addedCount)} entries</span>
          <span class="muted-xs">${escapeHtml(entry.timestamp)}</span>
        </div>
        <div class="muted-xs" style="margin-bottom:6px;"><strong>Searched:</strong> ${escapeHtml(entry.queryFocus)}</div>
        <div style="font-size:13px;">${escapeHtml(entry.notes)}</div>
      </div>
    `
    )
    .join("");
}

function openDetailsModal(id) {
  const item = state.listings.find((x) => x.id === id);
  if (!item) return;
  const p = item.pricing || {};
  const note = (state.userState.notes || {})[id] || "";
  const modalBody = document.getElementById("modal-body");

  modalBody.innerHTML = `
    <div class="card-badges" style="margin-bottom:8px;">
      <span class="badge badge-cat">${escapeHtml(item.category)}</span>
      <span class="badge badge-metro">🚇 ${escapeHtml(item.metroStation)}</span>
      <span class="badge badge-cat">Source: ${escapeHtml(item.source)}</span>
    </div>
    <h2 id="modal-title" style="margin:0 0 6px;">${escapeHtml(item.name)}</h2>
    <p class="muted-xs" style="margin:0 0 14px;">📍 ${escapeHtml(item.address)}</p>

    <div class="price-strip" style="margin-bottom:12px;">
      <div>
        <div class="price-main">${formatRange(p.effectiveTotalPerPersonMin, p.effectiveTotalPerPersonMax)} / person</div>
        <div class="price-sub">Base Rent ${formatRange(p.monthlyRentPerPersonMin, p.monthlyRentPerPersonMax)} + AC EB ${formatRange(p.estimatedAcEbPerPersonMin, p.estimatedAcEbPerPersonMax)}</div>
      </div>
      <div>
        <div class="price-main">${escapeHtml(p.sharingType || "2-Sharing")}</div>
        <div class="price-sub">Deposit: ${escapeHtml(p.deposit || "Verify")}</div>
      </div>
    </div>
    <p style="font-size:13px; color:#334155; margin:0 0 14px;"><strong>Pricing Note:</strong> ${escapeHtml(p.priceNote)}</p>

    <div class="commute-strip" style="margin-bottom:14px;">
      <div class="commute-pill">
        <strong>You → Jidoka: ${escapeHtml(item.commute?.jidokaMins)}</strong>
        <span>${escapeHtml(item.commute?.jidokaRoute)}</span>
      </div>
      <div class="commute-pill">
        <strong>Friend → IITM: ${escapeHtml(item.commute?.iitmMins)}</strong>
        <span>${escapeHtml(item.commute?.iitmRoute)}</span>
      </div>
    </div>

    <div class="feature-split" style="margin-bottom:14px;">
      <div class="feature-col good">
        <h4>✅ Included Features</h4>
        <ul class="feature-list">
          ${(item.features?.included || []).map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
        </ul>
      </div>
      <div class="feature-col bad">
        <h4>❌ Missing / Questions to Ask</h4>
        <ul class="feature-list">
          ${(item.features?.missingOrCaveat || []).map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
        </ul>
      </div>
    </div>

    <div class="reddit-box" style="margin-bottom:14px;">
      <strong>💬 Reddit Community Sentiment:</strong> ${escapeHtml(item.redditSummary)}
    </div>

    <div style="margin-bottom:14px;">
      <label for="modal-notes" style="font-size:12.5px; font-weight:700;">Your Visit / Call Notes (saved locally):</label>
      <textarea id="modal-notes" class="notes-area" placeholder="e.g., Called owner: ₹11k flat incl. AC, EB direct meter, visiting Saturday...">${escapeHtml(note)}</textarea>
      <button class="btn" id="save-note-btn" data-id="${escapeHtml(item.id)}" style="margin-top:6px;">Save Note</button>
    </div>

    <div class="card-actions">
      <a class="btn btn-primary" href="${escapeHtml(item.links?.listingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.links?.listingLabel || "Open Listing")} ↗</a>
      <a class="btn" href="${escapeHtml(item.links?.mapsUrl)}" target="_blank" rel="noopener noreferrer">Google Maps 📍</a>
    </div>
  `;

  document.getElementById("detail-modal").classList.remove("hidden");
}

function renderAll() {
  renderHeaderAndKpis();
  populateLocalities();
  renderListings();
  renderMetroSection();
  renderRedditSection();
  renderSearchLog();
}

async function fetchState(isPoll = false) {
  if (IS_EMBEDDED) {
    const data = window.__EMBEDDED_STAYMID_DATA__ || {};
    state.meta = data.meta || {};
    state.listings = data.listings || [];
    state.reddit = data.reddit || [];
    const local = loadLocalUserState();
    state.userState = local || data.userState || { shortlisted: [], hidden: [], notes: {} };
    state.lastKnownRound = state.meta?.roundsCompleted ?? 1;
    state.lastKnownCount = state.listings.length;
    renderAll();
    return;
  }
  try {
    let data;
    if (IS_LOCAL_SERVER) {
      const res = await fetch(`/api/state?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      data = await res.json();
    } else {
      const ts = Date.now();
      const [metaRes, listRes, redRes] = await Promise.all([
        fetch(`./data/meta.json?t=${ts}`, { cache: "no-store" }),
        fetch(`./data/listings.json?t=${ts}`, { cache: "no-store" }),
        fetch(`./data/reddit.json?t=${ts}`, { cache: "no-store" }),
      ]);
      if (!metaRes.ok || !listRes.ok || !redRes.ok) return;
      data = {
        meta: await metaRes.json(),
        listings: await listRes.json(),
        reddit: await redRes.json(),
        userState: null,
      };
    }

    const nextRound = data.meta?.roundsCompleted ?? 1;
    const nextCount = (data.listings || []).length;

    if (
      isPoll &&
      state.lastKnownRound !== null &&
      (nextRound > state.lastKnownRound || nextCount > state.lastKnownCount)
    ) {
      const diff = Math.max(0, nextCount - state.lastKnownCount);
      showToast(`Live Update: Round #${nextRound} finished (${diff > 0 ? `+${diff} new places` : "listings refreshed"})!`);
    }

    state.meta = data.meta || {};
    state.listings = data.listings || [];
    state.reddit = data.reddit || [];

    const local = loadLocalUserState();
    if (!isPoll) {
      state.userState = local || data.userState || { shortlisted: [], hidden: [], notes: {} };
    }

    state.lastKnownRound = nextRound;
    state.lastKnownCount = nextCount;
    renderAll();
  } catch (err) {
    console.error("Failed to fetch state", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Navigation tabs
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const target = btn.dataset.section;
      document.querySelectorAll(".section").forEach((sec) => sec.classList.remove("active"));
      document.getElementById(`section-${target}`).classList.add("active");
    });
  });

  // Filter chips
  document.getElementById("filter-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll("#filter-chips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.activeChip = chip.dataset.filter;
    renderListings();
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderListings();
  });

  document.getElementById("locality-select").addEventListener("change", (e) => {
    state.locality = e.target.value;
    renderListings();
  });

  document.getElementById("sort-select").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderListings();
  });

  document.getElementById("show-hidden-toggle").addEventListener("change", (e) => {
    state.showHidden = e.target.checked;
    renderListings();
  });

  // Card action delegation
  document.getElementById("listings-grid").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    if (btn.classList.contains("js-details")) {
      openDetailsModal(id);
    } else if (btn.classList.contains("js-star")) {
      const list = new Set(state.userState.shortlisted || []);
      if (list.has(id)) list.delete(id);
      else list.add(id);
      state.userState.shortlisted = Array.from(list);
      await saveUserState();
      renderHeaderAndKpis();
      renderListings();
    } else if (btn.classList.contains("js-hide")) {
      const list = new Set(state.userState.hidden || []);
      if (list.has(id)) list.delete(id);
      else list.add(id);
      state.userState.hidden = Array.from(list);
      await saveUserState();
      renderHeaderAndKpis();
      renderListings();
    }
  });

  // Reddit topic filter
  document.getElementById("reddit-topic-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.activeRedditTopic = chip.dataset.topic;
    renderRedditSection();
  });

  // Modal controls
  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("detail-modal").classList.add("hidden");
  });
  document.getElementById("detail-modal").addEventListener("click", async (e) => {
    if (e.target.id === "detail-modal") {
      document.getElementById("detail-modal").classList.add("hidden");
      return;
    }
    if (e.target.id === "save-note-btn") {
      const id = e.target.dataset.id;
      const val = document.getElementById("modal-notes").value;
      state.userState.notes = state.userState.notes || {};
      state.userState.notes[id] = val;
      await saveUserState();
      showToast("Saved visit note locally!");
    }
  });

  fetchState(false);
  if (!IS_EMBEDDED) {
    setInterval(() => fetchState(true), IS_LOCAL_SERVER ? 5000 : 30000);
  }
});
