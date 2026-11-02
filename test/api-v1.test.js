// Tests for web/api-v1.js (builder API v1 -> status page view model).
// Fixtures in test/fixtures/ were captured from a local plumbline-faucet
// running the builder API v1 against the live Calix API.
// Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const api = require(path.join(__dirname, '..', 'web', 'api-v1.js'));
const fx = (n) => require(path.join(__dirname, 'fixtures', n));

test('fixtures are v1 responses', () => {
  for (const n of ['v1-faucet-status.json', 'v1-network.json', 'v1-sp.json']) {
    assert.equal(api.isV1(fx(n)), true, n);
  }
  assert.equal(api.isV1({ ok: true }), false);
  assert.equal(api.isV1({ apiVersion: '1', ok: false, error: 'upstream_unavailable' }), false);
});

test('faucet status maps state, balances and 24h counters', () => {
  const s = fx('v1-faucet-status.json');
  const m = api.faucetFromV1(s);
  // captured from a throwaway, unfunded dispenser: below reserve
  assert.equal(m.state, 'watch');
  assert.equal(m.text, 'Degraded: low reserve');
  assert.equal(m.filWei, s.assets.fil.balanceWei);
  assert.equal(m.usdfcWei, s.assets.usdfc.balanceWei);
  assert.equal(m.fil24, s.stats.drips24h.fil);
  const healthy = api.faucetFromV1({ ...s, state: 'ok', healthy: true, reasons: [] });
  assert.deepEqual([healthy.state, healthy.text], ['ok', 'Operational']);
  const down = api.faucetFromV1({ ...s, state: 'bad', rpcOk: false, reasons: ['rpc_unreachable'] });
  assert.deepEqual([down.state, down.text], ['bad', 'Major Outage']);
});

test('network maps Calix health and chain signals', () => {
  const n = fx('v1-network.json');
  const m = api.calixFromV1(n);
  assert.equal(m.state, n.state);
  assert.equal(m.epoch, n.chain.epoch);
  assert.equal(m.nv, n.chain.networkVersion);
  assert.equal(m.headAge, n.chain.headAgeSeconds);
  assert.equal(m.bpe, n.signals.blocksPerEpoch.value);
  assert.equal(api.calixFromV1({ ...n, stale: true }), null, 'stale -> caller falls back to Calix directly');
  const forked = api.calixFromV1({ ...n, state: 'bad', forked: true });
  assert.deepEqual([forked.state, forked.text], ['bad', 'Forked from canonical']);
  const lag = api.calixFromV1({ ...n, state: 'watch', level: 'operational', chain: { ...n.chain, headAgeSeconds: 900 } });
  assert.deepEqual([lag.state, lag.text], ['watch', 'Degraded: head lagging']);
});

test('sp maps the test target', () => {
  const s = fx('v1-sp.json');
  const m = api.spFromV1(s, 't0143103');
  assert.equal(m.state, s.targets[0].state);
  assert.deepEqual(api.spFromV1(s, 't0999999'), { state: 'bad', text: 'Offline' });
  assert.equal(api.spFromV1({ ...s, stale: true }, 't0143103'), null);
});

test('api base override only on localhost', () => {
  const loc = (hostname, search) => ({ hostname, search });
  assert.equal(api.resolveApiBase(loc('status.reiers.io', '?api=http://evil.example')), 'https://faucet.reiers.io');
  assert.equal(api.resolveApiBase(loc('127.0.0.1', '?api=http://127.0.0.1:18005/x')), 'http://127.0.0.1:18005');
  assert.equal(api.resolveApiBase(loc('localhost', '?api=javascript:alert(1)')), 'https://faucet.reiers.io');
  assert.equal(api.resolveApiBase(loc('localhost', '')), 'https://faucet.reiers.io');
  assert.equal(api.endpoints('https://faucet.reiers.io').network, 'https://faucet.reiers.io/api/v1/network');
});
