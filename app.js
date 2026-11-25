const state = {
  meta: {},
  listings: [],
  reddit: [],
  userState: { shortlisted: [], hidden: [], notes: {} },
  profile: null,
  pendingProfile: null,
  chatOpen: false,
  chatMentionId: null,
  collabSynced: true,
  lastSeenMsgTs: 0,
  collab: {
    version: 1,
    room: "staymid_chennai_9f4c2e1b8a3d7c50",
    saved: { harsha: [], rajat: [] },
    messages: [],
    notes: { harsha: {}, rajat: {} },
  },
  activeSection: "listings",
  activeChip: "all",
  viewMode: "cards",
  activeRedditTopic: "All",
  searchQuery: "",
  locality: "all",
  sortBy: "best-match",
  showHidden: false,
  cardImageIdx: {},
  modalItemId: null,
  modalImageIdx: 0,
  lastKnownRound: null,
  lastKnownCount: null,
};

const STORAGE_KEY = "staymid_chennai_user_state_v1";
const PROFILE_KEY = "staymid_profile_v1";
const AUTH_KEY = "staymid_pass_ok_v1";
const COLLAB_STORAGE_KEY = "staymid_collab_cache_v1";
const CHAT_SEEN_KEY = "staymid_chat_seen_ts_v1";
const DEFAULT_COLLAB_ROOM = "staymid_chennai_9f4c2e1b8a3d7c50";

function verifyPasscode(raw) {
  const s = String(raw ?? "").trim();
  if (s.length !== 6) return false;
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) ^ c) >>> 0;
  }
  return h1 === 1857711445 && h2 === 3782405765;
}
const IS_EMBEDDED = Boolean(window.__EMBEDDED_STAYMID_DATA__);
const IS_LOCAL_SERVER =
  location.hostname === "127.0.0.1" || location.hostname === "localhost";

function getCollabRoomId() {
  try {
    const sp = new URLSearchParams(location.search);
    const hashMatch = location.hash.match(/room=([A-Za-z0-9_-]+)/);
    return (
      sp.get("room") ||
      (hashMatch && hashMatch[1]) ||
      state.meta?.collabRoomId ||
      DEFAULT_COLLAB_ROOM
    );
  } catch {
    return state.meta?.collabRoomId || DEFAULT_COLLAB_ROOM;
  }
}

function getRemoteCollabUrl() {
  const room = getCollabRoomId();
  if (state.meta?.collabEndpoint && room === state.meta?.collabRoomId) {
    return state.meta.collabEndpoint;
  }
  return `https://textdb.dev/api/data/${room}`;
}

function normalizeCollab(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const saved = obj.saved && typeof obj.saved === "object" ? obj.saved : {};
  const savedAt = obj.savedAt && typeof obj.savedAt === "object" ? obj.savedAt : {};
  const notes = obj.notes && typeof obj.notes === "object" ? obj.notes : {};
  const notesAt = obj.notesAt && typeof obj.notesAt === "object" ? obj.notesAt : {};
  return {
    version: 1,
    room: obj.room || getCollabRoomId(),
    saved: {
      harsha: Array.isArray(saved.harsha) ? Array.from(new Set(saved.harsha)) : [],
      rajat: Array.isArray(saved.rajat) ? Array.from(new Set(saved.rajat)) : [],
    },
    savedAt: {
      harsha: Number(savedAt.harsha) || 0,
      rajat: Number(savedAt.rajat) || 0,
    },
    messages: Array.isArray(obj.messages)
      ? obj.messages
          .filter((m) => m && typeof m === "object" && m.id && m.sender)
          .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      : [],
    notes: {
      harsha: notes.harsha && typeof notes.harsha === "object" ? { ...notes.harsha } : {},
      rajat: notes.rajat && typeof notes.rajat === "object" ? { ...notes.rajat } : {},
    },
    notesAt: {
      harsha: Number(notesAt.harsha) || 0,
      rajat: Number(notesAt.rajat) || 0,
    },
  };
}

let collabWriteChain = Promise.resolve();
let collabPendingWrites = 0;

function mergeCollab(localRaw, remoteRaw) {
  const local = normalizeCollab(localRaw);
  const remote = normalizeCollab(remoteRaw);
  const out = normalizeCollab({ room: remote.room || local.room });

  ["harsha", "rajat"].forEach((u) => {
    const lTs = local.savedAt[u] || 0;
    const rTs = remote.savedAt[u] || 0;
    if (lTs > rTs) {
      out.saved[u] = [...local.saved[u]];
      out.savedAt[u] = lTs;
    } else if (rTs > lTs) {
      out.saved[u] = [...remote.saved[u]];
      out.savedAt[u] = rTs;
    } else {
      out.saved[u] = Array.from(new Set([...local.saved[u], ...remote.saved[u]]));
      out.savedAt[u] = Math.max(lTs, rTs);
    }

    const lnTs = local.notesAt[u] || 0;
    const rnTs = remote.notesAt[u] || 0;
    if (lnTs >= rnTs && lnTs > 0) {
      out.notes[u] = { ...remote.notes[u], ...local.notes[u] };
      out.notesAt[u] = lnTs;
    } else {
      out.notes[u] = { ...local.notes[u], ...remote.notes[u] };
      out.notesAt[u] = Math.max(lnTs, rnTs);
    }
  });

  const msgMap = new Map();
  [...remote.messages, ...local.messages].forEach((m) => {
    if (m && m.id) msgMap.set(m.id, m);
  });
  out.messages = Array.from(msgMap.values())
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

const IDB_NAME = "StayMidPermanentDB";
const IDB_STORE = "collab_backup";

function openCollabIdb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbLoadCollab(roomId) {
  const db = await openCollabIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(roomId || getCollabRoomId());
      req.onsuccess = () => resolve(req.result ? normalizeCollab(req.result) : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSaveCollab(collabObj) {
  const db = await openCollabIdb();
  if (!db) return;
  try {
    const clean = normalizeCollab(collabObj);
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(clean, clean.room || getCollabRoomId());
  } catch {}
}

function loadLocalCollab() {
  try {
    const raw = localStorage.getItem(COLLAB_STORAGE_KEY);
    return raw ? normalizeCollab(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function persistCollabLocal() {
  try {
    localStorage.setItem(COLLAB_STORAGE_KEY, JSON.stringify(state.collab));
  } catch {}
  idbSaveCollab(state.collab);
}

function profileDisplayName(p) {
  return p === "rajat" ? "Rajat" : p === "harsha" ? "Harsha" : "Guest";
}

function getSaveInfo(id) {
  const h = (state.collab.saved?.harsha || []).includes(id);
  const r = (state.collab.saved?.rajat || []).includes(id);
  return {
    harsha: h,
    rajat: r,
    both: h && r,
    any: h || r,
    mine: state.profile ? (state.collab.saved?.[state.profile] || []).includes(id) : false,
  };
}

function saveBadgeHtml(id) {
  const s = getSaveInfo(id);
  if (s.both) return `<span class="badge badge-save-both" title="Saved by both Harsha & Rajat">★ Both Saved</span>`;
  if (s.harsha) return `<span class="badge badge-save-harsha" title="Saved by Harsha">★ Harsha</span>`;
  if (s.rajat) return `<span class="badge badge-save-rajat" title="Saved by Rajat">★ Rajat</span>`;
  return "";
}

async function fetchRemoteCollabRaw() {
  const url = `${getRemoteCollabUrl()}?t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Remote HTTP ${res.status}`);
  const txt = await res.text();
  if (!txt || txt.trim() === "" || txt.trim() === "{}") return null;
  const parsed = JSON.parse(txt);
  if (!parsed || typeof parsed !== "object" || !parsed.saved) return null;
  return normalizeCollab(parsed);
}

async function writeRemoteCollab(payload) {
  const clean = normalizeCollab(payload);
  const res = await fetch(getRemoteCollabUrl(), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(clean),
  });
  if (!res.ok) throw new Error(`Remote save HTTP ${res.status}`);
  if (IS_LOCAL_SERVER) {
    try {
      await fetch("/api/collab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clean),
      });
    } catch {}
  }
}

async function fetchCollabSync() {
  const idbCached = await idbLoadCollab(getCollabRoomId());
  if (idbCached) {
    state.collab = mergeCollab(state.collab, idbCached);
  }
  if (IS_EMBEDDED) {
    const cached = loadLocalCollab();
    if (cached) state.collab = mergeCollab(state.collab, cached);
    persistCollabLocal();
    state.collabSynced = false;
    return;
  }
  if (collabPendingWrites > 0) return;
  try {
    const remote = await fetchRemoteCollabRaw();
    if (collabPendingWrites > 0) return;
    if (remote) {
      const merged = mergeCollab(state.collab, remote);
      const remoteNeedsHeal =
        merged.messages.length > (remote.messages || []).length ||
        (merged.savedAt?.harsha || 0) > (remote.savedAt?.harsha || 0) ||
        (merged.savedAt?.rajat || 0) > (remote.savedAt?.rajat || 0);
      state.collab = merged;
      persistCollabLocal();
      state.collabSynced = true;
      if (remoteNeedsHeal) {
        await writeRemoteCollab(state.collab);
      } else if (IS_LOCAL_SERVER) {
        fetch("/api/collab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.collab),
        }).catch(() => {});
      }
      return;
    } else if ((state.collab.messages || []).length > 0 || (state.collab.saved?.harsha || []).length > 0 || (state.collab.saved?.rajat || []).length > 0) {
      // Auto-heal remote store if external host returned empty while local permanent archive has history
      await writeRemoteCollab(state.collab);
      state.collabSynced = true;
      return;
    }
  } catch {
    state.collabSynced = false;
  }
  if (IS_LOCAL_SERVER && collabPendingWrites === 0) {
    try {
      const lr = await fetch(`/api/collab?t=${Date.now()}`, { cache: "no-store" });
      if (lr.ok) {
        state.collab = mergeCollab(state.collab, await lr.json());
        persistCollabLocal();
      }
    } catch {}
  }
}

async function updateCollab(mutator) {
  if (!state.profile) {
    openLoginOverlay(true);
    return;
  }
  collabPendingWrites += 1;
  mutator(state.collab);
  state.collab = normalizeCollab(state.collab);
  persistCollabLocal();
  renderAll();

  collabWriteChain = collabWriteChain.then(async () => {
    try {
      let base = state.collab;
      try {
        const remote = await fetchRemoteCollabRaw();
        if (remote) base = mergeCollab(state.collab, remote);
      } catch {}
      mutator(base);
      state.collab = normalizeCollab(base);
      persistCollabLocal();
      await writeRemoteCollab(state.collab);
      state.collabSynced = true;
    } catch {
      state.collabSynced = false;
    } finally {
      collabPendingWrites = Math.max(0, collabPendingWrites - 1);
      renderAll();
    }
  });
  return collabWriteChain;
}

async function toggleSaveStay(id) {
  if (!state.profile) {
    openLoginOverlay(true);
    return;
  }
  const actor = state.profile;
  const currentlySaved = (state.collab.saved?.[actor] || []).includes(id);
  const targetSaved = !currentlySaved;
  const opTs = Date.now();
  await updateCollab((c) => {
    const set = new Set(c.saved[actor] || []);
    if (targetSaved) set.add(id);
    else set.delete(id);
    c.saved[actor] = Array.from(set);
    c.savedAt = c.savedAt || { harsha: 0, rajat: 0 };
    c.savedAt[actor] = opTs;
  });
  showToast(
    targetSaved
      ? `Saved by ${profileDisplayName(actor)} (shared live!)`
      : `Removed from ${profileDisplayName(actor)}'s saves`
  );
}

function getSharedUrl() {
  const room = getCollabRoomId();
  const base = location.href.split("#")[0].split("?")[0];
  return room && room !== DEFAULT_COLLAB_ROOM ? `${base}?room=${encodeURIComponent(room)}` : base;
}

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
      return getSaveInfo(item.id).any;
    case "saved-harsha":
      return getSaveInfo(item.id).harsha;
    case "saved-rajat":
      return getSaveInfo(item.id).rajat;
    case "saved-both":
      return getSaveInfo(item.id).both;
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

function ensureSaveFilterChips(hCount, rCount, bothCount, unionCount) {
  const row = document.getElementById("filter-chips");
  if (!row) return;
  const legacy = row.querySelector('[data-filter="shortlisted"]');
  if (legacy && !row.querySelector('[data-filter="saved-harsha"]')) {
    legacy.insertAdjacentHTML(
      "afterend",
      `
      <button class="chip" data-filter="saved-harsha">Harsha Saved (0)</button>
      <button class="chip" data-filter="saved-rajat">Rajat Saved (0)</button>
      <button class="chip" data-filter="saved-both">Both Saved ★ (0)</button>
    `
    );
  }
  const map = {
    shortlisted: `Any Saved ★ (${unionCount})`,
    "saved-harsha": `Harsha Saved (${hCount})`,
    "saved-rajat": `Rajat Saved (${rCount})`,
    "saved-both": `Both Saved ★ (${bothCount})`,
  };
  Object.entries(map).forEach(([f, txt]) => {
    const el = row.querySelector(`[data-filter="${f}"]`);
    if (el) {
      el.textContent = txt;
      el.classList.toggle("active", state.activeChip === f);
    }
  });
}

function renderHeaderAndKpis() {
  const total = state.listings.length;
  const inBudget = state.listings.filter((x) => x.pricing?.budgetFit === "in-budget").length;
  const hasKitchen = state.listings.filter((x) => matchesChip(x, "kitchen")).length;
  const validIds = new Set(state.listings.map((x) => x.id));
  const hSaved = (state.collab.saved?.harsha || []).filter((id) => validIds.has(id));
  const rSaved = (state.collab.saved?.rajat || []).filter((id) => validIds.has(id));
  const hSet = new Set(hSaved);
  const rSet = new Set(rSaved);
  const bothCount = hSaved.filter((id) => rSet.has(id)).length;
  const unionCount = new Set([...hSaved, ...rSaved]).size;

  document.getElementById("kpi-total").textContent = total;
  document.getElementById("kpi-inbudget").textContent = inBudget;
  document.getElementById("kpi-kitchen").textContent = hasKitchen;
  document.getElementById("kpi-shortlisted").textContent = unionCount;
  const kpiShortLbl = document.getElementById("kpi-shortlisted")?.parentElement?.querySelector("span");
  if (kpiShortLbl) kpiShortLbl.textContent = `Saved (H:${hSaved.length} · R:${rSaved.length})`;
  ensureSaveFilterChips(hSaved.length, rSaved.length, bothCount, unionCount);
  document.getElementById("tab-count-listings").textContent = total;
  document.getElementById("tab-count-reddit").textContent = state.reddit.length;
  document.getElementById("hidden-count").textContent = (state.userState.hidden || []).length;

  const hStat = document.getElementById("login-stat-harsha");
  const rStat = document.getElementById("login-stat-rajat");
  if (hStat) hStat.textContent = `${hSaved.length} stay${hSaved.length === 1 ? "" : "s"} saved`;
  if (rStat) rStat.textContent = `${rSaved.length} stay${rSaved.length === 1 ? "" : "s"} saved`;

  const profBtn = document.getElementById("profile-switch-btn");
  if (profBtn) {
    if (state.profile) {
      profBtn.classList.remove("hidden");
      const av = document.getElementById("topbar-avatar");
      const nm = document.getElementById("topbar-profile-name");
      if (av) {
        av.textContent = state.profile === "rajat" ? "R" : "H";
        av.className = `profile-avatar ${state.profile === "rajat" ? "avatar-rajat" : "avatar-harsha"}`;
      }
      if (nm) nm.textContent = profileDisplayName(state.profile);
    } else {
      profBtn.classList.add("hidden");
    }
  }

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

function getImages(item) {
  if (Array.isArray(item.images) && item.images.length) return item.images.filter(Boolean);
  return item.imageUrl ? [item.imageUrl] : [];
}

function handleImgError(imgEl, fallbackText) {
  const wrap = imgEl.parentElement;
  imgEl.remove();
  if (!wrap) return;
  wrap.classList.add("img-fallback");
  if (!wrap.querySelector(".fallback-label")) {
    const span = document.createElement("div");
    span.className = "fallback-label";
    span.textContent = fallbackText || "Stay Photo Unavailable";
    wrap.appendChild(span);
  }
}

window.handleImgError = handleImgError;

function stepCardImage(id, delta) {
  const item = state.listings.find((x) => x.id === id);
  if (!item) return;
  const imgs = getImages(item);
  if (!imgs.length) return;
  const cur = state.cardImageIdx[id] ?? 0;
  const next = delta === 0 ? Math.min(cur, imgs.length - 1) : (cur + delta + imgs.length) % imgs.length;
  state.cardImageIdx[id] = next;

  const media = document.querySelector(`.stay-card[data-id="${CSS.escape(id)}"] .card-media`);
  if (!media) return;
  let img = media.querySelector("img");
  if (!img) {
    media.classList.remove("img-fallback");
    media.querySelector(".fallback-label")?.remove();
    img = document.createElement("img");
    img.alt = item.name;
    img.referrerPolicy = "no-referrer";
    const fb = `${item.locality || item.metroStation} · ${shortCategory(item.category)}`;
    img.onerror = () => handleImgError(img, fb);
    media.prepend(img);
  }
  img.src = imgs[next];
  const counter = media.querySelector(".js-photo-idx");
  if (counter) counter.textContent = `${next + 1} / ${imgs.length}`;
  media.querySelectorAll(".carousel-dot").forEach((d, idx) => {
    d.classList.toggle("active", idx === next);
  });
}

function photoTagHtml(item) {
  const isProp = item.imageType === "property";
  const isFlat = (item.category || "").toLowerCase().includes("1rk") || (item.category || "").toLowerCase().includes("1bhk");
  const ico = `<svg class="ico" style="width:11px;height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
  const label = isProp
    ? `Property Photo · ${item.source || "Listing"}`
    : `${isFlat ? "Flat" : "Room"} Photo (${item.locality || "Chennai"})`;
  return `<span class="photo-tag">${ico}<span>${escapeHtml(label)}</span></span>`;
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
              const isStar = getSaveInfo(item.id).mine;
              const isHidden = hiddenSet.has(item.id);
              const saveBadge = saveBadgeHtml(item.id);
              return `
                <tr class="${isHidden ? "is-hidden-card" : ""}">
                  <td>
                    <div style="display:flex; align-items:center; gap:10px;">
                      ${
                        item.imageUrl
                          ? `<img class="table-thumb" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'" />`
                          : ""
                      }
                      <div>
                        <div style="font-weight:700; color:var(--text);">${escapeHtml(item.name)}</div>
                        <div class="muted-xs">${escapeHtml(item.locality)} · ${escapeHtml(shortCategory(item.category))} ${saveBadge}</div>
                      </div>
                    </div>
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
                      <button type="button" class="btn btn-discuss js-discuss" data-id="${escapeHtml(item.id)}">Discuss</button>
                      <button type="button" class="btn js-details" data-id="${escapeHtml(item.id)}">Details</button>
                      <button type="button" class="btn-icon-star ${isStar ? "active" : ""} js-star" data-id="${escapeHtml(item.id)}" title="Save">${isStar ? "★" : "☆"}</button>
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
      const saveInfo = getSaveInfo(item.id);
      const isStar = saveInfo.mine;
      const saveBadge = saveBadgeHtml(item.id);
      const isHidden = hiddenSet.has(item.id);
      const isNew = latestRound > 1 && item.addedRound === latestRound;
      const included = (item.features?.included || []).slice(0, 2);
      const missing = (item.features?.missingOrCaveat || []).slice(0, 2);
      const imgs = getImages(item);
      const imgIdx = Math.min(state.cardImageIdx[item.id] ?? 0, Math.max(0, imgs.length - 1));
      const activeImg = imgs[imgIdx] || "";
      const fallbackTxt = `${item.locality || item.metroStation} · ${shortCategory(item.category)}`;

      return `
        <article class="stay-card ${saveInfo.any ? "shortlisted" : ""} ${isHidden ? "is-hidden-card" : ""}" data-id="${escapeHtml(item.id)}">
          <div class="card-media ${activeImg ? "" : "img-fallback"} js-card-photo" data-id="${escapeHtml(item.id)}">
            ${
              activeImg
                ? `<img src="${escapeHtml(activeImg)}" alt="${escapeHtml(item.name)}" referrerpolicy="no-referrer" loading="lazy" onerror="handleImgError(this, '${escapeHtml(fallbackTxt).replaceAll("'", "\\'")}')" />`
                : `<div class="fallback-label">${escapeHtml(fallbackTxt)}</div>`
            }
            ${
              imgs.length > 1
                ? `<button type="button" class="carousel-nav carousel-prev js-prev-img" data-id="${escapeHtml(item.id)}" aria-label="Previous image">&#8249;</button>
                   <button type="button" class="carousel-nav carousel-next js-next-img" data-id="${escapeHtml(item.id)}" aria-label="Next image">&#8250;</button>`
                : ""
            }
            <div class="card-media-top">
              <div class="card-badges">
                <span class="badge ${fit.cls}">${fit.label}</span>
                <span class="badge badge-cat">${escapeHtml(shortCategory(item.category))}</span>
                ${saveBadge}
                ${isNew ? `<span class="badge badge-new">R${item.addedRound} New</span>` : ""}
              </div>
              <button type="button" class="btn-icon-star ${isStar ? "active" : ""} js-star" data-id="${escapeHtml(item.id)}" aria-label="${isStar ? "Remove save" : "Save stay"}" title="${state.profile ? (isStar ? `Saved by ${profileDisplayName(state.profile)}` : `Save as ${profileDisplayName(state.profile)}`) : "Choose Harsha / Rajat to save"}">${isStar ? "★" : "☆"}</button>
            </div>
            <div class="card-media-bottom">
              ${photoTagHtml(item)}
              ${
                imgs.length > 1
                  ? `<div style="display:flex; align-items:center; gap:5px;">
                       <div class="carousel-dots">${imgs.map((_, i) => `<span class="carousel-dot ${i === imgIdx ? "active" : ""}"></span>`).join("")}</div>
                       <span class="photo-count-pill js-photo-idx">${imgIdx + 1} / ${imgs.length}</span>
                     </div>`
                  : ""
              }
            </div>
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
            <button type="button" class="btn btn-discuss js-discuss" data-id="${escapeHtml(item.id)}" title="Mention this stay &amp; discuss in chat">Discuss</button>
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

function updateModalPhoto(nextIdx) {
  const item = state.listings.find((x) => x.id === state.modalItemId);
  if (!item) return;
  const imgs = getImages(item);
  if (!imgs.length) return;
  const idx = ((nextIdx % imgs.length) + imgs.length) % imgs.length;
  state.modalImageIdx = idx;
  state.cardImageIdx[item.id] = idx;

  const mainImg = document.getElementById("modal-main-photo");
  if (mainImg) mainImg.src = imgs[idx];
  const pill = document.getElementById("modal-photo-count");
  if (pill) pill.textContent = `${idx + 1} / ${imgs.length}`;
  document.querySelectorAll("#modal-thumbs .modal-thumb-btn").forEach((b, i) => {
    b.classList.toggle("active", i === idx);
  });
  stepCardImage(item.id, 0);
}

function openDetailsModal(id) {
  const item = state.listings.find((x) => x.id === id);
  if (!item) return;
  const p = item.pricing || {};
  const saveInfo = getSaveInfo(id);
  const myNote =
    (state.profile && state.collab.notes?.[state.profile]?.[id]) ||
    (state.userState.notes || {})[id] ||
    "";
  const partner = state.profile === "rajat" ? "harsha" : "rajat";
  const partnerNote = state.collab.notes?.[partner]?.[id] || "";
  const imgs = getImages(item);
  const startIdx = Math.min(state.cardImageIdx[id] ?? 0, Math.max(0, imgs.length - 1));
  state.modalItemId = id;
  state.modalImageIdx = startIdx;
  const modalBody = document.getElementById("modal-body");

  modalBody.innerHTML = `
    ${
      imgs.length
        ? `<div class="modal-hero-img">
            <img id="modal-main-photo" src="${escapeHtml(imgs[startIdx])}" alt="${escapeHtml(item.name)}" referrerpolicy="no-referrer" onerror="handleImgError(this, '${escapeHtml(item.locality || item.metroStation).replaceAll("'", "\\'")}')" />
            ${
              imgs.length > 1
                ? `<button type="button" class="carousel-nav carousel-prev" id="modal-prev-btn" aria-label="Previous image">&#8249; Prev</button>
                   <button type="button" class="carousel-nav carousel-next" id="modal-next-btn" aria-label="Next image">Next &#8250;</button>
                   <span class="photo-count-pill" id="modal-photo-count">${startIdx + 1} / ${imgs.length}</span>`
                : ""
            }
            ${photoTagHtml(item)}
          </div>
          ${
            imgs.length > 1
              ? `<div class="modal-thumbs" id="modal-thumbs">
                  ${imgs
                    .map(
                      (src, i) =>
                        `<button type="button" class="modal-thumb-btn ${i === startIdx ? "active" : ""}" data-idx="${i}" aria-label="View image ${i + 1}"><img src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer" loading="lazy" /></button>`
                    )
                    .join("")}
                 </div>`
              : ""
          }`
        : ""
    }
    <div class="card-badges" style="margin-bottom:8px;">
      <span class="badge ${fitBadgeMeta(p.budgetFit).cls}">${fitBadgeMeta(p.budgetFit).label}</span>
      <span class="badge badge-cat">${escapeHtml(item.category)}</span>
      <span class="badge badge-metro">${escapeHtml(item.metroStation)}</span>
      ${saveBadgeHtml(id)}
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

    ${
      partnerNote
        ? `<div class="modal-box" style="margin-bottom:12px; background:var(--blue-bg); border-color:var(--blue-border);">
            <h4 style="color:var(--blue);">${escapeHtml(profileDisplayName(partner))}'s Visit Note</h4>
            <div style="font-size:12.5px;">${escapeHtml(partnerNote)}</div>
           </div>`
        : ""
    }

    <div style="margin-bottom:14px;">
      <label for="modal-notes" style="font-size:12px; font-weight:700;">${escapeHtml(state.profile ? profileDisplayName(state.profile) + "'s" : "Shared")} Visit / Call Note (synced with partner):</label>
      <textarea id="modal-notes" class="notes-area" placeholder="e.g., Called owner: ₹11k flat incl. AC, EB direct meter, visiting Saturday...">${escapeHtml(myNote)}</textarea>
      <button type="button" class="btn" id="save-note-btn" data-id="${escapeHtml(item.id)}" style="margin-top:6px;">Save Shared Note</button>
    </div>

    <div class="card-actions" style="border-top:0; padding-top:0;">
      <a class="btn btn-primary" href="${escapeHtml(item.links?.listingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.links?.listingLabel || "Open Listing")} ↗</a>
      <a class="btn" href="${escapeHtml(item.links?.mapsUrl)}" target="_blank" rel="noopener noreferrer">Open Google Maps ↗</a>
      <button type="button" class="btn" id="modal-save-btn" data-id="${escapeHtml(item.id)}">${saveInfo.mine ? "★ Saved by Me" : "☆ Save Stay"}</button>
      <button type="button" class="btn btn-discuss" id="modal-discuss-btn" data-id="${escapeHtml(item.id)}">Discuss in Chat</button>
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

function openLoginOverlay(canDismiss = false) {
  const overlay = document.getElementById("login-overlay");
  if (!overlay) return;
  overlay.dataset.dismissible = canDismiss ? "1" : "0";
  const pre = state.profile || state.pendingProfile || null;
  state.pendingProfile = pre;
  document.querySelectorAll("#login-profile-grid .profile-choice").forEach((el) => {
    el.classList.toggle("selected", el.dataset.profile === pre);
  });
  const enterBtn = document.getElementById("login-enter-btn");
  if (enterBtn) {
    enterBtn.disabled = !pre;
    enterBtn.textContent = pre ? `Enter as ${profileDisplayName(pre)} →` : "Enter Shared Finder →";
  }
  const passInput = document.getElementById("login-password-input");
  const passToggle = document.getElementById("login-pass-toggle");
  const errEl = document.getElementById("login-error");
  if (passInput) {
    passInput.value = "";
    passInput.type = "password";
    passInput.classList.remove("is-invalid");
  }
  if (passToggle) passToggle.textContent = "Show";
  if (errEl) errEl.classList.add("hidden");
  const roomNote = document.getElementById("login-room-note");
  if (roomNote) {
    roomNote.textContent = state.collabSynced
      ? "Shared Sync: Live across this link"
      : "Offline / Local Storage Mode";
  }
  overlay.classList.remove("hidden");
  if (pre && passInput) {
    setTimeout(() => passInput.focus(), 40);
  }
}

function confirmProfileLogin(chosen) {
  const p = chosen || state.pendingProfile;
  const errEl = document.getElementById("login-error");
  const passInput = document.getElementById("login-password-input");
  if (p !== "harsha" && p !== "rajat") {
    if (errEl) {
      errEl.textContent = "Please select Harsha or Rajat first.";
      errEl.classList.remove("hidden");
    }
    return false;
  }
  const entered = passInput ? passInput.value : "";
  if (!verifyPasscode(entered)) {
    if (passInput) {
      passInput.classList.add("is-invalid");
      passInput.focus();
      passInput.select();
    }
    if (errEl) {
      errEl.textContent = entered.trim()
        ? "Incorrect passcode. Please try again."
        : "Please enter passcode to login.";
      errEl.classList.remove("hidden");
    }
    return false;
  }
  state.profile = p;
  state.pendingProfile = p;
  try {
    localStorage.setItem(PROFILE_KEY, p);
    localStorage.setItem(AUTH_KEY, "1");
  } catch {}
  document.getElementById("login-overlay")?.classList.add("hidden");
  renderAll();
  showToast(`Signed in as ${profileDisplayName(p)} — saves & chat sync on this link`);
  return true;
}

function setChatMention(stayId) {
  state.chatMentionId = stayId || null;
  const sel = document.getElementById("chat-stay-select");
  if (sel) sel.value = state.chatMentionId || "";
  const attached = document.getElementById("chat-attached-pill");
  if (attached) {
    if (!state.chatMentionId) {
      attached.classList.add("hidden");
      attached.innerHTML = "";
    } else {
      const item = state.listings.find((x) => x.id === state.chatMentionId);
      attached.classList.remove("hidden");
      attached.innerHTML = `
        <span>Mentioning: <strong>${escapeHtml(item ? item.name : state.chatMentionId)}</strong></span>
        <button type="button" class="chat-attached-clear" aria-label="Clear mentioned stay">✕</button>
      `;
    }
  }
}

function openChatDrawer(mentionId = null) {
  if (!state.profile) {
    openLoginOverlay(true);
    return;
  }
  state.chatOpen = true;
  document.getElementById("chat-drawer")?.classList.remove("hidden");
  markChatSeen();
  if (mentionId) setChatMention(mentionId);
  renderCollabUi();
  setTimeout(() => {
    const listEl = document.getElementById("chat-messages");
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
    const inp = document.getElementById("chat-input");
    if (inp) inp.focus();
  }, 50);
}

function markChatSeen() {
  const msgs = state.collab.messages || [];
  const maxTs = msgs.length ? Math.max(...msgs.map((m) => m.ts || 0)) : Date.now();
  state.lastSeenMsgTs = Math.max(state.lastSeenMsgTs || 0, maxTs);
  try {
    localStorage.setItem(CHAT_SEEN_KEY, String(state.lastSeenMsgTs));
  } catch {}
}

function updateChatMentionSelect() {
  const sel = document.getElementById("chat-stay-select");
  if (!sel) return;
  const hSet = new Set(state.collab.saved?.harsha || []);
  const rSet = new Set(state.collab.saved?.rajat || []);
  const savedItems = state.listings.filter((x) => hSet.has(x.id) || rSet.has(x.id));
  const otherItems = state.listings.filter((x) => !hSet.has(x.id) && !rSet.has(x.id));
  const tagPrefix = (id) => {
    if (hSet.has(id) && rSet.has(id)) return "[Both ★] ";
    if (hSet.has(id)) return "[Harsha ★] ";
    if (rSet.has(id)) return "[Rajat ★] ";
    return "";
  };
  sel.innerHTML =
    `<option value="">No specific stay (General chat)</option>` +
    (savedItems.length
      ? `<optgroup label="Saved Stays (Harsha / Rajat)">${savedItems
          .map(
            (x) =>
              `<option value="${escapeHtml(x.id)}">${escapeHtml(tagPrefix(x.id) + x.name)}</option>`
          )
          .join("")}</optgroup>`
      : "") +
    `<optgroup label="All Other Verified Stays">${otherItems
      .map(
        (x) =>
          `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)} (${escapeHtml(x.locality || "")})</option>`
      )
      .join("")}</optgroup>`;
  sel.value = state.chatMentionId || "";
}

function renderCollabUi() {
  const msgs = state.collab.messages || [];
  const countPill = document.getElementById("chat-count-pill");
  if (countPill) countPill.textContent = String(msgs.length);

  const toggleBtn = document.getElementById("chat-toggle-btn");
  if (toggleBtn) {
    const unread = msgs.some(
      (m) => (m.ts || 0) > (state.lastSeenMsgTs || 0) && m.sender !== state.profile
    );
    toggleBtn.classList.toggle("has-unread", unread && !state.chatOpen);
  }

  const syncBadge = document.getElementById("chat-sync-status");
  if (syncBadge) {
    syncBadge.textContent = state.collabSynced ? "Synced Live" : "Local Mode";
    syncBadge.classList.toggle("offline", !state.collabSynced);
  }

  const savedBar = document.getElementById("chat-saved-bar");
  if (savedBar) {
    const hSet = new Set(state.collab.saved?.harsha || []);
    const rSet = new Set(state.collab.saved?.rajat || []);
    const unionIds = Array.from(new Set([...hSet, ...rSet]));
    const savedStays = unionIds
      .map((id) => state.listings.find((x) => x.id === id))
      .filter(Boolean);
    if (!savedStays.length) {
      savedBar.innerHTML = `<span class="muted-xs">No saved stays yet — click ☆ on any card to shortlist &amp; mention here!</span>`;
    } else {
      savedBar.innerHTML = savedStays
        .map((x) => {
          const s = getSaveInfo(x.id);
          const who = s.both ? "★ Both" : s.harsha ? "H" : "R";
          return `<button type="button" class="chat-saved-pill ${s.both ? "is-both" : ""} js-mention-pill" data-id="${escapeHtml(x.id)}" title="Click to mention ${escapeHtml(x.name)} in chat">${who} · ${escapeHtml(x.name.split("(")[0].trim().slice(0, 26))}</button>`;
        })
        .join("");
    }
  }

  updateChatMentionSelect();

  const listEl = document.getElementById("chat-messages");
  if (listEl) {
    if (!msgs.length) {
      listEl.innerHTML = `<div class="chat-empty">No messages yet!<br />Click a saved location chip above or click <strong>Discuss</strong> on any card to mention a stay and decide together.</div>`;
    } else {
      const wasAtBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
      listEl.innerHTML = msgs
        .map((m) => {
          const isMine = m.sender === state.profile;
          const stay = m.stayId ? state.listings.find((x) => x.id === m.stayId) : null;
          const dt = new Date(m.ts || Date.now());
          const tm = Number.isNaN(dt.getTime())
            ? ""
            : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const mentionCard = stay
            ? `<button type="button" class="chat-stay-mention js-open-stay-from-chat" data-id="${escapeHtml(stay.id)}" title="Open details for ${escapeHtml(stay.name)}">
                <span class="chat-stay-mention-title">★ ${escapeHtml(stay.name)}</span>
                <span class="chat-stay-mention-sub">${escapeHtml(stay.metroStation)} · ${escapeHtml(formatRange(stay.pricing?.effectiveTotalPerPersonMin, stay.pricing?.effectiveTotalPerPersonMax))}/mo · View Details ↗</span>
               </button>`
            : "";
          return `
            <div class="chat-msg ${isMine ? "is-mine" : ""} sender-${escapeHtml(m.sender)}">
              <div class="chat-msg-meta">
                <span class="chat-author-tag ${escapeHtml(m.sender)}">${escapeHtml(profileDisplayName(m.sender))}</span>
                <span>${escapeHtml(tm)}</span>
              </div>
              <div class="chat-bubble">
                ${mentionCard}
                <div>${escapeHtml(m.text)}</div>
              </div>
            </div>
          `;
        })
        .join("");
      if (wasAtBottom) {
        listEl.scrollTop = listEl.scrollHeight;
      }
    }
  }
}

async function sendChatMessage(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return;
  if (!state.profile) {
    openLoginOverlay(true);
    return;
  }
  const msg = {
    id: `${Date.now()}_${state.profile}_${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    sender: state.profile,
    text,
    stayId: state.chatMentionId || null,
  };
  await updateCollab((c) => {
    c.messages = c.messages || [];
    if (!c.messages.some((m) => m.id === msg.id)) {
      c.messages.push(msg);
      c.messages = c.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }
  });
  markChatSeen();
  const inp = document.getElementById("chat-input");
  if (inp) inp.value = "";
  setChatMention(null);
}

function renderAll() {
  renderHeaderAndKpis();
  populateLocalities();
  renderListings();
  renderMetroSection();
  renderRedditSection();
  renderSearchLog();
  renderCollabUi();
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
    await fetchCollabSync();
    renderAll();
    if (state.modalItemId && !document.getElementById("detail-modal").classList.contains("hidden")) {
      // keep modal intact; refresh collab badges cleanly
    }
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
    if (!btn) {
      const media = e.target.closest(".js-card-photo");
      if (media && media.dataset.id) {
        openDetailsModal(media.dataset.id);
      }
      return;
    }
    const id = btn.dataset.id;
    if (!id) return;

    if (btn.classList.contains("js-prev-img")) {
      stepCardImage(id, -1);
    } else if (btn.classList.contains("js-next-img")) {
      stepCardImage(id, 1);
    } else if (btn.classList.contains("js-details")) {
      openDetailsModal(id);
    } else if (btn.classList.contains("js-discuss")) {
      openChatDrawer(id);
    } else if (btn.classList.contains("js-star")) {
      await toggleSaveStay(id);
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
    if (e.target.closest("#modal-prev-btn")) {
      updateModalPhoto(state.modalImageIdx - 1);
      return;
    }
    if (e.target.closest("#modal-next-btn")) {
      updateModalPhoto(state.modalImageIdx + 1);
      return;
    }
    const thumbBtn = e.target.closest(".modal-thumb-btn");
    if (thumbBtn) {
      updateModalPhoto(Number(thumbBtn.dataset.idx) || 0);
      return;
    }
    if (e.target.id === "modal-save-btn") {
      const id = e.target.dataset.id;
      await toggleSaveStay(id);
      openDetailsModal(id);
      return;
    }
    if (e.target.id === "modal-discuss-btn") {
      const id = e.target.dataset.id;
      document.getElementById("detail-modal").classList.add("hidden");
      openChatDrawer(id);
      return;
    }
    if (e.target.id === "save-note-btn") {
      const id = e.target.dataset.id;
      const val = document.getElementById("modal-notes").value;
      state.userState.notes = state.userState.notes || {};
      state.userState.notes[id] = val;
      await saveUserState();
      if (state.profile) {
        const actor = state.profile;
        const noteTs = Date.now();
        await updateCollab((c) => {
          c.notes = c.notes || { harsha: {}, rajat: {} };
          c.notes[actor] = c.notes[actor] || {};
          c.notes[actor][id] = val;
          c.notesAt = c.notesAt || { harsha: 0, rajat: 0 };
          c.notesAt[actor] = noteTs;
        });
      }
      showToast("Saved visit note & synced!");
    }
  });

  // Profile Login & Switcher
  try {
    const savedProf = localStorage.getItem(PROFILE_KEY);
    const authOk = localStorage.getItem(AUTH_KEY) === "1";
    if (authOk && (savedProf === "harsha" || savedProf === "rajat")) {
      state.profile = savedProf;
    }
    state.lastSeenMsgTs = Number(localStorage.getItem(CHAT_SEEN_KEY) || "0");
    const cachedCollab = loadLocalCollab();
    if (cachedCollab) state.collab = cachedCollab;
  } catch {}

  document.getElementById("login-profile-grid")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".profile-choice");
    if (!btn) return;
    state.pendingProfile = btn.dataset.profile;
    document.querySelectorAll("#login-profile-grid .profile-choice").forEach((el) => {
      el.classList.toggle("selected", el.dataset.profile === state.pendingProfile);
    });
    const enterBtn = document.getElementById("login-enter-btn");
    if (enterBtn) {
      enterBtn.disabled = false;
      enterBtn.textContent = `Enter as ${profileDisplayName(state.pendingProfile)} →`;
    }
    document.getElementById("login-error")?.classList.add("hidden");
    document.getElementById("login-password-input")?.focus();
  });

  document.getElementById("login-password-input")?.addEventListener("input", () => {
    document.getElementById("login-password-input")?.classList.remove("is-invalid");
    document.getElementById("login-error")?.classList.add("hidden");
  });

  document.getElementById("login-pass-toggle")?.addEventListener("click", () => {
    const inp = document.getElementById("login-password-input");
    const btn = document.getElementById("login-pass-toggle");
    if (!inp || !btn) return;
    const isHidden = inp.type === "password";
    inp.type = isHidden ? "text" : "password";
    btn.textContent = isHidden ? "Hide" : "Show";
  });

  document.getElementById("login-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    confirmProfileLogin(state.pendingProfile);
  });

  document.getElementById("login-overlay")?.addEventListener("click", (e) => {
    const overlay = document.getElementById("login-overlay");
    if (e.target.id === "login-overlay" && overlay.dataset.dismissible === "1") {
      overlay.classList.add("hidden");
    }
  });

  document.getElementById("profile-switch-btn")?.addEventListener("click", () => {
    openLoginOverlay(true);
  });

  // Copy shared link buttons
  const copyLinkHandler = async () => {
    const link = getSharedUrl();
    try {
      await navigator.clipboard.writeText(link);
      showToast("Shared link copied! Send it to your partner.");
    } catch {
      window.prompt("Copy this shared link for your partner:", link);
    }
  };
  document.getElementById("copy-shared-link-btn")?.addEventListener("click", copyLinkHandler);
  document.getElementById("chat-copy-link-btn")?.addEventListener("click", copyLinkHandler);
  document.getElementById("chat-export-btn")?.addEventListener("click", () => {
    const stayById = new Map(state.listings.map((s) => [s.id, s]));
    const dump = {
      exportedAt: new Date().toISOString(),
      room: state.collab.room || getCollabRoomId(),
      saved: state.collab.saved,
      notes: state.collab.notes,
      messages: (state.collab.messages || []).map((m) => {
        const st = m.stayId ? stayById.get(m.stayId) : null;
        return {
          ...m,
          timeLocal: new Date(m.ts || Date.now()).toLocaleString(),
          stayName: st ? st.name : null,
          stayUrl: st?.links?.listingUrl || null,
        };
      }),
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `staymid-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${(state.collab.messages || []).length} permanent chat messages!`);
  });

  // Chat drawer listeners
  document.getElementById("chat-toggle-btn")?.addEventListener("click", () => {
    if (state.chatOpen) {
      state.chatOpen = false;
      document.getElementById("chat-drawer")?.classList.add("hidden");
    } else {
      openChatDrawer();
    }
  });

  document.getElementById("chat-close-btn")?.addEventListener("click", () => {
    state.chatOpen = false;
    document.getElementById("chat-drawer")?.classList.add("hidden");
  });

  document.getElementById("chat-saved-bar")?.addEventListener("click", (e) => {
    const pill = e.target.closest(".js-mention-pill");
    if (!pill) return;
    setChatMention(pill.dataset.id);
    document.getElementById("chat-input")?.focus();
  });

  document.getElementById("chat-stay-select")?.addEventListener("change", (e) => {
    setChatMention(e.target.value || null);
  });

  document.getElementById("chat-attached-pill")?.addEventListener("click", (e) => {
    if (e.target.closest(".chat-attached-clear")) setChatMention(null);
  });

  document.getElementById("chat-messages")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".js-open-stay-from-chat");
    if (!btn) return;
    if (window.innerWidth <= 760) {
      state.chatOpen = false;
      document.getElementById("chat-drawer")?.classList.add("hidden");
    }
    openDetailsModal(btn.dataset.id);
  });

  document.getElementById("chat-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = document.getElementById("chat-input");
    if (inp) await sendChatMessage(inp.value);
  });

  document.getElementById("chat-input")?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await sendChatMessage(e.target.value);
    }
  });

  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("detail-modal");
    if (!modal.classList.contains("hidden")) {
      if (e.key === "ArrowRight") updateModalPhoto(state.modalImageIdx + 1);
      else if (e.key === "ArrowLeft") updateModalPhoto(state.modalImageIdx - 1);
      else if (e.key === "Escape") modal.classList.add("hidden");
      return;
    }
    const loginOverlay = document.getElementById("login-overlay");
    if (
      loginOverlay &&
      !loginOverlay.classList.contains("hidden") &&
      e.key === "Enter" &&
      state.pendingProfile &&
      e.target?.id !== "login-pass-toggle"
    ) {
      e.preventDefault();
      confirmProfileLogin(state.pendingProfile);
    }
  });

  if (!state.profile) {
    openLoginOverlay(false);
  }
  fetchState(false);
  if (!IS_EMBEDDED) {
    setInterval(() => fetchState(true), IS_LOCAL_SERVER ? 4500 : 8000);
  }
});
