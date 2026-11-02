/*
 * Plumbline builder API v1 client for the status page.
 *
 * Pure functions that turn builder API v1 responses into the view model
 * the page renders. Loaded in the browser as window.PlumblineApi and in
 * Node (tests) via require().
 *
 * API reference: https://github.com/Reiers/plumbline-faucet/blob/main/docs/api.md
 */
(function (root) {
  'use strict';

  const DEFAULT_API_BASE = 'https://faucet.reiers.io';
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

  // ?api=<base> override, honoured only when the page itself is served
  // from localhost. Used to point a local copy at a local faucet.
  function resolveApiBase(loc) {
    try {
      if (!loc || LOCAL_HOSTS.indexOf(loc.hostname) === -1) return DEFAULT_API_BASE;
      const raw = new URLSearchParams(loc.search || '').get('api');
      if (!raw) return DEFAULT_API_BASE;
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_API_BASE;
      return u.origin;
    } catch (e) {
      return DEFAULT_API_BASE;
    }
  }

  function endpoints(base) {
    return {
      index:        base + '/api/v1',
      faucetStatus: base + '/api/v1/faucet/status',
      network:      base + '/api/v1/network',
      sp:           base + '/api/v1/sp',
    };
  }

  function isV1(body) {
    return !!body && body.apiVersion === '1' && body.ok === true;
  }

  // GET /api/v1/faucet/status -> faucet component + faucet signals
  function faucetFromV1(s) {
    const reasons = Array.isArray(s.reasons) ? s.reasons : [];
    let state = 'ok';
    let text = 'Operational';
    if (s.state === 'bad' || s.rpcOk === false) {
      state = 'bad';
      text = 'Major Outage';
    } else if (s.state === 'watch') {
      state = 'watch';
      text = reasons.some(function (r) { return /below_reserve$/.test(r); })
        ? 'Degraded: low reserve'
        : 'Degraded';
    }
    const assets = s.assets || {};
    const stats = s.stats || {};
    const d24 = stats.drips24h || {};
    return {
      state: state,
      text: text,
      filWei: assets.fil ? assets.fil.balanceWei : null,
      usdfcWei: assets.usdfc ? assets.usdfc.balanceWei : null,
      fil24: d24.fil !== undefined ? d24.fil : null,
      usdfc24: d24.usdfc !== undefined ? d24.usdfc : null,
    };
  }

  // GET /api/v1/network -> Calix component + chain signals.
  // Returns null when the payload is stale (Calix not answering the
  // faucet), so the caller can check Calix directly instead.
  function calixFromV1(n) {
    if (n.stale) return null;
    const chain = n.chain || {};
    const signals = n.signals || {};
    let state = n.state === 'bad' ? 'bad' : n.state === 'watch' ? 'watch' : 'ok';
    let text = 'Operational';
    if (state === 'bad') {
      text = n.forked === true ? 'Forked from canonical' : 'Degraded';
    } else if (state === 'watch') {
      if (n.level === 'upgrade') text = 'Upgrade window';
      else if (n.level === 'watch') text = 'Watch';
      else if (typeof chain.headAgeSeconds === 'number' && chain.headAgeSeconds > 300) text = 'Degraded: head lagging';
      else text = 'Watch';
    }
    return {
      state: state,
      text: text,
      epoch: chain.epoch,
      nv: chain.networkVersion,
      headAge: chain.headAgeSeconds,
      bpe: signals.blocksPerEpoch ? signals.blocksPerEpoch.value : null,
    };
  }

  // GET /api/v1/sp -> SP component for one target. Null when stale.
  function spFromV1(s, target) {
    if (s.stale) return null;
    const list = Array.isArray(s.targets) ? s.targets : [];
    const t = list.find(function (x) { return x.address === target; });
    if (!t) return { state: 'bad', text: 'Offline' };
    if (t.state === 'ok') return { state: 'ok', text: 'Operational' };
    if (t.state === 'watch') return { state: 'watch', text: 'Degraded' };
    return { state: 'bad', text: 'Offline' };
  }

  const api = {
    DEFAULT_API_BASE: DEFAULT_API_BASE,
    resolveApiBase: resolveApiBase,
    endpoints: endpoints,
    isV1: isV1,
    faucetFromV1: faucetFromV1,
    calixFromV1: calixFromV1,
    spFromV1: spFromV1,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlumblineApi = api;
})(typeof self !== 'undefined' ? self : this);
