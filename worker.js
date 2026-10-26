/**
 * HireD Backend Keep-Alive Cloudflare Worker
 * Pings https://hired-be.sidhartht.online/api/v1/health every 13 minutes
 * Retries every 30 seconds when sleeping until 200 OK is returned
 */

let lastResult = {
  status: "healthy",
  lastCheckTime: null,
  latencyMs: null,
  uptime: null,
  attempts: 0,
  message: "Worker deployed. Awaiting first scheduled run or manual ping."
};

const CONFIG = {
  targetUrl: "https://hired-be.sidhartht.online/api/v1/health",
  retryDelayMs: 30000, // 30s retry delay
  maxRetries: 8,       // Retries if server stays unresponsive
  pauseStartHour: 1,   // 01:00 AM off-hours
  pauseEndHour: 5,     // 05:00 AM off-hours
  timezone: "Asia/Kolkata",
  enable24x7: false
};

function isOffHours(config) {
  if (config.enable24x7) return false;
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour: "numeric",
      hourCycle: "h23"
    }).format(new Date());
    const currentHour = parseInt(hourStr, 10);
    return currentHour >= config.pauseStartHour && currentHour < config.pauseEndHour;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performHealthCheck(env) {
  const cfg = {
    ...CONFIG,
    enable24x7: env?.ENABLE_24_7 === "true" || CONFIG.enable24x7
  };

  const now = new Date().toLocaleString("en-GB", { timeZone: cfg.timezone });

  if (isOffHours(cfg)) {
    lastResult = {
      status: "paused",
      lastCheckTime: now,
      latencyMs: null,
      uptime: null,
      attempts: 0,
      message: `Off-hours active (${cfg.pauseStartHour}:00 - ${cfg.pauseEndHour}:00 ${cfg.timezone}). Ping skipped.`
    };
    console.log(`[OFF-HOURS] ${lastResult.message}`);
    return lastResult;
  }

  let attempt = 1;
  while (attempt <= cfg.maxRetries) {
    const startTime = Date.now();
    try {
      console.log(`[CYCLE] Attempt #${attempt}: Pinging ${cfg.targetUrl}...`);
      const response = await fetch(cfg.targetUrl, {
        method: "GET",
        headers: { "User-Agent": "CloudflareKeepAliveBot/1.0" }
      });

      const durationMs = Date.now() - startTime;

      if (response.ok) {
        let json = null;
        try { json = await response.json(); } catch {}

        const isSuccess = json ? (json.success === true || json.data?.status === "ok") : true;

        if (isSuccess) {
          lastResult = {
            status: "healthy",
            lastCheckTime: now,
            latencyMs: durationMs,
            uptime: json?.data?.uptime || null,
            attempts: attempt,
            message: `Server responded 200 OK in ${durationMs}ms. Backend is awake and healthy!`
          };
          console.log(`[SUCCESS] ${lastResult.message}`);
          return lastResult;
        }
      }

      console.log(`[SLEEPING] Attempt #${attempt}: Server returned HTTP ${response.status}. Retrying in 30s...`);
    } catch (err) {
      console.log(`[SLEEPING] Attempt #${attempt}: Request failed (${err.message}). Retrying in 30s...`);
    }

    if (attempt < cfg.maxRetries) {
      await sleep(cfg.retryDelayMs);
    }
    attempt++;
  }

  lastResult = {
    status: "failed",
    lastCheckTime: now,
    latencyMs: null,
    uptime: null,
    attempts: attempt - 1,
    message: `Server did not respond with 200 OK after ${cfg.maxRetries} attempts.`
  };
  return lastResult;
}

export default {
  // Triggered automatically by Cloudflare's Cron Trigger every 13 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(performHealthCheck(env));
  },

  // Serves the Web Dashboard UI and API endpoints
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ping") {
      const res = await performHealthCheck(env);
      return new Response(JSON.stringify(res), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname === "/api/status") {
      return new Response(JSON.stringify(lastResult), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HireD Keep-Alive Monitor</title>
  <style>
    body { background: #0b0f19; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px 16px; margin: 0; display: flex; justify-content: center; }
    .card { background: #111827; border: 1px solid #1f293d; border-radius: 14px; max-width: 650px; width: 100%; padding: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
    h1 { font-size: 22px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
    .badge { display: inline-block; padding: 5px 14px; border-radius: 20px; font-weight: 700; font-size: 13px; margin: 16px 0; }
    .badge-healthy { background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
    .badge-sleeping { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
    .badge-paused { background: rgba(59,130,246,0.15); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3); }
    .meta { background: #050811; border: 1px solid #1f293d; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; line-height: 1.8; margin-bottom: 20px; }
    .btn { background: #2563eb; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; transition: background 0.2s; }
    .btn:hover { background: #1d4ed8; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    a { color: #38bdf8; text-decoration: none; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ HireD Backend Keep-Alive</h1>
    <div style="font-size: 13px; color: #9ca3af; margin-bottom: 12px;">Cloudflare Worker • Active 24/7 in Cloud</div>
    <div>Target: <a href="${CONFIG.targetUrl}" target="_blank">${CONFIG.targetUrl}</a></div>

    <div id="badge" class="badge badge-healthy">${lastResult.status.toUpperCase()}</div>

    <div class="meta" id="details">
      <div>Status Message : <b>${lastResult.message}</b></div>
      <div>Last Check    : ${lastResult.lastCheckTime || 'Pending first cron run'}</div>
      <div>Latency       : ${lastResult.latencyMs ? lastResult.latencyMs + 'ms' : '--'}</div>
      <div>Uptime        : ${lastResult.uptime ? Math.round(lastResult.uptime) + 's' : '--'}</div>
      <div>Attempts      : ${lastResult.attempts}</div>
      <div>Schedule      : Every 13 minutes (retry every 30s when sleeping)</div>
    </div>

    <button class="btn" id="pingBtn" onclick="triggerPing()">⚡ Ping Server Now</button>
  </div>

  <script>
    async function triggerPing() {
      const btn = document.getElementById('pingBtn');
      btn.disabled = true;
      btn.innerText = '⏳ Pinging server...';
      try {
        const res = await fetch('/api/ping');
        const data = await res.json();
        document.getElementById('details').innerHTML =
          '<div>Status Message : <b>' + data.message + '</b></div>' +
          '<div>Last Check    : ' + data.lastCheckTime + '</div>' +
          '<div>Latency       : ' + (data.latencyMs ? data.latencyMs + 'ms' : '--') + '</div>' +
          '<div>Uptime        : ' + (data.uptime ? Math.round(data.uptime) + 's' : '--') + '</div>' +
          '<div>Attempts      : ' + data.attempts + '</div>' +
          '<div>Schedule      : Every 13 minutes (retry every 30s when sleeping)</div>';
        
        const badge = document.getElementById('badge');
        badge.className = 'badge ' + (data.status === 'healthy' ? 'badge-healthy' : 'badge-sleeping');
        badge.innerText = data.status.toUpperCase();
      } catch (e) {
        alert('Ping error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '⚡ Ping Server Now';
      }
    }
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};
