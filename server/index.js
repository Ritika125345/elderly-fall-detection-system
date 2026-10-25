import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT || 4000);
const topic = process.env.MQTT_TOPIC || 'elderly/fall/test';
const deviceId = process.env.DEVICE_ID || 'esp32_demo_01';
const offlineAfter = Number(process.env.DEVICE_OFFLINE_AFTER_SECONDS || 45);
app.use(cors({ origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',') }));
app.use(express.json({ limit: '32kb' }));

const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasSupabase ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
let mqttClient = null;
let lastMessageAt = null;
let mqttConnected = false;
const clients = new Set();

function publish(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
function isoNow() { return new Date().toISOString(); }
function validateMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Message must be a JSON object');
  const id = String(raw.device_id || deviceId).slice(0, 100);
  const event = raw.event == null ? 'sensor_reading' : String(raw.event).slice(0, 80);
  const timestamp = raw.timestamp && !Number.isNaN(Date.parse(raw.timestamp)) ? new Date(raw.timestamp).toISOString() : isoNow();
  const numberOrNull = (v) => Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
  const accel = raw.acceleration || {};
  const gyro = raw.gyroscope || raw.gyro || {};
  const reading = {
    device_id: id,
    event,
    fall_detected: raw.fall_detected === true,
    alert: typeof raw.alert === 'string' ? raw.alert.slice(0, 500) : null,
    ax: numberOrNull(raw.ax ?? accel.x), ay: numberOrNull(raw.ay ?? accel.y), az: numberOrNull(raw.az ?? accel.z),
    gx: numberOrNull(raw.gx ?? gyro.x), gy: numberOrNull(raw.gy ?? gyro.y), gz: numberOrNull(raw.gz ?? gyro.z),
    source: raw.source === 'test' || raw.source === 'simulated' || String(raw.event || '').toLowerCase().includes('test') ? 'test' : 'device',
    occurred_at: timestamp,
    raw_payload: raw
  };
  if (reading.ax === null && reading.ay === null && reading.az === null && reading.gx === null && reading.gy === null && reading.gz === null && !raw.event && raw.fall_detected !== true) {
    throw new Error('Message must contain sensor values or an event');
  }
  return reading;
}
async function storeReading(reading) {
  if (!supabase) throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env.');
  const { data, error } = await supabase.from('sensor_readings').insert({
    device_id: reading.device_id, ax: reading.ax, ay: reading.ay, az: reading.az,
    gx: reading.gx, gy: reading.gy, gz: reading.gz, source: reading.source,
    occurred_at: reading.occurred_at, raw_payload: reading.raw_payload
  }).select().single();
  if (error) throw error;
  let eventRow = null;
  if (reading.fall_detected || reading.event.toLowerCase().includes('fall') || reading.event.toLowerCase().includes('help') || reading.event.toLowerCase().includes('check')) {
    const type = reading.fall_detected || reading.event.toLowerCase().includes('fall') ? 'possible_fall' : reading.event.toLowerCase().includes('help') ? 'manual_help' : 'check_in';
    const result = await supabase.from('alerts').insert({ device_id: reading.device_id, type, source: reading.source, status: 'active', message: reading.alert || reading.event, occurred_at: reading.occurred_at, reading_id: data.id }).select().single();
    if (result.error) throw result.error;
    eventRow = result.data;
    publish('alert', eventRow);
  }
  lastMessageAt = reading.occurred_at;
  publish('reading', data);
  return { reading: data, alert: eventRow };
}

app.get('/api/health', (_req, res) => res.json({ api: 'online', supabaseConfigured: hasSupabase, mqttConfigured: Boolean(process.env.MQTT_URL), mqttConnected, lastMessageAt, deviceOnline: Boolean(lastMessageAt && Date.now() - Date.parse(lastMessageAt) < offlineAfter * 1000) }));
app.get('/api/status', (_req, res) => res.json({ deviceId, mqttConnected, lastMessageAt, deviceOnline: Boolean(lastMessageAt && Date.now() - Date.parse(lastMessageAt) < offlineAfter * 1000), offlineAfterSeconds: offlineAfter, supabaseConfigured: hasSupabase }));
app.get('/api/readings', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const { data, error } = await supabase.from('sensor_readings').select('id,device_id,ax,ay,az,gx,gy,gz,source,occurred_at').order('occurred_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data.reverse() });
});
app.get('/api/alerts', async (_req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  const { data, error } = await supabase.from('alerts').select('*').order('occurred_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});
app.patch('/api/alerts/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase is not configured' });
  const { status } = req.body || {};
  if (!['acknowledged', 'resolved'].includes(status)) return res.status(400).json({ error: 'status must be acknowledged or resolved' });
  const updates = { status, updated_at: isoNow() };
  if (status === 'resolved') updates.resolved_at = isoNow();
  const { data, error } = await supabase.from('alerts').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  publish('alert', data); res.json({ data });
});
app.post('/api/check-in', async (req, res) => {
  try {
    const result = await storeReading({ ...validateMessage({ device_id: req.body?.device_id || deviceId, event: 'check_in', source: 'device', alert: 'Check-in submitted from dashboard' }), event: 'check_in', source: 'device' });
    res.status(201).json(result);
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.post('/api/help', async (req, res) => {
  try {
    const result = await storeReading({ ...validateMessage({ device_id: req.body?.device_id || deviceId, event: 'manual_help', source: 'device', alert: 'Manual help request from dashboard' }), event: 'manual_help', source: 'device' });
    res.status(201).json(result);
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.(); res.write(`event: connected\ndata: ${JSON.stringify({ connected: true, at: isoNow() })}\n\n`);
  clients.add(res); req.on('close', () => clients.delete(res));
});

app.listen(port, () => console.log(`CareWatch API listening on http://localhost:${port}`));
if (process.env.MQTT_URL) {
  mqttClient = mqtt.connect(process.env.MQTT_URL, { username: process.env.MQTT_USERNAME || undefined, password: process.env.MQTT_PASSWORD || undefined, reconnectPeriod: 3000, connectTimeout: 10000 });
  mqttClient.on('connect', () => { mqttConnected = true; console.log(`MQTT connected; subscribing to ${topic}`); mqttClient.subscribe(topic, { qos: 1 }, (err) => err && console.error('MQTT subscribe failed:', err.message)); publish('status', { mqttConnected }); });
  mqttClient.on('reconnect', () => { mqttConnected = false; });
  mqttClient.on('close', () => { mqttConnected = false; publish('status', { mqttConnected }); });
  mqttClient.on('error', (err) => console.error('MQTT error:', err.message));
  mqttClient.on('message', async (_topic, buffer) => {
    try { const reading = validateMessage(JSON.parse(buffer.toString())); await storeReading(reading); }
    catch (error) { console.error('Rejected MQTT message:', error.message); publish('error', { message: 'An incoming MQTT message could not be saved. Check backend logs.' }); }
  });
}
process.on('SIGINT', () => { mqttClient?.end(true); process.exit(0); });
