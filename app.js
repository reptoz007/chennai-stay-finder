const state = {
  meta: {},
  listings: [],
  reddit: [],
  userState: { shortlisted: [], hidden: [], notes: {} },
  activeSection: "listings",
  activeChip: "all",
  viewMode: "cards",
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

function shortRange(min, max) {
  const fmt = (v) =>
    typeof v !== "number" || Number.isNaN(v)
      ? "?"
      : v >= 1000
      ? `₹${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`
      : `₹${v}`;
  if (min === max) return fmt(min);
  return `${fmt(min)}–${fmt(max)}`;
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

function shortMins(txt) {
  const clean = String(txt || "").replace(/^~/, "");
  return clean.replace(/\s*\(.*?\)/g, "").trim() || "Verify";
}

function shortCategory(cat) {
  const c = String(cat || "").toLowerCase();
  if (c.includes("co-living")) return "Co-living";
  if (c.includes("1rk") || c.includes("1bhk")) return "1RK / 1BHK";
  if (c.includes("pg")) return "Men's PG";
  return cat || "Stay";
}

function amenityStatuses(item) {
  const acRaw = String(item.features?.ac || "").toLowerCase();
  const bedsRaw = String(item.features?.beds || "").toLowerCase();
  const ka = item.features?.kitchenAccess || "";
  const kitRaw = String(item.features?.kitchen || "").toLowerCase();

  let acStatus = { cls: "status-warn", label: "AC Optional" };
  if (acRaw.startsWith("yes")) acStatus = { cls: "status-yes", label: "AC Ready" };
  else if (acRaw.includes("rent")) acStatus = { cls: "status-warn", label: "+ Rent AC" };
  else if (acRaw.startsWith("no")) acStatus = { cls: "status-no", label: "No AC" };

  let bedsStatus = { cls: "status-no", label: "No Beds" };
  if (bedsRaw.startsWith("yes")) bedsStatus = { cls: "status-yes", label: "Beds Incl." };
  else if (bedsRaw.includes("verify") || bedsRaw.includes("semi"))
    bedsStatus = { cls: "status-warn", label: "Semi-Furn." };

  let kitStatus = { cls: "status-no", label: "No Kitchen" };
  if (ka === "full" || kitRaw.includes("full private") || kitRaw.includes("private kitchen"))
    kitStatus = { cls: "status-yes", label: "Private Kitchen" };
  else if (ka === "shared" || kitRaw.includes("shared") || kitRaw.includes("common kitchen"))
    kitStatus = { cls: "status-yes", label: "Shared Kitchen" };
  else if (ka === "verify" || kitRaw.includes("verify") || kitRaw.includes("microwave"))
    kitStatus = { cls: "status-warn", label: "Verify Cook" };

  return { acStatus, bedsStatus, kitStatus };
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
    statusText.textContent = `Snapshot · R${round}`;
    if (shareBtn) shareBtn.classList.add("hidden");
  } else {
    const isPaused = String(state.meta.searchStatus || "").toUpperCase() === "STOPPED";
    pill.classList.toggle("paused", isPaused);
    if (!IS_LOCAL_SERVER) {
      statusText.textContent = isPaused ? `Archive · R${round}` : `Live · R${round}`;
      if (shareBtn) {
        shareBtn.setAttribute("href", "./share.html");
        shareBtn.setAttribute("download", `staymid-chennai-round-${round}.html`);
      }
    } else {
      statusText.textContent = isPaused ? `Stopped · R${round}` : `Live · R${round}`;
    }
  }

  document.getElementById("next-focus-line").textContent = state.meta.nextFocus
    ? state.meta.nextFocus
    : "";
}

function populateLocalities() {
  const select = document.getElementById("locality-select");
  const prev = select.value;
  const localities = Array.from(new Set(state.listings.map((x) => x.locality).filter(Boolean))).sort();
  select.innerHTML =
    `<option value="all">All Areas (${state.listings.length})</option>` +
    localities.map((loc) => `<option value="${escapeHtml(loc)}">${escapeHtml(loc)}</option>`).join("");
  if (localities.includes(prev)) select.value = prev;
}

function fitBadgeMeta(fit) {
  if (fit === "in-budget") return { cls: "badge-fit-in-budget", label: "Fits ≤ ₹8k" };
  if (fit === "borderline") return { cls: "badge-fit-borderline", label: "₹8k–₹11k" };
  return { cls: "badge-fit-stretch", label: "> ₹8k Cap" };
}

function renderListingsTable(items, shortlistedSet, hiddenSet) {
  return `
    <div class="compare-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Stay &amp; Locality</th>
            <th>Metro</th>
            <th>Est. Total / Person</th>
            <th>Base Rent</th>
            <th>Amenities (AC · Beds · Kitchen)</th>
            <th>Commute (Jidoka / IITM)</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map((item) => {
              const p = item.pricing || {};
              const fit = fitBadgeMeta(p.budgetFit);
              const { acStatus, bedsStatus, kitStatus } = amenityStatuses(item);
              const isStar = shortlistedSet.has(item.id);
              const isHidden = hiddenSet.has(item.id);
              return `
                <tr class="${isHidden ? "is-hidden-card" : ""}">
                  <td>
                    <div style="font-weight:700; color:var(--text);">${escapeHtml(item.name)}</div>
                    <div class="muted-xs">${escapeHtml(item.locality)} · ${escapeHtml(shortCategory(item.category))}</div>
                  </td>
                  <td><span class="badge badge-metro">${escapeHtml(item.metroStation)}</span></td>
                  <td>
                    <span class="badge ${fit.cls}">${formatRange(p.effectiveTotalPerPersonMin, p.effectiveTotalPerPersonMax)}</span>
                  </td>
                  <td style="white-space:nowrap;">${shortRange(p.monthlyRentPerPersonMin, p.monthlyRentPerPersonMax)}</td>
                  <td>
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                      <span class="status-chip ${acStatus.cls}">${acStatus.label}</span>
                      <span class="status-chip ${bedsStatus.cls}">${bedsStatus.label}</span>
                      <span class="status-chip ${kitStatus.cls}">${kitStatus.label}</span>
                    </div>
                  </td>
                  <td style="white-space:nowrap; font-size:12px;">
                    J: <strong>${escapeHtml(shortMins(item.commute?.jidokaMins))}</strong> · I: <strong>${escapeHtml(shortMins(item.commute?.iitmMins))}</strong>
                  </td>
                  <td>
                    <div style="display:flex; gap:5px; align-items:center;">
                      <a class="btn btn-primary" href="${escapeHtml(item.links?.listingUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
                      <button class="btn js-details" data-id="${escapeHtml(item.id)}">Details</button>
                      <button class="btn-icon-star ${isStar ? "active" : ""} js-star" data-id="${escapeHtml(item.id)}" title="Save">${isStar ? "★" : "☆"}</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderListings() {
  const grid = document.getElementById("listings-grid");
  const items = getFilteredListings();
  const shortlistedSet = new Set(state.userState.shortlisted || []);
  const hiddenSet = new Set(state.userState.hidden || []);
  const latestRound = state.meta.roundsCompleted ?? 1;

  document.getElementById("results-summary").textContent =
    `Showing ${items.length} of ${state.listings.length} verified stays`;

  if (!items.length) {
    grid.innerHTML = `<div class="panel-card" style="grid-column:1/-1;"><h3>No stays match your filters</h3><p class="muted-xs">Clear the search query or switch back to "All".</p></div>`;
    return;
  }

  if (state.viewMode === "table") {
    grid.innerHTML = renderListingsTable(items, shortlistedSet, hiddenSet);
    return;
  }

  grid.innerHTML = items
    .map((item) => {
      const p = item.pricing || {};
      const fit = fitBadgeMeta(p.budgetFit);
      const { acStatus, bedsStatus, kitStatus } = amenityStatuses(item);
      const isStar = shortlistedSet.has(item.id);
      const isHidden = hiddenSet.has(item.id);
      const isNew = latestRound > 1 && item.addedRound === latestRound;
      const included = (item.features?.included || []).slice(0, 2);
      const missing = (item.features?.missingOrCaveat || []).slice(0, 2);

      return `
        <article class="stay-card ${isStar ? "shortlisted" : ""} ${isHidden ? "is-hidden-card" : ""}" data-id="${escapeHtml(item.id)}">
          <div class="card-top-bar">
            <div class="card-badges">
              <span class="badge ${fit.cls}">${fit.label}</span>
              <span class="badge badge-cat">${escapeHtml(shortCategory(item.category))}</span>
              ${isNew ? `<span class="badge badge-new">R${item.addedRound} New</span>` : ""}
            </div>
            <button type="button" class="btn-icon-star ${isStar ? "active" : ""} js-star" data-id="${escapeHtml(item.id)}" aria-label="${isStar ? "Remove bookmark" : "Save stay"}" title="${isStar ? "Saved" : "Save stay"}">${isStar ? "★" : "☆"}</button>
          </div>

          <div class="card-head">
            <h3>${escapeHtml(item.name)}</h3>
            <div class="card-loc" title="${escapeHtml(item.address)}">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span>${escapeHtml(item.metroStation)}${item.metroWalk ? ` · ${escapeHtml(item.metroWalk)}` : ""}</span>
            </div>
          </div>

          <div class="metrics-band">
            <div class="price-col">
              <div class="price-figure">${formatRange(p.effectiveTotalPerPersonMin, p.effectiveTotalPerPersonMax)} <span class="price-unit">/mo est.</span></div>
              <div class="price-meta">Base ${shortRange(p.monthlyRentPerPersonMin, p.monthlyRentPerPersonMax)} · Dep ${escapeHtml(p.deposit || "Verify")}</div>
            </div>
            <div class="commute-col">
              <div class="commute-row"><span>Jidoka</span><strong>${escapeHtml(shortMins(item.commute?.jidokaMins))}</strong></div>
              <div class="commute-row"><span>IITM</span><strong>${escapeHtml(shortMins(item.commute?.iitmMins))}</strong></div>
            </div>
          </div>

          <div class="status-matrix">
            <div class="status-chip ${acStatus.cls}" title="${escapeHtml(item.features?.ac)}">${acStatus.label}</div>
            <div class="status-chip ${bedsStatus.cls}" title="${escapeHtml(item.features?.beds)}">${bedsStatus.label}</div>
            <div class="status-chip ${kitStatus.cls}" title="${escapeHtml(item.features?.kitchen)}">${kitStatus.label}</div>
          </div>

          <div class="submeta-line" title="${escapeHtml(item.eligibility)}">${escapeHtml(item.eligibility)} · ${escapeHtml(p.sharingType || "2-Sharing")}</div>

          <div class="highlights-grid">
            <ul class="hl-list hl-good">
              ${included.map((f) => `<li title="${escapeHtml(f.label + ": " + f.detail)}"><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
            </ul>
            <ul class="hl-list hl-bad">
              ${missing.map((f) => `<li title="${escapeHtml(f.label + ": " + f.detail)}"><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
            </ul>
          </div>

          <div class="reddit-line" title="${escapeHtml(item.redditSummary)}">${escapeHtml(item.redditSummary)}</div>

          <div class="card-actions">
            <a class="btn btn-primary" href="${escapeHtml(item.links?.listingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.links?.listingLabel || "Open Listing")} ↗</a>
            <a class="btn" href="${escapeHtml(item.links?.mapsUrl)}" target="_blank" rel="noopener noreferrer" title="Open location in Google Maps">Maps</a>
            <button type="button" class="btn js-details" data-id="${escapeHtml(item.id)}">Details</button>
            <button type="button" class="btn js-hide" data-id="${escapeHtml(item.id)}" title="Hide from list">${isHidden ? "Unhide" : "Hide"}</button>
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
        <a class="btn" href="${escapeHtml(wp.mapsUrl)}" target="_blank" rel="noopener noreferrer">Open on Maps ↗</a>
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
        <div class="reddit-tip"><strong>Actionable Tip:</strong> ${escapeHtml(r.actionableTip)}</div>
        <div>
          <a class="btn" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Open Thread ↗</a>
        </div>
      </article>
    `
    )
    .join("");
}

function renderSearchLog() {
  document.getElementById("next-focus-card").innerHTML = `
    <strong>Status:</strong> ${escapeHtml(state.meta.statusLabel || "Active")}<br />
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
        <div class="muted-xs" style="margin-bottom:4px;"><strong>Searched:</strong> ${escapeHtml(entry.queryFocus)}</div>
        <div style="font-size:12.5px;">${escapeHtml(entry.notes)}</div>
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
      <span class="badge ${fitBadgeMeta(p.budgetFit).cls}">${fitBadgeMeta(p.budgetFit).label}</span>
      <span class="badge badge-cat">${escapeHtml(item.category)}</span>
      <span class="badge badge-metro">${escapeHtml(item.metroStation)}</span>
      <span class="badge badge-cat">Source: ${escapeHtml(item.source)}</span>
    </div>
    <h2 id="modal-title" style="margin:0 0 4px; font-size:19px;">${escapeHtml(item.name)}</h2>
    <p class="muted-xs" style="margin:0 0 12px;">${escapeHtml(item.address)} ${item.metroWalk ? `· ${escapeHtml(item.metroWalk)}` : ""}</p>

    <div class="metrics-band" style="margin-bottom:12px;">
      <div class="price-col">
        <div class="price-figure">${formatRange(p.effectiveTotalPerPersonMin, p.effectiveTotalPerPersonMax)} <span class="price-unit">/person est.</span></div>
        <div class="price-meta">Base ${formatRange(p.monthlyRentPerPersonMin, p.monthlyRentPerPersonMax)} + EB ${formatRange(p.estimatedAcEbPerPersonMin, p.estimatedAcEbPerPersonMax)} · Deposit: ${escapeHtml(p.deposit || "Verify")}</div>
      </div>
      <div class="commute-col">
        <div class="commute-row"><span>Jidoka:</span><strong>${escapeHtml(item.commute?.jidokaMins)}</strong></div>
        <div class="commute-row"><span>IITM:</span><strong>${escapeHtml(item.commute?.iitmMins)}</strong></div>
      </div>
    </div>

    <div class="modal-box" style="margin-bottom:12px;">
      <h4>Full Room &amp; Pricing Specs</h4>
      <div style="font-size:12.5px; color:var(--text-secondary); display:grid; gap:4px;">
        <div><strong>AC:</strong> ${escapeHtml(item.features?.ac)}</div>
        <div><strong>Beds:</strong> ${escapeHtml(item.features?.beds)}</div>
        <div><strong>Kitchen:</strong> ${escapeHtml(item.features?.kitchen)}</div>
        <div><strong>Eligibility:</strong> ${escapeHtml(item.eligibility)} (${escapeHtml(p.sharingType || "2-Sharing")})</div>
        <div><strong>Pricing Note:</strong> ${escapeHtml(p.priceNote)}</div>
        <div><strong>Commute Routes:</strong> Jidoka (${escapeHtml(item.commute?.jidokaRoute)}) · IITM (${escapeHtml(item.commute?.iitmRoute)})</div>
      </div>
    </div>

    <div class="modal-grid-2">
      <div class="modal-box">
        <h4 style="color:var(--teal-dark);">Included Features</h4>
        <ul class="modal-list hl-good">
          ${(item.features?.included || []).map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
        </ul>
      </div>
      <div class="modal-box">
        <h4 style="color:var(--amber);">Missing / Verify Before Visiting</h4>
        <ul class="modal-list hl-bad">
          ${(item.features?.missingOrCaveat || []).map((f) => `<li><strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.detail)}</li>`).join("")}
        </ul>
      </div>
    </div>

    <div class="reddit-line" style="margin-bottom:12px; -webkit-line-clamp:unset;">
      <strong>Reddit / Community Note:</strong> ${escapeHtml(item.redditSummary)}
    </div>

    <div style="margin-bottom:14px;">
      <label for="modal-notes" style="font-size:12px; font-weight:700;">Visit / Call Notes (saved locally in browser):</label>
      <textarea id="modal-notes" class="notes-area" placeholder="e.g., Called owner: ₹11k flat incl. AC, EB direct meter, visiting Saturday...">${escapeHtml(note)}</textarea>
      <button type="button" class="btn" id="save-note-btn" data-id="${escapeHtml(item.id)}" style="margin-top:6px;">Save Note</button>
    </div>

    <div class="card-actions" style="border-top:0; padding-top:0;">
      <a class="btn btn-primary" href="${escapeHtml(item.links?.listingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.links?.listingLabel || "Open Listing")} ↗</a>
      <a class="btn" href="${escapeHtml(item.links?.mapsUrl)}" target="_blank" rel="noopener noreferrer">Open Google Maps ↗</a>
    </div>
  `;

  document.getElementById("detail-modal").classList.remove("hidden");
}

function setActiveChip(filterVal) {
  state.activeChip = filterVal;
  document.querySelectorAll("#filter-chips .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.filter === filterVal);
  });
  // Switch back to listings tab if triggered from KPI pill
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b.dataset.section === "listings"));
  document.querySelectorAll(".section").forEach((s) => s.classList.toggle("active", s.id === "section-listings"));
  renderListings();
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

  // Reality guide toggle
  const guideBtn = document.getElementById("guide-toggle-btn");
  const guideDrawer = document.getElementById("reality-drawer");
  if (guideBtn && guideDrawer) {
    guideBtn.addEventListener("click", () => {
      const willOpen = guideDrawer.classList.contains("hidden");
      guideDrawer.classList.toggle("hidden", !willOpen);
      guideBtn.setAttribute("aria-expanded", String(willOpen));
    });
  }

  // Clickable KPI filters
  document.querySelectorAll(".js-kpi-filter").forEach((btn) => {
    btn.addEventListener("click", () => setActiveChip(btn.dataset.filter));
  });

  // Layout switcher (Cards vs Table)
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.viewMode = btn.dataset.view;
      renderListings();
    });
  });

  // Filter chips
  document.getElementById("filter-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    setActiveChip(chip.dataset.filter);
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
