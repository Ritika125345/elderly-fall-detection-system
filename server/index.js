import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT || 4000);
const topic = process.env.MQTT_TOPIC || 'elderly/fall/test';
const deviceId = process.env.DEVICE_ID || 'esp32_demo_01';

const offlineAfter = Number(
  process.env.DEVICE_OFFLINE_AFTER_SECONDS || 45
);

app.use(
  cors({
    origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((value) => value.trim()),
  })
);

app.use(express.json({ limit: '32kb' }));

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const hasSupabase = Boolean(supabaseUrl && supabaseKey);

const supabase = hasSupabase
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

let mqttClient = null;
let lastMessageAt = null;
let mqttConnected = false;

const clients = new Set();

function publish(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of clients) {
    if (!res.writableEnded) {
      res.write(payload);
    }
  }
}

function isoNow() {
  return new Date().toISOString();
}

// Log errors without exposing credentials.
function logError(label, error) {
  console.error(label, {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    details: error?.details,
    hint: error?.hint,
    cause: error?.cause
      ? {
          name: error.cause.name,
          message: error.cause.message,
          code: error.cause.code,
        }
      : undefined,
  });
}

function errorResponse(res, error, fallback = 'Request failed') {
  logError(fallback, error);

  return res.status(500).json({
    error: error?.message || fallback,
    cause: error?.cause?.code || error?.cause?.message || null,
  });
}

function validateMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Message must be a JSON object');
  }

  const id = String(raw.device_id || deviceId).slice(0, 100);

  const event =
    raw.event == null
      ? 'sensor_reading'
      : String(raw.event).slice(0, 80);

  const timestamp =
    raw.timestamp && !Number.isNaN(Date.parse(raw.timestamp))
      ? new Date(raw.timestamp).toISOString()
      : isoNow();

  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const accel = raw.acceleration || {};
  const gyro = raw.gyroscope || raw.gyro || {};

  const reading = {
    device_id: id,
    event,
    fall_detected: raw.fall_detected === true,
    alert:
      typeof raw.alert === 'string'
        ? raw.alert.slice(0, 500)
        : null,

    ax: numberOrNull(raw.ax ?? accel.x),
    ay: numberOrNull(raw.ay ?? accel.y),
    az: numberOrNull(raw.az ?? accel.z),

    gx: numberOrNull(raw.gx ?? gyro.x),
    gy: numberOrNull(raw.gy ?? gyro.y),
    gz: numberOrNull(raw.gz ?? gyro.z),

    source:
      raw.source === 'test' ||
      raw.source === 'simulated' ||
      String(raw.event || '').toLowerCase().includes('test')
        ? 'test'
        : 'device',

    occurred_at: timestamp,
    raw_payload: raw,
  };

  const hasSensorValues = [
    reading.ax,
    reading.ay,
    reading.az,
    reading.gx,
    reading.gy,
    reading.gz,
  ].some((value) => value !== null);

  if (!hasSensorValues && !raw.event && raw.fall_detected !== true) {
    throw new Error(
      'Message must contain sensor values or an event'
    );
  }

  return reading;
}

async function storeReading(reading) {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Check server/.env.'
    );
  }

  // Store every valid sensor reading in Supabase.
  const { data, error } = await supabase
    .from('sensor_readings')
    .insert({
      device_id: reading.device_id,
      ax: reading.ax,
      ay: reading.ay,
      az: reading.az,
      gx: reading.gx,
      gy: reading.gy,
      gz: reading.gz,
      source: reading.source,
      occurred_at: reading.occurred_at,
      raw_payload: reading.raw_payload,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  let eventRow = null;

  // Only recognized event names create alert records.
  // Ordinary sensor_reading messages do not create fall alerts.
  const eventName = reading.event.toLowerCase();

  const isFallEvent = eventName === 'fall_alert';
  const isHelpEvent = eventName === 'manual_help';
  const isCheckInEvent = eventName === 'check_in';

  if (isFallEvent || isHelpEvent || isCheckInEvent) {
    const type = isFallEvent
      ? 'possible_fall'
      : isHelpEvent
        ? 'manual_help'
        : 'check_in';

    const result = await supabase
      .from('alerts')
      .insert({
        device_id: reading.device_id,
        type,
        source: reading.source,
        status: 'active',
        message: reading.alert || reading.event,
        occurred_at: reading.occurred_at,
        reading_id: data.id,
      })
      .select()
      .single();

    if (result.error) {
      throw result.error;
    }

    eventRow = result.data;
    publish('alert', eventRow);
  }

  lastMessageAt = reading.occurred_at;

  // Continue sending readings to the live dashboard.
  publish('reading', data);

  return {
    reading: data,
    alert: eventRow,
  };
}

// Health endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    api: 'online',
    supabaseConfigured: hasSupabase,
    mqttConfigured: Boolean(process.env.MQTT_URL),
    mqttConnected,
    lastMessageAt,
    deviceOnline: Boolean(
      lastMessageAt &&
      Date.now() - Date.parse(lastMessageAt) < offlineAfter * 1000
    ),
  });
});

// Device and connection status
app.get('/api/status', (_req, res) => {
  res.json({
    deviceId,
    mqttConnected,
    lastMessageAt,
    deviceOnline: Boolean(
      lastMessageAt &&
      Date.now() - Date.parse(lastMessageAt) < offlineAfter * 1000
    ),
    offlineAfterSeconds: offlineAfter,
    supabaseConfigured: hasSupabase,
  });
});

// Read sensor readings
app.get('/api/readings', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase is not configured',
    });
  }

  try {
    const limit = Math.min(
      200,
      Math.max(1, Number(req.query.limit) || 50)
    );

    const { data, error } = await supabase
      .from('sensor_readings')
      .select(
        'id,device_id,ax,ay,az,gx,gy,gz,source,occurred_at'
      )
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (error) {
      logError('Supabase readings query failed', error);

      return res.status(500).json({
        error: error.message,
        code: error.code || null,
      });
    }

    return res.json({
      data: data.reverse(),
    });
  } catch (error) {
    return errorResponse(
      res,
      error,
      'Supabase readings request failed'
    );
  }
});

// Read alerts
app.get('/api/alerts', async (_req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase is not configured',
    });
  }

  try {
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(100);

    if (error) {
      logError('Supabase alerts query failed', error);

      return res.status(500).json({
        error: error.message,
        code: error.code || null,
      });
    }

    return res.json({ data });
  } catch (error) {
    return errorResponse(
      res,
      error,
      'Supabase alerts request failed'
    );
  }
});

// Acknowledge or resolve an alert
app.patch('/api/alerts/:id', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase is not configured',
    });
  }

  const { status } = req.body || {};

  if (!['acknowledged', 'resolved'].includes(status)) {
    return res.status(400).json({
      error: 'status must be acknowledged or resolved',
    });
  }

  try {
    const updates = {
      status,
      updated_at: isoNow(),
    };

    if (status === 'resolved') {
      updates.resolved_at = isoNow();
    }

    const { data, error } = await supabase
      .from('alerts')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      logError('Supabase alert update failed', error);

      return res.status(500).json({
        error: error.message,
        code: error.code || null,
      });
    }

    publish('alert', data);

    return res.json({ data });
  } catch (error) {
    return errorResponse(
      res,
      error,
      'Supabase alert update failed'
    );
  }
});

// Dashboard check-in
app.post('/api/check-in', async (req, res) => {
  try {
    const reading = validateMessage({
      device_id: req.body?.device_id || deviceId,
      event: 'check_in',
      source: 'device',
      alert: 'Check-in submitted from dashboard',
    });

    const result = await storeReading(reading);

    return res.status(201).json(result);
  } catch (error) {
    logError('Check-in failed', error);

    return res.status(503).json({
      error: error.message || 'Check-in failed',
      cause: error?.cause?.code || error?.cause?.message || null,
    });
  }
});

// Manual help request
app.post('/api/help', async (req, res) => {
  try {
    const reading = validateMessage({
      device_id: req.body?.device_id || deviceId,
      event: 'manual_help',
      source: 'device',
      alert: 'Manual help request from dashboard',
    });

    const result = await storeReading(reading);

    return res.status(201).json(result);
  } catch (error) {
    logError('Manual help request failed', error);

    return res.status(503).json({
      error: error.message || 'Manual help request failed',
      cause: error?.cause?.code || error?.cause?.message || null,
    });
  }
});

// Live server-sent event stream
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.flushHeaders?.();

  res.write(
    `event: connected\ndata: ${JSON.stringify({
      connected: true,
      at: isoNow(),
    })}\n\n`
  );

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

// Start HTTP server
const server = app.listen(port, () => {
  console.log(`CareWatch API listening on http://localhost:${port}`);
  console.log(`Supabase configured: ${hasSupabase}`);
});

// Connect to MQTT if configured
if (process.env.MQTT_URL) {
  mqttClient = mqtt.connect(process.env.MQTT_URL, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;

    console.log(`MQTT connected; subscribing to ${topic}`);

    mqttClient.subscribe(topic, { qos: 1 }, (error) => {
      if (error) {
        console.error('MQTT subscribe failed:', error.message);
      }
    });

    publish('status', { mqttConnected });
  });

  mqttClient.on('reconnect', () => {
    mqttConnected = false;
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    publish('status', { mqttConnected });
  });

  mqttClient.on('error', (error) => {
    console.error('MQTT error:', error.message);
  });

  mqttClient.on('message', async (_topic, buffer) => {
    try {
      const reading = validateMessage(
        JSON.parse(buffer.toString())
      );

      await storeReading(reading);
    } catch (error) {
      logError('Incoming MQTT message could not be saved', error);

      publish('error', {
        message:
          'An incoming MQTT message could not be saved. Check backend logs.',
      });
    }
  });
}

// Graceful shutdown
function shutdown() {
  console.log('Shutting down CareWatch API...');

  for (const res of clients) {
    res.end();
  }

  mqttClient?.end(true);

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);