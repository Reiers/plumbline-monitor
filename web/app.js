/*
 * Plumbline · Public Status
 *
 * Vanilla JS. Two data sources:
 *
 *   1. /uptime.json (same origin) - 90-day history collected by a
 *      systemd timer on the Hetzner box (see collector/). Renders the
 *      uptime bar strips.
 *
 *   2. Live public endpoints on faucet + calix - fills the "Live
 *      signals" grid and drives the top banner colour.
 *
 * Every metric maps to a named SLI in Reiers/plumbline/SLO.md.
 */

const REFRESH_MS      = 30_000;
const UPTIME_URL      = '/uptime.json';
const BAR_COUNT       = 90;    // 90-day chart

const ENDPOINTS = {
  faucetHealth: 'https://faucet.reiers.io/healthz',
  faucetInfo:   'https://faucet.reiers.io/api/info',
  faucetStats:  'https://faucet.reiers.io/api/stats',
  calixHealth:  'https://calix.reiers.io/api/v1/health',
  calixStatus:  'https://calix.reiers.io/api/v1/status',
  calixSignals: 'https://calix.reiers.io/api/v1/signals',
  calixMiners:  'https://calix.reiers.io/api/v1/miners/status?addrs=t0143103',
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

async function pollLive() {
  const [fH, fI, fS, cH, cS, cSig, cM] = await Promise.all([
    safe(ENDPOINTS.faucetHealth),
    safe(ENDPOINTS.faucetInfo),
    safe(ENDPOINTS.faucetStats),
    safe(ENDPOINTS.calixHealth),
    safe(ENDPOINTS.calixStatus),
    safe(ENDPOINTS.calixSignals),
    safe(ENDPOINTS.calixMiners),
  ]);

  // Faucet ----------------------------------------------------------
  let faucetState = 'bad', faucetText = 'Major Outage';
  if (fH.ok && fH.value && fH.value.ok) {
    faucetState = 'ok'; faucetText = 'Operational';
    if (fI.ok) {
      const filWei  = BigInt(fI.value.filBalanceWei   ?? '0');
      const usdWei  = BigInt(fI.value.usdfcBalanceWei ?? '0');
      const dec     = 10n ** 18n;
      const minFil  = BigInt(fI.value.minReserveFil   ?? '0') * dec;
      const minUsd  = BigInt(fI.value.minReserveUsdfc ?? '0') * dec;
      if (filWei < minFil || usdWei < minUsd) {
        faucetState = 'watch';
        faucetText  = 'Degraded — low reserve';
      }
    }
  }
  setComponentState('faucet', faucetState, faucetText);

  if (fI.ok) {
    setText('signal-fil',   fmtBigUnit(fI.value.filBalanceWei, 18, 'tFIL'));
    setText('signal-usdfc', fmtBigUnit(fI.value.usdfcBalanceWei, 18, 'USDFC'));
  }
  if (fS.ok) {
    setText('signal-fil24',   fmtInt(fS.value.filDripsToday));
    setText('signal-usdfc24', fmtInt(fS.value.usdfcDripsToday));
  }

  // Calix -----------------------------------------------------------
  let calixState = 'bad', calixText = 'Major Outage';
  if (cH.ok && cH.value && cH.value.ok) {
    calixState = 'ok'; calixText = 'Operational';
  }
  if (cS.ok) {
    const s = cS.value;
    if (s.epoch !== undefined)          setText('signal-epoch', fmtInt(s.epoch));
    if (s.networkVersion !== undefined) setText('signal-nv',    `nv${s.networkVersion}`);
    if (s.headAgeSeconds !== undefined) {
      setText('signal-head-age', fmtSeconds(s.headAgeSeconds));
      if (s.headAgeSeconds > 300 && calixState === 'ok') {
        calixState = 'watch';
        calixText  = 'Degraded — head lagging';
      }
    }
    if (s.forked === true) {
      calixState = 'bad';
      calixText  = 'Forked from canonical';
    }
    const level = String(s.level || '').toLowerCase();
    if (level === 'degraded') {
      calixState = 'bad';
      calixText  = 'Degraded';
    } else if (level === 'watch' && calixState === 'ok') {
      calixState = 'watch';
      calixText  = 'Watch';
    }
  }
  if (cSig.ok && cSig.value.blocksPerEpoch) {
    setText('signal-bpe', Number(cSig.value.blocksPerEpoch.value).toFixed(2));
  }
  setComponentState('calix', calixState, calixText);

  // SP --------------------------------------------------------------
  let spState = 'bad', spText = 'Major Outage';
  if (cM.ok) {
    const list = Array.isArray(cM.value) ? cM.value : (cM.value.miners || []);
    const target = list.find(m => (m.address || m.id) === 't0143103');
    if (target) {
      const status = String(target.status || '').toLowerCase();
      if (status === 'active' || status === 'ok') {
        spState = 'ok'; spText = 'Operational';
      } else if (status === 'watch') {
        spState = 'watch'; spText = 'Degraded';
      } else {
        spState = 'bad'; spText = 'Offline';
      }
    }
  }
  setComponentState('sp', spState, spText);

  // Group + banner --------------------------------------------------
  const worst = rank([faucetState, calixState, spState]);
  const rankMap = { ok: 'Operational', watch: 'Degraded Performance', bad: 'Major Outage' };
  setGroupState('surface', worst, rankMap[worst]);

  if (worst === 'ok') {
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

async function tick() {
  await Promise.all([pollLive(), refreshUptime()]);
}

tick().catch(console.error);
setInterval(() => { tick().catch(console.error); }, REFRESH_MS);
