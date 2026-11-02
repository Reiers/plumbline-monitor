/*
 * Plumbline · Public Status
 *
 * Vanilla JS. Two data sources:
 *
 *   1. /uptime.json (same origin) - 90-day history collected by a
 *      systemd timer on the Plumbline host (see collector/). Renders the
 *      uptime bar strips.
 *
 *   2. The Plumbline builder API v1 on faucet.reiers.io - fills the
 *      "Live signals" grid and drives the top banner colour:
 *        GET /api/v1/faucet/status, /api/v1/network, /api/v1/sp
 *      If the API is unreachable, or reports stale Calix data, the page
 *      falls back to the original direct endpoints for that component,
 *      so the faucet being down never hides Calix health.
 *
 * Every metric maps to a named SLI in Reiers/plumbline/SLO.md.
 */

const REFRESH_MS      = 30_000;
const UPTIME_URL      = '/uptime.json';
const BAR_COUNT       = 90;    // 90-day chart
const SP_TARGET       = 't0143103';

const API_BASE = PlumblineApi.resolveApiBase(window.location);
const API_V1   = PlumblineApi.endpoints(API_BASE);

// Direct endpoints, used only as a fallback when the builder API cannot
// answer for a component.
const ENDPOINTS = {
  faucetHealth: API_BASE + '/healthz',
  faucetInfo:   API_BASE + '/api/info',
  faucetStats:  API_BASE + '/api/stats',
  calixHealth:  'https://calix.reiers.io/api/v1/health',
  calixStatus:  'https://calix.reiers.io/api/v1/status',
  calixSignals: 'https://calix.reiers.io/api/v1/signals',
  calixMiners:  'https://calix.reiers.io/api/v1/miners/status?addrs=' + SP_TARGET,
};

const COMPONENTS = ['faucet', 'calix', 'sp'];
const COMPONENT_LABEL = {
  faucet: 'Plumbline Faucet',
  calix:  'Calix',
  sp:     'SP Test Target',
};

// ---------- fetch helpers ---------------------------------------------

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

async function safe(url) {
  try { return { ok: true, value: await getJSON(url) }; }
  catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

// For builder API v1 calls: only a 200 with apiVersion "1" counts.
async function safeV1(url) {
  const r = await safe(url);
  if (r.ok && !PlumblineApi.isV1(r.value)) return { ok: false, error: 'not a v1 response' };
  return r;
}

// ---------- formatting ------------------------------------------------

function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
  return Number(n).toLocaleString('en-US');
}

// Wei / minor-unit -> compact "1.55M tFIL" style.
function fmtBigUnit(wei, decimals, suffix) {
  if (wei === null || wei === undefined) return '–';
  try {
    const s = String(wei);
    if (!/^[0-9]+$/.test(s)) return '–';
    const pad = s.padStart(decimals + 1, '0');
    const intPart = pad.slice(0, pad.length - decimals);
    const fracPart = pad.slice(pad.length - decimals, pad.length - decimals + 2);
    const whole = Number(intPart) + Number('0.' + fracPart);
    if (whole >= 1_000_000) return (whole / 1_000_000).toFixed(2) + `M ${suffix}`;
    if (whole >= 1_000)     return (whole / 1_000).toFixed(2) + `K ${suffix}`;
    return whole.toFixed(2) + ` ${suffix}`;
  } catch { return '–'; }
}

function fmtSeconds(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '–';
  const n = Math.round(Number(s));
  if (n < 60)    return `${n}s`;
  if (n < 3600)  return `${Math.floor(n / 60)}m ${n % 60}s`;
  if (n < 86400) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`;
}

function isoDay(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---------- DOM helpers -----------------------------------------------

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function setComponentState(comp, state, text) {
  const el = document.querySelector(`.component[data-component="${comp}"] .component-state`);
  if (!el) return;
  el.dataset.state = state;
  const t = el.querySelector('.state-text');
  if (t) t.textContent = text;
}

function setGroupState(group, state, text) {
  const el = document.querySelector(`.group[data-group="${group}"] .group-state`);
  if (!el) return;
  el.dataset.state = state;
  const t = el.querySelector('.state-text');
  if (t) t.textContent = text;
}

function setBanner(state, text) {
  const b = document.getElementById('status-banner');
  b.dataset.state = state;
  setText('banner-text', text);
}

// ---------- scheduled maintenance override ----------------------------
// Planned maintenance on the calibration host(s). While the window is
// active, listed components and the top banner show a maintenance notice
// instead of "Major Outage". Clear by setting MAINTENANCE = null (or
// letting until pass).
const MAINTENANCE = null;
// Previous window (closed 2026-10-16): planned storage-server maintenance Oct 12-16.
// To open a new window:
//   const MAINTENANCE = { components:['sp'], since:'YYYY-MM-DD', until:'YYYY-MM-DDTHH:MM:SSZ',
//                        componentText:'...', bannerText:'...' };

function maintenanceActive() {
  if (!MAINTENANCE || !MAINTENANCE.until) return false;
  return Date.now() < Date.parse(MAINTENANCE.until);
}


// ---------- rendering: uptime bars ------------------------------------

/*
 * Build the 90-day uptime bar for a component. Data shape from /uptime.json:
 *
 * {
 *   generatedAt: "2026-08-03T13:00:00Z",
 *   window_days: 90,
 *   components: {
 *     faucet: {
 *       days: [
 *         { date: "2026-05-06", state: "ok"|"watch"|"bad"|"nodata", uptime: 0.999, incidents: 0 },
 *         ...
 *       ],
 *       uptime_90d: 0.9982
 *     },
 *     calix: {...},
 *     sp: {...}
 *   }
 * }
 *
 * Days are ordered oldest -> newest. If a day is missing we render "nodata".
 */
function renderBar(comp, days90) {
  const bar = document.querySelector(`.uptime-bar[data-bar="${comp}"]`);
  if (!bar) return;
  bar.innerHTML = '';
  const byDate = new Map();
  for (const d of days90 || []) byDate.set(d.date, d);
  for (let i = BAR_COUNT - 1; i >= 0; i--) {
    const iso = isoDay(i);
    const rec = byDate.get(iso);
    const el = document.createElement('div');
    el.className = 'u-bar';
    if (!rec) {
      el.dataset.state = 'nodata';
      el.title = `${iso}: no data`;
    } else {
      el.dataset.state = rec.state;
      const uptimePct = rec.uptime !== undefined ? (rec.uptime * 100).toFixed(2) : '–';
      el.title = `${iso}: ${rec.state.toUpperCase()} · ${uptimePct}% uptime` +
                 (rec.incidents ? ` · ${rec.incidents} incident${rec.incidents === 1 ? '' : 's'}` : '');
    }
    bar.appendChild(el);
  }
}

function setPct(comp, uptime90d) {
  const el = document.querySelector(`strong[data-pct="${comp}"]`);
  if (!el) return;
  if (uptime90d === null || uptime90d === undefined) {
    el.textContent = '–';
    return;
  }
  el.textContent = (uptime90d * 100).toFixed(1);
}

async function refreshUptime() {
  const r = await safe(UPTIME_URL);
  if (!r.ok) {
    // Render "nodata" bars so the shell renders even without a collector.
    for (const c of COMPONENTS) {
      renderBar(c, []);
      setPct(c, null);
    }
    return { collectorOk: false };
  }
  const data = r.value;
  const comps = data.components || {};
  for (const c of COMPONENTS) {
    const rec = comps[c] || {};
    renderBar(c, rec.days || []);
    setPct(c, rec.uptime_90d ?? null);
  }
  return { collectorOk: true };
}

// ---------- live signals: banner + signals grid -----------------------

// Fallbacks: same logic the page used before the builder API existed.
async function legacyFaucet() {
  const [fH, fI, fS] = await Promise.all([
    safe(ENDPOINTS.faucetHealth),
    safe(ENDPOINTS.faucetInfo),
    safe(ENDPOINTS.faucetStats),
  ]);
  const out = { state: 'bad', text: 'Major Outage', filWei: null, usdfcWei: null, fil24: null, usdfc24: null };
  if (fH.ok && fH.value && fH.value.ok) {
    out.state = 'ok'; out.text = 'Operational';
    if (fI.ok) {
      const filWei  = BigInt(fI.value.filBalanceWei   ?? '0');
      const usdWei  = BigInt(fI.value.usdfcBalanceWei ?? '0');
      const dec     = 10n ** 18n;
      const minFil  = BigInt(fI.value.minReserveFil   ?? '0') * dec;
      const minUsd  = BigInt(fI.value.minReserveUsdfc ?? '0') * dec;
      if (filWei < minFil || usdWei < minUsd) {
        out.state = 'watch';
        out.text  = 'Degraded: low reserve';
      }
    }
  }
  if (fI.ok) { out.filWei = fI.value.filBalanceWei; out.usdfcWei = fI.value.usdfcBalanceWei; }
  if (fS.ok) { out.fil24 = fS.value.filDripsToday; out.usdfc24 = fS.value.usdfcDripsToday; }
  return out;
}

async function legacyCalix() {
  const [cH, cS, cSig] = await Promise.all([
    safe(ENDPOINTS.calixHealth),
    safe(ENDPOINTS.calixStatus),
    safe(ENDPOINTS.calixSignals),
  ]);
  const out = { state: 'bad', text: 'Major Outage', epoch: undefined, nv: undefined, headAge: undefined, bpe: null };
  if (cH.ok && cH.value && cH.value.ok) {
    out.state = 'ok'; out.text = 'Operational';
  }
  if (cS.ok) {
    const s = cS.value;
    out.epoch = s.epoch; out.nv = s.networkVersion; out.headAge = s.headAgeSeconds;
    if (s.headAgeSeconds !== undefined && s.headAgeSeconds > 300 && out.state === 'ok') {
      out.state = 'watch'; out.text = 'Degraded: head lagging';
    }
    if (s.forked === true) { out.state = 'bad'; out.text = 'Forked from canonical'; }
    const level = String(s.level || '').toLowerCase();
    if (level === 'degraded') {
      out.state = 'bad'; out.text = 'Degraded';
    } else if (level === 'watch' && out.state === 'ok') {
      out.state = 'watch'; out.text = 'Watch';
    }
  }
  if (cSig.ok && cSig.value.blocksPerEpoch) out.bpe = cSig.value.blocksPerEpoch.value;
  return out;
}

async function legacySp() {
  const cM = await safe(ENDPOINTS.calixMiners);
  if (!cM.ok) return { state: 'bad', text: 'Major Outage' };
  const list = Array.isArray(cM.value) ? cM.value : (cM.value.miners || []);
  const target = list.find(m => (m.address || m.id) === SP_TARGET);
  if (!target) return { state: 'bad', text: 'Major Outage' };
  const status = String(target.status || '').toLowerCase();
  if (status === 'active' || status === 'ok') return { state: 'ok', text: 'Operational' };
  if (status === 'watch') return { state: 'watch', text: 'Degraded' };
  return { state: 'bad', text: 'Offline' };
}

async function pollLive() {
  const [vF, vN, vS] = await Promise.all([
    safeV1(API_V1.faucetStatus),
    safeV1(API_V1.network),
    safeV1(API_V1.sp),
  ]);

  const used = [];
  let faucet = vF.ok ? PlumblineApi.faucetFromV1(vF.value) : null;
  let calix  = vN.ok ? PlumblineApi.calixFromV1(vN.value) : null;
  let sp     = vS.ok ? PlumblineApi.spFromV1(vS.value, SP_TARGET) : null;
  if (faucet && calix && sp) used.push('api-v1');
  const fallbacks = await Promise.all([
    faucet ? faucet : legacyFaucet(),
    calix  ? calix  : legacyCalix(),
    sp     ? sp     : legacySp(),
  ]);
  faucet = fallbacks[0]; calix = fallbacks[1]; sp = fallbacks[2];

  // Faucet ----------------------------------------------------------
  setComponentState('faucet', faucet.state, faucet.text);
  if (faucet.filWei !== null)   setText('signal-fil',   fmtBigUnit(faucet.filWei, 18, 'tFIL'));
  if (faucet.usdfcWei !== null) setText('signal-usdfc', fmtBigUnit(faucet.usdfcWei, 18, 'USDFC'));
  if (faucet.fil24 !== null)    setText('signal-fil24',   fmtInt(faucet.fil24));
  if (faucet.usdfc24 !== null)  setText('signal-usdfc24', fmtInt(faucet.usdfc24));

  // Calix -----------------------------------------------------------
  if (calix.epoch !== undefined && calix.epoch !== null) setText('signal-epoch', fmtInt(calix.epoch));
  if (calix.nv !== undefined && calix.nv !== null)       setText('signal-nv',    'nv' + calix.nv);
  if (calix.headAge !== undefined && calix.headAge !== null) setText('signal-head-age', fmtSeconds(calix.headAge));
  if (calix.bpe !== null && calix.bpe !== undefined)     setText('signal-bpe', Number(calix.bpe).toFixed(2));
  setComponentState('calix', calix.state, calix.text);

  // SP --------------------------------------------------------------
  let spState = sp.state, spText = sp.text;
  if (maintenanceActive() && MAINTENANCE.components.includes('sp')) {
    spState = 'watch';
    spText  = MAINTENANCE.componentText;
  }
  setComponentState('sp', spState, spText);

  // Data source note ------------------------------------------------
  const srcEl = document.getElementById('data-source');
  if (srcEl) {
    srcEl.textContent = used.includes('api-v1')
      ? 'Plumbline builder API v1'
      : 'builder API v1 with direct-endpoint fallback';
    srcEl.dataset.source = used.includes('api-v1') ? 'api-v1' : 'fallback';
  }

  // Group + banner --------------------------------------------------
  const faucetState = faucet.state, calixState = calix.state;
  const worst = rank([faucetState, calixState, spState]);
  const rankMap = { ok: 'Operational', watch: 'Degraded Performance', bad: 'Major Outage' };
  setGroupState('surface', worst, rankMap[worst]);

  if (maintenanceActive()) {
    setBanner('watch', MAINTENANCE.bannerText);
    document.getElementById('status-banner').classList.add('is-maintenance');
    setGroupState('surface', 'watch', 'Scheduled Maintenance');
  } else if (worst === 'ok') {
    setBanner('ok', 'All Systems Operational');
  } else if (worst === 'watch') {
    setBanner('watch', 'Some Systems Experiencing Degraded Performance');
  } else {
    setBanner('bad', 'Major Outage On One Or More Systems');
  }

  setText('last-refresh', new Date().toLocaleTimeString());
}

function rank(states) {
  if (states.includes('bad')) return 'bad';
  if (states.includes('watch')) return 'watch';
  return 'ok';
}

// ---------- top-level tick --------------------------------------------

// Populate the 'Today' incident-day heading with the real date.
function setTodayLabel() {
  const el = document.getElementById('incident-today-date');
  if (!el) return;
  const opts = { year: 'numeric', month: 'short', day: 'numeric' };
  el.textContent = `Today \u00b7 ${new Date().toLocaleDateString('en-US', opts)}`;
  // If a dated incident block exists for today, it replaces the empty 'Today' stub.
  const todayISO = new Date().toISOString().slice(0, 10);
  const dated = document.querySelector(`.incident-day[data-date="${todayISO}"]`);
  if (dated) {
    document.getElementById('incident-today').style.display = 'none';
    const h = dated.querySelector('h3');
    if (h) h.textContent = el.textContent;
  }
}

async function tick() {
  setTodayLabel();
  await Promise.all([pollLive(), refreshUptime()]);
  if (maintenanceActive()) {
    for (const comp of (MAINTENANCE.components || [])) {
      const bar = document.querySelector(`.uptime-bar[data-bar="${comp}"]`);
      if (!bar) continue;
      const since = MAINTENANCE.since ? Date.parse(MAINTENANCE.since + 'T00:00:00Z') : null;
      const bars = bar.children;
      for (let i = 0; i < bars.length; i++) {
        const daysAgo = bars.length - 1 - i;
        const iso = isoDay(daysAgo);
        const dayMs = Date.parse(iso + 'T00:00:00Z');
        if (since !== null && dayMs < since) continue;
        bars[i].dataset.state = 'maint';
        bars[i].title = iso + ': planned maintenance';
      }
    }
  }
}

tick().catch(console.error);
setInterval(() => { tick().catch(console.error); }, REFRESH_MS);
