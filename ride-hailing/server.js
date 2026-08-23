/**
 * Ride-Hailing App — Express + Mongoose + Socket.io
 * Serves Customer App (/customer) and Driver App (/driver)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { computeBackfillPaidUntil } = require('./lib/backfillPaidUntil');

// ─── Global crash protection ──────────────────────────────────────────────────
// Catch any unhandled error/rejection so the server never exits unexpectedly.
// Log the problem and keep running — the request that caused it will simply
// time-out or receive a 500, which is far better than a full process crash.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection (server kept alive):', reason);
});

const express = require('express');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const webpush  = require('web-push');
const crypto   = require('crypto');
const Tesseract = require('tesseract.js');
const sharp    = require('sharp');

// ── 2. APP & SERVER INITIALIZATION ───────────────────────────────────────
const app    = express();

// ── 3. HEALTHCHECK ROUTES — FIRST lines after express(), zero dependencies
// Replit deployment probes / immediately on startup; this must win before
// any other route, middleware, or DB work is registered.
app.get('/',       (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).send('OK'));
app.get('/api',    (_req, res) => res.status(200).json({ status: 'ok' }));

const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Request body timeout ──────────────────────────────────────────────────
// Drivers on 2G/3G can take 30–90 s to push four compressed photos (~1 MB
// at 100–300 kbps). We set server.requestTimeout explicitly so the value is
// visible, intentional, and configurable — leaving it implicit risks an
// accidental reduction by a framework upgrade or deployment change.
//
// The Node 18+ default is 300 000 ms; we raise it to 600 000 ms (10 min)
// to comfortably cover worst-case 2G uploads without silently cutting drivers
// off mid-transfer.
//
// REQUEST_TIMEOUT_MS env var overrides the value so integration tests can use
// a shorter window (e.g. REQUEST_TIMEOUT_MS=8000) without waiting 10 minutes.
server.requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || '600000', 10);

// ── 4. START LISTENING IMMEDIATELY ───────────────────────────────────────
// Bind the port right after healthchecks so the OS accepts connections and
// deployment probes succeed while DB connects asynchronously in the background.
const PORT = parseInt(process.env.PORT || '8080', 10);
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚗 Ride-Hailing Server running on port ${PORT}`);
    console.log(`   Customer App : /customer`);
    console.log(`   Driver App   : /driver`);
    console.log(`   DB Status    : Connecting…\n`);
  });
}

// ── 5. MIDDLEWARES & STATIC FILES ─────────────────────────────────────────
app.use(cors());
// Keep the exact bytes for gateway signature verification while still exposing
// the normal parsed JSON body to every other route.
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Resolve the public directory absolutely — works in any CWD or spawn context.
const PUBLIC_DIR = path.resolve(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Pre-read HTML pages synchronously at startup so we never rely on sendFile's
// stream/path behaviour in Cloud Run containers.  If a file is missing the
// server refuses to start with a clear error rather than silently 500-ing.
const fs = require('fs');

// Driver files retain their existing public review path. Customer identity
// documents are deliberately stored separately and are never exposed by static
// middleware; only an authenticated super-admin can retrieve them.
const UPLOADS_DIR = path.resolve(__dirname, 'uploads', 'driver_docs');
const CUSTOMER_ID_UPLOADS_DIR = path.resolve(__dirname, 'uploads', 'customer_identity');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CUSTOMER_ID_UPLOADS_DIR, { recursive: true });
// Only driver review documents are public. Never mount the parent uploads
// directory, because it also contains customer identity files.
app.use('/uploads/customer_identity', (_req, res) => res.status(404).end());
app.use('/uploads/driver_docs', express.static(UPLOADS_DIR));

const MAX_ID_DOCUMENT_BYTES = 6 * 1024 * 1024;
const ID_DOCUMENT_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/s;

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(ID_DOCUMENT_DATA_URL);
  if (!match) throw new Error('ID document must be a JPEG, PNG, or WebP image');
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > MAX_ID_DOCUMENT_BYTES) {
    throw new Error('ID document must be between 1 byte and 6 MB');
  }
  return { ext: match[1] === 'jpeg' ? 'jpg' : match[1], bytes };
}

// Save a base64 data-URL to disk; return the public path.  If the value is
// already a file path (not a data: URL) it is returned unchanged.
async function compressImage(bytes) {
  return sharp(bytes)
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

async function saveDocToDisk(dataUrl, fieldName) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl || '';
  const m = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s);
  if (!m) return dataUrl;
  const fname = `${fieldName}_${Date.now()}_${crypto.randomBytes(10).toString('hex')}.jpg`;
  try {
    const compressed = await compressImage(Buffer.from(m[2], 'base64'));
    fs.writeFileSync(path.join(UPLOADS_DIR, fname), compressed, { mode: 0o640 });
  }
  catch { return dataUrl; } // fallback — keep base64 if disk write fails
  return `/uploads/driver_docs/${fname}`;
}

async function savePrivateIdentityDocument(dataUrl, label) {
  const { ext, bytes } = parseImageDataUrl(dataUrl);
  const filename = `${label}_${Date.now()}_${crypto.randomBytes(12).toString('hex')}.jpg`;
  const compressed = await compressImage(bytes);
  fs.writeFileSync(path.join(CUSTOMER_ID_UPLOADS_DIR, filename), compressed, { mode: 0o600 });
  return filename;
}

function deletePrivateIdentityDocuments(filenames = []) {
  for (const filename of filenames.filter(Boolean)) {
    try { fs.unlinkSync(path.join(CUSTOMER_ID_UPLOADS_DIR, path.basename(filename))); } catch {}
  }
}
function loadPage(file) {
  const full = path.resolve(PUBLIC_DIR, file);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (e) {
    // Return a minimal fallback so a missing file never crashes startup or 500s the healthcheck
    console.error(`[startup] Warning: cannot load ${full}: ${e.message}`);
    return `<!DOCTYPE html><html><body><h1>MyRide</h1><p>Page unavailable.</p></body></html>`;
  }
}
const PAGES = {
  customer: loadPage('customer.html'),
  driver:   loadPage('driver.html'),
  admin:    loadPage('admin.html'),
  download: loadPage('download.html'),
};

const JWT_SECRET = process.env.JWT_SECRET || 'ride-hailing-secret-fallback';
let dbConnected  = false;

// Gateway credentials are encrypted before they are stored in MongoDB and are
// never returned to browsers. Set PAYMENT_CONFIG_ENCRYPTION_KEY in production;
// SESSION_SECRET is used only as a backwards-compatible local fallback.
const PAYMENT_CONFIG_KEY = crypto
  .createHash('sha256')
  .update(process.env.PAYMENT_CONFIG_ENCRYPTION_KEY || process.env.SESSION_SECRET || '')
  .digest();

function encryptSecret(value) {
  if (!value) return '';
  if (!process.env.PAYMENT_CONFIG_ENCRYPTION_KEY && !process.env.SESSION_SECRET) {
    throw new Error('PAYMENT_CONFIG_ENCRYPTION_KEY or SESSION_SECRET is required before storing gateway credentials');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PAYMENT_CONFIG_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    const [iv, tag, ciphertext] = String(value).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', PAYMENT_CONFIG_KEY, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

const FARE_VEHICLE_CATEGORIES = [
  'Car Sedan',
  'Car Mini',
  'Riksha',
  'Bike',
  'Car SUV',
  'Van Seven Seats',
  'Cary Dibba',
  'Toyota Highroof',
  'Toyota Saloon Coaster'
];
const FARE_VEHICLE_ALIASES = {
  Sedan: 'Car Sedan',
  'Car AC': 'Car Sedan',
  Rickshaw: 'Riksha',
  'Car Mini': 'Car Mini',
  Bike: 'Bike',
  SUV: 'Car SUV',
  Van: 'Van Seven Seats',
  'Van Seven Seats': 'Van Seven Seats',
  'Carry Dibba': 'Cary Dibba',
  'Cary Dibba': 'Cary Dibba',
  'Toyota Hi Roof': 'Toyota Highroof',
  'Toyota Hi-Roof': 'Toyota Highroof',
  'Toyota High Roof': 'Toyota Highroof',
  'Toyota Coaster': 'Toyota Saloon Coaster',
  'Toyota Saloon': 'Toyota Saloon Coaster'
};
const PAYMENT_GATEWAYS = ['jazzcash', 'easypaisa', 'bank', 'sadapay'];
const PAYMENT_GATEWAY_DEFAULTS = {
  jazzcash: { title: '', number: '' },
  easypaisa: { title: '', number: '' },
  bank: { name: '', title: '', iban: '' },
  sadapay: { title: '', number: '' }
};
const PAYMENT_SUCCESS_STATUSES = new Set(['paid', 'approved', 'success', 'successful', 'completed', 'complete']);

function isSuccessfulWebhookStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  return PAYMENT_SUCCESS_STATUSES.has(status) || status === '000' || status === '0';
}

function normalizeGateway(value) {
  const gateway = String(value || '').toLowerCase().trim();
  return gateway === 'bank-transfer' ? 'bank' : gateway;
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyWebhookSignature(req, secret) {
  if (!secret || !req.rawBody) return false;
  const provided = String(
    req.get('x-webhook-signature') ||
    req.get('x-signature') ||
    req.get('x-signature-sha256') ||
    req.get('x-jazzcash-signature') ||
    req.get('x-easypaisa-signature') ||
    req.get('x-sadapay-signature') ||
    req.get('x-bank-signature') ||
    req.get('x-hmac-signature') || ''
  ).replace(/^sha256=/i, '').trim();
  if (!provided) return false;
  const digestHex = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const digestBase64 = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  return constantTimeEqual(provided.toLowerCase(), digestHex.toLowerCase()) ||
    constantTimeEqual(provided, digestBase64);
}

function readWebhookValue(payload, keys) {
  const sources = [payload, payload?.data, payload?.transaction, payload?.payment, payload?.result];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  return undefined;
}

function publicGatewayConfig(value) {
  return {
    configured: !!(value?.apiKey || value?.accessToken || value?.merchantId || value?.secretKey || value?.webhookSecret),
    apiKeyConfigured: !!value?.apiKey,
    accessTokenConfigured: !!value?.accessToken,
    merchantIdConfigured: !!value?.merchantId,
    secretKeyConfigured: !!value?.secretKey,
    webhookSecretConfigured: !!value?.webhookSecret
  };
}

function normalizeFareVehicle(value) {
  const raw = String(value || '').trim();
  return FARE_VEHICLE_CATEGORIES.includes(raw) ? raw : (FARE_VEHICLE_ALIASES[raw] || raw);
}

const DRIVER_RIDE_PREFERENCES = ['Short Range Only', 'Long Range Only', 'Both'];
function normalizeRidePreference(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'long range only' || raw === 'long-range-only' || raw === 'longrangeonly') return 'Long Range Only';
  if (raw === 'short range only' || raw === 'short-range-only' || raw === 'shortrangeonly') return 'Short Range Only';
  return 'Both';
}

function isLongRangeOnlyDriver(driver) {
  return normalizeRidePreference(driver?.ridePreference) === 'Long Range Only';
}

function canDriverReceiveRideForPreference(ridePreference, isLongRange) {
  const preference = normalizeRidePreference(ridePreference);
  return isLongRange ? preference !== 'Short Range Only' : preference !== 'Long Range Only';
}

function storedVehicleTypesForFareCategory(category) {
  const normalized = normalizeFareVehicle(category);
  return [...new Set([
    normalized,
    ...Object.keys(FARE_VEHICLE_ALIASES).filter(key => FARE_VEHICLE_ALIASES[key] === normalized)
  ])];
}

function emptyDailyFeeSettings() {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, null]));
}

function normalizeDailyFeeSettings(value = {}) {
  const result = emptyDailyFeeSettings();
  for (const category of FARE_VEHICLE_CATEGORIES) {
    const legacyAlias = Object.keys(FARE_VEHICLE_ALIASES).find(alias =>
      FARE_VEHICLE_ALIASES[alias] === category && value?.[alias] !== undefined
    );
    const source = value?.[category] ?? (legacyAlias ? value[legacyAlias] : undefined);
    const amount = source && typeof source === 'object' ? source.amount : source;
    result[category] = amount === null || amount === undefined || amount === '' ? null : Number(amount);
  }
  return result;
}

function validateDailyFeeSettings(value) {
  const settings = normalizeDailyFeeSettings(value);
  const errors = [];
  for (const category of FARE_VEHICLE_CATEGORIES) {
    const amount = settings[category];
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`${category}: Daily Fee must be greater than zero`);
    }
    if (Number.isFinite(amount) && Math.round(amount * 100) !== amount * 100) {
      errors.push(`${category}: Daily Fee can have at most two decimal places`);
    }
  }
  return { settings, errors };
}

async function getDailyFeeSettings() {
  const doc = await Settings.findOne({ key: 'daily_fee_settings' }).lean();
  return normalizeDailyFeeSettings(doc?.value);
}

async function getDailyFeeForVehicle(vehicleType, settings = null) {
  const current = settings || await getDailyFeeSettings();
  return current[normalizeFareVehicle(vehicleType)] ?? null;
}

function endOfTodayUTC() {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

// The automatic fee is a cost of going online, not a cost of merely having
// an active driver account. The conditional wallet query also prevents two
// simultaneous online requests from charging the same driver twice.
const ACTIVE_FEE_PASS_MS = 24 * 60 * 60 * 1000;

async function chargeDailyFeeForOnlineDriver(driverId, driver, dailyFeeSettings = null) {
  if (isLongRangeOnlyDriver(driver)) {
    return { allowed: true, charged: false, rate: null, exempt: true, reason: 'Long Range Only drivers are exempt from the Daily Fee' };
  }
  const rate = await getDailyFeeForVehicle(driver.vehicleType, dailyFeeSettings);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { allowed: true, charged: false, rate: null };
  }

  const now = new Date();
  const activePassCutoff = new Date(now.getTime() - ACTIVE_FEE_PASS_MS);
  if (driver.isFreeTrial && driver.paidUntilDate && new Date(driver.paidUntilDate) >= now) {
    return { allowed: true, charged: false, rate, alreadyPaid: true };
  }

  const walletSnapshot = await Wallet.findOne({ user: driverId })
    .select('fee_paid_at balance').lean();
  const previousFeePaidAt = walletSnapshot?.fee_paid_at || driver.lastDailyFeePaidAt;
  if (previousFeePaidAt && new Date(previousFeePaidAt) > activePassCutoff) {
    return { allowed: true, charged: false, rate, alreadyPaid: true, feePaidAt: previousFeePaidAt };
  }

  const wallet = await Wallet.findOneAndUpdate(
    {
      user: driverId,
      balance: { $gte: rate },
      $or: [
        { fee_paid_at: { $exists: false } },
        { fee_paid_at: null },
        { fee_paid_at: { $lte: activePassCutoff } }
      ]
    },
    {
      $inc: { balance: -rate },
      $set: { fee_paid_at: now, dailyFeeChargedDate: todayUTC() },
      $push: {
        transactions: {
          amount: rate,
          type: 'debit',
          description: `Automatic daily fee for going online (${driver.vehicleType || 'Car'})`
        }
      }
    },
    { new: true }
  );

  if (!wallet) {
    const currentWallet = await Wallet.findOne({ user: driverId })
      .select('balance fee_paid_at').lean();
    if (currentWallet?.fee_paid_at && new Date(currentWallet.fee_paid_at) > activePassCutoff) {
      return { allowed: true, charged: false, rate, alreadyCharged: true, balance: currentWallet.balance, feePaidAt: currentWallet.fee_paid_at };
    }
    return { allowed: false, charged: false, rate, balance: currentWallet?.balance || 0 };
  }

  await User.updateOne(
    { _id: driverId },
    {
      lastDailyFeePaidAt: now,
      paidUntilDate: new Date(now.getTime() + ACTIVE_FEE_PASS_MS),
      isFreeTrial: false
    }
  );
  return { allowed: true, charged: true, rate, balance: wallet.balance, feePaidAt: now };
}

const DEFAULT_PER_KM_RATES = {
  Bike: 30,
  Riksha: 40,
  'Car Mini': 50,
  'Car Sedan': 70,
  'Cary Dibba': 80,
  'Car SUV': 100,
  'Van Seven Seats': 100,
  'Toyota Highroof': 120,
  'Toyota Saloon Coaster': 140
};

function normalizePerKmRates(value = {}) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
    const aliases = Object.keys(FARE_VEHICLE_ALIASES).filter(alias => FARE_VEHICLE_ALIASES[alias] === category);
    const raw = value?.[category] ?? aliases.map(alias => value?.[alias]).find(item => item !== undefined);
    const rate = raw === '' || raw === null || raw === undefined ? DEFAULT_PER_KM_RATES[category] : Number(raw);
    return [category, rate];
  }));
}

function validatePerKmRates(value) {
  const rates = normalizePerKmRates(value);
  const errors = [];
  for (const category of FARE_VEHICLE_CATEGORIES) {
    if (!Number.isFinite(rates[category]) || rates[category] <= 0) {
      errors.push(`${category}: /km rate must be greater than zero`);
    }
  }
  return { rates, errors };
}

async function getPerKmRates() {
  const doc = await Settings.findOne({ key: 'per_km_rates' }).lean();
  return normalizePerKmRates(doc?.value);
}

function emptyFareSettings() {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, {
    baseFare: null,
    distanceSlabs: [],
    peakRules: []
  }]));
}

function normalizeFareSettings(input) {
  const output = emptyFareSettings();
  if (!input || typeof input !== 'object') return output;
  for (const category of FARE_VEHICLE_CATEGORIES) {
    const source = input[category] || {};
    output[category] = {
      baseFare: Number.isFinite(Number(source.baseFare)) && Number(source.baseFare) >= 0
        ? Number(source.baseFare) : null,
      distanceSlabs: Array.isArray(source.distanceSlabs) ? source.distanceSlabs.map(slab => ({
        minKm: Number(slab.minKm),
        maxKm: slab.maxKm === null || slab.maxKm === '' || slab.maxKm === undefined ? null : Number(slab.maxKm),
        rate: Number(slab.rate)
      })).filter(slab =>
        Number.isFinite(slab.minKm) && slab.minKm >= 0 &&
        (slab.maxKm === null || (Number.isFinite(slab.maxKm) && slab.maxKm > slab.minKm)) &&
        Number.isFinite(slab.rate) && slab.rate >= 0
      ).sort((a, b) => a.minKm - b.minKm) : [],
      peakRules: Array.isArray(source.peakRules) ? source.peakRules.map(rule => {
        const adjustmentType = rule.adjustmentType || (Number(rule.adjustmentPercent) < 0 ? 'down' : 'up');
        const percentage = Number(rule.percentage ?? Math.abs(Number(rule.adjustmentPercent || 0)));
        return {
          start: String(rule.start || ''),
          end: String(rule.end || ''),
          adjustmentType: adjustmentType === 'down' ? 'down' : 'up',
          percentage,
          adjustmentPercent: adjustmentType === 'down' ? -Math.abs(percentage) : Math.abs(percentage)
        };
      }).filter(rule =>
        /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.start) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(rule.end) &&
        Number.isFinite(rule.percentage) && rule.percentage >= 0 &&
        (rule.adjustmentType === 'up' || rule.percentage <= 100)
      ) : []
    };
  }
  return output;
}

function validateFareSettings(input) {
  const settings = normalizeFareSettings(input);
  const errors = [];
  for (const category of FARE_VEHICLE_CATEGORIES) {
    const rule = settings[category];
    validateFareCategory(category, rule, errors);
  }
  return { settings, errors };
}

function validateFareCategory(category, rule, errors = []) {
  if (!FARE_VEHICLE_CATEGORIES.includes(category)) {
    errors.push(`${category}: unknown vehicle category`);
    return errors;
  }
  if (rule.baseFare === null) errors.push(`${category}: Base Fare is required`);
  for (let i = 0; i < rule.distanceSlabs.length; i++) {
    const slab = rule.distanceSlabs[i];
    const next = rule.distanceSlabs[i + 1];
    if (next && slab.maxKm !== null && slab.maxKm > next.minKm) {
      errors.push(`${category}: distance slabs overlap`);
    }
    if (next && slab.maxKm !== null && Math.abs(slab.maxKm - next.minKm) > 0.000001) {
      errors.push(`${category}: distance slabs must be continuous without gaps`);
    }
    if (i === 0 && slab.minKm !== 0) errors.push(`${category}: first distance slab must start at 0 km`);
    if (i === rule.distanceSlabs.length - 1 && slab.maxKm !== null) {
      errors.push(`${category}: last distance slab must have no maximum`);
    }
  }
  if (!rule.distanceSlabs.length) errors.push(`${category}: at least one distance slab is required`);
  return errors;
}

function validateFareCategorySettings(category, input) {
  const normalized = normalizeFareSettings({ [category]: input })[category];
  return { setting: normalized, errors: validateFareCategory(category, normalized, []) };
}

function mergeFareCategorySettings(existing, category, setting) {
  return normalizeFareSettings({ ...(existing || {}), [category]: setting });
}

const LONG_RANGE_SETTINGS_KEY = 'long_range_ride_settings';
const DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES = Object.freeze(
  Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 500]))
);
const DEFAULT_LONG_RANGE_SETTINGS = Object.freeze({
  enabled: false,
  distanceCutoffKm: 50,
  minimumWalletBalances: DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES,
  broadcastRadiusKm: 30,
  commissionPercent: 10,
  commissionTiming: 'accepted',
  perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, null]))
});

function normalizeLongRangeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const numberInRange = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? Number(number.toFixed(2)) : fallback;
  };
  return {
    enabled: source.enabled === true,
    distanceCutoffKm: numberInRange(source.distanceCutoffKm, DEFAULT_LONG_RANGE_SETTINGS.distanceCutoffKm, 1, 2000),
    minimumWalletBalances: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
      const legacyMinimum = source.minimumWalletBalance;
      const configuredMinimum = source.minimumWalletBalances?.[category] ?? legacyMinimum;
      return [category, numberInRange(configuredMinimum, DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES[category], 0, 1000000)];
    })),
    broadcastRadiusKm: numberInRange(source.broadcastRadiusKm, DEFAULT_LONG_RANGE_SETTINGS.broadcastRadiusKm, 0.5, 500),
    commissionPercent: numberInRange(source.commissionPercent, DEFAULT_LONG_RANGE_SETTINGS.commissionPercent, 0, 100),
    commissionTiming: source.commissionTiming === 'started' ? 'started' : 'accepted',
    perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
      const rate = Number(source.perKmRates?.[category]);
      return [category, Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(2)) : null];
    }))
  };
}

function validateLongRangeSettings(input) {
  const settings = normalizeLongRangeSettings(input);
  const errors = [];
  if (input?.enabled === true) {
    for (const category of FARE_VEHICLE_CATEGORIES) {
      if (!settings.perKmRates[category]) errors.push(`${category}: Long Range /km rate must be greater than zero`);
      if (!Number.isFinite(settings.minimumWalletBalances[category]) || settings.minimumWalletBalances[category] < 0) {
        errors.push(`${category}: Minimum Wallet Balance must be zero or greater`);
      }
    }
  }
  return { settings, errors };
}

async function getLongRangeSettings() {
  const doc = await Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean();
  return normalizeLongRangeSettings(doc?.value);
}

function isLongRangeDistance(distanceKm, settings) {
  return settings.enabled && Number(distanceKm) >= settings.distanceCutoffKm;
}

function getLongRangeMinimumWalletBalance(settings, vehicleType) {
  const category = normalizeFareVehicle(vehicleType || 'Car Mini');
  return Number(settings?.minimumWalletBalances?.[category] ?? DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES[category] ?? 0);
}

function calculateRideFare(fareSettings, longRangeSettings, vehicleType, distanceKm, at, perKmRates) {
  if (!isLongRangeDistance(distanceKm, longRangeSettings)) {
    return calculateFareFromSettings(fareSettings, vehicleType, distanceKm, at, perKmRates);
  }
  const category = normalizeFareVehicle(vehicleType);
  const distance = Number(distanceKm);
  const rate = Number(longRangeSettings.perKmRates[category]);
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(rate) || rate <= 0) {
    return { error: `Long Range fare settings are not configured for ${category}` };
  }
  const totalFare = Math.round(distance * rate);
  return {
    vehicleType: category,
    distanceKm: Number(distance.toFixed(2)),
    isLongRange: true,
    longRangeRatePerKm: rate,
    subtotal: totalFare,
    totalFare,
    calculatedAt: at
  };
}

function timeMatchesRule(rule, date = new Date()) {
  const current = date.getHours() * 60 + date.getMinutes();
  const parse = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = parse(rule.start);
  const end = parse(rule.end);
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function calculateFareFromSettings(settings, vehicleType, distanceKm, at = new Date(), perKmRates = DEFAULT_PER_KM_RATES) {
  const category = normalizeFareVehicle(vehicleType);
  const rule = settings[category];
  const distance = Number(distanceKm);
  if (!rule || !Number.isFinite(distance) || distance < 0) {
    return { error: 'A valid vehicle category and distance are required' };
  }
  if (rule.baseFare === null || !rule.distanceSlabs.length) {
    return { error: `Fare settings are not configured for ${category}` };
  }
  const slab = rule.distanceSlabs.find(item =>
    distance >= item.minKm && (item.maxKm === null || distance <= item.maxKm)
  );
  if (!slab) return { error: `No distance slab covers ${distance} km for ${category}` };
  const activeRules = rule.peakRules
    .filter(item => timeMatchesRule(item, at))
    .map(item => {
      const percentage = Number(item.percentage ?? Math.abs(Number(item.adjustmentPercent || 0)));
      return {
        ...item,
        percentage,
        adjustmentPercent: item.adjustmentType === 'down' ? -Math.abs(percentage) : Math.abs(percentage)
      };
    });
  const adjustmentPercent = activeRules.reduce((sum, item) => sum + item.adjustmentPercent, 0);
  const perKmRate = Number(perKmRates[category]);
  if (!Number.isFinite(perKmRate) || perKmRate <= 0) {
    return { error: `/km rate is not configured for ${category}` };
  }
  const distanceFare = distance * perKmRate;
  const subtotal = rule.baseFare + distanceFare;
  const total = Math.max(0, Math.round(subtotal * (1 + adjustmentPercent / 100)));
  return {
    vehicleType: category,
    distanceKm: Number(distance.toFixed(2)),
    baseFare: rule.baseFare,
    perKmRate,
    distanceFare: Number(distanceFare.toFixed(2)),
    slab: { ...slab },
    activeRules,
    adjustmentPercent,
    subtotal,
    totalFare: total,
    calculatedAt: at.toISOString()
  };
}

async function refreshPendingRideFares(settings, perKmRates = null) {
  const currentPerKmRates = perKmRates || await getPerKmRates();
  const longRangeSettings = await getLongRangeSettings();
  const pendingRides = await Ride.find({ status: 'requested' });
  for (const ride of pendingRides) {
    const fareQuote = calculateRideFare(settings, longRangeSettings, ride.vehicleType, ride.distance, new Date(), currentPerKmRates);
    if (fareQuote.error || ride.fare === fareQuote.totalFare) continue;
    ride.fare = fareQuote.totalFare;
    ride.fareQuote = fareQuote;
    await ride.save();
    const payload = { id: ride._id, fare: ride.fare, fareQuote: ride.fareQuote };
    io.to(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini')}`).emit('ride:fare-updated', payload);
    io.to(`ride:${ride._id}`).emit('ride:fare-updated', payload);
  }
}

// Encode raw special characters in username/password without double-encoding
// already-percent-encoded sequences (mirrors the existing api-server approach).
function normalizeMongoUri(uri) {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return uri;
  const authorityStart     = schemeEnd + 3;
  const userInfoSeparator  = uri.lastIndexOf('@');
  if (userInfoSeparator < authorityStart) return uri;
  const userInfo           = uri.slice(authorityStart, userInfoSeparator);
  const passwordSeparator  = userInfo.indexOf(':');
  if (passwordSeparator === -1) return uri;
  const username = userInfo.slice(0, passwordSeparator);
  const password = userInfo.slice(passwordSeparator + 1);
  const normalizeCredential = (s) =>
    s.replace(/%[0-9a-f]{2}|./giu, (ch) =>
      ch.startsWith('%') ? ch.toUpperCase() : encodeURIComponent(ch)
    );
  const normalized = `${normalizeCredential(username)}:${normalizeCredential(password)}`;
  return `${uri.slice(0, authorityStart)}${normalized}${uri.slice(userInfoSeparator)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mongoose Schemas
// ─────────────────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  email:   { type: String, unique: true, sparse: true, lowercase: true, trim: true }, // optional
  password:{ type: String, required: true },
  phone:   { type: String, default: '', trim: true },
  role:    { type: String, enum: ['customer', 'driver'], default: 'customer' },
  vehicleType:  { type: String, enum: [...FARE_VEHICLE_CATEGORIES, 'Rickshaw', 'Car AC', ''], default: '' },
  ridePreference: { type: String, enum: DRIVER_RIDE_PREFERENCES, default: 'Both' },
  vehicleModel: { type: String, default: '' },
  vehiclePlate: { type: String, default: '' },
  isOnline: { type: Boolean, default: false },
  longRangeEnabled: { type: Boolean, default: false },
  isAdmin:  { type: Boolean, default: false },
  currentLocation: {
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 }
  },
  // Availability is persisted separately from a transient Socket.io connection.
  // Native foreground services reconnect after radio/process changes, so a
  // disconnect must not silently make an otherwise approved driver unavailable.
  lastOnlineHeartbeat: { type: Date, default: null },
  expoPushToken:       { type: String, default: '' },
  rating:       { type: Number, default: 5.0 },
  totalRides:   { type: Number, default: 0 },
  emergencyContacts: [{
    name:  { type: String, default: '' },
    phone: { type: String, required: true }
  }],
  otpCode:   { type: String,  default: null },
  otpExpiry: { type: Date,    default: null },
  // Admin management
  accountStatus:   { type: String, enum: ['active','pending','suspended','blocked','pending_deletion'], default: 'active' },
  suspendReason:   { type: String, default: '' },
  suspendedAt:     { type: Date,   default: null },
  activeSessionToken: { type: String, default: null },   // single-device login enforcement
  // Daily platform fee tracking
  lastDailyFeePaidAt: { type: Date,   default: null },
  dailyFeeAmount:     { type: Number, default: null },
  paidUntilDate:      { type: Date,    default: null },   // set when daily fee paid or admin grants waiver
  isFreeTrial:        { type: Boolean, default: false },  // true when paidUntilDate was set by admin trial grant
  trialStartDate:     { type: Date,    default: null },   // when the free trial started
  // Driver verification documents (URL strings)
  profilePhoto:    { type: String, default: '' },
  cnicFront:       { type: String, default: '' },
  cnicBack:        { type: String, default: '' },
  licensePhoto:    { type: String, default: '' },
  vehicleRegPhoto: { type: String, default: '' },
  vehicleReviewRequestedAt: { type: Date, default: null },
  cnicNumber:      { type: String, default: '' },      // retained for existing driver records only
  nationalIdHash:  { type: String, unique: true, sparse: true, default: '', select: false },
  nationalIdLast4: { type: String, default: '' },
  customerIdFront: { type: String, default: '', select: false },
  customerIdBack:  { type: String, default: '', select: false },
  identityVerifiedAt: { type: Date, default: null },
  identityVerificationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: null }
}, { timestamps: true });

const rideSchema = new mongoose.Schema({
  passenger: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driver:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  pickupLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: 'Pickup Point' }
  },
  dropoffLocation: {                // primary stop (first drop) — kept for driver-app compat
    lat:     { type: Number, default: 0 },
    lng:     { type: Number, default: 0 },
    address: { type: String, default: 'Dropoff Point' }
  },
  dropoffLocations: [{              // full ordered list of all stops
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: 'Stop' }
  }],
  fare:        { type: Number, required: true },
  fareQuote: {
    vehicleType: String,
    distanceKm: Number,
    baseFare: Number,
    slab: { minKm: Number, maxKm: Number, rate: Number },
    activeRules: [{ start: String, end: String, adjustmentPercent: Number }],
    adjustmentPercent: Number,
    subtotal: Number,
    totalFare: Number,
    calculatedAt: Date
  },
  isLongRange: { type: Boolean, default: false },
  longRangeCommissionAmount: { type: Number, default: 0 },
  longRangeCommissionChargedAt: { type: Date, default: null },
  distance:    { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['requested', 'accepted', 'arrived', 'in-progress', 'completed', 'cancelled'],
    default: 'requested'
  },
  driverLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  vehicleType:   { type: String, default: 'Car Mini' },
  notes:         { type: String, default: '' },
  paymentMethod: { type: String, enum: ['cash', 'easypaisa', 'jazzcash', 'wallet'], default: 'cash' },
  mobileAccount: { type: String, default: '' },
  counterOffers: [{
    driver:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    driverName:   String,
    vehicleModel: String,
    vehiclePlate: String,
    rating:       Number,
    price:        Number,
    type:         { type: String, enum: ['accept', 'counter'], default: 'accept' },
    timestamp:    { type: Date, default: Date.now }
  }],
  driverRating:    { type: Number, default: null },
  driverReview:    { type: String,  default: '' },
  customerRating:  { type: Number, default: null },
  customerReview:  { type: String,  default: '' },
  verificationPin: { type: String,  default: null }   // 4-digit PIN for ride start
}, { timestamps: true });

const walletSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  balance:        { type: Number, default: 0 },             // net spendable (all credits − debits)
  realCashWallet: { type: Number, default: 0 },             // deposits + ride earnings only
  bonusWallet:    { type: Number, default: 0 },             // promotional bonuses only
  dailyFeeChargedDate: { type: String, default: '' },       // legacy calendar-day marker
  fee_paid_at:      { type: Date, default: null },          // rolling 24-hour pass start
  transactions: [{
    amount:        Number,
    type:          { type: String, enum: ['credit', 'debit'] },
    description:   String,
    paymentMethod: { type: String, default: '' },
    mobileAccount: { type: String, default: '' },
    rideId: { type: String, default: '' },
    createdAt:     { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// Every dashboard surface and sensitive action has a named, fail-closed
// Sub-Admin permission. Keep this list as the single source of truth for the
// Admin UI, persisted accounts, and backend authorization.
const SUB_ADMIN_PERMISSION_CATALOG = Object.freeze([
  { key: 'viewOverview',          group: 'Dashboard',          label: 'View overview dashboard' },
  { key: 'viewDrivers',           group: 'Drivers',            label: 'View drivers & vehicle categories' },
  { key: 'manageDriverApprovals', group: 'Drivers',            label: 'Approve or reject driver applications' },
  { key: 'manageDriverStatus',    group: 'Drivers',            label: 'Suspend, block, or restore drivers' },
  { key: 'viewDriverPasses',      group: 'Driver passes',      label: 'View Driver Pass status & countdowns' },
  { key: 'manageDriverPasses',    group: 'Driver passes',      label: 'Manage passes, waivers & reminders' },
  { key: 'viewCustomers',         group: 'Customers',          label: 'View customer accounts' },
  { key: 'manageCustomers',       group: 'Customers',          label: 'Block, restore, or reject customers' },
  { key: 'viewRides',             group: 'Rides',              label: 'View live rides & ride history' },
  { key: 'viewPayments',          group: 'Wallet recharges',   label: 'View Driver recharge requests' },
  { key: 'viewPaymentProofs',     group: 'Wallet recharges',   label: 'View recharge proof screenshots' },
  { key: 'approveWalletTopups',   group: 'Wallet recharges',   label: 'Approve or reject Driver recharges' },
  { key: 'viewSOS',               group: 'Operations',         label: 'View SOS alerts' },
  { key: 'manageSOS',             group: 'Operations',         label: 'Resolve SOS alerts' },
  { key: 'viewRatings',           group: 'Operations',         label: 'View ratings & feedback' },
  { key: 'viewSupport',           group: 'Operations',         label: 'View support tickets' },
  { key: 'manageSupport',         group: 'Operations',         label: 'Reply to and resolve support tickets' },
  { key: 'manageRideSettings',    group: 'System configuration', label: 'Manage ride broadcast settings' },
  { key: 'manageFareSettings',    group: 'System configuration', label: 'Manage fare rates & pricing rules' },
  { key: 'managePaymentSettings', group: 'System configuration', label: 'Manage receiving account settings' },
  { key: 'viewAuditLogs',         group: 'System configuration', label: 'View payment and pass audit logs' }
]);
const SUB_ADMIN_PERMISSION_DEFAULTS = Object.freeze(
  Object.fromEntries(SUB_ADMIN_PERMISSION_CATALOG.map(({ key }) => [key, false]))
);

function normalizeSubAdminPermissions(permissions) {
  return Object.fromEntries(SUB_ADMIN_PERMISSION_CATALOG.map(({ key }) => [key, !!permissions?.[key]]));
}

function hasAdminPermission(admin, permission) {
  return !!admin?.isSuperAdmin || !!admin?.permissions?.[permission];
}

// Sub-Admin schema — granular-permission secondary admin accounts (max 50)
const subAdminSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  password:  { type: String, required: true },
  isBlocked: { type: Boolean, default: false },
  permissions: { type: mongoose.Schema.Types.Mixed, default: () => ({ ...SUB_ADMIN_PERMISSION_DEFAULTS }) }
}, { timestamps: true });
const SubAdmin = mongoose.model('SubAdmin', subAdminSchema);

const sosSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  location: { lat: Number, lng: Number },
  message:  { type: String, default: 'SOS Emergency Alert!' },
  ride:     { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
  resolved: { type: Boolean, default: false }
}, { timestamps: true });

const ticketSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:       { type: String, enum: ['customer','driver'], required: true },
  subject:    { type: String, required: true, trim: true },
  message:    { type: String, required: true, trim: true },
  status:     { type: String, enum: ['open','resolved'], default: 'open' },
  adminReply: { type: String, default: '' },
  repliedAt:  { type: Date,    default: null },
  readByUser: { type: Boolean, default: false }
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  driver:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  trxId:           { type: String, required: true, trim: true, uppercase: true },
  amount:          { type: Number, required: true },
  vehicleCategory: { type: String, required: true },
  paymentType:     { type: String, enum: ['jazzcash','easypaisa','bank','sadapay'], default: 'jazzcash' },
  status:          { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  proofScreenshot: { type: String, required: true, select: false },
  adminNote:       { type: String, default: '' },
  approvedBy:      { type: String, default: '' },
  approvedAt:      { type: Date, default: null },
  rejectedBy:      { type: String, default: '' },
  rejectedAt:      { type: Date, default: null },
  submittedDate:   { type: String, required: true },   // 'YYYY-MM-DD' UTC date, for uniqueness check
  auditLog: [{
    action:        { type: String, enum: ['pending', 'approved', 'rejected'], required: true },
    actorId:       { type: String, default: '' },
    actorRole:     { type: String, default: '' },
    reason:        { type: String, default: '' },
    balanceBefore: { type: Number, default: null },
    balanceAfter:  { type: Number, default: null },
    passValidUntil:{ type: Date, default: null },
    createdAt:     { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// Database-enforced protections against repeated payment references and daily spam.
paymentSchema.index({ trxId: 1 }, { unique: true });
paymentSchema.index({ driver: 1, submittedDate: 1 }, { unique: true });

// Key-value settings store
const settingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

// Web-Push subscriptions per driver
const pushSubSchema = new mongoose.Schema({
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  endpoint:     { type: String, required: true },
  keys:         { p256dh: String, auth: String },
  updatedAt:    { type: Date, default: Date.now }
});
pushSubSchema.index({ user: 1, endpoint: 1 }, { unique: true });

const User     = mongoose.model('User',     userSchema);
const Ride     = mongoose.model('Ride',     rideSchema);
const Wallet   = mongoose.model('Wallet',   walletSchema);
const SOS      = mongoose.model('SOS',      sosSchema);
const Payment  = mongoose.model('Payment',  paymentSchema);
const Ticket   = mongoose.model('Ticket',   ticketSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const PushSub  = mongoose.model('PushSub',  pushSubSchema);

const TERMS_SETTINGS_KEY = 'terms_and_conditions';
const DEFAULT_TERMS = Object.freeze({
  customer: 'Please use My Ride responsibly and follow all applicable local laws.',
  driver: 'Please drive safely, follow all applicable local laws, and treat customers respectfully.'
});
function normalizeTerms(value = {}) {
  return {
    customer: typeof value.customer === 'string' ? value.customer.slice(0, 50000) : DEFAULT_TERMS.customer,
    driver: typeof value.driver === 'string' ? value.driver.slice(0, 50000) : DEFAULT_TERMS.driver
  };
}
async function getTermsSettings() {
  const doc = await Settings.findOne({ key: TERMS_SETTINGS_KEY }).lean();
  return normalizeTerms(doc?.value);
}

const RIDE_RETENTION_SETTINGS_KEY = 'ride_data_retention';
const DEFAULT_RIDE_RETENTION_DAYS = 30;
const MIN_RIDE_RETENTION_DAYS = 1;
const MAX_RIDE_RETENTION_DAYS = 3650;

function normalizeRideRetentionDays(value) {
  const days = Number(value);
  return Number.isInteger(days) ? days : DEFAULT_RIDE_RETENTION_DAYS;
}

function validateRideRetentionDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < MIN_RIDE_RETENTION_DAYS || days > MAX_RIDE_RETENTION_DAYS) {
    return { days: null, error: `Retention period must be a whole number between ${MIN_RIDE_RETENTION_DAYS} and ${MAX_RIDE_RETENTION_DAYS} days` };
  }
  return { days, error: null };
}

async function getRideRetentionDays() {
  const doc = await Settings.findOne({ key: RIDE_RETENTION_SETTINGS_KEY }).lean();
  const days = normalizeRideRetentionDays(doc?.value?.days ?? doc?.value);
  return Math.min(MAX_RIDE_RETENTION_DAYS, Math.max(MIN_RIDE_RETENTION_DAYS, days));
}
// A foreground-location task posts at least every 15 seconds. The grace window
// absorbs OS/radio jitter while failing closed after a force-stop or prolonged
// connectivity loss.
const DRIVER_HEARTBEAT_MAX_AGE_MS = 90 * 1000;
const DEFAULT_RIDE_BROADCAST_RADIUS_KM = 5;
const MIN_RIDE_BROADCAST_RADIUS_KM = 0.5;
const MAX_RIDE_BROADCAST_RADIUS_KM = 100;

async function sendExpoPush(tokens, message) {
  const recipients = [...new Set(tokens.filter(token => /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(String(token || ''))))];
  if (!recipients.length) return;
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(recipients.map(to => ({ to, sound: 'default', priority: 'high', ...message })))
    });
    if (!response.ok) console.warn(`[expo-push] delivery request failed: ${response.status}`);
  } catch (err) {
    console.warn(`[expo-push] delivery request failed: ${err.message}`);
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeRideBroadcastSettings(value = {}) {
  const rawRadius = typeof value === 'object' && value !== null
    ? value.maximumRideBroadcastRadiusKm
    : value;
  const radius = Number(rawRadius);
  if (!Number.isFinite(radius) || radius < MIN_RIDE_BROADCAST_RADIUS_KM || radius > MAX_RIDE_BROADCAST_RADIUS_KM) {
    return { maximumRideBroadcastRadiusKm: DEFAULT_RIDE_BROADCAST_RADIUS_KM };
  }
  return { maximumRideBroadcastRadiusKm: Number(radius.toFixed(2)) };
}

function validateRideBroadcastSettings(value) {
  const rawRadius = value?.maximumRideBroadcastRadiusKm;
  const radius = Number(rawRadius);
  const errors = [];
  if (!Number.isFinite(radius)) errors.push('Maximum Ride Broadcast Radius must be a number');
  else if (radius < MIN_RIDE_BROADCAST_RADIUS_KM || radius > MAX_RIDE_BROADCAST_RADIUS_KM) {
    errors.push(`Maximum Ride Broadcast Radius must be between ${MIN_RIDE_BROADCAST_RADIUS_KM} and ${MAX_RIDE_BROADCAST_RADIUS_KM} km`);
  } else if (Math.round(radius * 100) !== radius * 100) {
    errors.push('Maximum Ride Broadcast Radius can have at most two decimal places');
  }
  return { settings: normalizeRideBroadcastSettings({ maximumRideBroadcastRadiusKm: radius }), errors };
}

async function getRideBroadcastSettings() {
  const doc = await Settings.findOne({ key: 'ride_broadcast_settings' }).lean();
  return normalizeRideBroadcastSettings(doc?.value);
}

function hasValidCoordinates(location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lng) && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

async function findRideBroadcastDrivers(pickupLocation, vehicleType, settings = null) {
  const rideSettings = settings || await getRideBroadcastSettings();
  const radiusKm = rideSettings.maximumRideBroadcastRadiusKm;
  if (!hasValidCoordinates(pickupLocation)) return { drivers: [], radiusKm };

  const candidates = await User.find({
    role: 'driver',
    isOnline: true,
    accountStatus: 'active',
    ridePreference: { $ne: 'Long Range Only' },
    vehicleType: { $in: storedVehicleTypesForFareCategory(vehicleType) },
    lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
    'currentLocation.lat': { $ne: 0 },
    'currentLocation.lng': { $ne: 0 }
  }).select('_id currentLocation expoPushToken').lean();

  if (!candidates.length) return { drivers: [], radiusKm };
  const candidateIds = candidates.map(driver => driver._id);
  const eligibleWallets = await Wallet.find({
    user: { $in: candidateIds },
    balance: { $gte: 0 }
  }).select('user').lean();
  const walletEligibleIds = new Set(eligibleWallets.map(wallet => String(wallet.user)));
  const drivers = candidates
    .filter(driver => walletEligibleIds.has(String(driver._id)) && hasValidCoordinates(driver.currentLocation))
    .map(driver => ({
      ...driver,
      distanceFromPickupKm: haversineKm(
        Number(pickupLocation.lat),
        Number(pickupLocation.lng),
        Number(driver.currentLocation.lat),
        Number(driver.currentLocation.lng)
      )
    }))
    .filter(driver => driver.distanceFromPickupKm <= radiusKm);
  return { drivers, radiusKm };
}

async function findLongRangeBroadcastDrivers(pickupLocation, vehicleType, longRangeSettings) {
  const radiusKm = longRangeSettings.broadcastRadiusKm;
  if (!hasValidCoordinates(pickupLocation)) return { drivers: [], radiusKm };
  const candidates = await User.find({
    role: 'driver', isOnline: true, longRangeEnabled: true, accountStatus: 'active',
    ridePreference: { $ne: 'Short Range Only' },
    vehicleType: { $in: storedVehicleTypesForFareCategory(vehicleType) },
    lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
    'currentLocation.lat': { $ne: 0 }, 'currentLocation.lng': { $ne: 0 }
  }).select('_id currentLocation expoPushToken longRangeEnabled').lean();
  const eligibleWallets = await Wallet.find({
    user: { $in: candidates.map(driver => driver._id) },
    balance: { $gte: getLongRangeMinimumWalletBalance(longRangeSettings, vehicleType) }
  }).select('user').lean();
  const eligibleIds = new Set(eligibleWallets.map(wallet => String(wallet.user)));
  const drivers = candidates.filter(driver => driver.longRangeEnabled === true
      && eligibleIds.has(String(driver._id)) && hasValidCoordinates(driver.currentLocation))
    .map(driver => ({ ...driver, distanceFromPickupKm: haversineKm(
      Number(pickupLocation.lat), Number(pickupLocation.lng),
      Number(driver.currentLocation.lat), Number(driver.currentLocation.lng)
    ) })).filter(driver => driver.distanceFromPickupKm <= radiusKm);
  return { drivers, radiusKm };
}

async function chargeLongRangeCommission(ride, driverId, timing, longRangeSettings) {
  if (!ride.isLongRange || longRangeSettings.commissionTiming !== timing || ride.longRangeCommissionChargedAt) {
    return { ok: true, alreadyCharged: !!ride.longRangeCommissionChargedAt };
  }
  const amount = Number((Number(ride.fare) * longRangeSettings.commissionPercent / 100).toFixed(2));
  if (!amount) {
    await Ride.updateOne({ _id: ride._id, longRangeCommissionChargedAt: null }, {
      $set: { longRangeCommissionAmount: 0, longRangeCommissionChargedAt: new Date() }
    });
    return { ok: true };
  }
  const debited = await Wallet.findOneAndUpdate({
    user: driverId, balance: { $gte: amount },
    transactions: { $not: { $elemMatch: { rideId: String(ride._id), description: 'Long Range commission' } } }
  }, {
    $inc: { balance: -amount },
    $push: { transactions: { amount, type: 'debit', description: 'Long Range commission', rideId: String(ride._id) } }
  }, { new: true });
  if (!debited) {
    const already = await Wallet.exists({ user: driverId, transactions: { $elemMatch: { rideId: String(ride._id), description: 'Long Range commission' } } });
    if (!already) return { ok: false, error: 'Wallet balance is insufficient for the Long Range commission.' };
  }
  await Ride.updateOne({ _id: ride._id, longRangeCommissionChargedAt: null }, {
    $set: { longRangeCommissionAmount: amount, longRangeCommissionChargedAt: new Date() }
  });
  return { ok: true };
}

async function validateLongRangeDriverEligibility(driverId, settings) {
  const [driver, wallet] = await Promise.all([
    User.findById(driverId).select('longRangeEnabled accountStatus vehicleType').lean(),
    Wallet.findOne({ user: driverId }).select('balance').lean()
  ]);
  return !!(settings.enabled && driver?.accountStatus === 'active' && driver.longRangeEnabled
    && Number(wallet?.balance || 0) >= getLongRangeMinimumWalletBalance(settings, driver.vehicleType));
}

function emitRideRequestToDrivers(drivers, payload) {
  for (const driver of drivers) {
    io.to(`user:${driver._id}`).emit('ride:new', payload);
  }
}

const ADMIN_SECURITY_KEY = 'admin_security';
const ADMIN_RECOVERY_ATTEMPTS = new Map();
const ADMIN_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_RECOVERY_MAX_ATTEMPTS = 5;

function normalizeNationalId(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeNameForMatch(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function validateStrongPassword(value) {
  return typeof value === 'string' && value.length >= 10;
}

function validateRecoveryKey(value) {
  return typeof value === 'string' && value.trim().length >= 12;
}

function throttleAdminRecovery(req) {
  const key = `${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`;
  const now = Date.now();
  const current = ADMIN_RECOVERY_ATTEMPTS.get(key) || { attempts: 0, resetAt: now + ADMIN_RECOVERY_WINDOW_MS };
  if (current.resetAt <= now) {
    current.attempts = 0;
    current.resetAt = now + ADMIN_RECOVERY_WINDOW_MS;
  }
  current.attempts += 1;
  ADMIN_RECOVERY_ATTEMPTS.set(key, current);
  return current.attempts <= ADMIN_RECOVERY_MAX_ATTEMPTS;
}

function clearAdminRecoveryThrottle(req) {
  ADMIN_RECOVERY_ATTEMPTS.delete(`${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`);
}

async function getAdminSecurity() {
  const doc = await Settings.findOne({ key: ADMIN_SECURITY_KEY }).lean();
  return {
    passwordHash: doc?.value?.passwordHash || '',
    recoveryKeyHash: doc?.value?.recoveryKeyHash || '',
    sessionVersion: Number.isInteger(doc?.value?.sessionVersion) ? doc.value.sessionVersion : 0
  };
}

async function saveAdminSecurity(security) {
  await Settings.findOneAndUpdate(
    { key: ADMIN_SECURITY_KEY },
    { key: ADMIN_SECURITY_KEY, value: security },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function verifySuperAdminPassword(candidate, security = null) {
  const current = security || await getAdminSecurity();
  if (current.passwordHash) return bcrypt.compare(String(candidate || ''), current.passwordHash);
  return constantTimeEqual(candidate, process.env.ADMIN_PASSWORD || 'admin1234');
}

async function verifyCustomerIdentityDocuments({ name, nationalId, front, back }) {
  const expectedId = normalizeNationalId(nationalId);
  const expectedName = normalizeNameForMatch(name);
  if (!/^\d{13}$/.test(expectedId) || expectedName.length < 4) return false;
  const [frontImage, backImage] = [parseImageDataUrl(front), parseImageDataUrl(back)];
  const [frontOcr, backOcr] = await Promise.all([
    Tesseract.recognize(frontImage.bytes, 'eng'),
    Tesseract.recognize(backImage.bytes, 'eng')
  ]);
  const text = `${frontOcr.data?.text || ''}\n${backOcr.data?.text || ''}`;
  const normalizedText = normalizeNameForMatch(text);
  const digits = normalizeNationalId(text);
  const idMatched = digits.includes(expectedId);
  const nameMatched = normalizedText.includes(expectedName);
  return idMatched && nameMatched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    // Single-device session enforcement — drivers only
    if (req.user.role === 'driver' && dbConnected) {
      const clientSession = req.headers['x-session-token'];
      if (clientSession) {
        const driver = await User.findById(req.user.id).select('activeSessionToken').lean();
        if (driver && driver.activeSessionToken && driver.activeSessionToken !== clientSession) {
          return res.status(401).json({ error: 'LOGGED_IN_ELSEWHERE' });
        }
      }
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Middleware (two flavours)
// ─────────────────────────────────────────────────────────────────────────────

// ── driverOnly — must follow authMiddleware ───────────────────────────────
// Rejects any caller that is not a driver with an active (approved) account.
async function driverOnly(req, res, next) {
  if (!req.user || req.user.role !== 'driver') {
    return res.status(403).json({ error: 'Access denied: driver accounts only' });
  }
  // accountStatus is embedded in the JWT payload at login
  if (req.user.accountStatus && req.user.accountStatus !== 'active') {
    return res.status(403).json({ error: 'Your driver account is not yet approved or has been suspended' });
  }
  // A vehicle-document replacement can revoke approval after a token was
  // issued. When the database is available, its current status is authoritative
  // so a stale token cannot keep a driver eligible for rides or availability.
  if (dbConnected) {
    try {
      const driver = await User.findById(req.user.id).select('accountStatus').lean();
      if (!driver || driver.accountStatus !== 'active') {
        return res.status(403).json({ error: 'Your driver account is pending verification. Availability returns after Admin approval.' });
      }
    } catch (err) {
      return next(err);
    }
  }
  return next();
}

// ── customerOnly — must follow authMiddleware ─────────────────────────────
// Rejects any caller that is not a customer.
function customerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'customer') {
    return res.status(403).json({ error: 'Access denied: customer accounts only' });
  }
  next();
}

async function customerCanBook(req, res, next) {
  // The focused unit suite runs without MongoDB; production always checks the
  // current persisted state so approval changes take effect immediately.
  if (!dbConnected) {
    if (req.user.accountStatus && req.user.accountStatus !== 'active') {
      return res.status(403).json({ error: 'Your account is pending verification. Booking will be available after approval.' });
    }
    return next();
  }
  const customer = await User.findById(req.user.id).select('accountStatus identityVerificationStatus').lean();
  if (!customer || customer.accountStatus !== 'active' || customer.identityVerificationStatus === 'rejected') {
    return res.status(403).json({ error: 'Your account is pending verification. Booking will be available after approval.' });
  }
  next();
}

// Legacy: used by /api/payments/* routes (needs authMiddleware first)
async function adminMiddleware(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('isAdmin');
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// New: accepts both super-admin JWTs (isAdmin:true) and sub-admin JWTs (isSubAdmin:true)
async function adminJwt(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Admin token required' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.isAdmin) {
      const security = await getAdminSecurity();
      if (Number(payload.adminSessionVersion || 0) !== security.sessionVersion) {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }
      req.admin = { ...payload, isSuperAdmin: true };
      return next();
    }
    if (payload.isSubAdmin) {
      const sub = await SubAdmin.findById(payload.subAdminId).select('username permissions isBlocked').lean();
      if (!sub || sub.isBlocked) return res.status(401).json({ error: 'This Sub-Admin session is no longer active.' });
      // Reload from the database on every request so permission grants and
      // revocations take effect immediately instead of waiting for JWT expiry.
      req.admin = {
        isSubAdmin: true,
        isSuperAdmin: false,
        subAdminId: String(sub._id),
        username: sub.username,
        permissions: normalizeSubAdminPermissions(sub.permissions)
      };
      return next();
    }
    return res.status(403).json({ error: 'Admin access required' });
  } catch { return res.status(401).json({ error: 'Invalid or expired admin token' }); }
}

// Super-admin-only guard — sub-admins are always rejected
function requireSuperAdmin(req, res, next) {
  if (!req.admin?.isSuperAdmin) return res.status(403).json({ error: 'Super-admin access required' });
  next();
}

// Permission guard — super-admins always pass; sub-admins need the named flag
function requirePerm(permName) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'Admin token required' });
    if (req.admin.isSuperAdmin) return next();
    if (!hasAdminPermission(req.admin, permName))
      return res.status(403).json({ error: `Permission denied: ${permName} required` });
    next();
  };
}

function requireProfileSearchAccess(req, res, next) {
  if (req.admin?.isSuperAdmin || hasAdminPermission(req.admin, 'viewCustomers') || hasAdminPermission(req.admin, 'viewDrivers')) {
    return next();
  }
  return res.status(403).json({ error: 'Permission denied: customer or driver view access required' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, role, vehicleType, vehicleModel, vehiclePlate, ridePreference,
             profilePhoto, licensePhoto, cnicFront, cnicBack, cnicNumber, vehicleRegPhoto } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
    if (!phone)             return res.status(400).json({ error: 'Phone number is required' });
    const resolvedRoleEarly = role || 'customer';
    const resolvedRidePreference = resolvedRoleEarly === 'driver' ? normalizeRidePreference(ridePreference) : 'Both';
    const normalizedCustomerId = normalizeNationalId(cnicNumber);
    if (resolvedRoleEarly === 'customer') {
      if (!cnicNumber || !cnicFront || !cnicBack) {
        return res.status(400).json({ error: 'Full Name, CNIC/NIC, and both ID document images are required' });
      }
      if (!/^\d{13}$/.test(normalizedCustomerId)) {
        return res.status(400).json({ error: 'Enter a valid 13-digit CNIC / NIC number' });
      }
    }
    if (resolvedRoleEarly === 'driver' && (!profilePhoto || !licensePhoto || !cnicFront || !cnicBack || !vehicleRegPhoto)) {
      return res.status(400).json({ error: 'Profile photo, CNIC front/back, driving license, and vehicle registration documents are required' });
    }
    if (resolvedRoleEarly === 'driver' && !FARE_VEHICLE_CATEGORIES.includes(normalizeFareVehicle(vehicleType))) {
      return res.status(400).json({ error: 'Choose a valid vehicle category' });
    }

    const resolvedEmail = email ? email.toLowerCase().trim() : null;

    if (resolvedEmail && await User.findOne({ email: resolvedEmail }))
      return res.status(409).json({ error: 'Email already registered' });
    if (phone && await User.findOne({ phone: phone.trim() }))
      return res.status(409).json({ error: 'Phone number already registered' });
    const nationalIdHash = resolvedRoleEarly === 'customer'
      ? crypto.createHmac('sha256', JWT_SECRET).update(normalizedCustomerId).digest('hex')
      : '';
    if (nationalIdHash && await User.findOne({ nationalIdHash }).select('_id').lean()) {
      return res.status(409).json({ error: 'This CNIC / NIC is already registered' });
    }

    let identityVerified = false;
    if (resolvedRoleEarly === 'customer') {
      try {
        identityVerified = await verifyCustomerIdentityDocuments({
          name, nationalId: normalizedCustomerId, front: cnicFront, back: cnicBack
        });
      } catch (err) {
        console.warn(`[identity-verification] Unable to read submitted customer ID: ${err.message}`);
      }
    }

    const hash = await bcrypt.hash(password, 12);
    const resolvedRole = role || 'customer';
    const customerFrontFile = resolvedRole === 'customer' ? await savePrivateIdentityDocument(cnicFront, 'customer_id_front') : '';
    const customerBackFile = resolvedRole === 'customer' ? await savePrivateIdentityDocument(cnicBack, 'customer_id_back') : '';
    const user = await User.create({
      name,
      email:         resolvedEmail  || undefined,
      phone:         phone?.trim()  || '',
      password:      hash,
      role:          resolvedRole,
      accountStatus: resolvedRole === 'driver' ? 'pending' : (identityVerified ? 'active' : 'pending'),
      vehicleType:   resolvedRole === 'driver' ? normalizeFareVehicle(vehicleType) : '',
      ridePreference: resolvedRidePreference,
      vehicleModel:  vehicleModel   || '',
      vehiclePlate:  vehiclePlate   || '',
      profilePhoto:  await saveDocToDisk(profilePhoto, 'profile'),
      licensePhoto:  await saveDocToDisk(licensePhoto, 'license'),
      vehicleRegPhoto: resolvedRole === 'driver' ? await saveDocToDisk(vehicleRegPhoto, 'vehicleReg') : '',
      cnicFront:     resolvedRole === 'driver' ? await saveDocToDisk(cnicFront, 'cnicFront') : '',
      cnicBack:      resolvedRole === 'driver' ? await saveDocToDisk(cnicBack, 'cnicBack') : '',
      cnicNumber:    resolvedRole === 'driver' ? (cnicNumber || '') : '',
      nationalIdHash,
      nationalIdLast4: resolvedRole === 'customer' ? normalizedCustomerId.slice(-4) : '',
      customerIdFront: customerFrontFile,
      customerIdBack: customerBackFile,
      identityVerifiedAt: resolvedRole === 'customer' ? new Date() : null,
      identityVerificationStatus: resolvedRole === 'customer' ? (identityVerified ? 'approved' : 'rejected') : null
    });
    if (user.role === 'driver') {
      await Wallet.create({ user: user._id, balance: 0, transactions: [] });
    }

    // Single-device session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await User.updateOne({ _id: user._id }, { activeSessionToken: sessionToken });

    const token = jwt.sign(
        { id: user._id, email: user.email || '', role: user.role, name: user.name, accountStatus: user.accountStatus },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.status(201).json({
      token,
      sessionToken,
      user: { id: user._id, name: user.name, email: user.email || '', phone: user.phone,
               role: user.role, accountStatus: user.accountStatus, identityVerificationStatus: user.identityVerificationStatus,
              vehicleType: user.vehicleType,
              ridePreference: user.ridePreference || 'Both',
              vehicleModel: user.vehicleModel, vehiclePlate: user.vehiclePlate,
               lastDailyFeePaidAt: null, dailyFeeAmount: await getDailyFeeForVehicle(user.vehicleType),
               paidUntilDate: null, dailyFeeRate: await getDailyFeeForVehicle(user.vehicleType) }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    // Accept { identifier, password } (new) or { email, password } (legacy)
    const identifier = (req.body.identifier || req.body.email || '').trim();
    const { password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'Phone/email and password required' });

    // Look up by email if it contains @, otherwise by phone
    const user = identifier.includes('@')
      ? await User.findOne({ email: identifier.toLowerCase() })
      : await User.findOne({ phone: identifier });

    if (!user) return res.status(404).json({ error: 'No account found with this phone number or email' });
    if (!(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    // Back-fill paidUntilDate for drivers who paid under the old system
    // (lastDailyFeePaidAt set, paidUntilDate still null). Run silently so
    // no previously-paid driver is locked out after the daily-fee update.
    const backfillDate = computeBackfillPaidUntil(user);
    if (backfillDate) {
      await User.updateOne({ _id: user._id }, { paidUntilDate: backfillDate });
      user.paidUntilDate = backfillDate;
    }

    // Generate a new single-device session token and overwrite any previous one
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await User.updateOne({ _id: user._id }, { activeSessionToken: sessionToken });

    const token = jwt.sign(
       { id: user._id, email: user.email || '', role: user.role, name: user.name, accountStatus: user.accountStatus },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
      token,
      sessionToken,
      user: { id: user._id, name: user.name, email: user.email || '', phone: user.phone,
               role: user.role, accountStatus: user.accountStatus, identityVerificationStatus: user.identityVerificationStatus,
              profilePhoto: user.profilePhoto || '',
               vehicleType: user.vehicleType,
               ridePreference: user.ridePreference || 'Both',
              vehicleModel: user.vehicleModel, vehiclePlate: user.vehiclePlate, rating: user.rating,
              lastDailyFeePaidAt: user.lastDailyFeePaidAt || null,
               dailyFeeAmount: await getDailyFeeForVehicle(user.vehicleType),
              paidUntilDate:  user.paidUntilDate  || null,
               dailyFeeRate:   await getDailyFeeForVehicle(user.vehicleType),
              isFreeTrial:    user.isFreeTrial    || false,
              trialStartDate: user.trialStartDate || null }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account Deletion Request ──────────────────────────────────────────────
app.post('/api/account/delete-request', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password confirmation is required' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    // Mark for deletion and invalidate session — admin reviews before permanent removal
    await User.updateOne({ _id: user._id }, { accountStatus: 'pending_deletion', activeSessionToken: null });
    res.json({ message: 'Account deletion requested. Our team will review and permanently remove your data within 24–48 hours.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Forgot Password (OTP-based) ───────────────────────────────────────────

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body;
    // Always return the same response to avoid exposing which phone numbers
    // are registered. Reject non-string input before it can reach MongoDB.
    const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
    const genericResponse = {
      success: true,
      message: 'If the phone number is registered, a password reset code has been issued.'
    };
    if (!normalizedPhone) return res.json(genericResponse);
    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) return res.json(genericResponse);

    const otp = String(crypto.randomInt(100000, 1000000));          // 6-digit, CSPRNG
    const expiry = new Date(Date.now() + 10 * 60 * 1000);           // 10 min
    await User.updateOne(
      { _id: user._id },
      { otpCode: await bcrypt.hash(otp, 12), otpExpiry: expiry }
    );

    // OTP values and account identifiers must never be returned to the caller
    // or written to logs. Connect an SMS provider before enabling this flow in
    // production; until then, the code is intentionally server-only.
    res.json(genericResponse);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, otp, newPassword } = req.body;
    if (typeof phone !== 'string' || typeof otp !== 'string' || typeof newPassword !== 'string' ||
        !phone.trim() || !otp.trim() || !newPassword)
      return res.status(400).json({ error: 'Phone, OTP, and new password required' });
    const user = await User.findOne({ phone: phone.trim() });
    if (!user || !user.otpCode || !(await bcrypt.compare(otp.trim(), user.otpCode)))
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    if (user.otpExpiry < new Date()) return res.status(400).json({ error: 'OTP has expired — request a new one' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const hash = await bcrypt.hash(newPassword, 12);
    await User.updateOne({ _id: user._id }, { password: hash, otpCode: null, otpExpiry: null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Emergency Contacts ─────────────────────────────────────────────────────

app.get('/api/auth/emergency-contacts', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('emergencyContacts');
    res.json(user?.emergencyContacts || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/auth/emergency-contacts', authMiddleware, async (req, res) => {
  try {
    const contacts = (req.body.contacts || [])
      .filter(c => c.phone && c.phone.trim())
      .slice(0, 2)
      .map(c => ({ name: (c.name || '').trim(), phone: c.phone.trim() }));
    await User.updateOne({ _id: req.user.id }, { emergencyContacts: contacts });
    res.json({ success: true, contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public fare quote used by both customer and driver apps. Pricing is always
// calculated from the current Admin Settings document.
app.post('/api/fare/calculate', async (req, res) => {
  try {
    const [settingsDoc, ratesDoc, longRangeDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean()
    ]);
    const result = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      normalizeLongRangeSettings(longRangeDoc?.value),
      req.body?.vehicleType,
      req.body?.distanceKm,
      new Date(),
      normalizePerKmRates(ratesDoc?.value)
    );
    if (result.error) return res.status(422).json({ error: result.error });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fare-settings', async (req, res) => {
  try {
    const settingsDoc = await Settings.findOne({ key: 'daily_fare_settings' }).lean();
    res.json(normalizeFareSettings(settingsDoc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ride Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/rides', authMiddleware, customerOnly, customerCanBook, async (req, res) => {
  try {
    const { pickupLocation, dropoffLocation, dropoffLocations, distance, vehicleType, notes, paymentMethod, mobileAccount } = req.body;
    if (!pickupLocation) {
      return res.status(400).json({ error: 'Pickup is required' });
    }
    const [settingsDoc, ratesDoc, longRangeDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean()
    ]);
    const longRangeSettings = normalizeLongRangeSettings(longRangeDoc?.value);
    const fareQuote = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      longRangeSettings,
      vehicleType,
      distance,
      new Date(),
      normalizePerKmRates(ratesDoc?.value)
    );
    if (fareQuote.error) return res.status(422).json({ error: fareQuote.error });
    // Resolve stops: prefer dropoffLocations array; fall back to single dropoffLocation
    const stops = Array.isArray(dropoffLocations) && dropoffLocations.length
      ? dropoffLocations
      : (dropoffLocation ? [dropoffLocation] : []);
    if (!stops.length) return res.status(400).json({ error: 'At least one dropoff stop is required' });

    const ride = await Ride.create({
      passenger:        req.user.id,
      pickupLocation,
      dropoffLocation:  stops[0],        // primary stop
      dropoffLocations: stops,
      fare:          fareQuote.totalFare,
      fareQuote,
      isLongRange:       !!fareQuote.isLongRange,
      distance:      fareQuote.distanceKm,
      vehicleType:   fareQuote.vehicleType,
      notes:         notes         || '',
      paymentMethod: paymentMethod || 'cash',
      mobileAccount: mobileAccount || ''
    });

    const ridePayload = {
      id:               ride._id,
      pickupLocation:   ride.pickupLocation,
      dropoffLocation:  ride.dropoffLocation,
      dropoffLocations: ride.dropoffLocations,   // full multi-stop list
      fare:             ride.fare,
      distance:         ride.distance,
      fareQuote:        ride.fareQuote,
      isLongRange:      ride.isLongRange,
      vehicleType:      ride.vehicleType,
      paymentMethod:    ride.paymentMethod,
      notes:            ride.notes,
      createdAt:        ride.createdAt
    };

    // Every delivery channel receives the exact same eligible, geo-filtered
    // driver set. This prevents a distant socket or push recipient from seeing
    // an offer that is outside the Admin-configured broadcast radius.
    // Tests may attach an in-memory Mongoose connection after importing this
    // module, so use the connection's live state alongside the startup flag.
    const databaseReady = dbConnected || mongoose.connection.readyState === 1;
    const broadcast = databaseReady
      ? (ride.isLongRange
        ? await findLongRangeBroadcastDrivers(ride.pickupLocation, ride.vehicleType, longRangeSettings)
        : await findRideBroadcastDrivers(ride.pickupLocation, ride.vehicleType))
      : { drivers: [], radiusKm: DEFAULT_RIDE_BROADCAST_RADIUS_KM };
    ridePayload.broadcastRadiusKm = broadcast.radiusKm;
    emitRideRequestToDrivers(broadcast.drivers, ridePayload);

    // Also push a Web Push notification to subscribed eligible drivers
    // (handles closed browser tabs).
    if (global._vapidPublicKey && broadcast.drivers.length) {
      const area         = ride.pickupLocation?.address || 'Nearby';
      const fareStr      = `Rs ${(ride.fare || 0).toLocaleString()}`;
      const distStr      = ride.distance ? ` · ${ride.distance.toFixed(1)} km` : '';
      const customerName = req.user?.name || 'Customer';
      const pushData = {
        title:   '🚗 New Ride Request!',
        body:    `👤 ${customerName}\n📍 ${area}\n💰 ${fareStr}${distStr}`,
        url:     '/driver',
        rideId:  String(ride._id),
        actions: [
          { action: 'accept', title: '✅ Accept Ride' },
          { action: 'reject', title: '❌ Reject Ride' },
          { action: 'open',   title: '📱 Go to App'  }
        ]
      };
      const subscriptions = await PushSub.find({
        user: { $in: broadcast.drivers.map(driver => driver._id) }
      }).lean().catch(() => []);
      subscriptions.forEach(sub => {
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(pushData),
          { urgency: 'high', TTL: 60 }
        ).catch(err => {
          // 410 Gone = subscription expired — clean it up
          if (err.statusCode === 410) PushSub.deleteOne({ _id: sub._id }).catch(() => {});
        });
      });
    }

    // Native Driver installs do not rely on a browser tab or service worker.
    // Send a high-priority platform notification too, so Android/iOS can wake
    // the driver with an actionable alert while the UI is backgrounded.
    if (broadcast.drivers.length) {
      void sendExpoPush(broadcast.drivers.map(driver => driver.expoPushToken), {
        title: 'New ride request',
        body: `${ride.pickupLocation?.address || 'Nearby pickup'} · Rs ${(ride.fare || 0).toLocaleString()}`,
        data: { type: 'ride:new', ride: ridePayload, rideId: String(ride._id) },
        categoryId: 'ride-request'
      });
    }

    res.status(201).json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/available', authMiddleware, driverOnly, async (req, res) => {
  try {
    const driver = await User.findById(req.user.id).select('vehicleType ridePreference accountStatus isOnline longRangeEnabled lastOnlineHeartbeat currentLocation').lean();
    const hasFreshHeartbeat = driver?.lastOnlineHeartbeat &&
      new Date(driver.lastOnlineHeartbeat).getTime() >= Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS;
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline || !hasFreshHeartbeat || !hasValidCoordinates(driver.currentLocation)) {
      return res.status(403).json({ error: 'You must be an approved online driver to receive rides' });
    }
    const [{ maximumRideBroadcastRadiusKm: radiusKm }, longRangeSettings] = await Promise.all([
      getRideBroadcastSettings(), getLongRangeSettings()
    ]);
    const rides = await Ride.find({
      status: 'requested',
      vehicleType: { $in: storedVehicleTypesForFareCategory(driver.vehicleType) }
    })
      .populate('passenger', 'name phone rating')
      .sort({ createdAt: -1 });
    const hasLongRangeRides = rides.some(ride => ride.isLongRange);
    const wallet = hasLongRangeRides
      ? await Wallet.findOne({ user: req.user.id }).select('balance').lean()
      : null;
    res.json(rides.filter(ride => hasValidCoordinates(ride.pickupLocation)
      && canDriverReceiveRideForPreference(driver.ridePreference, ride.isLongRange)
      && (!ride.isLongRange || (longRangeSettings.enabled && driver.longRangeEnabled && Number(wallet?.balance || 0) >= getLongRangeMinimumWalletBalance(longRangeSettings, driver.vehicleType)))
      && haversineKm(
        Number(driver.currentLocation.lat),
        Number(driver.currentLocation.lng),
        Number(ride.pickupLocation.lat),
        Number(ride.pickupLocation.lng)
      ) <= (ride.isLongRange ? longRangeSettings.broadcastRadiusKm : radiusKm)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Native driver runtime endpoints. Background location tasks use REST because
// mobile operating systems may wake them without restoring the JS Socket.io app.
app.post('/api/driver/availability', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Access denied: driver accounts only' });
    }
    const isOnline = req.body?.isOnline === true;
    const driver = await User.findById(req.user.id)
      .select('accountStatus vehicleType ridePreference paidUntilDate lastDailyFeePaidAt isFreeTrial longRangeEnabled').lean();
    if (!driver || driver.accountStatus !== 'active') {
      return res.status(403).json({ error: 'Your driver account is not approved for online availability' });
    }
    if (isOnline) {
      const feeResult = await chargeDailyFeeForOnlineDriver(req.user.id, driver);
      if (!feeResult.allowed) {
        return res.status(403).json({
          error: `Wallet balance must cover today's Daily Fee of Rs ${feeResult.rate.toLocaleString()} before going online. Current balance: Rs ${Number(feeResult.balance).toLocaleString()}.`
        });
      }
    }
    const update = isOnline
      ? { isOnline: true, lastOnlineHeartbeat: new Date() }
      : { isOnline: false };
    await User.updateOne({ _id: req.user.id }, update);
    res.json({ isOnline, vehicleType: normalizeFareVehicle(driver.vehicleType || 'Car Mini'), ridePreference: normalizeRidePreference(driver.ridePreference), longRangeEnabled: !!driver.longRangeEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/driver/long-range', authMiddleware, driverOnly, async (req, res) => {
  try {
    const [driver, wallet, settings] = await Promise.all([
      User.findById(req.user.id).select('longRangeEnabled vehicleType ridePreference').lean(),
      Wallet.findOne({ user: req.user.id }).select('balance').lean(),
      getLongRangeSettings()
    ]);
    res.json({ enabled: !!driver?.longRangeEnabled, walletBalance: Number(wallet?.balance || 0), vehicleType: normalizeFareVehicle(driver?.vehicleType || 'Car Mini'), ridePreference: normalizeRidePreference(driver?.ridePreference), settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/driver/long-range', authMiddleware, driverOnly, async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    const settings = await getLongRangeSettings();
    if (enabled && !settings.enabled) return res.status(403).json({ error: 'Long Range rides are currently disabled by Admin.' });
    if (enabled) {
      const [driver, wallet] = await Promise.all([
        User.findById(req.user.id).select('vehicleType').lean(),
        Wallet.findOne({ user: req.user.id }).select('balance').lean()
      ]);
      const category = normalizeFareVehicle(driver?.vehicleType || 'Car Mini');
      const minimumWalletBalance = getLongRangeMinimumWalletBalance(settings, category);
      if (Number(wallet?.balance || 0) < minimumWalletBalance) {
        return res.status(403).json({ error: `Minimum Wallet Balance of Rs ${minimumWalletBalance.toLocaleString()} required for ${category} to enable Long Range rides.` });
      }
    }
    await User.updateOne({ _id: req.user.id }, { longRangeEnabled: enabled });
    io.to(`user:${req.user.id}`).emit('long-range:updated', { enabled, settings });
    res.json({ enabled, settings, message: enabled
      ? 'Active: You will now receive both local and long-range rides.'
      : 'Deactivated: You will now receive local rides only.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/driver/heartbeat', authMiddleware, driverOnly, async (req, res) => {
  try {
    const driver = await User.findById(req.user.id).select('accountStatus isOnline').lean();
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) {
      return res.status(403).json({ error: 'Driver availability is no longer active' });
    }
    await User.updateOne({ _id: req.user.id }, { lastOnlineHeartbeat: new Date() });
    res.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/driver/location', authMiddleware, driverOnly, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const rideId = req.body?.rideId;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(422).json({ error: 'A valid GPS location is required' });
    }
    const driver = await User.findById(req.user.id).select('accountStatus isOnline').lean();
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) {
      return res.status(403).json({ error: 'Driver availability is no longer active' });
    }
    const updates = { 'currentLocation.lat': lat, 'currentLocation.lng': lng, lastOnlineHeartbeat: new Date() };
    await User.updateOne({ _id: req.user.id }, updates);
    if (rideId) {
      const ride = await Ride.findOne({
        _id: rideId,
        driver: req.user.id,
        status: { $in: ['accepted', 'arrived', 'in-progress'] }
      }).select('_id').lean();
      if (ride) {
        await Ride.updateOne({ _id: rideId }, { 'driverLocation.lat': lat, 'driverLocation.lng': lng });
        io.to(`ride:${rideId}`).emit('driver:location', { lat, lng });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/driver/push-token', authMiddleware, driverOnly, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!/^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token)) {
    return res.status(422).json({ error: 'A valid Expo push token is required' });
  }
  await User.updateOne({ _id: req.user.id }, { expoPushToken: token });
  res.json({ ok: true });
});

app.get('/api/rides/my', authMiddleware, async (req, res) => {
  try {
    const query = req.user.role === 'driver'
      ? { driver: req.user.id }
      : { passenger: req.user.id };
    const rides = await Ride.find(query)
      .populate('passenger driver', 'name phone vehicleType rating')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/:id', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('passenger driver', 'name phone vehicleType rating currentLocation');
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rides/:id/accept', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can accept rides' });
    }
    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, status: 'requested', driver: null },
      { $set: { driver: req.user.id, status: 'accepted' } },
      { new: true }
    ).populate('passenger', 'name phone');

    if (!ride) return res.status(409).json({ error: 'Ride no longer available' });
    if (ride.isLongRange) {
      const settings = await getLongRangeSettings();
      if (!await validateLongRangeDriverEligibility(req.user.id, settings)) {
        await Ride.updateOne({ _id: ride._id, driver: req.user.id, status: 'accepted' }, { $set: { driver: null, status: 'requested' } });
        return res.status(403).json({ error: 'You are not currently eligible for Long Range rides.' });
      }
      const commission = await chargeLongRangeCommission(ride, req.user.id, 'accepted', settings);
      if (!commission.ok) {
        await Ride.updateOne({ _id: ride._id, driver: req.user.id, status: 'accepted' }, { $set: { driver: null, status: 'requested' } });
        return res.status(403).json({ error: commission.error });
      }
    }

    // Generate 4-digit verification PIN for ride start
    const verificationPin = String(Math.floor(1000 + Math.random() * 9000));
    ride.verificationPin = verificationPin;
    await ride.save();

    // Fetch full driver profile for the acceptance payload
    const driverUser = await User.findById(req.user.id).select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    io.to(`ride:${ride._id}`).emit('ride:accepted', {
      rideId: ride._id,
      verificationPin,
      driver: {
        id:           req.user.id,
        name:         driverUser.name,
        phone:        driverUser.phone || '',
        vehicleType:  driverUser.vehicleType,
        vehicleModel: driverUser.vehicleModel || '',
        vehiclePlate: driverUser.vehiclePlate || '',
        rating:       driverUser.rating || 5.0,
        profilePhoto: driverUser.profilePhoto || ''
      }
    });
    io.to(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini')}`).emit('ride:taken', { rideId: ride._id });

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const STATUS_TRANSITIONS = {
  'accepted':   ['arrived', 'cancelled'],
  'arrived':    ['in-progress'],
  'in-progress':['completed']
};

app.patch('/api/rides/:id/status', authMiddleware, driverOnly, async (req, res) => {
  try {
    const { status } = req.body;
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    // Only the assigned driver may advance the ride status
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You are not the driver for this ride' });
    }

    const allowed = STATUS_TRANSITIONS[ride.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from "${ride.status}" to "${status}"` });
    }

    // Validate verification PIN before starting the ride
    if (ride.status === 'arrived' && status === 'in-progress') {
      const { pin } = req.body;
      if (!pin) return res.status(400).json({ error: 'PIN_REQUIRED' });
      if (String(pin).trim() !== String(ride.verificationPin)) {
        return res.status(400).json({ error: 'WRONG_PIN' });
      }
    }

    if (ride.status === 'arrived' && status === 'in-progress') {
      const commission = await chargeLongRangeCommission(ride, req.user.id, 'started', await getLongRangeSettings());
      if (!commission.ok) return res.status(403).json({ error: commission.error });
    }
    ride.status = status;
    await ride.save();

    io.to(`ride:${ride._id}`).emit('ride:status', { rideId: ride._id, status });

    if (status === 'completed') {
      await Wallet.updateOne(
        { user: ride.passenger },
        { $inc: { balance: -ride.fare },
          $push: { transactions: { amount: ride.fare, type: 'debit', description: 'Ride fare' } } }
      );
      const earnings = +(ride.fare * 0.85).toFixed(2);
      await Wallet.updateOne(
        { user: ride.driver },
        { $inc: { balance: earnings, realCashWallet: earnings },   // ride earnings → realCashWallet
          $push: { transactions: { amount: earnings, type: 'credit', description: 'Ride earnings' } } },
        { upsert: true }
      );
      await User.updateOne({ _id: ride.driver },    { $inc: { totalRides: 1 } });
      await User.updateOne({ _id: ride.passenger }, { $inc: { totalRides: 1 } });
    }

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rides/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (!['requested', 'accepted'].includes(ride.status)) {
      return res.status(400).json({ error: 'Cannot cancel at this stage' });
    }

    // Only the passenger who booked or the assigned driver may cancel
    const isPassenger = String(ride.passenger) === String(req.user.id);
    const isDriver    = ride.driver && String(ride.driver) === String(req.user.id);
    if (!isPassenger && !isDriver) {
      return res.status(403).json({ error: 'You are not authorised to cancel this ride' });
    }

    ride.status = 'cancelled';
    await ride.save();
    io.to(`ride:${ride._id}`).emit('ride:status', { rideId: ride._id, status: 'cancelled' });
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/counter — driver submits an offer or counter-offer
app.patch('/api/rides/:id/counter', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
    const { price, type } = req.body;           // type: 'accept' | 'counter'
    if (!price || price < 1) return res.status(400).json({ error: 'Valid price required' });

    const ride = await Ride.findOne({ _id: req.params.id, status: 'requested' });
    if (!ride) return res.status(404).json({ error: 'Ride not available' });
    if (ride.isLongRange) {
      const [driverLongRange, settings, wallet] = await Promise.all([
        User.findById(req.user.id).select('longRangeEnabled vehicleType').lean(),
        getLongRangeSettings(),
        Wallet.findOne({ user: req.user.id }).select('balance').lean()
      ]);
      if (!settings.enabled || !driverLongRange?.longRangeEnabled || Number(wallet?.balance || 0) < getLongRangeMinimumWalletBalance(settings, driverLongRange.vehicleType)) {
        return res.status(403).json({ error: 'You are not currently eligible for Long Range rides.' });
      }
    }

    // Prevent duplicate offers from same driver
    const already = ride.counterOffers.some(o => String(o.driver) === String(req.user.id));
    if (already) return res.status(409).json({ error: 'You already sent an offer for this ride' });

    const driver = await User.findById(req.user.id).select('name vehicleModel vehiclePlate rating');
    const offer = {
      driver:       req.user.id,
      driverName:   driver.name,
      vehicleModel: driver.vehicleModel || '',
      vehiclePlate: driver.vehiclePlate || '',
      rating:       driver.rating || 5.0,
      price:        Number(price),
      type:         type === 'counter' ? 'counter' : 'accept',
      timestamp:    new Date()
    };
    ride.counterOffers.push(offer);
    await ride.save();

    // Emit updated offers list to the customer
    io.to(`ride:${ride._id}`).emit('ride:offers', ride.counterOffers.map(o => ({
      driverId:     String(o.driver),
      driverName:   o.driverName,
      vehicleModel: o.vehicleModel,
      vehiclePlate: o.vehiclePlate,
      rating:       o.rating,
      price:        o.price,
      type:         o.type,
      timestamp:    o.timestamp
    })));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/driver/active-ride — returns the in-progress ride for the authenticated driver
// Used by the driver's Refresh button to force-sync UI after a freeze or missed event
app.get('/api/driver/active-ride', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
    const ride = await Ride.findOne({
      driver: req.user.id,
      status: { $in: ['accepted', 'arrived', 'in-progress'] }
    }).populate('passenger', 'name phone').lean();
    res.json({ ride: ride || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/accept-driver — customer selects a specific driver
app.patch('/api/rides/:id/accept-driver', authMiddleware, async (req, res) => {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, passenger: req.user.id, status: 'requested', driver: null },
      { $set: { driver: driverId, status: 'accepted' } },
      { new: true }
    ).populate('passenger', 'name phone');
    if (!ride) return res.status(409).json({ error: 'Ride no longer available' });

    // Find the agreed price from the offer
    const offer = ride.counterOffers.find(o => String(o.driver) === String(driverId));
    if (offer && offer.price && offer.price !== ride.fare) {
      ride.fare = offer.price;
    }

    // Generate 4-digit verification PIN for ride start
    const verificationPin = String(Math.floor(1000 + Math.random() * 9000));
    ride.verificationPin = verificationPin;
    await ride.save();
    if (ride.isLongRange) {
      const settings = await getLongRangeSettings();
      if (!await validateLongRangeDriverEligibility(driverId, settings)) {
        await Ride.updateOne({ _id: ride._id, driver: driverId, status: 'accepted' }, { $set: { driver: null, status: 'requested', verificationPin: null } });
        return res.status(403).json({ error: 'Selected Driver is no longer eligible for Long Range rides.' });
      }
      const commission = await chargeLongRangeCommission(ride, driverId, 'accepted', settings);
      if (!commission.ok) {
        await Ride.updateOne({ _id: ride._id, driver: driverId, status: 'accepted' }, { $set: { driver: null, status: 'requested', verificationPin: null } });
        return res.status(403).json({ error: commission.error });
      }
    }

    const driverUser = await User.findById(driverId).select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    io.to(`ride:${ride._id}`).emit('ride:accepted', {
      rideId: ride._id,
      verificationPin,
      driver: {
        id:           String(driverId),
        name:         driverUser.name,
        phone:        driverUser.phone || '',
        vehicleType:  driverUser.vehicleType,
        vehicleModel: driverUser.vehicleModel || '',
        vehiclePlate: driverUser.vehiclePlate || '',
        rating:       driverUser.rating || 5.0,
        profilePhoto: driverUser.profilePhoto || ''
      }
    });
    io.to(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini')}`).emit('ride:taken', { rideId: ride._id });

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/update-fare — refresh a pending ride using the current
// Admin-controlled fare rules. Client supplied prices are deliberately ignored.
app.patch('/api/rides/:id/update-fare', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findOne({ _id: req.params.id, passenger: req.user.id, status: 'requested' });
    if (!ride) return res.status(404).json({ error: 'Ride not found or already accepted' });
    const [settingsDoc, ratesDoc, longRangeDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean()
    ]);
    const fareQuote = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      normalizeLongRangeSettings(longRangeDoc?.value),
      ride.vehicleType,
      ride.distance,
      new Date(),
      normalizePerKmRates(ratesDoc?.value)
    );
    if (fareQuote.error) return res.status(422).json({ error: fareQuote.error });
    ride.fare = fareQuote.totalFare;
    ride.fareQuote = fareQuote;
    await ride.save();

    // Re-broadcast updated fare only to drivers of the same vehicle category
    io.to(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini')}`).emit('ride:fare-updated', {
      id:   ride._id,
      fare: ride.fare,
      fareQuote: ride.fareQuote
    });

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Profile Update (phone, password, vehicle) with current-password verification ─
app.post('/api/user/update-profile', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPhone, newPassword, vehicleType, vehicleModel, vehiclePlate, vehicleRegPhoto } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Incorrect current password' });

    const updates = {};
    if (newPhone && newPhone !== user.phone) {
      const clash = await User.findOne({ phone: newPhone, _id: { $ne: user._id } });
      if (clash) return res.status(409).json({ error: 'That phone number is already registered to another account' });
      updates.phone = newPhone.trim();
    }
    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      updates.password = await bcrypt.hash(newPassword, 10);
    }
    const vehicleChangeRequested = vehicleType !== undefined || vehicleModel !== undefined || vehiclePlate !== undefined || vehicleRegPhoto !== undefined;
    if (vehicleChangeRequested) {
      if (user.role !== 'driver') return res.status(403).json({ error: 'Only Drivers can change vehicle information' });
      const model = String(vehicleModel || '').trim();
      const plate = String(vehiclePlate || '').trim().toUpperCase();
      const category = normalizeFareVehicle(vehicleType || user.vehicleType || 'Car Mini');
      if (!model || !plate || !vehicleRegPhoto) {
        return res.status(400).json({ error: 'Vehicle model, number plate, and a new vehicle registration or ownership document are required' });
      }
      if (!FARE_VEHICLE_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'A valid vehicle category is required' });
      }
      // A vehicle document must be a freshly supplied image. Validate before
      // writing the file or changing any persisted driver state.
      parseImageDataUrl(vehicleRegPhoto);
      const replacementDocument = await saveDocToDisk(vehicleRegPhoto, 'vehicleReg');
      if (!replacementDocument) return res.status(422).json({ error: 'Could not save the vehicle document' });
      Object.assign(updates, {
        vehicleModel: model,
        vehiclePlate: plate,
        vehicleType: category,
        vehicleRegPhoto: replacementDocument,
        accountStatus: 'pending',
        identityVerificationStatus: 'pending',
        identityVerifiedAt: null,
        vehicleReviewRequestedAt: new Date(),
        isOnline: false,
        longRangeEnabled: false,
        suspendReason: 'Vehicle details and registration document require Admin review',
        suspendedAt: null
      });
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No changes provided' });

    await User.updateOne({ _id: user._id }, updates);
    const updated = await User.findById(user._id)
      .select('name phone email vehicleModel vehiclePlate vehicleType vehicleRegPhoto accountStatus identityVerificationStatus isOnline longRangeEnabled');
    if (vehicleChangeRequested) {
      io.to(`user:${user._id}`).emit('account:vehicle-review', {
        reason: 'Your new vehicle details are under Admin review. You cannot go online or receive rides until approval.'
      });
    }
    res.json({
      message: vehicleChangeRequested
        ? 'Vehicle details and document submitted for Admin review. You are offline until approval.'
        : 'Profile updated successfully',
      user: updated
    });
  } catch (err) {
    const status = /ID document must|ID document must be between/.test(err.message) ? 422 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Wallet Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/wallet', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(410).json({ error: 'Customer wallets are not available. Pay drivers directly by cash or your own mobile-money account.' });
    }
    let wallet = await Wallet.findOne({ user: req.user.id });
    if (!wallet) wallet = await Wallet.create({ user: req.user.id, balance: 0, transactions: [] });
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallet/add-funds', authMiddleware, async (req, res) => {
  return res.status(410).json({
    error: 'Customer wallet top-ups have been removed. Customers pay drivers directly by cash or their own mobile-money account.'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payment Routes (Driver Wallet / TRX submission)
// ─────────────────────────────────────────────────────────────────────────────

// Daily earnings targets per vehicle category (PKR)
const DAILY_TARGETS   = {
  Bike: 2500,
  Rickshaw: 4000,
  'Car Mini': 5500,
  'Car AC': 6500,
  'Toyota Highroof': 8000,
  'Toyota Saloon Coaster': 9000
};
// Helper: today's date string in UTC (YYYY-MM-DD)
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/payments/submit — driver submits daily TRX ID
app.post('/api/payments/submit', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can submit payments' });
    }
    const { trxId, amount, paymentType, proofScreenshot } = req.body;
    const cleanTrx = (trxId || '').trim().toUpperCase();

    // ── Format validation ──────────────────────────────────────────────────
    if (!cleanTrx) {
      return res.status(400).json({ error: 'TRX ID is required' });
    }
    if (cleanTrx.length < 8) {
      return res.status(400).json({ error: 'TRX ID must be at least 8 characters' });
    }
    // Allow letters, digits, hyphens and underscores; reject anything else
    if (!/^[A-Za-z0-9\-_]+$/.test(cleanTrx)) {
      return res.status(400).json({ error: 'TRX ID may only contain letters, digits, hyphens and underscores' });
    }
    // Reject obviously fake IDs (all identical characters, e.g. "111111111" or "xxxxxxxxx")
    if (/^(.)\1+$/.test(cleanTrx)) {
      return res.status(400).json({ error: 'Invalid TRX ID — please enter the real transaction reference' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'A valid amount is required' });
    }
    try {
      parseImageDataUrl(proofScreenshot);
    } catch {
      return res.status(422).json({ error: 'A valid payment proof screenshot (JPEG, PNG, or WebP; max 6 MB) is required' });
    }

    const driver = await User.findById(req.user.id).select('vehicleType');
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const configuredFee = await getDailyFeeForVehicle(driver.vehicleType);
    if (!Number.isFinite(configuredFee) || configuredFee <= 0) {
      return res.status(422).json({ error: 'Daily Fee is not configured for your vehicle category. Please contact Admin.' });
    }
    if (Math.abs(Number(amount) - configuredFee) > 0.001) {
      return res.status(422).json({ error: `Payment amount must equal the current Daily Fee of Rs ${configuredFee.toLocaleString()}.` });
    }

    // ── Global TRX ID uniqueness (prevents reuse across drivers) ───────────
    const trxDuplicate = await Payment.findOne({ trxId: cleanTrx });
    if (trxDuplicate) {
      return res.status(409).json({ error: 'This Transaction ID has already been used. If you believe this is an error, contact admin.' });
    }

    const dateStr = todayUTC();
    // Uniqueness: one submission per driver per day
    const existing = await Payment.findOne({ driver: req.user.id, submittedDate: dateStr });
    if (existing) {
      return res.status(409).json({ error: 'You have already submitted a payment for today. Wait for admin review before resubmitting.' });
    }

    const validTypes = ['jazzcash', 'easypaisa', 'bank', 'sadapay'];
    const payment = await Payment.create({
      driver:          req.user.id,
      trxId:           cleanTrx,
      amount:          configuredFee,
      paymentType:     validTypes.includes(paymentType) ? paymentType : 'jazzcash',
      vehicleCategory: driver.vehicleType || 'Car Mini',
      submittedDate:   dateStr,
      proofScreenshot,
      auditLog: [{
        action: 'pending',
        actorId: String(req.user.id),
        actorRole: 'driver',
        reason: 'Driver submitted payment proof'
      }]
    });

    res.status(201).json(payment);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This TRX ID or today’s payment submission already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Gateway callbacks are intentionally disabled. Every Driver recharge remains
// pending until an authorized Admin reviews the submitted proof and approves it.
function disabledPaymentWebhook(_req, res) {
  return res.status(410).json({
    error: 'Gateway auto-approval is disabled. Driver payments require manual Admin approval.'
  });
}
app.post('/api/payments/verify', disabledPaymentWebhook);
app.post('/api/v1/payments/webhook/:gateway', disabledPaymentWebhook);

function paymentAdminActor(admin) {
  return {
    id: String(admin?.email || admin?.id || admin?.sub || 'unknown-admin'),
    role: admin?.isSuperAdmin ? 'super-admin' : 'sub-admin'
  };
}

async function approveDriverPayment(paymentId, admin, adminNote = '') {
  const now = new Date();
  const actor = paymentAdminActor(admin);
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: 'pending' },
    {
      $set: {
        status: 'approved',
        adminNote: String(adminNote || '').trim(),
        approvedBy: actor.id,
        approvedAt: now
      }
    },
    { new: true }
  );
  if (!payment) return null;

  const passValidUntil = new Date(now.getTime() + ACTIVE_FEE_PASS_MS);
  const wallet = await Wallet.findOneAndUpdate(
    { user: payment.driver },
    {
      $inc: { balance: payment.amount, realCashWallet: payment.amount },
      $set: { fee_paid_at: now },
      $push: {
        transactions: {
          amount: payment.amount,
          type: 'credit',
          description: `Approved driver recharge (TRX ${payment.trxId})`,
          paymentMethod: payment.paymentType,
          mobileAccount: payment.trxId
        }
      }
    },
    { new: true, upsert: true }
  );
  await User.updateOne(
    { _id: payment.driver },
    { lastDailyFeePaidAt: now, paidUntilDate: passValidUntil, isFreeTrial: false }
  );
  await Payment.updateOne(
    { _id: payment._id },
    {
      $push: {
        auditLog: {
          action: 'approved',
          actorId: actor.id,
          actorRole: actor.role,
          reason: String(adminNote || '').trim(),
          balanceBefore: Number(wallet.balance) - Number(payment.amount),
          balanceAfter: Number(wallet.balance),
          passValidUntil,
          createdAt: now
        }
      }
    }
  );
  return { payment, wallet, passValidUntil, actor };
}

async function rejectDriverPayment(paymentId, admin, reason = '') {
  const actor = paymentAdminActor(admin);
  const wallet = await Wallet.findOne({ user: (await Payment.findById(paymentId).select('driver'))?.driver })
    .select('balance').lean();
  const balance = Number(wallet?.balance || 0);
  return Payment.findOneAndUpdate(
    { _id: paymentId, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        adminNote: String(reason || '').trim(),
        rejectedBy: actor.id,
        rejectedAt: new Date()
      },
      $push: {
        auditLog: {
          action: 'rejected',
          actorId: actor.id,
          actorRole: actor.role,
          reason: String(reason || '').trim(),
          balanceBefore: balance,
          balanceAfter: balance,
          createdAt: new Date()
        }
      }
    },
    { new: true }
  );
}

// GET /api/payments/my — driver's own payment history
app.get('/api/payments/my', authMiddleware, driverOnly, async (req, res) => {
  try {
    const payments = await Payment.find({ driver: req.user.id })
      .sort({ createdAt: -1 })
      .limit(30);
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallet/status — driver's wallet status vs daily target
app.get('/api/wallet/status', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers have a payment wallet status' });
    }
    const driver = await User.findById(req.user.id).select('vehicleType');
    const category = driver?.vehicleType || 'Car Mini';
    const target   = DAILY_TARGETS[category] || 5500;

    // Sum all approved payments ever
    const result = await Payment.aggregate([
      { $match: { driver: new mongoose.Types.ObjectId(req.user.id), status: 'approved' } },
      { $group: { _id: null, totalApproved: { $sum: '$amount' } } }
    ]);
    const totalApproved = result[0]?.totalApproved || 0;

    // Today's ride earnings: sum of 'Ride earnings' wallet credits for the current UTC day
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setUTCHours(23, 59, 59, 999);

    const wallet = await Wallet.findOne({ user: req.user.id });
    const todayRideEarnings = wallet
      ? wallet.transactions
          .filter(t =>
            t.type === 'credit' &&
            t.description === 'Ride earnings' &&
            t.createdAt >= todayStart &&
            t.createdAt <= todayEnd
          )
          .reduce((sum, t) => sum + t.amount, 0)
      : 0;

    const remaining = Math.max(0, target - totalApproved - todayRideEarnings);

    // Today's submission (if any)
    const todayPayment = await Payment.findOne({ driver: req.user.id, submittedDate: todayUTC() });

    res.json({ category, target, totalApproved, todayRideEarnings, remaining, todayPayment: todayPayment || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/pending — admin: list pending submissions
app.get('/api/payments/pending', adminJwt, requirePerm('viewPayments'), async (req, res) => {
  try {
    const payments = await Payment.find({ status: 'pending' })
      .populate('driver', 'name phone vehicleType')
      .sort({ createdAt: 1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payments/:id/approve — admin
app.patch('/api/payments/:id/approve', adminJwt, requirePerm('approveWalletTopups'), async (req, res) => {
  return res.status(410).json({ error: 'Use the Admin Panel payment approval workflow so the decision is fully audited.' });
});

// PATCH /api/payments/:id/reject — admin
app.patch('/api/payments/:id/reject', adminJwt, requirePerm('approveWalletTopups'), async (req, res) => {
  return res.status(410).json({ error: 'Use the Admin Panel payment rejection workflow so the decision is fully audited.' });
});

// GET /api/payments/history — admin: recently approved/rejected submissions
app.get('/api/payments/history', adminJwt, requirePerm('viewPayments'), async (req, res) => {
  try {
    const payments = await Payment.find({ status: { $in: ['approved', 'rejected'] } })
      .populate('driver', 'name phone vehicleType')
      .sort({ updatedAt: -1 })
      .limit(50);
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOS Route
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/sos', authMiddleware, async (req, res) => {
  try {
    const { location, message, rideId, driverInfo } = req.body;
    // Fetch user's emergency contacts for the alert
    const userDoc = await User.findById(req.user.id).select('emergencyContacts name phone');
    const sos = await SOS.create({
      user:     req.user.id,
      location: location || { lat: 0, lng: 0 },
      message:  message  || 'SOS Emergency Alert!',
      ride:     rideId   || null
    });
    const sosPayload = {
      sosId:             sos._id,
      userId:            req.user.id,
      userName:          req.user.name,
      userPhone:         userDoc?.phone || '',
      location, message, rideId,
      driverInfo:        driverInfo || null,
      emergencyContacts: userDoc?.emergencyContacts || [],
      ts: new Date().toISOString()
    };
    io.emit('sos:alert', sosPayload);
    io.to('admin-room').emit('sos:alert', sosPayload); // explicit to admin room
    res.status(201).json({
      success: true, sos,
      emergencyContacts: userDoc?.emergencyContacts || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Geocode Proxy — forwards to LocationIQ (if LOCATIONIQ_KEY set) or Nominatim
// Keeps API keys server-side and adds a proper User-Agent for Nominatim ToS.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);

  try {
    const key = process.env.LOCATIONIQ_KEY;
    let url, headers = {};

    if (key) {
      // LocationIQ — superior Pakistani locality / neighbourhood data
      url = `https://us1.locationiq.com/v1/search` +
            `?key=${encodeURIComponent(key)}` +
            `&q=${encodeURIComponent(q)}` +
            `&format=json&limit=8&countrycodes=pk` +
            `&addressdetails=1&normalizeaddress=1&dedupe=1&namedetails=1`;
    } else {
      // Enhanced Nominatim fallback (OSM data, good for major Pakistani areas)
      url = `https://nominatim.openstreetmap.org/search` +
            `?q=${encodeURIComponent(q)}` +
            `&format=json&limit=8&countrycodes=pk` +
            `&addressdetails=1&dedupe=1&namedetails=1`;
      headers = {
        'User-Agent': 'MyRide-App/1.0 (ride-hailing)',
        'Accept-Language': 'en,ur'
      };
    }

    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Geocode upstream ${r.status}`);
    const data = await r.json();
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('Geocode error:', err.message);
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin Routes  (/api/admin/*)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/login — password is persisted only as a hash after setup.
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@myride.com';
    if (!email || !password || String(email).trim().toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const security = await getAdminSecurity();
    if (!(await verifySuperAdminPassword(password, security))) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const token = jwt.sign(
      { isAdmin: true, email: adminEmail, adminSessionVersion: security.sessionVersion },
      JWT_SECRET, { expiresIn: '12h' }
    );
    res.json({ token, admin: { email: adminEmail, recoveryKeyConfigured: !!security.recoveryKeyHash } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/security/status', adminJwt, requireSuperAdmin, async (_req, res) => {
  try {
    const security = await getAdminSecurity();
    res.json({ recoveryKeyConfigured: !!security.recoveryKeyHash, passwordManaged: !!security.passwordHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/security/password', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!validateStrongPassword(newPassword)) {
      return res.status(422).json({ error: 'New password must be at least 10 characters' });
    }
    const security = await getAdminSecurity();
    if (!(await verifySuperAdminPassword(currentPassword, security))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await saveAdminSecurity({
      ...security,
      passwordHash: await bcrypt.hash(newPassword, 12),
      sessionVersion: security.sessionVersion + 1
    });
    res.json({ success: true, message: 'Password changed. Please sign in again.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/security/recovery-key', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const { currentPassword, recoveryKey } = req.body || {};
    if (!validateRecoveryKey(recoveryKey)) {
      return res.status(422).json({ error: 'Secret Recovery Key must be at least 12 characters' });
    }
    const security = await getAdminSecurity();
    if (!(await verifySuperAdminPassword(currentPassword, security))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await saveAdminSecurity({
      ...security,
      recoveryKeyHash: await bcrypt.hash(recoveryKey.trim(), 12)
    });
    res.json({ success: true, recoveryKeyConfigured: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/forgot-password', async (req, res) => {
  try {
    const genericError = 'Unable to reset the password with those recovery details';
    if (!throttleAdminRecovery(req)) return res.status(429).json({ error: 'Too many recovery attempts. Try again later.' });
    const { email, recoveryKey, newPassword } = req.body || {};
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@myride.com';
    if (!validateStrongPassword(newPassword) || !validateRecoveryKey(recoveryKey) ||
        String(email || '').trim().toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(401).json({ error: genericError });
    }
    const security = await getAdminSecurity();
    if (!security.recoveryKeyHash || !(await bcrypt.compare(recoveryKey.trim(), security.recoveryKeyHash))) {
      return res.status(401).json({ error: genericError });
    }
    await saveAdminSecurity({
      ...security,
      passwordHash: await bcrypt.hash(newPassword, 12),
      sessionVersion: security.sessionVersion + 1
    });
    clearAdminRecoveryThrottle(req);
    res.json({ success: true, message: 'Password reset. Sign in with your new password.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Customer identity files are private. They are intentionally not under /uploads.
app.get('/api/admin/customer-identity/:userId/:side', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const field = req.params.side === 'front' ? 'customerIdFront' : req.params.side === 'back' ? 'customerIdBack' : '';
    if (!field) return res.status(400).json({ error: 'Document side must be front or back' });
    const customer = await User.findOne({ _id: req.params.userId, role: 'customer' })
      .select(`${field} identityVerifiedAt`);
    const filename = customer?.[field];
    if (!filename) return res.status(404).json({ error: 'Identity document not found' });
    const filePath = path.join(CUSTOMER_ID_UPLOADS_DIR, path.basename(filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Identity document not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(filePath);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/sub-user/login — sub-admin credential login
app.post('/api/admin/sub-user/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const sub = await SubAdmin.findOne({ username: username.trim() });
    if (!sub) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, sub.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    if (sub.isBlocked) return res.status(403).json({ error: 'Your sub-admin account is currently blocked by Super Admin.' });
    const permissions = normalizeSubAdminPermissions(sub.permissions);
    const token = jwt.sign(
      { isSubAdmin: true, subAdminId: sub._id, username: sub.username },
      JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({ token, subAdmin: { id: sub._id, username: sub.username, permissions } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/session — refresh the current Admin identity and permissions.
app.get('/api/admin/session', adminJwt, async (req, res) => {
  res.json({
    isSuperAdmin: !!req.admin.isSuperAdmin,
    email: req.admin.email || req.admin.username || '',
    permissions: req.admin.isSuperAdmin ? {} : normalizeSubAdminPermissions(req.admin.permissions)
  });
});

// POST /api/admin/sub-users/create — super-admin only; enforces 50-user cap
app.post('/api/admin/sub-users/create', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const count = await SubAdmin.countDocuments();
    if (count >= 50) return res.status(400).json({ error: 'Maximum limit of 50 sub-admin users reached.' });
    const { username, password, permissions } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (await SubAdmin.findOne({ username: username.trim() }))
      return res.status(409).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    const sub = await SubAdmin.create({
      username: username.trim(), password: hashed,
      permissions: normalizeSubAdminPermissions(permissions)
    });
    res.json({ success: true, subAdmin: { id: sub._id, username: sub.username, permissions: sub.permissions, createdAt: sub.createdAt } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/sub-users/list
app.get('/api/admin/sub-users/list', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const subs = await SubAdmin.find().select('-password').sort('-createdAt');
    res.json(subs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/sub-users/update — update permissions, password, and/or isBlocked
app.put('/api/admin/sub-users/update', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const { id, permissions, password, isBlocked } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const setFields = {};
    if (permissions) {
      setFields.permissions = normalizeSubAdminPermissions(permissions);
    }
    if (typeof isBlocked === 'boolean') setFields.isBlocked = isBlocked;
    if (password && password.trim()) setFields.password = await bcrypt.hash(password.trim(), 10);
    const sub = await SubAdmin.findByIdAndUpdate(id, { $set: setFields }, { new: true }).select('-password');
    if (!sub) return res.status(404).json({ error: 'Sub-admin not found' });
    res.json({ success: true, subAdmin: sub });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Keep legacy alias so any existing callers still work
app.put('/api/admin/sub-users/update-permissions', adminJwt, requireSuperAdmin, async (req, res) => {
  req.body = { ...req.body, id: req.body.id };
  const { id, permissions } = req.body;
  if (!id || !permissions) return res.status(400).json({ error: 'id and permissions required' });
  try {
    const sub = await SubAdmin.findByIdAndUpdate(id,
      { $set: { permissions: normalizeSubAdminPermissions(permissions) }}, { new: true }
    ).select('-password');
    if (!sub) return res.status(404).json({ error: 'Sub-admin not found' });
    res.json({ success: true, subAdmin: sub });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/sub-users/delete/:id
app.delete('/api/admin/sub-users/delete/:id', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const sub = await SubAdmin.findByIdAndDelete(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Sub-admin not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/stats — overview dashboard numbers
app.get('/api/admin/stats', adminJwt, requirePerm('viewOverview'), async (req, res) => {
  try {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const [totalDrivers, pendingDrivers, suspendedDrivers, totalPassengers,
           blockedPassengers, activeRides, pendingPayments, unresolvedSOS] =
      await Promise.all([
        User.countDocuments({ role: 'driver' }),
        User.countDocuments({ role: 'driver', accountStatus: 'pending' }),
        User.countDocuments({ role: 'driver', accountStatus: 'suspended' }),
        User.countDocuments({ role: 'customer' }),
        User.countDocuments({ role: 'customer', accountStatus: 'blocked' }),
        Ride.countDocuments({ status: { $in: ['requested','accepted','arrived','in-progress'] } }),
        Payment.countDocuments({ status: 'pending' }),
        SOS.countDocuments({ resolved: false })
      ]);
    const earningsAgg = await Payment.aggregate([
      { $match: { status: 'approved', updatedAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    res.json({
      totalDrivers, pendingDrivers, suspendedDrivers, totalPassengers,
      blockedPassengers, activeRides, pendingPayments, unresolvedSOS,
      todayEarnings: earningsAgg[0]?.total || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/search?q= — permission-scoped profile search. Private
// customer identity files are represented only by availability flags; their
// bytes remain behind the Super Admin-only download endpoint.
app.get('/api/admin/search', adminJwt, requireProfileSearchAccess, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json([]);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(escaped, 'i');
    const allowedRoles = req.admin?.isSuperAdmin
      ? ['customer', 'driver']
      : [
          hasAdminPermission(req.admin, 'viewCustomers') && 'customer',
          hasAdminPermission(req.admin, 'viewDrivers') && 'driver'
        ].filter(Boolean);
    const users = await User.find({
      $and: [
        { role: { $in: allowedRoles } },
        { $or: [
          { name: matcher }, { phone: matcher }, { email: matcher },
          { cnicNumber: matcher }, { nationalIdLast4: matcher },
          { vehicleType: matcher }, { vehicleModel: matcher }, { vehiclePlate: matcher }
        ] }
      ]
    })
      .select('name email phone role cnicNumber vehicleType vehicleModel vehiclePlate accountStatus suspendReason suspendedAt isOnline rating totalRides createdAt profilePhoto cnicFront cnicBack licensePhoto vehicleRegPhoto identityVerificationStatus identityVerifiedAt +customerIdFront +customerIdBack')
      .sort({ role: 1, name: 1 })
      .limit(50)
      .lean();
    res.json(users.map(user => ({
      ...user,
      hasCustomerIdentityDocuments: user.role === 'customer' && !!(user.customerIdFront || user.customerIdBack),
      customerIdFront: undefined,
      customerIdBack: undefined
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/drivers?status=all|pending|approved|suspended|blocked
app.get('/api/admin/drivers', adminJwt, requirePerm('viewDrivers'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'driver' };
    if (status && status !== 'all') filter.accountStatus = status;
    const drivers = await User.find(filter)
      .select('-password -otpCode -otpExpiry')
      .sort('-createdAt').limit(200);
    res.json(drivers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/passengers?status=all|pending|active|blocked
app.get('/api/admin/passengers', adminJwt, requirePerm('viewCustomers'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'customer' };
    if (['pending', 'active', 'blocked', 'suspended'].includes(status)) filter.accountStatus = status;
    const passengers = await User.find(filter)
      .select('-password -otpCode -otpExpiry')
      .sort('-createdAt').limit(200);
    // Attach ride count to each passenger
    const withCounts = await Promise.all(passengers.map(async p => {
      const rideCount = await Ride.countDocuments({ passenger: p._id });
      return { ...p.toObject(), rideCount };
    }));
    res.json(withCounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/users/:id/status — approve|suspend|block|unblock
app.patch('/api/admin/users/:id/status', adminJwt, async (req, res) => {
  try {
    const { action, reason } = req.body;
    const target = await User.findById(req.params.id).select('role');
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!['driver', 'customer'].includes(target.role)) {
      return res.status(403).json({ error: 'Only Driver and Customer accounts can be managed from this endpoint' });
    }

    // This route has multiple action/target combinations, so it cannot use a
    // single generic permission guard. The matrix below is exhaustive and
    // fail-closed; any missing action or role combination is denied.
    const requiredPermission = {
      driver: {
        approve: 'manageDriverApprovals',
        reject: 'manageDriverApprovals',
        suspend: 'manageDriverStatus',
        block: 'manageDriverStatus',
        unblock: 'manageDriverStatus'
      },
      customer: {
        approve: 'manageCustomers',
        reject: 'manageCustomers',
        suspend: 'manageCustomers',
        block: 'manageCustomers',
        unblock: 'manageCustomers'
      }
    }[target.role]?.[action];
    if (action === 'reject-deletion' && !req.admin.isSuperAdmin) {
      return res.status(403).json({ error: 'Permission denied: Super Admin required for deletion requests' });
    }
    if (action !== 'reject-deletion' && !requiredPermission) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    if (!req.admin.isSuperAdmin && !hasAdminPermission(req.admin, requiredPermission)) {
      return res.status(403).json({ error: `Permission denied: ${requiredPermission} required` });
    }

    let update = {};
    if      (action === 'approve')          update = { accountStatus: 'active', identityVerificationStatus: 'approved', vehicleReviewRequestedAt: null, suspendReason: '', suspendedAt: null };
    else if (action === 'suspend')          update = { accountStatus: 'suspended', suspendReason: reason || 'Temporary suspension', suspendedAt: new Date() };
    else if (action === 'block')            update = { accountStatus: 'blocked',   suspendReason: reason || 'Permanently blocked',  suspendedAt: new Date() };
    else if (action === 'unblock')          update = { accountStatus: 'active',    suspendReason: '', suspendedAt: null };
    else if (action === 'reject-deletion')  update = { accountStatus: 'active',    suspendReason: '', suspendedAt: null };
    else if (action === 'reject')           update = { accountStatus: 'blocked', identityVerificationStatus: 'rejected', suspendReason: reason || 'Identity documents rejected', suspendedAt: new Date() };
    else return res.status(400).json({ error: 'Invalid action' });

    const user = await User.findByIdAndUpdate(target._id, { ...update, isOnline: false }, { new: true }).select('-password');

    if (action === 'suspend' || action === 'block' || action === 'reject')
      io.to(`user:${req.params.id}`).emit('account:suspended', { reason: reason || 'Account suspended' });
    if (action === 'approve' || action === 'unblock' || action === 'reject-deletion')
      io.to(`user:${req.params.id}`).emit('account:activated', {});

    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/account-deletion-requests
app.get('/api/admin/account-deletion-requests', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const users = await User.find({ accountStatus: 'pending_deletion' })
      .select('name phone email role vehicleType createdAt updatedAt')
      .sort('-updatedAt')
      .lean();
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/users/:id — permanently purge a user account
app.delete('/api/admin/users/:id', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('name role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Disconnect live socket session
    io.to(`user:${req.params.id}`).emit('account:deleted', { reason: 'Your account has been permanently deleted.' });
    await User.deleteOne({ _id: req.params.id });
    res.json({ success: true, name: user.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET/PATCH /api/admin/ride-retention — Super Admin controls the ride-only
// retention policy. This setting never changes user, wallet, or file records.
app.get('/api/admin/ride-retention', adminJwt, requireSuperAdmin, async (_req, res) => {
  try {
    const days = await getRideRetentionDays();
    res.json({ days, statuses: ['completed', 'cancelled'] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/ride-retention', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const validated = validateRideRetentionDays(req.body?.days);
    if (validated.error) return res.status(422).json({ error: validated.error });
    await Settings.findOneAndUpdate(
      { key: RIDE_RETENTION_SETTINGS_KEY },
      { key: RIDE_RETENTION_SETTINGS_KEY, value: { days: validated.days } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, days: validated.days, statuses: ['completed', 'cancelled'] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ride-retention/purge', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const configuredDays = await getRideRetentionDays();
    const requested = req.body?.days === undefined
      ? { days: configuredDays, error: null }
      : validateRideRetentionDays(req.body.days);
    if (requested.error) return res.status(422).json({ error: requested.error });
    const cutoff = new Date(Date.now() - requested.days * 24 * 60 * 60 * 1000);
    // Intentionally delete only Ride documents. No User, Wallet, or filesystem
    // operation belongs in this handler.
    const result = await Ride.deleteMany({
      status: { $in: ['completed', 'cancelled'] },
      createdAt: { $lt: cutoff }
    });
    res.json({
      success: true,
      deletedCount: result.deletedCount || 0,
      days: requested.days,
      cutoff: cutoff.toISOString(),
      statuses: ['completed', 'cancelled']
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/rides?status=active|completed|cancelled|all&date=YYYY-MM-DD
app.get('/api/admin/rides', adminJwt, requirePerm('viewRides'), async (req, res) => {
  try {
    const { status, date } = req.query;
    const filter = {};
    if (status === 'active') filter.status = { $in: ['requested','accepted','arrived','in-progress'] };
    else if (status && status !== 'all') filter.status = status;
    if (date) {
      const d = new Date(date); d.setUTCHours(0,0,0,0);
      const d2 = new Date(d);   d2.setUTCHours(23,59,59,999);
      filter.createdAt = { $gte: d, $lte: d2 };
    }
    const rides = await Ride.find(filter)
      .populate('passenger', 'name phone')
      .populate('driver',    'name phone vehicleModel vehiclePlate')
      .sort('-createdAt').limit(100);
    res.json(rides);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/sos?resolved=false|true|all
app.get('/api/admin/sos', adminJwt, requirePerm('viewSOS'), async (req, res) => {
  try {
    const { resolved } = req.query;
    const filter = {};
    if (resolved === 'false') filter.resolved = false;
    else if (resolved === 'true') filter.resolved = true;
    const alerts = await SOS.find(filter)
      .populate('user', 'name phone role')
      .populate('ride')
      .sort('-createdAt').limit(50);
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/sos/:id/resolve', adminJwt, requirePerm('manageSOS'), async (req, res) => {
  try {
    await SOS.updateOne({ _id: req.params.id }, { resolved: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/payments?status=pending|approved|rejected|all
app.get('/api/admin/payments', adminJwt, requirePerm('viewPayments'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const selectFields = hasAdminPermission(req.admin, 'viewPaymentProofs') ? '+proofScreenshot' : '';
    const payments = await Payment.find(filter)
      .select(selectFields)
      .populate('driver', 'name phone vehicleType vehiclePlate')
      .sort('-createdAt').limit(100);
    res.json(payments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/payments/:id/approve', adminJwt, requirePerm('approveWalletTopups'), async (req, res) => {
  try {
    const approved = await approveDriverPayment(req.params.id, req.admin, req.body?.note);
    if (!approved) return res.status(409).json({ error: 'Payment is no longer pending and cannot be approved again.' });
    const notification = {
      paymentId: String(approved.payment._id),
      trxId: approved.payment.trxId,
      amount: approved.payment.amount,
      status: 'approved',
      paidUntilDate: approved.passValidUntil.toISOString()
    };
    io.to(`user:${approved.payment.driver}`).emit('payment:approved', notification);
    io.to('admin-room').emit('payment:approved', notification);
    res.json({
      success: true,
      payment: approved.payment,
      balanceBefore: Number(approved.wallet.balance) - Number(approved.payment.amount),
      balanceAfter: approved.wallet.balance,
      passValidUntil: approved.passValidUntil
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/payments/:id/reject', adminJwt, requirePerm('approveWalletTopups'), async (req, res) => {
  try {
    const { reason } = req.body;
    const payment = await rejectDriverPayment(req.params.id, req.admin, reason);
    if (!payment) return res.status(409).json({ error: 'Payment is no longer pending and cannot be rejected.' });
    io.to(`user:${payment.driver}`).emit('payment:rejected', { reason: reason || 'Rejected' });
    res.json({ success: true, payment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read-only operational audit view. Private proof images are never included
// here; they remain behind the separate viewPaymentProofs permission.
app.get('/api/admin/audit-logs', adminJwt, requirePerm('viewAuditLogs'), async (_req, res) => {
  try {
    const payments = await Payment.find({ 'auditLog.0': { $exists: true } })
      .select('driver trxId amount status paymentType auditLog approvedAt rejectedAt')
      .populate('driver', 'name phone vehicleType')
      .sort('-updatedAt')
      .limit(200)
      .lean();
    const entries = payments.flatMap(payment => (payment.auditLog || []).map(entry => ({
      ...entry,
      paymentId: String(payment._id),
      trxId: payment.trxId,
      amount: payment.amount,
      paymentType: payment.paymentType,
      paymentStatus: payment.status,
      driver: payment.driver
    }))).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 300);
    res.json(entries);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile Photo Upload
// ─────────────────────────────────────────────────────────────────────────────

app.put('/api/auth/profile/photos', authMiddleware, async (req, res) => {
  try {
    const { profilePhoto, licensePhoto, cnicFront, cnicBack, vehicleRegPhoto } = req.body;
    const update = {};
    if (profilePhoto    !== undefined) update.profilePhoto    = await saveDocToDisk(profilePhoto,    'profile');
    if (licensePhoto    !== undefined) update.licensePhoto    = await saveDocToDisk(licensePhoto,    'license');
    if (cnicFront       !== undefined) update.cnicFront       = await saveDocToDisk(cnicFront,       'cnicFront');
    if (cnicBack        !== undefined) update.cnicBack        = await saveDocToDisk(cnicBack,        'cnicBack');
    if (vehicleRegPhoto !== undefined) update.vehicleRegPhoto = await saveDocToDisk(vehicleRegPhoto, 'vehicleReg');
    await User.updateOne({ _id: req.user.id }, update);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ride Review / Rating
// ─────────────────────────────────────────────────────────────────────────────

app.patch('/api/rides/:id/review', authMiddleware, async (req, res) => {
  try {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (String(ride.passenger) !== String(req.user.id)) return res.status(403).json({ error: 'Not your ride' });
    if (ride.status !== 'completed') return res.status(400).json({ error: 'Ride not completed' });
    if (ride.driverRating !== null) return res.status(409).json({ error: 'Already reviewed' });
    ride.driverRating = Number(rating);
    ride.driverReview = (review || '').trim();
    await ride.save();
    // Update driver average rating
    if (ride.driver) {
      const ratings = await Ride.find({ driver: ride.driver, driverRating: { $ne: null } }).select('driverRating');
      const avg = ratings.reduce((s, r) => s + r.driverRating, 0) / ratings.length;
      await User.updateOne({ _id: ride.driver }, { rating: +avg.toFixed(1), $inc: { totalRides: 0 } });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/rides/:id/review-passenger — driver rates the customer after completion
app.patch('/api/rides/:id/review-passenger', authMiddleware, async (req, res) => {
  try {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (String(ride.driver) !== String(req.user.id)) return res.status(403).json({ error: 'Not your ride' });
    if (ride.status !== 'completed') return res.status(400).json({ error: 'Ride not completed' });
    if (ride.customerRating !== null) return res.status(409).json({ error: 'Already reviewed' });
    ride.customerRating = Number(rating);
    ride.customerReview = (review || '').trim();
    await ride.save();
    // Update passenger average rating
    if (ride.passenger) {
      const ratings = await Ride.find({ passenger: ride.passenger, customerRating: { $ne: null } }).select('customerRating');
      const avg = ratings.reduce((s, r) => s + r.customerRating, 0) / ratings.length;
      await User.updateOne({ _id: ride.passenger }, { rating: +avg.toFixed(1) });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Support Tickets
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/support/my — user's own tickets with replies
app.get('/api/support/my', authMiddleware, async (req, res) => {
  try {
    const tickets = await Ticket.find({ user: req.user.id }).sort('-createdAt').limit(50);
    res.json(tickets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/support/my/read — mark all replied tickets as read for this user
app.patch('/api/support/my/read', authMiddleware, async (req, res) => {
  try {
    await Ticket.updateMany(
      { user: req.user.id, adminReply: { $ne: '' }, readByUser: false },
      { readByUser: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/wallet/summary — driver's wallet balance, bonus credits, ledger
app.get('/api/wallet/summary', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
    const driver = await User.findById(req.user.id).select('vehicleType');
    const vehicleType = driver?.vehicleType || 'Car Mini';

    const wallet = await Wallet.findOne({ user: req.user.id });
    const balance      = wallet?.balance || 0;
    const transactions = wallet?.transactions || [];

    // Sum all bonus/promotional credits
    const totalBonus = transactions
      .filter(t => t.type === 'credit' &&
        (t.description?.toLowerCase().includes('bonus') ||
         t.description?.toLowerCase().includes('trial') ||
         t.description?.toLowerCase().includes('promotional')))
      .reduce((s, t) => s + t.amount, 0);

    // Recent ledger — last 40 entries newest first
    const ledger = [...transactions].reverse().slice(0, 40).map(t => ({
      amount: t.amount, type: t.type, description: t.description, createdAt: t.createdAt
    }));

    // Today's payment submission
    const todayPayment = await Payment.findOne({ driver: req.user.id, submittedDate: todayUTC() });

    const realCashWallet = wallet?.realCashWallet || 0;
    const bonusWalletAmt = wallet?.bonusWallet    || 0;
    res.json({ balance, totalBonus, vehicleType, ledger, todayPayment: todayPayment || null,
               realCashWallet, bonusWallet: bonusWalletAmt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/support/ticket', authMiddleware, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject?.trim() || !message?.trim()) return res.status(400).json({ error: 'Subject and message required' });
    const ticket = await Ticket.create({
      user: req.user.id, role: req.user.role || 'customer',
      subject: subject.trim(), message: message.trim()
    });
    res.status(201).json(ticket);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/support', adminJwt, requirePerm('viewSupport'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const tickets = await Ticket.find(filter)
      .populate('user', 'name phone email role')
      .sort('-createdAt').limit(100);
    res.json(tickets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/support/:id/resolve', adminJwt, requirePerm('manageSupport'), async (req, res) => {
  try {
    const { adminReply } = req.body;
    const ticket = await Ticket.findById(req.params.id).select('user subject');
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    await Ticket.updateOne({ _id: req.params.id }, {
      status: 'resolved', adminReply: adminReply || '',
      repliedAt: new Date(), readByUser: false
    });
    // Push real-time notification to the user
    if (adminReply?.trim() && ticket.user) {
      io.to(`user:${ticket.user}`).emit('support:replied', {
        ticketId: String(ticket._id), subject: ticket.subject, reply: adminReply
      });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ratings & Reviews (admin)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/admin/ratings', adminJwt, requirePerm('viewRatings'), async (req, res) => {
  try {
    const rides = await Ride.find({ driverRating: { $ne: null } })
      .populate('passenger', 'name phone')
      .populate('driver', 'name phone vehiclePlate rating')
      .select('driverRating driverReview createdAt fare vehicleType')
      .sort('-createdAt').limit(100);
    res.json(rides);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Grant Free Trial Credit
// ─────────────────────────────────────────────────────────────────────────────

const TRIAL_AMOUNTS = { 'Bike': 2000, 'Rickshaw': 3000, 'Car Mini': 4500, 'Car AC': 6500 };

app.post('/api/admin/drivers/grant-trial', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    const { driverIds, days } = req.body;
    if (!Array.isArray(driverIds) || !driverIds.length)
      return res.status(400).json({ error: 'driverIds array required' });
    const trialDays = Math.max(1, Math.min(365, parseInt(days) || 30));

    const trialStartDate = new Date();
    const paidUntilDate  = new Date();
    paidUntilDate.setDate(paidUntilDate.getDate() + trialDays);
    paidUntilDate.setUTCHours(23, 59, 59, 999);

    const drivers = await User.find({ _id: { $in: driverIds }, role: 'driver' }).select('vehicleType name');
    const results = [];
    for (const driver of drivers) {
      const amount = TRIAL_AMOUNTS[driver.vehicleType] || 4500;
      await Wallet.findOneAndUpdate(
        { user: driver._id },
        { $inc: { balance: amount, bonusWallet: amount },
          $push: { transactions: { amount, type: 'credit', description: `${trialDays}-Day Free Trial Bonus Credit` } } },
        { upsert: true, new: true }
      );
      await User.updateOne({ _id: driver._id }, { paidUntilDate, isFreeTrial: true, trialStartDate });
      // Notify driver via socket instantly
      io.to(`user:${driver._id}`).emit('fee:waived', {
        paidUntilDate:  paidUntilDate.toISOString(),
        isFreeTrial:    true,
        trialStartDate: trialStartDate.toISOString()
      });
      results.push({ id: driver._id, name: driver.name, amount });
    }
    res.json({ success: true, credited: results.length, results, trialDays, paidUntilDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/daily-fee-compliance — active drivers grouped by paid / unpaid for today
app.get('/api/admin/daily-fee-compliance', adminJwt, requirePerm('viewDriverPasses'), async (req, res) => {
  try {
    const now = new Date();
    const drivers = await User.find({ role: 'driver', accountStatus: 'active' })
      .select('name phone vehicleType paidUntilDate lastDailyFeePaidAt accountStatus rating totalRides')
      .sort('name')
      .lean();

    const paid   = [];
    const unpaid = [];
    for (const d of drivers) {
      if (d.paidUntilDate && new Date(d.paidUntilDate) >= now) paid.push(d);
      else unpaid.push(d);
    }
    res.json({ paid, unpaid, asOf: now.toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/daily-fee-compliance/driver/:id — individual driver fee & TRX history
app.get('/api/admin/daily-fee-compliance/driver/:id', adminJwt, requirePerm('viewDriverPasses'), async (req, res) => {
  try {
    const driver = await User.findOne({ _id: req.params.id, role: 'driver' })
      .select('name phone vehicleType paidUntilDate lastDailyFeePaidAt accountStatus rating totalRides')
      .lean();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const payments = await Payment.find({ driver: req.params.id })
      .select('trxId amount status submittedDate createdAt adminNote paymentType')
      .sort('-createdAt').limit(30).lean();
    res.json({ driver, payments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/daily-fee-compliance/remind — push reminder to all unpaid active drivers
app.post('/api/admin/daily-fee-compliance/remind', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    if (!global._vapidPublicKey) return res.status(503).json({ error: 'Push notifications not configured' });
    const now = new Date();
    const unpaidDrivers = await User.find({
      role: 'driver', accountStatus: 'active',
      $or: [{ paidUntilDate: null }, { paidUntilDate: { $lt: now } }]
    }).select('_id').lean();
    const driverIds = unpaidDrivers.map(d => d._id);
    if (!driverIds.length) return res.json({ success: true, sent: 0, message: 'No unpaid active drivers found' });
    const subs = await PushSub.find({ user: { $in: driverIds } }).lean();
    if (!subs.length) return res.json({ success: true, sent: 0, message: 'No push subscriptions for unpaid drivers' });
    const payload = JSON.stringify({
      title: "⚠️ Daily Fee Reminder",
      body:  "You haven't paid today's platform fee. Pay now to keep accepting ride requests.",
      url:   '/driver'
    });
    let sent = 0;
    await Promise.allSettled(subs.map(async sub => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { urgency: 'high', TTL: 3600 });
        sent++;
      } catch (err) {
        if (err.statusCode === 410) await PushSub.deleteOne({ _id: sub._id }).catch(() => {});
      }
    }));
    res.json({ success: true, sent, total: subs.length, drivers: driverIds.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/drivers/nearby?lat=&lng= — online drivers within the current
// Admin-configured broadcast radius for customer map visualization.
app.get('/api/drivers/nearby', authMiddleware, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });
    const { maximumRideBroadcastRadiusKm: radiusKm } = await getRideBroadcastSettings();
    const drivers = await User.find({
      role: 'driver', isOnline: true, accountStatus: 'active',
      lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
      'currentLocation.lat': { $ne: 0 }, 'currentLocation.lng': { $ne: 0 }
    }).select('vehicleType currentLocation').lean();
    const nearby = drivers
      .filter(d => haversineKm(lat, lng, d.currentLocation.lat, d.currentLocation.lng) <= radiusKm)
      .map(d => ({ vehicleType: d.vehicleType, lat: d.currentLocation.lat, lng: d.currentLocation.lng }));
    res.json(nearby);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/drivers/grant-fee-waiver — set paidUntilDate for selected drivers (waiver / advance pay)
app.post('/api/admin/drivers/grant-fee-waiver', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    const { driverIds, paidUntilDate } = req.body;
    if (!Array.isArray(driverIds) || !driverIds.length)
      return res.status(400).json({ error: 'driverIds array required' });
    if (!paidUntilDate) return res.status(400).json({ error: 'paidUntilDate required' });
    const until = new Date(paidUntilDate);
    until.setUTCHours(23, 59, 59, 999);   // include the full selected day
    if (isNaN(until)) return res.status(400).json({ error: 'Invalid date' });
    await User.updateMany({ _id: { $in: driverIds }, role: 'driver' }, { paidUntilDate: until });
    // Instantly notify each driver via socket so their Accept button lights up immediately
    driverIds.forEach(id => io.to(`user:${id}`).emit('fee:waived', { paidUntilDate: until.toISOString() }));
    res.json({ success: true, count: driverIds.length, paidUntilDate: until });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings Routes
// ─────────────────────────────────────────────────────────────────────────────

function defaultPaymentAccounts() {
  return JSON.parse(JSON.stringify(PAYMENT_GATEWAY_DEFAULTS));
}

function publicFareSettings(value) {
  return normalizeFareSettings(value);
}

function publicDailyFeeSettings(value) {
  return normalizeDailyFeeSettings(value);
}

function publicRideBroadcastSettings(value) {
  return normalizeRideBroadcastSettings(value);
}

// Driver-only receiving account details. Never return gateway credentials or
// webhook secrets to browsers.
app.get('/api/settings/payment', authMiddleware, driverOnly, async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'payment_accounts' });
    const accounts = { ...defaultPaymentAccounts(), ...(doc?.value || {}) };
    const gatewayDoc = await Settings.findOne({ key: 'payment_gateway_configs' }).lean();
    const gatewayStatus = {};
    for (const gateway of PAYMENT_GATEWAYS) gatewayStatus[gateway] = publicGatewayConfig(gatewayDoc?.value?.[gateway]);
    res.json({ ...accounts, gatewayStatus, dailyFeeSettings: publicDailyFeeSettings(
      (await Settings.findOne({ key: 'daily_fee_settings' }).lean())?.value
    ), perKmRates: normalizePerKmRates(
      (await Settings.findOne({ key: 'per_km_rates' }).lean())?.value
    ), dailyFareSettings: publicFareSettings(
      (await Settings.findOne({ key: 'daily_fare_settings' }).lean())?.value
    ), rideBroadcastSettings: publicRideBroadcastSettings(
      (await Settings.findOne({ key: 'ride_broadcast_settings' }).lean())?.value
    ) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/settings — admin: return account details and credential
// presence only. Plaintext secrets are never sent back after saving.
app.get('/api/admin/settings', adminJwt, requirePerm('managePaymentSettings'), async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'payment_accounts' });
    const accounts = { ...defaultPaymentAccounts(), ...(doc?.value || {}) };
    const gatewayDoc = await Settings.findOne({ key: 'payment_gateway_configs' }).lean();
    const gatewayStatus = {};
    for (const gateway of PAYMENT_GATEWAYS) gatewayStatus[gateway] = publicGatewayConfig(gatewayDoc?.value?.[gateway]);
    res.json({ ...accounts, gatewayStatus, dailyFeeSettings: publicDailyFeeSettings(
      (await Settings.findOne({ key: 'daily_fee_settings' }).lean())?.value
    ), perKmRates: normalizePerKmRates(
      (await Settings.findOne({ key: 'per_km_rates' }).lean())?.value
    ), dailyFareSettings: publicFareSettings(
      (await Settings.findOne({ key: 'daily_fare_settings' }).lean())?.value
    ), rideBroadcastSettings: publicRideBroadcastSettings(
      (await Settings.findOne({ key: 'ride_broadcast_settings' }).lean())?.value
    ) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/ride-settings', adminJwt, requirePerm('manageRideSettings'), async (req, res) => {
  try {
    res.json(await getRideBroadcastSettings());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/ride-settings', adminJwt, requirePerm('manageRideSettings'), async (req, res) => {
  try {
    const validated = validateRideBroadcastSettings(req.body?.rideBroadcastSettings);
    if (validated.errors.length) {
      return res.status(422).json({ error: 'Invalid Ride Settings', errors: validated.errors });
    }
    await Settings.findOneAndUpdate(
      { key: 'ride_broadcast_settings' },
      { key: 'ride_broadcast_settings', value: validated.settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const payload = { settings: validated.settings, updatedAt: new Date().toISOString() };
    io.emit('ride:broadcast-radius-updated', payload);
    res.json({ success: true, ...payload });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/fare-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'daily_fare_settings' }).lean();
    res.json(publicFareSettings(doc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/per-km-rates', async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'per_km_rates' }).lean();
    res.json(normalizePerKmRates(doc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Customer fare display needs both legacy local rates and the active Long
// Range configuration. Keep the legacy endpoint above unchanged for Driver
// and older clients, while giving the Customer app one coherent payload.
app.get('/api/customer/fare-config', async (req, res) => {
  try {
    const [ratesDoc, longRangeDoc] = await Promise.all([
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean()
    ]);
    res.json({
      perKmRates: normalizePerKmRates(ratesDoc?.value),
      longRangeSettings: normalizeLongRangeSettings(longRangeDoc?.value)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/per-km-rates', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'per_km_rates' }).lean();
    res.json(normalizePerKmRates(doc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/per-km-rates', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const validated = validatePerKmRates(req.body?.perKmRates);
    if (validated.errors.length) {
      return res.status(422).json({ error: 'Invalid /km Rates', errors: validated.errors });
    }
    await Settings.findOneAndUpdate(
      { key: 'per_km_rates' },
      { key: 'per_km_rates', value: validated.rates },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const fareDoc = await Settings.findOne({ key: 'daily_fare_settings' }).lean();
    await refreshPendingRideFares(normalizeFareSettings(fareDoc?.value), validated.rates);
    const payload = { rates: validated.rates, updatedAt: new Date().toISOString() };
    io.emit('per-km:updated', payload);
    res.json({ success: true, ...payload });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/daily-fee-settings', async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'daily_fee_settings' }).lean();
    res.json(publicDailyFeeSettings(doc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/daily-fee-settings', adminJwt, requirePerm('viewDriverPasses'), async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'daily_fee_settings' }).lean();
    res.json(publicDailyFeeSettings(doc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/long-range-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try { res.json(await getLongRangeSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/long-range-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const validated = validateLongRangeSettings(req.body?.longRangeSettings);
    if (validated.errors.length) return res.status(422).json({ error: 'Invalid Long Range settings', errors: validated.errors });
    await Settings.findOneAndUpdate({ key: LONG_RANGE_SETTINGS_KEY }, { key: LONG_RANGE_SETTINGS_KEY, value: validated.settings }, { upsert: true, new: true, setDefaultsOnInsert: true });
    io.emit('long-range:settings-updated', { settings: validated.settings, updatedAt: new Date().toISOString() });
    res.json({ success: true, settings: validated.settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Terms are public read-only content for the two role apps; only authorized
// Admins can change them. Socket broadcast keeps already-open apps current.
app.get('/api/terms/:role', async (req, res) => {
  if (!['customer', 'driver'].includes(req.params.role)) return res.status(400).json({ error: 'Unknown terms role' });
  const terms = await getTermsSettings();
  res.json({ role: req.params.role, content: terms[req.params.role] });
});
app.get('/api/admin/terms', adminJwt, requirePerm('manageFareSettings'), async (_req, res) => {
  res.json(await getTermsSettings());
});
app.patch('/api/admin/terms', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  const current = await getTermsSettings();
  const next = normalizeTerms({
    customer: req.body?.customer ?? current.customer,
    driver: req.body?.driver ?? current.driver
  });
  await Settings.findOneAndUpdate(
    { key: TERMS_SETTINGS_KEY },
    { key: TERMS_SETTINGS_KEY, value: next },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const payload = { terms: next, updatedAt: new Date().toISOString() };
  io.emit('terms:updated', payload);
  res.json({ success: true, ...payload });
});

app.patch('/api/admin/daily-fee-settings', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    const validated = validateDailyFeeSettings(req.body?.dailyFeeSettings);
    if (validated.errors.length) {
      return res.status(422).json({ error: 'Invalid Daily Fee Settings', errors: validated.errors });
    }
    await Settings.findOneAndUpdate(
      { key: 'daily_fee_settings' },
      { key: 'daily_fee_settings', value: validated.settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const payload = { settings: validated.settings, updatedAt: new Date().toISOString() };
    io.emit('daily-fee:updated', payload);
    res.json({ success: true, ...payload });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/fare-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const category = req.body?.category;
    const submittedSettings = req.body?.dailyFareSettings;
    if (category !== undefined) {
      const categoryInput = submittedSettings?.[category];
      const categoryValidation = validateFareCategorySettings(category, categoryInput);
      if (categoryValidation.errors.length) {
        return res.status(422).json({ error: 'Invalid Daily Fare Settings', errors: categoryValidation.errors });
      }
      const existingDoc = await Settings.findOne({ key: 'daily_fare_settings' }).lean();
      const settings = mergeFareCategorySettings(existingDoc?.value, category, categoryValidation.setting);
      await Settings.findOneAndUpdate(
        { key: 'daily_fare_settings' },
        { key: 'daily_fare_settings', value: settings },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await refreshPendingRideFares(settings);
      const payload = { settings, updatedAt: new Date().toISOString(), category };
      io.emit('fare:updated', payload);
      return res.json({ success: true, ...payload });
    }

    const validated = validateFareSettings(submittedSettings);
    if (validated.errors.length) {
      return res.status(422).json({ error: 'Invalid Daily Fare Settings', errors: validated.errors });
    }
    await Settings.findOneAndUpdate(
      { key: 'daily_fare_settings' },
      { key: 'daily_fare_settings', value: validated.settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await refreshPendingRideFares(validated.settings);
    const payload = { settings: validated.settings, updatedAt: new Date().toISOString() };
    io.emit('fare:updated', payload);
    res.json({ success: true, ...payload });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/settings — save public account details and encrypted gateway
// credentials. Blank credential inputs mean "leave the existing value unchanged".
app.patch('/api/admin/settings', adminJwt, requirePerm('managePaymentSettings'), async (req, res) => {
  try {
    const { jazzcash, easypaisa, bank, sadapay, gatewayConfigs, dailyFareSettings } = req.body;
    if (dailyFareSettings !== undefined && !hasAdminPermission(req.admin, 'manageFareSettings')) {
      return res.status(403).json({ error: 'Permission denied: manageFareSettings required to change pricing rules' });
    }
    const value = {
      jazzcash:  { title: jazzcash?.title  || '', number: jazzcash?.number || '' },
      easypaisa: { title: easypaisa?.title || '', number: easypaisa?.number || '' },
      bank:      { name:  bank?.name  || '', title: bank?.title || '', iban: bank?.iban || '' },
      sadapay:   { title: sadapay?.title || '', number: sadapay?.number || '' }
    };
    await Settings.findOneAndUpdate(
      { key: 'payment_accounts' },
      { key: 'payment_accounts', value },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (gatewayConfigs && typeof gatewayConfigs === 'object') {
      const existing = (await Settings.findOne({ key: 'payment_gateway_configs' }).lean())?.value || {};
      const encrypted = {};
      for (const gateway of PAYMENT_GATEWAYS) {
        const input = gatewayConfigs[gateway] || {};
        const previous = existing[gateway] || {};
        encrypted[gateway] = { ...previous };
        for (const field of ['apiKey', 'accessToken', 'merchantId', 'secretKey', 'webhookSecret']) {
          if (typeof input[field] === 'string' && input[field].trim()) {
            encrypted[gateway][field] = encryptSecret(input[field].trim());
          }
        }
      }
      await Settings.findOneAndUpdate(
        { key: 'payment_gateway_configs' },
        { key: 'payment_gateway_configs', value: encrypted },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
    let savedFareSettings;
    if (dailyFareSettings !== undefined) {
      const validated = validateFareSettings(dailyFareSettings);
      if (validated.errors.length) {
        return res.status(422).json({ error: 'Invalid Daily Fare Settings', errors: validated.errors });
      }
      savedFareSettings = validated.settings;
      await Settings.findOneAndUpdate(
        { key: 'daily_fare_settings' },
        { key: 'daily_fare_settings', value: savedFareSettings },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      await refreshPendingRideFares(savedFareSettings);
      io.emit('fare:updated', { settings: savedFareSettings, updatedAt: new Date().toISOString() });
    }
    const gatewayDoc = await Settings.findOne({ key: 'payment_gateway_configs' }).lean();
    const gatewayStatus = {};
    for (const gateway of PAYMENT_GATEWAYS) gatewayStatus[gateway] = publicGatewayConfig(gatewayDoc?.value?.[gateway]);
    res.json({
      success: true,
      value,
      gatewayStatus,
      dailyFareSettings: publicFareSettings(savedFareSettings || (
        await Settings.findOne({ key: 'daily_fare_settings' }).lean()
      )?.value)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/daily-income — last 30 days grouped by date
app.get('/api/admin/daily-income', adminJwt, requirePerm('viewOverview'), async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30); since.setUTCHours(0,0,0,0);
    const payments = await Payment.find({ status: 'approved', updatedAt: { $gte: since } })
      .populate('driver', 'name vehicleType');
    const byDate = {};
    payments.forEach(p => {
      const d = (p.updatedAt || p.createdAt).toISOString().slice(0,10);
      if (!byDate[d]) byDate[d] = { date: d, total: 0, count: 0 };
      byDate[d].total += p.amount; byDate[d].count++;
    });
    res.json(Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Web Push Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/push/vapid-key — return the public VAPID key to the client
app.get('/api/push/vapid-key', (_req, res) => {
  if (!global._vapidPublicKey) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: global._vapidPublicKey });
});

// POST /api/push/subscribe — save (or update) a driver's push subscription
// Only active/approved drivers may register; customers are rejected.
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  try {
    // Drivers only
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can register push subscriptions' });
    }

    // Confirm driver is active in DB (not pending/suspended/blocked)
    const driver = await User.findById(req.user.id).select('role accountStatus');
    if (!driver || driver.role !== 'driver') {
      return res.status(403).json({ error: 'Driver account not found' });
    }
    if (driver.accountStatus !== 'active') {
      return res.status(403).json({ error: 'Only active driver accounts can register push subscriptions' });
    }

    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint and keys (p256dh, auth) are required' });
    }

    // Validate endpoint is from a known browser push-service origin.
    // This prevents SSRF: the server would otherwise make outbound requests
    // to any attacker-supplied HTTPS URL via webpush.sendNotification().
    const ALLOWED_PUSH_ORIGINS = [
      'https://fcm.googleapis.com',              // Chrome, Edge, Opera, Samsung
      'https://updates.push.services.mozilla.com', // Firefox
      'https://push.services.mozilla.com',        // Firefox (newer)
      'https://web.push.apple.com',               // Safari 16+
      'https://api.push.apple.com',               // Safari (alternate)
    ];
    let parsedEndpoint;
    try { parsedEndpoint = new URL(endpoint); } catch {
      return res.status(400).json({ error: 'endpoint must be a valid URL' });
    }
    if (parsedEndpoint.protocol !== 'https:') {
      return res.status(400).json({ error: 'endpoint must use HTTPS' });
    }
    const endpointOrigin = parsedEndpoint.origin;
    const isAllowed = ALLOWED_PUSH_ORIGINS.some(
      allowed => endpointOrigin === allowed || endpointOrigin.endsWith('.' + new URL(allowed).hostname)
    );
    if (!isAllowed) {
      return res.status(400).json({ error: 'endpoint is not from a supported browser push service' });
    }

    await PushSub.findOneAndUpdate(
      { user: req.user.id, endpoint },
      { user: req.user.id, endpoint, keys, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

// Health endpoints — deployment probe checks both /api and /api/health
app.get('/api', function(_req, res) { res.json({ status: 'ok' }); });
app.get('/api/health', function(_req, res) {
  res.json({ status: 'ok', db: dbConnected ? 'connected' : 'testing-mode', ts: new Date().toISOString() });
});

// Diagnostic: confirm PAGES are loaded in this container instance
app.get('/api/pages-status', function(_req, res) {
  res.json(Object.fromEntries(
    Object.entries(PAGES).map(([k, v]) => [k, { loaded: !!v, bytes: v ? v.length : 0 }])
  ));
});

// Page routes — serve pre-loaded HTML with explicit statements (no && chain).
function servePage(page) {
  return function(_req, res, next) {
    try {
      var content = PAGES[page];
      if (!content) {
        console.error('[servePage] PAGES["' + page + '"] is empty — startup load failed silently');
        return res.status(500).json({ error: 'page not loaded' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch (err) {
      console.error('[servePage] error serving page "' + page + '":', err);
      next(err);
    }
  };
}
app.get('/customer', servePage('customer'));
app.get('/driver',   servePage('driver'));
app.get('/admin',    servePage('admin'));
app.get('/download', servePage('download'));
app.get('/',         servePage('customer'));

// Catch-all: serve customer SPA for any unmatched path (deep-link support).
app.use(function(_req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGES.customer);
});

// ── Express error handler — must have 4 params so Express treats it as error middleware ──
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.code === 'ENOENT' ? 'Page not found' : (err.message || 'Internal server error');
  console.error(`[Express error] ${status} — ${err.message}`);
  if (res.headersSent) return;
  res.status(status).json({ error: message });
});

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io — Real-time Layer
// ─────────────────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  const user = socket.user;

  // ── Admin socket ───────────────────────────────────────────────────────────
  if (user.isAdmin) {
    socket.join('admin-room');
    console.log('Admin socket connected');
    socket.on('disconnect', () => console.log('Admin socket disconnected'));
    return;  // no further driver/passenger setup
  }

  const { id, name, role } = user;
  console.log(`Authenticated ${role || 'user'} socket connected`);

  // Join personal notification room
  socket.join(`user:${id}`);

  // ── Driver: restore room memberships from DB on every (re)connect ──────────
  // Socket.io rooms are process-memory only — they vanish on server restart.
  // We persist isOnline and active ride state to MongoDB so we can restore both
  // here without requiring the client to manually re-send status events first.
  if (role === 'driver') {
    Promise.all([
      User.findById(id).select('isOnline accountStatus vehicleType').lean().catch(() => null),
      Ride.findOne({ driver: id, status: { $in: ['accepted', 'arrived', 'in-progress'] } })
          .select('_id').lean().catch(() => null)
    ]).then(async ([driver, activeRide]) => {
      // Cache vehicle type on socket for fast room management
        if (driver?.vehicleType) socket.vehicleType = normalizeFareVehicle(driver.vehicleType);
      // Restore online rooms — only if DB says online and account is active
      if (driver?.isOnline && driver.accountStatus === 'active') {
        await User.updateOne({ _id: id }, { lastOnlineHeartbeat: new Date() }).catch(() => {});
        socket.join('drivers-online');
        socket.join(`drivers:${normalizeFareVehicle(driver.vehicleType || 'Car Mini')}`);
        socket.emit('driver:rehydrate', { isOnline: true, vehicleType: normalizeFareVehicle(driver.vehicleType || 'Car Mini') });
      }
      // Re-join the active ride room so location updates reach the passenger
      if (activeRide) {
        socket.join(`ride:${activeRide._id}`);
        console.log('Driver rejoined an active ride room after reconnect');
      }
    }).catch(() => {});
  }

  socket.on('ride:join',  (rideId) => socket.join(`ride:${rideId}`));
  socket.on('ride:leave', (rideId) => socket.leave(`ride:${rideId}`));

  // Driver sends location updates during a ride
  socket.on('driver:location', async ({ rideId, lat, lng }) => {
    if (role !== 'driver') return;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
    if (rideId) {
      io.to(`ride:${rideId}`).emit('driver:location', { lat, lng });
      await Ride.updateOne({ _id: rideId }, { 'driverLocation.lat': lat, 'driverLocation.lng': lng }).catch(() => {});
    }
    await User.updateOne({ _id: id }, {
      'currentLocation.lat': lat,
      'currentLocation.lng': lng,
      lastOnlineHeartbeat: new Date()
    }).catch(() => {});
  });

  // Driver toggles online/offline
  socket.on('driver:status', async ({ isOnline }) => {
    if (role !== 'driver') return;
    if (isOnline) {
      const driver = await User.findById(id)
        .select('accountStatus vehicleType paidUntilDate lastDailyFeePaidAt isFreeTrial').catch(() => null);
      if (driver?.accountStatus === 'pending') {
        socket.emit('account:suspended', { reason: 'Your account is pending Admin approval. You will be notified once approved.' });
        return;
      }
      if (driver?.accountStatus === 'suspended' || driver?.accountStatus === 'blocked' || driver?.accountStatus === 'pending_deletion') {
        socket.emit('account:suspended', { reason: 'Your account has been suspended. Please contact Admin.' });
        return;
      }
      const feeResult = await chargeDailyFeeForOnlineDriver(id, driver);
      if (!feeResult.allowed) {
        socket.emit('account:suspended', {
          reason: `Wallet balance must cover today's Daily Fee of Rs ${feeResult.rate.toLocaleString()} before going online. Current balance: Rs ${Number(feeResult.balance).toLocaleString()}.`
        });
        return;
      }
      // Cache vehicle type on socket for room management
      if (driver?.vehicleType) socket.vehicleType = normalizeFareVehicle(driver.vehicleType);
    }
    await User.updateOne({ _id: id }, isOnline
      ? { isOnline: true, lastOnlineHeartbeat: new Date() }
      : { isOnline: false }
    ).catch(() => {});
    const vRoom = `drivers:${socket.vehicleType || 'Car Mini'}`;
    if (isOnline) { socket.join('drivers-online'); socket.join(vRoom); }
    else          { socket.leave('drivers-online'); socket.leave(vRoom); }
  });

  // Native clients explicitly heartbeat while their foreground service is
  // active. This lets the server detect policy/account changes without treating
  // short radio reconnects as an offline transition.
  socket.on('driver:heartbeat', async () => {
    if (role !== 'driver') return;
    const driver = await User.findById(id).select('accountStatus isOnline').lean().catch(() => null);
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) {
      socket.emit('account:suspended', { reason: 'Driver availability is no longer active.' });
      return;
    }
    await User.updateOne({ _id: id }, { lastOnlineHeartbeat: new Date() }).catch(() => {});
    socket.emit('driver:heartbeat:ack', { serverTime: new Date().toISOString() });
  });

  // Share live location (customer)
  socket.on('location:share', ({ lat, lng, rideId }) => {
    if (rideId) io.to(`ride:${rideId}`).emit('passenger:location', { lat, lng });
  });

  socket.on('disconnect', async () => {
    console.log('Authenticated socket disconnected');
    // Do not set a driver offline here. A native foreground service can suffer
    // a brief Socket.io/radio disconnect while still being actively online and
    // tracking GPS; its persisted availability and heartbeat are authoritative.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

async function initVapidKeys() {
  // Prefer explicit env-var keys (set once, rotate rarely)
  const envPublic  = process.env.VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VAPID_PRIVATE_KEY;
  const contactEmail = process.env.VAPID_EMAIL || 'mailto:admin@myride.app';

  if (envPublic && envPrivate) {
    webpush.setVapidDetails(contactEmail, envPublic, envPrivate);
    global._vapidPublicKey = envPublic;
    console.log('✓ VAPID keys loaded from environment');
    return;
  }

  // Fall back to keys stored in MongoDB Settings (persist across restarts)
  if (dbConnected) {
    try {
      let doc = await Settings.findOne({ key: 'vapid_keys' });
      if (!doc) {
        const keys = webpush.generateVAPIDKeys();
        doc = await Settings.create({ key: 'vapid_keys', value: keys });
        console.log('✓ VAPID keys generated and saved to DB');
      }
      const { publicKey, privateKey } = doc.value;
      webpush.setVapidDetails(contactEmail, publicKey, privateKey);
      global._vapidPublicKey = publicKey;
      console.log('✓ VAPID keys loaded from DB');
      return;
    } catch (err) {
      console.warn('⚠  Could not load/store VAPID keys from DB:', err.message);
    }
  }

  // Last resort: ephemeral keys (won't survive a restart — clients must re-subscribe)
  const keys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails(contactEmail, keys.publicKey, keys.privateKey);
  global._vapidPublicKey = keys.publicKey;
  console.warn('⚠  Using ephemeral VAPID keys — set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY env vars for persistence');
}

async function connectDatabase() {
  const rawUri = process.env.MONGO_URI;
  console.log('MONGO_URI attached:', !!rawUri);
  if (!rawUri) {
    if (process.env.DEMO_ACCOUNTS_ENABLED !== 'true' || process.env.NODE_ENV === 'production') {
      console.warn('⚠  MONGO_URI not set — running in testing mode (data not persisted)');
      return;
    }
    try {
      // Preview-only persistence: this database lives for the workflow process
      // and is never used when a production MONGO_URI is configured.
      const { MongoMemoryServer } = require('mongodb-memory-server');
      const demoMongo = await MongoMemoryServer.create();
      await mongoose.connect(demoMongo.getUri(), { serverSelectionTimeoutMS: 8000 });
      dbConnected = true;
      global._demoMongoServer = demoMongo;
      await seedDemoAccounts();
      console.log('✓ Preview demo database connected and demo accounts seeded');
      await initVapidKeys();
    } catch (err) {
      console.warn('⚠  Demo database unavailable, running without persistence:', err.message);
    }
    return;
  }
  const uri = normalizeMongoUri(rawUri);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      heartbeatFrequencyMS: 10000,
    });
    dbConnected = true;
    console.log('✓ MongoDB Atlas connected');

    mongoose.connection.on('disconnected', () => {
      dbConnected = false;
      console.warn('⚠  MongoDB disconnected — Mongoose will auto-reconnect');
    });
    mongoose.connection.on('reconnected', () => {
      dbConnected = true;
      console.log('✓ MongoDB reconnected');
    });
    mongoose.connection.on('error', (mongoErr) => {
      console.error('MongoDB connection error:', mongoErr.message);
    });

    // Migrate email index to sparse (one-time, safe to re-run)
    try {
      const usersCol = mongoose.connection.collection('users');
      const idxs = await usersCol.indexes();
      const emailIdx = idxs.find(ix => ix.name === 'email_1');
      if (emailIdx && !emailIdx.sparse) {
        await usersCol.dropIndex('email_1');
        await usersCol.createIndex({ email: 1 }, { unique: true, sparse: true });
        console.log('✓ Email index migrated to sparse');
      }
    } catch (migrateErr) {
      console.warn('Email index migration skipped:', migrateErr.message);
    }
  } catch (err) {
    console.warn('⚠  MongoDB unavailable, running in testing mode:', err.message);
  }

  await initVapidKeys();
}

const DEMO_ACCOUNTS = Object.freeze({
  customer: {
    name: 'MyRide Demo Customer',
    phone: '+923000000001',
    email: 'demo.customer@myride.test',
    password: 'DemoCustomer-2026!'
  },
  driver: {
    name: 'MyRide Demo Driver',
    phone: '+923000000002',
    email: 'demo.driver@myride.test',
    password: 'DemoDriver-2026!'
  }
});

async function seedDemoAccounts() {
  if (process.env.DEMO_ACCOUNTS_ENABLED !== 'true' || process.env.NODE_ENV === 'production') return;
  const now = new Date();
  const customerPassword = await bcrypt.hash(DEMO_ACCOUNTS.customer.password, 12);
  const driverPassword = await bcrypt.hash(DEMO_ACCOUNTS.driver.password, 12);
  const subAdminPassword = await bcrypt.hash('DemoOps-2026!', 12);

  const customer = await User.findOneAndUpdate(
    { phone: DEMO_ACCOUNTS.customer.phone },
    {
      $set: {
        name: DEMO_ACCOUNTS.customer.name,
        email: DEMO_ACCOUNTS.customer.email,
        password: customerPassword,
        role: 'customer',
        accountStatus: 'active',
        nationalIdHash: crypto.createHmac('sha256', JWT_SECRET).update('demo-customer-national-id').digest('hex'),
        nationalIdLast4: '0001',
        identityVerificationStatus: 'approved',
        identityVerifiedAt: now
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const driver = await User.findOneAndUpdate(
    { phone: DEMO_ACCOUNTS.driver.phone },
    {
      $set: {
        name: DEMO_ACCOUNTS.driver.name,
        email: DEMO_ACCOUNTS.driver.email,
        password: driverPassword,
        role: 'driver',
        accountStatus: 'active',
        nationalIdHash: crypto.createHmac('sha256', JWT_SECRET).update('demo-driver-national-id').digest('hex'),
        nationalIdLast4: '0002',
        vehicleType: 'Car Mini',
        vehicleModel: 'Toyota Corolla',
        vehiclePlate: 'DEMO-2026',
        isOnline: false,
        lastDailyFeePaidAt: now,
        paidUntilDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        isFreeTrial: false
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Wallet.findOneAndUpdate(
    { user: driver._id },
    {
      $set: { balance: 5000, realCashWallet: 5000, fee_paid_at: now },
      $setOnInsert: { transactions: [] }
    },
    { upsert: true, new: true }
  );
  await Payment.findOneAndUpdate(
    { trxId: 'DEMO-APPROVED-2026' },
    {
      $set: {
        driver: driver._id,
        amount: 500,
        vehicleCategory: 'Car Mini',
        paymentType: 'jazzcash',
        status: 'approved',
        proofScreenshot: 'data:image/png;base64,DEMO_PROOF',
        submittedDate: todayUTC(),
        approvedBy: 'demo-seed',
        approvedAt: now,
        auditLog: [{
          action: 'approved',
          actorId: 'demo-seed',
          actorRole: 'super-admin',
          reason: 'Preview demo account seed',
          balanceBefore: 4500,
          balanceAfter: 5000,
          passValidUntil: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          createdAt: now
        }]
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await SubAdmin.findOneAndUpdate(
    { username: 'demo-ops' },
    {
      $set: {
        username: 'demo-ops',
        password: subAdminPassword,
        isBlocked: false,
        permissions: normalizeSubAdminPermissions({
          viewOverview: true,
          viewDrivers: true,
          viewCustomers: true,
          viewPayments: true,
          approveWalletTopups: true,
          viewRides: true,
          viewDriverPasses: true
        })
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { customer, driver };
}

// Start DB connection in background — never blocks the HTTP server
if (require.main === module) {
  connectDatabase().catch(err => console.error('connectDatabase error:', err));
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily Subscription Deduction (runs at UTC midnight every day)
// ─────────────────────────────────────────────────────────────────────────────

async function runDailyDeduction({ force = false } = {}) {
  if (!dbConnected && !force) return;
  console.log('⏰ Running daily fee rollover checks…');
  try {
    // Drivers who choose Long Range Only never pay the standard Daily Fee.
    // Short Range Only and Both are charged through the same atomic 24-hour
    // pass logic used when going online. This also makes the scheduled sweep
    // safe to retry without charging an active pass twice.
    const drivers = await User.find({ role: 'driver', accountStatus: 'active' })
      .select('_id vehicleType ridePreference name paidUntilDate lastDailyFeePaidAt isFreeTrial');
    const dailyFeeSettings = await getDailyFeeSettings();
    let charged = 0;
    let exempt = 0;
    let blocked = 0;
    for (const driver of drivers) {
      const result = await chargeDailyFeeForOnlineDriver(driver._id, driver, dailyFeeSettings);
      if (result.exempt) exempt++;
      else if (result.charged) charged++;
      else if (!result.allowed) blocked++;
    }
    console.log(`✓ Daily fee rollover complete: ${drivers.length} active driver(s) checked; ${charged} charged, ${exempt} Long Range Only exempt, ${blocked} awaiting wallet balance`);

    // Notify drivers who now have zero or negative balance
    if (global._vapidPublicKey && drivers.length > 0) {
      try {
        const driverIds    = drivers.map(d => d._id);
        const lowWallets   = await Wallet.find({ user: { $in: driverIds }, balance: { $lte: 0 } }).select('user').lean();
        const lowIds       = lowWallets.map(w => String(w.user));
        if (lowIds.length) {
          const lowBalPush = {
            title: '⚠️ Insufficient Wallet Balance',
            body:  'Your wallet balance is zero or negative. Please top up to continue receiving ride requests.\n\nDeposit via JazzCash / EasyPaisa to the account shown in the app.',
            url:   '/driver'
          };
          const subs = await PushSub.find({ user: { $in: lowIds } });
          subs.forEach(sub => {
            webpush.sendNotification(
              { endpoint: sub.endpoint, keys: sub.keys },
              JSON.stringify(lowBalPush),
              { urgency: 'high', TTL: 3600 }
            ).catch(err => {
              if (err.statusCode === 410) PushSub.deleteOne({ _id: sub._id }).catch(() => {});
            });
          });
          console.log(`⚠ Low-balance notification sent to ${lowIds.length} driver(s)`);
        }
      } catch (notifyErr) { console.warn('Low-balance notify error:', notifyErr.message); }
    }

    // Notify active drivers whose daily fee has now expired (paidUntilDate null or past midnight)
    if (global._vapidPublicKey) {
      try {
        const now = new Date();
        const expiredDrivers = await User.find({
          role: 'driver', accountStatus: 'active',
          $or: [{ paidUntilDate: null }, { paidUntilDate: { $lte: now } }]
        }).select('_id vehicleType ridePreference').lean();
        const feeRequiredDrivers = expiredDrivers.filter(driver => !isLongRangeOnlyDriver(driver));

        if (feeRequiredDrivers.length) {
          const vehicleTypeById = {};
          feeRequiredDrivers.forEach(d => { vehicleTypeById[String(d._id)] = d.vehicleType; });
          const expiredIds = feeRequiredDrivers.map(d => d._id);
          const subs = await PushSub.find({ user: { $in: expiredIds } }).lean();

          for (const sub of subs) {
            const vehicleType = vehicleTypeById[String(sub.user)] || '';
            const feeAmount = await getDailyFeeForVehicle(vehicleType, dailyFeeSettings);
            const amountText  = Number.isFinite(feeAmount) && feeAmount > 0
              ? ` of Rs ${feeAmount.toLocaleString()}`
              : '';
            const payload = JSON.stringify({
              title: '🔒 Daily Fee Expired',
              body:  `Your daily platform fee${amountText} is due. Pay now to unlock ride requests.`,
              url:   '/driver#payments'
            });
            webpush.sendNotification(
              { endpoint: sub.endpoint, keys: sub.keys },
              payload,
              { urgency: 'high', TTL: 3600 }
            ).catch(err => {
              if (err.statusCode === 410) PushSub.deleteOne({ _id: sub._id }).catch(() => {});
            });
          }
          console.log(`🔒 Fee-expiry notification sent to ${feeRequiredDrivers.length} driver(s)`);
        }
      } catch (notifyErr) { console.warn('Fee-expiry notify error:', notifyErr.message); }
    }
  } catch (err) { console.error('Daily deduction error:', err.message); }
}

if (require.main === module) (function scheduleMidnightDeduction() {
  function msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight - now;
  }
  function scheduleNext() {
    setTimeout(async () => {
      await runDailyDeduction();
      scheduleNext(); // re-schedule for next midnight
    }, msUntilMidnight());
  }
  scheduleNext();
  console.log(`⏰ Daily deduction scheduled (next run at UTC midnight)`);
})();

module.exports = {
  app,
  server,
  io,
  FARE_VEHICLE_CATEGORIES,
  DEFAULT_PER_KM_RATES,
  DEFAULT_RIDE_BROADCAST_RADIUS_KM,
  normalizeFareSettings,
  validateFareSettings,
  calculateFareFromSettings,
  normalizeLongRangeSettings,
  validateLongRangeSettings,
  getLongRangeMinimumWalletBalance,
  calculateRideFare,
  normalizeTerms,
  normalizeFareVehicle,
  storedVehicleTypesForFareCategory,
  DRIVER_RIDE_PREFERENCES,
  normalizeRidePreference,
  isLongRangeOnlyDriver,
  canDriverReceiveRideForPreference,
  chargeDailyFeeForOnlineDriver,
  runDailyDeduction,
  normalizeRideBroadcastSettings,
  validateRideBroadcastSettings,
  haversineKm,
  findRideBroadcastDrivers,
  findLongRangeBroadcastDrivers,
  emitRideRequestToDrivers,
  chargeLongRangeCommission,
  refreshPendingRideFares,
  SUB_ADMIN_PERMISSION_CATALOG,
  normalizeSubAdminPermissions,
  hasAdminPermission,
  models: { User, Ride, Wallet, Payment, Settings, SubAdmin }
};
