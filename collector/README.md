# Plumbline uptime collector

Small stdlib-only Python probe. Runs on the same box that serves
`status.reiers.io`, hits the public health endpoints on faucet + calix +
SP roster once every 5 minutes, and rebuilds `uptime.json` for the
frontend.

**Layout on the box:**

- `/opt/plumbline-monitor/collector/plumbline_uptime.py`: the probe
- `/var/lib/plumbline-monitor/probes-<component>.jsonl`: raw probe log
- `/var/lib/plumbline-monitor/uptime.json`: aggregated 90-day summary
- nginx serves it at `/uptime.json` through an `alias` (see below)
- systemd: `plumbline-uptime.service` + `plumbline-uptime.timer`,
  running as user `plumbline-monitor`

**Install:**

```bash
# One-time, from the checkout at /opt/plumbline-monitor
cd /opt/plumbline-monitor
sudo useradd --system --home-dir /var/lib/plumbline-monitor \
     --create-home --shell /usr/sbin/nologin plumbline-monitor
sudo chmod 755 /var/lib/plumbline-monitor   # nginx must read uptime.json
sudo cp collector/plumbline-uptime.service \
        collector/plumbline-uptime.timer  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plumbline-uptime.timer

# Verify
sudo -u plumbline-monitor python3 /opt/plumbline-monitor/collector/plumbline_uptime.py
sudo cat /var/lib/plumbline-monitor/uptime.json | jq '.components | keys'
```

**Nginx** serves `/uptime.json` from `/var/lib/plumbline-monitor/` via an
`alias` in the vhost, see `deploy/plumbline-monitor.nginx`.

**States** per calendar day (UTC):

- `ok`: 100% of probes succeeded
- `watch`: >= 95% succeeded
- `bad`: < 95% succeeded
- `nodata`: no probes recorded that day

Adjust thresholds via env: `PLUMBLINE_WATCH_THRESHOLD=0.99` etc.

**Probe targets** default to the canonical public URLs. Override with
`PLUMBLINE_FAUCET_URL`, `PLUMBLINE_CALIX_URL` and `PLUMBLINE_SP_URL`
(full URLs) when running against a staging or rebuilt host:

```bash
sudo systemctl edit plumbline-uptime.service
# [Service]
# Environment=PLUMBLINE_FAUCET_URL=https://faucet.example.org/healthz
```

**Known artifact:** for about 10 seconds after Calix restarts, its
miner-status endpoint reports the SP as down while its cache warms. A
probe that lands in that window records one SP failure. Restart Calix
right after a probe (`systemctl list-timers plumbline-uptime.timer`).

**Not covered here:**

- Drip-latency p99 measurement (that's the faucet's own `/metrics`)
- nv-validation latency (calix's own audit surface)
- Long-term historical archival: beyond 90 days probes are trimmed.
  Monthly reports at `Reiers/plumbline/reports/` are the durable record.
