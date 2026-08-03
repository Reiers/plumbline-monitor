#!/usr/bin/env python3
"""
Plumbline uptime collector.

Probes the public endpoints of the Plumbline surface every N minutes,
appends each probe to a per-component JSONL log at
  /var/lib/plumbline-monitor/probes-<component>.jsonl
and rebuilds the aggregated 90-day summary at
  /var/lib/plumbline-monitor/uptime.json

The nginx vhost for status.reiers.io serves the aggregate at
  https://status.reiers.io/uptime.json

Components probed:
  faucet - GET /healthz on faucet.reiers.io    (want {"ok":true})
  calix  - GET /api/v1/health on calix.reiers.io (want {"ok":true})
  sp     - GET /api/v1/miners/status?addrs=t0143103 on calix (want status=active)

State bucketing per day:
  ok    - 100% of probes succeeded on that day
  watch - >= 95% succeeded (drip latency / degraded)
  bad   - <  95% succeeded
  nodata- no probes recorded that day (collector was down, day is in
          the future, or day is >90 days old)

Runs standalone, stdlib only. No third-party deps. Safe to run under
systemd timer as a low-privilege user.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


COMPONENTS = ("faucet", "calix", "sp")

# Probe definitions. Each returns "ok" / "bad".
PROBES = {
    "faucet": {
        "url": "https://faucet.reiers.io/healthz",
        "timeout": 8,
    },
    "calix": {
        "url": "https://calix.reiers.io/api/v1/health",
        "timeout": 8,
    },
    "sp": {
        "url": "https://calix.reiers.io/api/v1/miners/status?addrs=t0143103",
        "timeout": 8,
    },
}

DATA_DIR = Path(os.environ.get("PLUMBLINE_MONITOR_DIR", "/var/lib/plumbline-monitor"))
WINDOW_DAYS = int(os.environ.get("PLUMBLINE_WINDOW_DAYS", "90"))
WATCH_THRESHOLD = float(os.environ.get("PLUMBLINE_WATCH_THRESHOLD", "0.95"))


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def today_iso() -> str:
    return utcnow().date().isoformat()


def probe_faucet() -> tuple[bool, str]:
    return _probe_json(PROBES["faucet"], lambda j: j.get("ok") is True)


def probe_calix() -> tuple[bool, str]:
    return _probe_json(PROBES["calix"], lambda j: j.get("ok") is True)


def probe_sp() -> tuple[bool, str]:
    def check(j: dict[str, Any]) -> bool:
        miners = j.get("miners") or []
        for m in miners:
            if (m.get("address") or m.get("id")) == "t0143103":
                status = str(m.get("status", "")).lower()
                return status in ("active", "ok")
        return False
    return _probe_json(PROBES["sp"], check)


PROBE_FN = {"faucet": probe_faucet, "calix": probe_calix, "sp": probe_sp}


def _probe_json(spec, ok_check) -> tuple[bool, str]:
    """Return (ok, reason)."""
    url = spec["url"]
    timeout = spec["timeout"]
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "plumbline-uptime-collector/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            code = resp.status
            body = resp.read(200_000).decode("utf-8", errors="replace")
            if code != 200:
                return False, f"HTTP {code}"
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                return False, "invalid JSON"
            if ok_check(payload):
                return True, "ok"
            return False, "predicate failed"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, f"URL error: {e.reason}"
    except TimeoutError:
        return False, "timeout"
    except Exception as e:
        return False, f"error: {e.__class__.__name__}"


# --- storage --------------------------------------------------------------


def probe_log_path(comp: str) -> Path:
    return DATA_DIR / f"probes-{comp}.jsonl"


def uptime_json_path() -> Path:
    return DATA_DIR / "uptime.json"


def append_probe(comp: str, ok: bool, reason: str) -> None:
    line = {
        "ts": int(time.time()),
        "iso": utcnow().isoformat(timespec="seconds"),
        "ok": ok,
        "reason": reason,
    }
    with probe_log_path(comp).open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, separators=(",", ":")) + "\n")


def load_probes(comp: str, since_ts: int) -> list[dict]:
    path = probe_log_path(comp)
    if not path.exists():
        return []
    out: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
            except json.JSONDecodeError:
                continue
            if p.get("ts", 0) >= since_ts:
                out.append(p)
    return out


def trim_probes(comp: str, since_ts: int) -> None:
    """Drop probes older than the retention window to keep the file small."""
    path = probe_log_path(comp)
    if not path.exists():
        return
    keep: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                p = json.loads(s)
            except json.JSONDecodeError:
                continue
            if p.get("ts", 0) >= since_ts:
                keep.append(json.dumps(p, separators=(",", ":")))
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for line in keep:
            f.write(line + "\n")
    tmp.replace(path)


# --- aggregation ----------------------------------------------------------


def aggregate(comp: str, days: int) -> dict:
    now = utcnow()
    horizon_ts = int((now - dt.timedelta(days=days)).timestamp())
    probes = load_probes(comp, horizon_ts)

    # Bucket per calendar UTC day.
    by_day: dict[str, dict[str, int]] = {}
    for p in probes:
        day = dt.datetime.fromtimestamp(p["ts"], tz=dt.timezone.utc).date().isoformat()
        d = by_day.setdefault(day, {"ok": 0, "bad": 0})
        if p.get("ok"):
            d["ok"] += 1
        else:
            d["bad"] += 1

    out_days: list[dict] = []
    total_ok = 0
    total_probes = 0
    for i in range(days - 1, -1, -1):
        day = (now.date() - dt.timedelta(days=i)).isoformat()
        b = by_day.get(day)
        if not b:
            out_days.append({"date": day, "state": "nodata", "probes": 0})
            continue
        n = b["ok"] + b["bad"]
        up = b["ok"] / n if n > 0 else 0
        state = "ok" if up >= 1.0 else ("watch" if up >= WATCH_THRESHOLD else "bad")
        out_days.append({
            "date": day,
            "state": state,
            "probes": n,
            "uptime": round(up, 4),
            "incidents": b["bad"] if state != "ok" else 0,
        })
        total_ok += b["ok"]
        total_probes += n

    uptime_90d = round(total_ok / total_probes, 4) if total_probes else None

    return {
        "days": out_days,
        "uptime_90d": uptime_90d,
        "probes_window": total_probes,
    }


def build_uptime_json() -> dict:
    return {
        "generatedAt": utcnow().isoformat(timespec="seconds"),
        "window_days": WINDOW_DAYS,
        "components": {c: aggregate(c, WINDOW_DAYS) for c in COMPONENTS},
    }


def write_uptime_json(payload: dict) -> None:
    path = uptime_json_path()
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), sort_keys=False)
    tmp.replace(path)


# --- main -----------------------------------------------------------------


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Probe.
    for comp, fn in PROBE_FN.items():
        ok, reason = fn()
        append_probe(comp, ok, reason)

    # Trim + aggregate.
    horizon = int((utcnow() - dt.timedelta(days=WINDOW_DAYS + 1)).timestamp())
    for comp in COMPONENTS:
        trim_probes(comp, horizon)

    payload = build_uptime_json()
    write_uptime_json(payload)

    # Print a one-line summary for journalctl.
    parts = []
    for c, r in payload["components"].items():
        u = r.get("uptime_90d")
        parts.append(f"{c}={u * 100:.2f}%" if u is not None else f"{c}=n/a")
    print(f"[{utcnow().isoformat(timespec='seconds')}] " + " ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
