import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, '.env');
const LOG_FILE = path.join(__dirname, 'cron.log');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Global in-memory state
const state = {
  status: 'checking', // 'healthy' | 'sleeping' | 'paused' | 'checking'
  currentAttempt: 1,
  lastResponseTimeMs: null,
  serverUptime: null,
  lastCheckTime: null,
  nextCheckEpochMs: null,
  totalSuccessCount: 0,
  totalFailCount: 0,
  logs: []
};

// Seed logs from existing cron.log if available
if (fs.existsSync(LOG_FILE)) {
  try {
    const existing = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    state.logs = existing.slice(-80);
  } catch {
    // Ignore error
  }
}

/**
 * Dynamically parse .env file so changes reflect live
 */
function getConfig() {
  const env = { ...process.env };

  if (fs.existsSync(ENV_PATH)) {
    try {
      const content = fs.readFileSync(ENV_PATH, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separatorIdx = trimmed.indexOf('=');
        if (separatorIdx !== -1) {
          const key = trimmed.slice(0, separatorIdx).trim();
          let value = trimmed.slice(separatorIdx + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          env[key] = value;
        }
      }
    } catch (err) {
      console.error(`[WARN] Failed reading .env: ${err.message}`);
    }
  }

  const parseBool = (val) => String(val).toLowerCase() === 'true' || val === '1';

  return {
    targetUrl: env.TARGET_URL || 'https://hired-be.sidhartht.online/api/v1/health',
    intervalMinutes: Math.max(1, parseFloat(env.INTERVAL_MINUTES) || 13),
    retryIntervalSeconds: Math.max(5, parseFloat(env.RETRY_INTERVAL_SECONDS) || 30),
    requestTimeoutMs: Math.max(5000, parseInt(env.REQUEST_TIMEOUT_MS, 10) || 35000),
    enable24x7: parseBool(env.ENABLE_24_7),
    pauseStartHour: parseInt(env.PAUSE_START_HOUR, 10) ?? 1,
    pauseEndHour: parseInt(env.PAUSE_END_HOUR, 10) ?? 5,
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    logToFile: parseBool(env.LOG_TO_FILE ?? 'true'),
    port: parseInt(env.PORT, 10) || 3000
  };
}

/**
 * Update an environment variable inside .env safely
 */
function updateEnvVar(key, value) {
  try {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    process.env[key] = String(value);
    return true;
  } catch (err) {
    console.error(`[ERROR] Failed updating .env: ${err.message}`);
    return false;
  }
}

function getTimestamp(timezone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

function log(message, config = getConfig()) {
  const timestamp = getTimestamp(config.timezone);
  const logLine = `[${timestamp} ${config.timezone}] ${message}`;
  console.log(logLine);

  state.logs.push(logLine);
  if (state.logs.length > 200) state.logs.shift();

  if (config.logToFile) {
    try {
      fs.appendFileSync(LOG_FILE, logLine + '\n', 'utf-8');
    } catch {
      // Ignore
    }
  }
}

function isOffHours(config) {
  if (config.enable24x7) return false;

  let currentHour;
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      hour: 'numeric',
      hourCycle: 'h23'
    }).format(new Date());
    currentHour = parseInt(hourStr, 10);
  } catch {
    currentHour = new Date().getHours();
  }

  const { pauseStartHour, pauseEndHour } = config;
  if (pauseStartHour === pauseEndHour) return false;

  if (pauseStartHour < pauseEndHour) {
    return currentHour >= pauseStartHour && currentHour < pauseEndHour;
  } else {
    return currentHour >= pauseStartHour || currentHour < pauseEndHour;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let isCheckRunning = false;

/**
 * Execute health check and retry loop
 */
async function runHealthCheckCycle() {
  if (isCheckRunning) return;
  isCheckRunning = true;

  const config = getConfig();

  if (isOffHours(config)) {
    state.status = 'paused';
    state.lastCheckTime = getTimestamp(config.timezone);
    log(
      `[OFF-HOURS] Paused: Current time falls within off-hours (${config.pauseStartHour}:00 - ${config.pauseEndHour}:00 in ${config.timezone}). Skipping ping.`,
      config
    );
    state.nextCheckEpochMs = Date.now() + config.intervalMinutes * 60 * 1000;
    isCheckRunning = false;
    return;
  }

  state.status = 'checking';
  log(`[CYCLE START] Pinging ${config.targetUrl} (Mode: ${config.enable24x7 ? '24/7 Active' : 'Off-Hours Scheduled'})...`, config);

  let attempt = 1;
  while (true) {
    state.currentAttempt = attempt;
    const startTime = Date.now();
    try {
      const response = await fetch(config.targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'RenderHealthBot/1.0 (+keep-alive)',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });

      const durationMs = Date.now() - startTime;
      state.lastResponseTimeMs = durationMs;
      state.lastCheckTime = getTimestamp(config.timezone);

      if (response.ok) {
        let json = null;
        try {
          json = await response.json();
        } catch {
          // Non-JSON
        }

        const isSuccess = json ? (json.success === true || json.data?.status === 'ok') : true;

        if (isSuccess) {
          state.status = 'healthy';
          state.totalSuccessCount++;
          if (json?.data?.uptime) {
            state.serverUptime = json.data.uptime;
          }
          const uptimeInfo = json?.data?.uptime ? ` (uptime: ${Math.round(json.data.uptime)}s)` : '';
          log(`[SUCCESS] Attempt #${attempt}: Server responded 200 OK in ${durationMs}ms${uptimeInfo}. Server is healthy!`, config);
          break; // Stop retry loop
        } else {
          state.status = 'sleeping';
          log(`[WARN] Attempt #${attempt}: Status 200 but payload unhealthy: ${JSON.stringify(json)}`, config);
        }
      } else {
        state.status = 'sleeping';
        log(`[SLEEPING] Attempt #${attempt}: HTTP ${response.status} ${response.statusText} (${durationMs}ms). Waiting for spin-up...`, config);
      }
    } catch (err) {
      state.status = 'sleeping';
      const durationMs = Date.now() - startTime;
      const errorMsg = err.name === 'TimeoutError' ? 'Request timed out' : err.message;
      log(`[SLEEPING] Attempt #${attempt}: Ping failed (${errorMsg}) after ${durationMs}ms. Waiting for spin-up...`, config);
    }

    state.totalFailCount++;
    log(`[RETRY] Retrying in ${config.retryIntervalSeconds}s...`, config);
    await sleep(config.retryIntervalSeconds * 1000);
    attempt++;
  }

  state.nextCheckEpochMs = Date.now() + config.intervalMinutes * 60 * 1000;
  log(`[CYCLE COMPLETE] Verified healthy. Next cycle in ${config.intervalMinutes} minutes.\n`, config);
  isCheckRunning = false;
}

/**
 * Background scheduler daemon loop
 */
async function startDaemonLoop() {
  while (true) {
    await runHealthCheckCycle();
    const config = getConfig();
    const waitMs = config.intervalMinutes * 60 * 1000;
    state.nextCheckEpochMs = Date.now() + waitMs;
    await sleep(waitMs);
  }
}

/**
 * HTTP Server for Dashboard & REST APIs
 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Helper to send JSON
  const sendJson = (statusCode, obj) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(obj));
  };

  // Serve Dashboard HTML
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Dashboard HTML not found.');
    }
  }

  // API: Status
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const config = getConfig();
    return sendJson(200, {
      ...state,
      targetUrl: config.targetUrl,
      intervalMinutes: config.intervalMinutes,
      retryIntervalSeconds: config.retryIntervalSeconds,
      enable24x7: config.enable24x7,
      pauseStartHour: config.pauseStartHour,
      pauseEndHour: config.pauseEndHour,
      timezone: config.timezone
    });
  }

  // API: Logs
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return sendJson(200, { logs: state.logs });
  }

  // API: Toggle 24/7 Mode
  if (req.method === 'POST' && url.pathname === '/api/toggle-24-7') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const enable = !!parsed.enable24x7;
        updateEnvVar('ENABLE_24_7', enable ? 'true' : 'false');
        log(`[CONFIG] 24/7 Mode toggled to: ${enable ? 'ENABLED (Always Active)' : 'DISABLED (Off-Hours Scheduled)'}`);
        return sendJson(200, { success: true, enable24x7: enable });
      } catch (err) {
        return sendJson(400, { error: err.message });
      }
    });
    return;
  }

  // API: Ping Server Now
  if (req.method === 'POST' && url.pathname === '/api/ping-now') {
    log(`[MANUAL TRIGGER] Instant ping requested via Dashboard UI.`);
    runHealthCheckCycle().catch(err => console.error(err));
    return sendJson(200, { success: true, message: 'Health check cycle triggered' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Start Server & Daemon
const initialConfig = getConfig();
const PORT = initialConfig.port;

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(70));
  console.log('   RENDER KEEP-ALIVE MONITOR & WEB DASHBOARD');
  console.log('='.repeat(70));
  console.log(` Web Dashboard UI   : http://localhost:${PORT}`);
  console.log(` Target Endpoint    : ${initialConfig.targetUrl}`);
  console.log(` Interval           : Every ${initialConfig.intervalMinutes} min`);
  console.log(` Retry Delay        : Every ${initialConfig.retryIntervalSeconds} sec`);
  console.log(` 24/7 Mode          : ${initialConfig.enable24x7 ? 'Active' : 'Off-Hours Scheduled'}`);
  console.log(` Off-Hours Window   : ${initialConfig.pauseStartHour}:00 - ${initialConfig.pauseEndHour}:00 (${initialConfig.timezone})`);
  console.log('='.repeat(70));
  console.log(`Open http://localhost:${PORT} in your browser to view live logs!\n`);

  // Start background monitoring daemon
  startDaemonLoop();
});
