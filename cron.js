import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, '.env');
const LOG_FILE = path.join(__dirname, 'cron.log');

/**
 * Dynamically parse .env file so changes (like ENABLE_24_7=true)
 * take effect immediately on each cycle without needing a restart.
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
          // Remove surrounding quotes if present
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
      console.error(`[WARN] Failed reading .env file: ${err.message}`);
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
    logToFile: parseBool(env.LOG_TO_FILE ?? 'true')
  };
}

/**
 * Get current time string formatted for console and logs
 */
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

/**
 * Formatted logger writing to console and optionally to cron.log
 */
function log(message, config = getConfig()) {
  const timestamp = getTimestamp(config.timezone);
  const logLine = `[${timestamp} ${config.timezone}] ${message}`;
  console.log(logLine);

  if (config.logToFile) {
    try {
      fs.appendFileSync(LOG_FILE, logLine + '\n', 'utf-8');
    } catch {
      // Ignore file writing errors
    }
  }
}

/**
 * Check if the current time falls inside the configured off-hours
 */
function isOffHours(config) {
  if (config.enable24x7) {
    return false; // 24/7 is enabled, never pause
  }

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

  if (pauseStartHour === pauseEndHour) {
    return false;
  }

  if (pauseStartHour < pauseEndHour) {
    return currentHour >= pauseStartHour && currentHour < pauseEndHour;
  } else {
    // Spans across midnight, e.g., 23:00 to 05:00
    return currentHour >= pauseStartHour || currentHour < pauseEndHour;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a single ping and retry loop until server responds with 200 OK
 */
async function runHealthCheckCycle() {
  const config = getConfig();

  // 1. Check if we should pause during quiet hours
  if (isOffHours(config)) {
    log(
      `[OFF-HOURS] Paused: Current time falls within off-hours (${config.pauseStartHour}:00 - ${config.pauseEndHour}:00 in ${config.timezone}). ` +
      `Set ENABLE_24_7=true in .env to run 24/7. Skipping ping.`,
      config
    );
    return;
  }

  log(`[CYCLE START] Pinging ${config.targetUrl} (Mode: ${config.enable24x7 ? '24/7 Active' : 'Off-Hours Scheduled'})...`, config);

  let attempt = 1;
  while (true) {
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

      if (response.ok) {
        let json = null;
        try {
          json = await response.json();
        } catch {
          // Non-JSON 200 response
        }

        const isSuccess = json ? (json.success === true || json.data?.status === 'ok') : true;

        if (isSuccess) {
          const uptimeInfo = json?.data?.uptime ? ` (uptime: ${Math.round(json.data.uptime)}s)` : '';
          log(`[SUCCESS] Attempt #${attempt}: Server responded 200 OK in ${durationMs}ms${uptimeInfo}. Server is healthy!`, config);
          break; // Server awake, stop retry loop
        } else {
          log(`[WARN] Attempt #${attempt}: Received HTTP 200 but payload indicated unhealthy: ${JSON.stringify(json)}`, config);
        }
      } else {
        log(`[SLEEPING] Attempt #${attempt}: Server responded with HTTP ${response.status} ${response.statusText} in ${durationMs}ms. Waiting for spin-up...`, config);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err.name === 'TimeoutError' ? 'Request timed out' : err.message;
      log(`[SLEEPING] Attempt #${attempt}: Request failed (${errorMsg}) after ${durationMs}ms. Server may be spinning up...`, config);
    }

    log(`[RETRY] Retrying in ${config.retryIntervalSeconds}s...`, config);
    await sleep(config.retryIntervalSeconds * 1000);
    attempt++;
  }

  log(`[CYCLE COMPLETE] Verified healthy. Next cycle in ${config.intervalMinutes} minutes.\n`, config);
}

/**
 * Main daemon loop
 */
async function main() {
  const initialConfig = getConfig();
  console.log('='.repeat(70));
  console.log('   RENDER BACKEND HEALTH MONITOR & KEEP-ALIVE CRON');
  console.log('='.repeat(70));
  console.log(` Target Endpoint     : ${initialConfig.targetUrl}`);
  console.log(` Check Cadence       : Every ${initialConfig.intervalMinutes} minutes`);
  console.log(` Wake-up Retry Delay : Every ${initialConfig.retryIntervalSeconds} seconds`);
  console.log(` 24/7 Mode Active    : ${initialConfig.enable24x7 ? 'YES' : 'NO (Pauses during off-hours)'}`);
  console.log(` Off-Hours Window    : ${initialConfig.pauseStartHour}:00 to ${initialConfig.pauseEndHour}:00 (${initialConfig.timezone})`);
  console.log(` Log to File         : ${initialConfig.logToFile ? LOG_FILE : 'Disabled'}`);
  console.log('='.repeat(70));
  console.log('TIP: You can change ENABLE_24_7=true in .env anytime; it will update live!\n');

  // Handle CLI argument '--once' for testing single execution
  if (process.argv.includes('--once')) {
    console.log('[INFO] Running single check (--once mode)...');
    await runHealthCheckCycle();
    return;
  }

  // Graceful shutdown
  const handleExit = () => {
    console.log('\n[INFO] Gracefully shutting down health cron...');
    process.exit(0);
  };
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  // Continuous loop
  while (true) {
    await runHealthCheckCycle();
    const currentConfig = getConfig();
    const waitMs = currentConfig.intervalMinutes * 60 * 1000;
    await sleep(waitMs);
  }
}

main().catch((err) => {
  console.error('[FATAL ERROR]', err);
  process.exit(1);
});
