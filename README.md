<div align="center">
  <a href="https://github.com/Reiers/plumbline">
    <img src="https://raw.githubusercontent.com/Reiers/plumbline/main/brand/banner.png" alt="Plumbline — public status page" />
  </a>
</div>

# plumbline-monitor

Public status page for the [Plumbline](https://github.com/Reiers/plumbline)
Filecoin Calibration stability surface. Live at
**<https://status.reiers.io>**.

Reports live compliance against the commitments in
[Plumbline's SLO.md](https://github.com/Reiers/plumbline/blob/main/SLO.md).

---

## What this is

A single-page static status dashboard that polls the public endpoints of
each Plumbline service and shows current health, current SLO compliance,
and recent activity. Zero backend, zero secrets — everything runs
client-side against public HTTPS endpoints.

**Covered services:**

- **Plumbline Faucet** (<https://faucet.reiers.io>) — tFIL + USDFC drip
  for Calibration
- **Calix** (<https://calix.reiers.io>) — Calibration chain-health
  console + nv-upgrade validation
- **SP test targets** — `t0143103`, `t0144416`

**What it shows:**

- Overall operational pill (OPERATIONAL / WATCH / DEGRADED)
- Per-service health tiles with current SLI values
- SLO summary: current status vs the targets in `SLO.md`
- Recent faucet drips (last 10) as an activity feed
- Calibration head epoch + network version + upgrade window

The page reads live from:

- `GET /healthz`, `/api/info`, `/api/stats`, `/api/recent` on the faucet
- `GET /api/v1/health`, `/api/v1/status`, `/api/v1/upgrade` on calix
- `GET /api/v1/miners/status` on calix (SP roster)

All endpoints are CORS-open, so the page renders anywhere without a
proxy.

---

## Design

Match the Calix aesthetic: dark background, calm greens, monospaced
numerals. Data-dense, no marketing copy. Every panel has one job:
answer "is this promise being kept, right now".

Panels update every 30 seconds. A single failed poll shows a soft
"stale" indicator without blanking the previous value.

---

## Deploy

Static files. Any web server that can serve HTML + CSS + JS with `Content-Type`
set correctly will work.

Canonical deployment is nginx on the Plumbline production box, served at
`status.reiers.io` behind Cloudflare (orange cloud). See
[`deploy/`](./deploy/) for the nginx vhost.

```bash
# On the production box:
git clone https://github.com/Reiers/plumbline-monitor /opt/plumbline-monitor
sudo ln -s /opt/plumbline-monitor/deploy/plumbline-monitor.nginx \
  /etc/nginx/sites-enabled/status.reiers.io
sudo nginx -t && sudo systemctl reload nginx
```

To deploy an update:

```bash
cd /opt/plumbline-monitor
git pull
# nginx serves ./web/ directly, no restart needed
```

---

## Local development

```bash
git clone https://github.com/Reiers/plumbline-monitor
cd plumbline-monitor
python3 -m http.server 8080 --directory web
# open http://localhost:8080
```

No build step, no dependencies. Editing HTML/CSS/JS in `web/` and
reloading the browser is the whole loop.

---

## Design principles

1. **Client-side only.** No backend. Cannot fail behind a bad deploy of
   its own — if it renders, the source of truth is the upstreams.
2. **Public endpoints only.** Never scrape private admin surfaces.
3. **Honest about staleness.** A missed poll is visible, not hidden.
4. **Match the SLO.** Every panel maps to a named SLO or SLI in
   [`Reiers/plumbline/SLO.md`](https://github.com/Reiers/plumbline/blob/main/SLO.md).
   If a metric isn't in the SLO, it doesn't belong on this page.

---

## License

MIT. See [LICENSE](./LICENSE).

## Operating organization

**TSE Reiersen** · Org. 929 074 912 (Norwegian enterprise registry)
