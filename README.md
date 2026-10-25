# Render Backend Keep-Alive Monitor & Web Dashboard

An all-in-one automated keep-alive daemon and interactive web dashboard for monitoring Render free-tier backends.

* **Target URL:** `https://hired-be.sidhartht.online/api/v1/health`
* **Ping Cadence:** Every **13 minutes** (Render sleeps after 15 minutes of inactivity).
* **Wake-Up Retry Loop:** If the server is sleeping or spinning up, retries every **30 seconds** until a `200 OK` success report is received, then resumes the 13-minute schedule.
* **Web Dashboard:** Interactive real-time web UI showing live status, response latency, uptime, next ping countdown, interactive 24/7 toggle switch, and live terminal logs.
* **Zero Dependencies:** Pure native Node.js (uses built-in `node:http`, `fetch`, and timers).

---

## Live Dashboard

Open in your browser:
```
http://localhost:3000
```

### Dashboard Features:
1. **Live Server Status:** Shows whether the backend is `🟢 Healthy & Awake`, `🟡 Spinning Up (Attempt #X)`, or `⏸️ Paused (Off-Hours)`.
2. **Next Ping Countdown:** Real-time timer counting down to the next 13-minute cycle.
3. **Interactive 24/7 Toggle:** A clickable switch on the page to toggle between Off-Hours Mode and 24/7 Mode without touching code.
4. **Instant Ping Trigger:** A `⚡ Ping Server Now` button to trigger an immediate check.
5. **Live Terminal Logs:** Auto-scrolling terminal showing real-time ping attempts, responses, and wake-up logs.

---

## Running Locally

### Start Server & Dashboard:
```bash
npm start
# or: node server.js
```

### Run in Background with PM2:
```bash
npm run pm2:start    # Starts in background
npm run pm2:logs     # Shows live logs
npm run pm2:stop     # Stops background worker
```

---

## Free Cloud Deployment (PC Turned Off)

To keep this monitor and dashboard running **24/7 even when your computer is turned off**, deploy this folder to a free cloud hosting service:

### Option 1: Render (Free Web Service)
1. Push this folder to a GitHub repository.
2. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Web Service**.
3. Connect your GitHub repository.
4. Set:
   * **Runtime:** `Node`
   * **Build Command:** *(leave empty)*
   * **Start Command:** `npm start`
5. Click **Deploy Web Service**.
6. Render will assign you a free public URL (e.g., `https://hired-monitor.onrender.com`). You can open your dashboard from your phone or any computer!

### Option 2: Koyeb or Railway
1. Connect your GitHub repository.
2. Build & Start command is automatically detected from `package.json` (`npm start`).
3. Deploy for free.

---

## Configuration (`.env`)

You can edit settings in `.env` or toggle 24/7 mode directly from the Web Dashboard UI:

```ini
TARGET_URL=https://hired-be.sidhartht.online/api/v1/health
INTERVAL_MINUTES=13
RETRY_INTERVAL_SECONDS=30
REQUEST_TIMEOUT_MS=35000

# Set to true for 24/7 continuous operation, or false to pause during off-hours
ENABLE_24_7=false

# Off-hours window (24-hour format: 1 = 01:00 AM, 5 = 05:00 AM)
PAUSE_START_HOUR=1
PAUSE_END_HOUR=5

TIMEZONE=Asia/Kolkata
PORT=3000
LOG_TO_FILE=true
```
