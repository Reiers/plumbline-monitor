/*
 * Plumbline · Public Status
 *
 * Vanilla JS. No framework, no build step. Polls public HTTPS endpoints
 * on the Plumbline surface every 30s and updates the DOM in place.
 *
 * Design principles:
 *   - Never blank a value on a failed poll; mark the tile "stale" instead.
 *   - Every metric maps to something in Reiers/plumbline/SLO.md.
 *   - No secrets. Everything readable by the browser is public already.
 */

const REFRESH_MS = 30_000;
const FRESH_MAX_AGE_MS = 90_000; // consider a poll stale after 90s

const ENDPOINTS = {
  faucetHealth: 'https://faucet.reiers.io/healthz',
  faucetInfo:   'https://faucet.reiers.io/api/info',
  faucetStats:  'https://faucet.reiers.io/api/stats',
  faucetRecent: 'https://faucet.reiers.io/api/recent?limit=10',
  calixHealth:  'https://calix.reiers.io/api/v1/health',
  calixStatus:  'https://calix.reiers.io/api/v1/status',
  calixUpgrade: 'https://calix.reiers.io/api/v1/upgrade',
  calixSignals: 'https://calix.reiers.io/api/v1/signals',
  calixMiners:  'https://calix.reiers.io/api/v1/miners/status?addrs=t0143103,t0144416',
};

// ---------- fetch helpers ----------------------------------------------

async function getJSON(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// Best-effort: return { ok: true, value } or { ok: false, error }.
async function safe(url) {
  try {
    return { ok: true, value: await getJSON(url) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---------- formatting -------------------------------------------------

function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
  return Number(n).toLocaleString('en-US');
}

// Wei / minor-unit → human ("1.2M FIL" style).
function fmtBigUnit(wei, decimals, suffix) {
  if (wei === null || wei === undefined) return '–';
  try {
    const s = String(wei);
    if (!/^[0-9]+$/.test(s)) return '–';
    // Convert to whole units without floating-point loss on the integer
    // portion. Round to 2 decimal places for display.
    const pad = s.padStart(decimals + 1, '0');
    const intPart = pad.slice(0, pad.length - decimals);
    const fracPart = pad.slice(pad.length - decimals, pad.length - decimals + 2);
    const intN = Number(intPart);
    const fracN = Number('0.' + fracPart);
    const whole = intN + (Number.isFinite(fracN) ? fracN : 0);
    if (whole >= 1_000_000) return (whole / 1_000_000).toFixed(2) + `M ${suffix}`;
    if (whole >= 1_000)     return (whole / 1_000).toFixed(2) + `K ${suffix}`;
    return whole.toFixed(2) + ` ${suffix}`;
  } catch { return '–'; }
}

function fmtSeconds(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '–';
  const n = Math.round(Number(s));
  if (n < 60)  return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`;
  if (n < 86400) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`;
}

function shortAddr(addr) {
  if (!addr) return '–';
  const s = String(addr);
  if (s.length <= 14) return s;
  return s.slice(0, 6) + '…' + s.slice(-4);
}

function shortHash(hash) {
  if (!hash) return '–';
  const s = String(hash);
  if (s.length <= 14) return s;
  return s.slice(0, 8) + '…' + s.slice(-6);
}

function relTime(iso) {
  if (!iso) return '–';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '–';
  const ageMs = Date.now() - t;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

// ---------- DOM helpers ------------------------------------------------

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function setTileState(id, state, label, footText) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.state = state; // ok | watch | bad | stale | loading
  const labelEl = el.querySelector('.state-label');
  if (labelEl) labelEl.textContent = label;
  const foot = el.querySelector('.tile-foot');
  if (foot && footText) foot.textContent = footText;
}

function setSloRow(id, valueText, state) {
  const row = document.querySelector(`.slo-row[data-id="${id}"]`);
  if (!row) return;
  row.dataset.state = state; // ok | watch | bad | unknown
  row.querySelector('.slo-value').textContent = valueText;
}

function setHero(state, label, tagline) {
  const hero = document.getElementById('hero');
  hero.dataset.state = state;
  setText('hero-label', label);
  setText('hero-tagline', tagline);
}

// ---------- state rollup ------------------------------------------------

/*
 * Compute overall page state from per-tile states.
 *   ok if all ok
 *   watch if any watch and none bad
 *   bad if any bad
 *   upgrade if calix is upgrade
 */
function rollup(tileStates) {
  if (tileStates.some(s => s === 'bad')) return 'bad';
  if (tileStates.some(s => s === 'upgrade')) return 'upgrade';
  if (tileStates.some(s => s === 'watch' || s === 'stale')) return 'watch';
  if (tileStates.every(s => s === 'ok')) return 'ok';
  return 'watch';
}

// ---------- pollers ----------------------------------------------------

async function pollFaucet() {
  const [health, info, stats] = await Promise.all([
    safe(ENDPOINTS.faucetHealth),
    safe(ENDPOINTS.faucetInfo),
    safe(ENDPOINTS.faucetStats),
  ]);

  // Balances + reserves.
  if (info.ok) {
    setText('faucet-fil-balance',   fmtBigUnit(info.value.filBalanceWei, 18, 'tFIL'));
    setText('faucet-usdfc-balance', fmtBigUnit(info.value.usdfcBalanceWei, 18, 'USDFC'));
  }

  // Drip counters.
  let tileState = 'ok';
  let footText  = 'Fresh · ' + new Date().toLocaleTimeString();
  let stateLabel = 'Operational';

  if (stats.ok) {
    const s = stats.value;
    // API returns per-asset lifetime + 24h counters; be defensive about shape.
    const fil24 = s.fil?.dripsLast24h ?? s.fil24h ?? s.fil?.h24 ?? s.dripsLast24hFil ?? null;
    const usd24 = s.usdfc?.dripsLast24h ?? s.usdfc24h ?? s.usdfc?.h24 ?? s.dripsLast24hUsdfc ?? null;
    const filLife = s.fil?.dripsLifetime ?? s.filLifetime ?? s.fil?.lifetime ?? s.dripsLifetimeFil ?? null;
    const usdLife = s.usdfc?.dripsLifetime ?? s.usdfcLifetime ?? s.usdfc?.lifetime ?? s.dripsLifetimeUsdfc ?? null;
    setText('faucet-fil-24h',   fmtInt(fil24));
    setText('faucet-usdfc-24h', fmtInt(usd24));
    if (filLife !== null && usdLife !== null) {
      setText('faucet-lifetime', `${fmtInt(filLife)} tFIL · ${fmtInt(usdLife)} USDFC`);
    }
  }

  // Health drives state.
  if (!health.ok) {
    tileState = 'bad';
    stateLabel = 'Down';
    footText   = `/healthz error: ${health.error}`;
  } else if (!health.value.ok) {
    tileState = 'watch';
    stateLabel = 'Degraded';
    footText   = '/healthz returned ok:false';
  } else if (info.ok) {
    // Low reserve check.
    const fil  = BigInt(info.value.filBalanceWei ?? '0');
    const usd  = BigInt(info.value.usdfcBalanceWei ?? '0');
    // minReserve values are strings in whole units; convert to wei.
    const decMul = 10n ** 18n;
    const minFil = BigInt(info.value.minReserveFil ?? '0')   * decMul;
    const minUsd = BigInt(info.value.minReserveUsdfc ?? '0') * decMul;
    if (fil < minFil || usd < minUsd) {
      tileState  = 'watch';
      stateLabel = 'Low reserve';
      footText   = 'Dispenser reserve below configured minimum — refill needed';
    } else {
      const dispenser = info.value.dispenser ? shortAddr(info.value.dispenser) : '–';
      footText = `Dispenser ${dispenser} · fresh ${new Date().toLocaleTimeString()}`;
    }
  }

  setTileState('tile-faucet', tileState, stateLabel, footText);

  // Recent activity table.
  const recent = await safe(ENDPOINTS.faucetRecent);
  renderRecent(recent);

  return tileState;
}

function renderRecent(recent) {
  const body = document.getElementById('activity-body');
  if (!body) return;
  if (!recent.ok) {
    body.innerHTML = `<tr><td colspan="4" class="empty">Feed unavailable · ${escapeHtml(recent.error || 'error')}</td></tr>`;
    return;
  }
  let rows = [];
  const list = Array.isArray(recent.value)
    ? recent.value
    : (recent.value.drips || recent.value.recent || []);
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty">No recent drips yet</td></tr>`;
    return;
  }
  for (const d of list.slice(0, 10)) {
    const asset = (d.asset || d.token || '').toLowerCase() || 'fil';
    const addr  = d.address || d.to || d.recipient || '';
    const tx    = d.txHash || d.tx || d.hash || '';
    const at    = d.at || d.timestamp || d.time || null;
    rows.push(`
      <tr>
        <td>${escapeHtml(relTime(at) || '–')}</td>
        <td class="${asset === 'fil' ? 'asset-fil' : 'asset-usdfc'}">${escapeHtml(asset.toUpperCase())}</td>
        <td class="addr">${escapeHtml(shortAddr(addr))}</td>
        <td class="txhash">${escapeHtml(shortHash(tx))}</td>
      </tr>`);
  }
  body.innerHTML = rows.join('');
}

async function pollCalix() {
  const [health, status, upgrade, signals] = await Promise.all([
    safe(ENDPOINTS.calixHealth),
    safe(ENDPOINTS.calixStatus),
    safe(ENDPOINTS.calixUpgrade),
    safe(ENDPOINTS.calixSignals),
  ]);

  let tileState = 'ok';
  let stateLabel = 'Operational';
  let footText  = 'Fresh · ' + new Date().toLocaleTimeString();

  if (!health.ok) {
    tileState = 'bad';
    stateLabel = 'Down';
    footText   = `/api/v1/health error: ${health.error}`;
  } else {
    const h = health.value;
    if (h.chainHeadAgeSeconds !== undefined) {
      setText('calix-head-age', fmtSeconds(h.chainHeadAgeSeconds));
      if (h.chainHeadAgeSeconds > 300) {
        tileState = 'watch';
        stateLabel = 'Head lagging';
      }
    }
    if (h.epoch !== undefined) setText('calix-epoch', fmtInt(h.epoch));
    if (h.networkVersion !== undefined) setText('calix-nv', `nv${h.networkVersion}`);
  }

  if (status.ok) {
    const s = status.value;
    if (s.epoch !== undefined) setText('calix-epoch', fmtInt(s.epoch));
    if (s.networkVersion !== undefined) setText('calix-nv', `nv${s.networkVersion}`);
    if (s.blocksPerEpoch !== undefined) setText('calix-bpe', Number(s.blocksPerEpoch).toFixed(2));
    // Overall status pill from calix drives the tile if worse than current.
    const op = String(s.operational || s.status || '').toUpperCase();
    if (op === 'UPGRADE_PENDING' || op === 'UPGRADE PENDING') {
      tileState = 'upgrade';
      stateLabel = 'Upgrade pending';
    } else if (op === 'DEGRADED') {
      tileState = 'bad';
      stateLabel = 'Degraded';
    } else if (op === 'WATCH') {
      if (tileState === 'ok') { tileState = 'watch'; stateLabel = 'Watch'; }
    }
  }

  if (signals.ok) {
    const g = signals.value;
    // Try common shape: array of KPIs, or an object of KPIs.
    const bpe = pickSignal(g, 'blocksPerEpoch', 'blocks_per_epoch');
    if (bpe !== null) setText('calix-bpe', Number(bpe).toFixed(2));
  }

  if (upgrade.ok) {
    const u = upgrade.value;
    if (u.codename && u.activationEpoch) {
      const eta = u.eta || u.etaSeconds || null;
      const parts = [`${u.codename} (nv${u.networkVersion || '?'})`];
      if (eta !== null) parts.push(`in ${fmtSeconds(eta)}`);
      else if (u.activationUnix) {
        const ageS = Math.max(0, Math.floor((u.activationUnix * 1000 - Date.now()) / 1000));
        if (ageS > 0) parts.push(`in ${fmtSeconds(ageS)}`);
      }
      setText('calix-upgrade', parts.join(' · '));
    } else if (u.next && u.next.codename) {
      setText('calix-upgrade', u.next.codename);
    } else {
      setText('calix-upgrade', 'None scheduled');
    }
  }

  setTileState('tile-calix', tileState, stateLabel, footText);
  return tileState;
}

// Try to pluck a named signal from calix /signals payload regardless of shape.
function pickSignal(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    if (obj.signals && obj.signals[k] !== undefined) return obj.signals[k];
  }
  if (Array.isArray(obj.signals)) {
    for (const s of obj.signals) {
      for (const k of keys) if (s.key === k || s.name === k) return s.value ?? s.current ?? null;
    }
  }
  return null;
}

async function pollSPs() {
  const r = await safe(ENDPOINTS.calixMiners);
  if (!r.ok) {
    setTileState('tile-sps', 'watch', 'Feed offline', `Miner probe error: ${r.error}`);
    return 'watch';
  }
  // Shape: { miners: [{ address, status, blocksLast60, ... }], ... }
  const list = Array.isArray(r.value) ? r.value
             : (r.value.miners || []);
  let anyActive  = false;
  let bothActive = true;
  for (const m of list) {
    const id     = m.address || m.id || m.miner;
    const status = String(m.status || '').toLowerCase();
    const power  = m.rawBytePower || m.qualityAdjPower || m.power || null;
    const blocks = m.blocksLast60 !== undefined ? m.blocksLast60 : null;
    const active = status === 'active' || status === 'ok' || (m.active ?? m.isActive ?? null) === true;
    const row = document.querySelector(`.sp-row[data-miner="${id}"] .sp-power`);
    if (row) {
      const parts = [];
      if (power) parts.push(fmtPower(power));
      if (blocks !== null) parts.push(`${blocks} blk/60ep`);
      if (!parts.length) parts.push(status || '–');
      row.textContent = parts.join(' · ');
    }
    if (active) anyActive = true;
    else bothActive = false;
  }
  const state = bothActive ? 'ok' : (anyActive ? 'watch' : 'bad');
  const label = bothActive ? 'Both active' : (anyActive ? 'One active' : 'Both offline');
  setTileState('tile-sps', state, label, `Refreshed ${new Date().toLocaleTimeString()}`);
  return state;
}

function fmtPower(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '–';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

// ---------- SLO summary -------------------------------------------------
//
// v1: we don't yet have persistent 30-day history collected client-side.
// We publish current-instant states as a rolling proxy — better than
// blanking them. Full 30-day compliance is in the monthly report per
// SLO.md §4.

function updateSloSummary(faucetState, calixState, spState) {
  const map = { ok: 'ok', watch: 'watch', bad: 'bad', stale: 'watch', upgrade: 'watch' };
  const label = (st) => ({ ok: 'Meeting', watch: 'Watch', bad: 'Breach' }[map[st] || 'watch']);
  setSloRow('faucet-avail',      label(faucetState), map[faucetState] || 'watch');
  setSloRow('calix-avail',       label(calixState),  map[calixState]  || 'watch');
  setSloRow('sp-avail',          label(spState),     map[spState]     || 'watch');
  // Drip latency + nv-validation come from data we don't yet expose in
  // an aggregatable way; the /metrics endpoints will provide the raw
  // numbers, but the rolling p99 is computed off-page.
  setSloRow('faucet-fil-latency',   'see /metrics', 'unknown');
  setSloRow('faucet-usdfc-latency', 'see /metrics', 'unknown');
  setSloRow('calix-nv',             'see /metrics', 'unknown');
}

// ---------- top-level tick ----------------------------------------------

async function tick() {
  const [faucetState, calixState, spState] = await Promise.all([
    pollFaucet(),
    pollCalix(),
    pollSPs(),
  ]);
  updateSloSummary(faucetState, calixState, spState);
  const overall = rollup([faucetState, calixState, spState]);
  const heroLabel = {
    ok:      'Operational',
    watch:   'Watch',
    bad:     'Degraded',
    upgrade: 'Upgrade pending',
  }[overall] || 'Unknown';
  const heroTag = {
    ok:      'All Plumbline services within SLO.',
    watch:   'Something is off — inspect service tiles for detail.',
    bad:     'One or more services outside SLO. See runbook.',
    upgrade: 'A Filecoin nv upgrade is approaching.',
  }[overall] || '–';
  setHero(overall, heroLabel, heroTag);
  setText('last-refresh', new Date().toLocaleTimeString());
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Kick off.
tick().catch(console.error);
setInterval(() => { tick().catch(console.error); }, REFRESH_MS);
