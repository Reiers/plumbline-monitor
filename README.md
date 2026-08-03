<div align="center">
  <a href="https://github.com/Reiers/plumbline">
    <img src="https://raw.githubusercontent.com/Reiers/plumbline/main/brand/banner.png" alt="Plumbline — public status page" />
  </a>
</div>

# plumbline-monitor

Public status page for the [Plumbline](https://github.com/Reiers/plumbline)
Filecoin Calibration stability surface. Live at
**<https://status.reiers.io>**.

Statuspage-style layout (banner, 90-day uptime bars per component,
grouped services). Reports live compliance against the commitments in
[Plumbline's SLO.md](https://github.com/Reiers/plumbline/blob/main/SLO.md).

---

## What this is

Two moving parts:

1. **Static frontend** in [`web/`](./web/) — vanilla HTML/CSS/JS, no
   build step. Rendered client-side, polls public HTTPS endpoints.
2. **Uptime collector** in [`collector/`](./collector/) — small
   stdlib-only Python probe. Runs on the same host, hits the health
   endpoints every 5 minutes, aggregates to a per-day 90-day summary
   at `/uptime.json`.

**Covered services:**

- **Plumbline Faucet** (<https://faucet.reiers.io>) — tFIL + USDFC drip
  for Calibration
- **Calix** (<https://calix.reiers.io>) — Calibration chain-health
  console + nv-upgrade validation
- **SP test target** — `t0143103` on Calibration

**What the page shows:**

- Top status banner: `All Systems Operational` / `Degraded` / `Major Outage`
- Grouped uptime bars per component, 90 vertical bars (one per day)
  coloured by state: green (ok) / amber (watch, ≥95%) / red (bad) / grey (nodata)
- Live signals grid: head epoch, head age, network version, blocks/epoch,
  faucet balances, drips-today counters
- Legend + machine-readable links (`/metrics`)

---

## Deploy

Static files + a systemd timer for the collector. Canonical deployment
is nginx on the Plumbline production box, serving `status.reiers.io`
behind Cloudflare (orange cloud).

```bash
# Frontend
git clone https://github.com/Reiers/plumbline-monitor /opt/plumbline-monitor
sudo ln -sf /opt/plumbline-monitor/deploy/plumbline-monitor.nginx \
  /etc/nginx/sites-enabled/status.reiers.io
sudo nginx -t && sudo systemctl reload nginx

# Collector
sudo useradd --system --home-dir /var/lib/plumbline-monitor \
     --create-home --shell /usr/sbin/nologin plumbline-monitor
sudo cp collector/plumbline-uptime.service \
        collector/plumbline-uptime.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plumbline-uptime.timer
```

To deploy an update:

```bash
cd /opt/plumbline-monitor && git pull
# nginx serves web/ directly, no reload needed
# collector timer picks up the new probe script on next fire
```

See [`collector/README.md`](./collector/README.md) for probe internals
and state thresholds.

---

## Local development

```bash
git clone https://github.com/Reiers/plumbline-monitor
cd plumbline-monitor
python3 -m http.server 8080 --directory web
# open http://localhost:8080
```

Uptime bars will show `nodata` because there's no `uptime.json` locally.
That's fine for iterating on the layout.

---

## Design principles

1. **Static + probe.** Frontend has zero server state; collector is a
   30-line-of-logic Python probe.
2. **Public endpoints only.** Never scrape private admin surfaces.
3. **Honest about staleness.** Missing days render as grey `nodata`,
   not fake green.
4. **Match the SLO.** Every panel maps to a named SLO or SLI in
   [`Reiers/plumbline/SLO.md`](https://github.com/Reiers/plumbline/blob/main/SLO.md).

---

## License

MIT. See [LICENSE](./LICENSE).

## Operating organization

**TSE Reiersen** · Org. 929 074 912 (Norwegian enterprise registry)
