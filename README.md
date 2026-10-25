# CareWatch — real-connected fall detection dashboard

This project starts with a React + TypeScript + Vite frontend and a separate Node.js backend. It is designed to show **only backend/database data**. It does not create fake sensor readings or simulate a connected device.

## Architecture

`MPU6050 → ESP32 → MQTT broker (HiveMQ) → Node.js API → Supabase/PostgreSQL → React dashboard`

The Node backend subscribes to `elderly/fall/test`, validates incoming JSON, stores sensor readings and event alerts in Supabase, and streams updates to the browser using Server-Sent Events (SSE). The dashboard also polls the API every five seconds as a fallback. Alert acknowledgement/resolution is persisted in the database.

## Requirements

- Node.js 20+ (LTS recommended)
- A Supabase project
- An MQTT broker. The current configuration supports local MQTT such as `mqtt://localhost:1883` or a broker URL supplied by your environment.
- Hardware is not required to develop the software; until real messages arrive, the dashboard shows empty states/offline status.

## Step 1 — Create the database

1. Open your Supabase project.
2. Go to **SQL Editor → New query**.
3. Copy and run `supabase/schema.sql`.
4. In Supabase **Project Settings → API**, copy the Project URL and `service_role` key. Keep the service-role key private and only in `server/.env`.

The schema creates `sensor_readings` and `alerts`, enables RLS, and revokes direct browser access. The current Node backend uses its private service-role key. Authentication/guardian-specific authorization should be added before deploying to the public internet.

## Step 2 — Configure the backend

```bash
cd server
# Windows PowerShell:
Copy-Item .env.example .env
# macOS/Linux: cp .env.example .env
npm install
```

Edit `server/.env` and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and your MQTT connection details. For a local broker listening on port 1883, use `MQTT_URL=mqtt://localhost:1883`. If using HiveMQ Cloud, use its TLS connection URL and broker credentials from its console. Set `FRONTEND_ORIGIN=http://localhost:5173`.

Start the backend:

```bash
npm run dev
```

Verify `http://localhost:4000/api/health`. The response reports whether Supabase credentials are present and whether MQTT is connected. `supabaseConfigured: true` only means credentials are configured; verify actual database operations too.

## Step 3 — Start the React dashboard

Open a **second terminal** in the project root (`elderly-fall-dashboard`):

```bash
npm install
Copy-Item .env.example .env
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`). The frontend API base URL is configured in root `.env` as `VITE_API_BASE_URL=http://localhost:4000`.

## Step 4 — Test the MQTT-to-database pipeline

Publish a JSON message to the configured topic (`elderly/fall/test`) using MQTTX. Example sensor reading payload:

```json
{
  "device_id": "esp32_demo_01",
  "event": "sensor_reading",
  "ax": 0.03,
  "ay": -0.02,
  "az": 0.98,
  "gx": 1.2,
  "gy": -0.4,
  "gz": 0.8,
  "timestamp": "2026-10-24T05:00:00.000Z"
}
```

This is a **manual integration test message**, not a physical sensor reading. It should be labeled as a test at the point you test it; use `source: "test"` if your payload is a test. Real firmware should send values using a consistent unit convention and should not call an event a fall unless its detection logic has actually fired. To create an alert record, publish `{"device_id":"esp32_demo_01","event":"fall_detected","fall_detected":true,"alert":"Test only - simulated fall","source":"test"}`. Do not represent this test event as a genuine detected fall.

In MQTTX, confirm the broker connection and publish to exactly the topic configured in `server/.env`. Watch the backend terminal for MQTT connection or message validation errors. Then refresh the dashboard and check the sensor reading/event history in Supabase.

## API endpoints

- `GET /api/health` — API, configuration, MQTT connection and last-message health
- `GET /api/status` — device status and offline threshold
- `GET /api/readings?limit=50` — recent persisted sensor readings
- `GET /api/alerts` — persisted alerts/events
- `PATCH /api/alerts/:id` — acknowledge or resolve an alert (`{"status":"acknowledged"}` or `{"status":"resolved"}`)
- `POST /api/check-in` and `POST /api/help` — persist a check-in/help event
- `GET /api/stream` — SSE stream of new readings, alerts, and status

## Important limitations / before deployment

- This is a local college-project integration scaffold, not a production-ready medical or emergency-response service.
- The dashboard does not fabricate sensor values. If the backend is unavailable, it displays an error and no live data.
- The current backend marks a device online after a recent MQTT message and offline after the configured threshold; tune this based on the firmware's heartbeat interval.
- The current API does not yet implement guardian login. Do not expose the backend publicly until authentication, authorization, rate limiting, secure broker access, input hardening, and deployment secrets are configured.
- Do not put Supabase service-role keys or MQTT broker passwords in frontend `VITE_*` variables.
- SMS, phone calls, push notifications, and emergency services are not connected.
- MPU6050 thresholds alone are not medically validated fall detection. Test and validate the detection algorithm separately.
