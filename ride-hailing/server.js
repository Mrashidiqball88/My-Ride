/**
 * Ride-Hailing App — Express + Mongoose + Socket.io
 * Serves Customer App (/customer) and Driver App (/driver)
 */

const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
// DigitalOcean deployments commonly keep the env file beside the service
// entrypoint, while the Replit workspace has historically used the repository
// root. Load both locations without overriding variables exported by the
// process environment. The app-local file wins when both dotenv files exist.
for (const envPath of [path.resolve(__dirname, '.env'), path.resolve(__dirname, '..', '.env')]) {
  dotenv.config({ path: envPath, override: false });
}
const { computeBackfillPaidUntil } = require('./lib/backfillPaidUntil');

function getMapboxAccessToken() {
  return String(
    process.env.MAPBOX_ACCESS_TOKEN ||
    process.env.MAPBOX_PUBLIC_TOKEN ||
    process.env.MAPBOX_TOKEN ||
    ''
  ).trim();
}

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
const https    = require('https');
const { Server } = require('socket.io');
const webpush  = require('web-push');
const crypto   = require('crypto');
const Tesseract = require('tesseract.js');
const sharp    = require('sharp');
const {
  startRedisAcceleration,
  isRedisReady,
  redisStatus,
  redisGetJson,
  redisSetJson,
  redisDelete,
  upsertDriverPresence,
  removeDriverPresence,
  searchDriverIds,
  rebuildDriverGeoIndex
} = require('./lib/redisAcceleration');

// ── 2. APP & SERVER INITIALIZATION ───────────────────────────────────────
const app    = express();
app.disable('x-powered-by');

const configuredCorsOrigins = new Set(
  String(process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(origin => origin && origin !== '*')
);
function allowConfiguredOrigin(origin, callback) {
  // Requests without an Origin include same-origin web requests and native
  // clients. CORS does not apply to those requests.
  if (!origin) return callback(null, true);
  const normalizedOrigin = String(origin).trim().replace(/\/+$/, '');
  if (configuredCorsOrigins.has(normalizedOrigin)) return callback(null, true);
  // Do not opt into wildcard cross-origin access. The browser will block the
  // response when the origin is not explicitly configured.
  return callback(null, false);
}
const corsPolicy = {
  origin: allowConfiguredOrigin,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Accept', 'Content-Type', 'Authorization', 'X-Session-Token', 'X-Requested-With'],
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
  credentials: false,
  maxAge: 600,
  optionsSuccessStatus: 204
};
function applySecurityHeaders(req, res, next) {
  // Helmet-equivalent baseline. Content-Security-Policy is intentionally not
  // enabled here because the existing Customer, Driver, and Admin shells use
  // inline scripts and Mapbox/browser capabilities that require a separate CSP
  // migration to avoid breaking the application.
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self)');
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  if (process.env.NODE_ENV === 'production' && (req.secure || forwardedProtocol === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
app.use(applySecurityHeaders);
app.use(cors(corsPolicy));

// ── 3. HEALTHCHECK ROUTES — FIRST lines after express(), zero dependencies
// Replit deployment probes / immediately on startup; this must win before
// any other route, middleware, or DB work is registered.
app.get('/',       (_req, res) => res.status(200).send('OK'));
app.get('/health', (_req, res) => res.status(200).send('OK'));
app.get('/api',    (_req, res) => res.status(200).json({ status: 'ok' }));

const server = http.createServer(app);
const io     = new Server(server, {
  cors: corsPolicy,
  // Keep the transport-level connection responsive while allowing the
  // application-level driver heartbeat to remain the source of truth for
  // online eligibility.
  pingInterval: 10_000,
  pingTimeout: 25_000,
  connectTimeout: 20_000,
  transports: ['websocket', 'polling']
});

const RESEND_API_HOST = 'api.resend.com';
const RESEND_API_PATH = '/emails';
const RESEND_REQUEST_TIMEOUT_MS = 15_000;

function resendApiKey() {
  return String(process.env.RESEND_API_KEY || '').trim();
}

function currentEmailFrom() {
  return String(process.env.EMAIL_FROM || '').trim();
}

function emailOtpConfigured() {
  // Read the environment at request time so tests and deployments that attach
  // secrets after module loading do not report the HTTPS email service as
  // unavailable. No SMTP or Gmail variables are consulted.
  return Boolean(resendApiKey() && currentEmailFrom());
}

function resendError(message, code = 'RESEND_REQUEST_FAILED') {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = code;
  return error;
}

function sendEmailViaResend({ from, to, subject, text, html }) {
  const apiKey = resendApiKey();
  if (!apiKey) return Promise.reject(resendError('Resend API key is not configured', 'RESEND_NOT_CONFIGURED'));

  const body = JSON.stringify({
    from: String(from || currentEmailFrom()).trim(),
    to,
    subject,
    text,
    html
  });

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: RESEND_API_HOST,
      path: RESEND_API_PATH,
      method: 'POST',
      timeout: RESEND_REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (responseBody.length < 8192) responseBody += chunk;
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        if (statusCode >= 200 && statusCode < 300) {
          let payload = {};
          try { payload = responseBody ? JSON.parse(responseBody) : {}; } catch (_err) {}
          return resolve(payload);
        }

        let providerMessage = responseBody.trim();
        try {
          const parsed = JSON.parse(responseBody);
          providerMessage = parsed?.message || parsed?.error || providerMessage;
        } catch (_err) {}
        const detail = providerMessage ? `: ${providerMessage}` : '';
        const error = resendError(
          `Resend email API request failed with HTTP ${statusCode || 'unknown'}${detail}`,
          `RESEND_HTTP_${statusCode || 'UNKNOWN'}`
        );
        error.providerStatusCode = statusCode;
        reject(error);
      });
    });

    request.on('timeout', () => {
      request.destroy(resendError('Resend email API request timed out', 'RESEND_ETIMEDOUT'));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

let emailSender = { sendMail: sendEmailViaResend };
function setEmailSenderForTests(sender) {
  emailSender = sender;
}

if (emailOtpConfigured()) console.log('✓ Resend email API configured over HTTPS');

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
  void startRedisAcceleration().then(() => rebuildRedisDriverIndex());
}

// ── 5. MIDDLEWARES & STATIC FILES ─────────────────────────────────────────
// Route handlers log their internal exception details server-side but should
// never disclose database, filesystem, or provider errors to API clients.
app.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = payload => res.statusCode >= 500
    ? json({ error: 'Internal server error' })
    : json(payload);
  next();
});
// Keep the exact bytes for gateway signature verification while still exposing
// the normal parsed JSON body to every other route.
app.use(express.json({
  limit: process.env.REQUEST_BODY_LIMIT || '32mb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ limit: process.env.REQUEST_BODY_LIMIT || '32mb', extended: true }));
// Resolve the public directory absolutely — works in any CWD or spawn context.
const PUBLIC_DIR = path.resolve(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    // The Admin and Customer shells contain authentication/bootstrap and live
    // location/voice JavaScript; neither may be served from an old cache after
    // a deployment.
    if (['admin.html', 'customer.html'].includes(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Pre-read HTML pages synchronously at startup so we never rely on sendFile's
// stream/path behaviour in Cloud Run containers.  If a file is missing the
// server refuses to start with a clear error rather than silently 500-ing.
const fs = require('fs');

// Driver identity documents and customer identity documents are private. Only
// non-sensitive Driver profile photos are mounted publicly for ride matching.
//
// Uploads must not live under the Git-tracked application directory. Configure
// MYRIDE_UPLOADS_DIR to a persistent mounted volume in production; the default
// is an external home-directory path for environments that provide persistent
// home storage.
const APPLICATION_SOURCE_DIR = path.resolve(__dirname);
const LEGACY_UPLOADS_ROOT = path.resolve(__dirname, 'uploads');
const DEFAULT_UPLOADS_ROOT = path.resolve(os.homedir(), 'Node-Server', 'uploads');

function resolvePersistentUploadsRoot() {
  const configuredRoot = process.env.MYRIDE_UPLOADS_DIR || DEFAULT_UPLOADS_ROOT;
  const resolvedRoot = path.resolve(configuredRoot);
  const relativeToSource = path.relative(APPLICATION_SOURCE_DIR, resolvedRoot);
  const isInsideApplication = relativeToSource === '' ||
    (!relativeToSource.startsWith(`..${path.sep}`) &&
      relativeToSource !== '..' &&
      !path.isAbsolute(relativeToSource));

  if (isInsideApplication) {
    throw new Error(
      `MYRIDE_UPLOADS_DIR must be outside the application directory: ${APPLICATION_SOURCE_DIR}`
    );
  }

  return resolvedRoot;
}

const PERSISTENT_UPLOADS_ROOT = resolvePersistentUploadsRoot();
const DRIVER_PROFILE_UPLOADS_DIR = path.join(PERSISTENT_UPLOADS_ROOT, 'driver_profiles');
const DRIVER_ID_UPLOADS_DIR = path.join(PERSISTENT_UPLOADS_ROOT, 'driver_identity');
const CUSTOMER_ID_UPLOADS_DIR = path.join(PERSISTENT_UPLOADS_ROOT, 'customer_identity');
const PERSISTENT_DRIVER_DOCS_DIR = path.join(PERSISTENT_UPLOADS_ROOT, 'driver_docs');

const LEGACY_DRIVER_DOCS_DIR = path.join(LEGACY_UPLOADS_ROOT, 'driver_docs');
const LEGACY_DRIVER_PROFILE_UPLOADS_DIR = path.join(LEGACY_UPLOADS_ROOT, 'driver_profiles');
const LEGACY_DRIVER_ID_UPLOADS_DIR = path.join(LEGACY_UPLOADS_ROOT, 'driver_identity');
const LEGACY_CUSTOMER_ID_UPLOADS_DIR = path.join(LEGACY_UPLOADS_ROOT, 'customer_identity');

for (const directory of [
  DRIVER_PROFILE_UPLOADS_DIR,
  DRIVER_ID_UPLOADS_DIR,
  CUSTOMER_ID_UPLOADS_DIR,
  PERSISTENT_DRIVER_DOCS_DIR
]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function migrateLegacyUploadDirectory(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, path.basename(entry.name));
    if (fs.existsSync(destinationPath)) continue;
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, 0o600);
    copied += 1;
  }
  return copied;
}

function migrateLegacyUploads() {
  const migrations = [
    [LEGACY_DRIVER_PROFILE_UPLOADS_DIR, DRIVER_PROFILE_UPLOADS_DIR],
    [LEGACY_DRIVER_ID_UPLOADS_DIR, DRIVER_ID_UPLOADS_DIR],
    [LEGACY_CUSTOMER_ID_UPLOADS_DIR, CUSTOMER_ID_UPLOADS_DIR],
    [LEGACY_DRIVER_DOCS_DIR, PERSISTENT_DRIVER_DOCS_DIR]
  ];
  const copied = migrations.reduce(
    (total, [sourceDir, destinationDir]) =>
      total + migrateLegacyUploadDirectory(sourceDir, destinationDir),
    0
  );
  if (copied > 0) {
    console.log(`✓ Migrated ${copied} legacy upload file(s) to ${PERSISTENT_UPLOADS_ROOT}`);
  }
}

migrateLegacyUploads();
// Never mount identity document directories. Legacy Driver paths are now
// deliberately denied, even when an old filename is known.
app.use('/uploads/customer_identity', (_req, res) => res.status(404).end());
app.use('/uploads/driver_docs', (_req, res) => res.status(404).end());
app.use('/uploads/driver_profiles', express.static(DRIVER_PROFILE_UPLOADS_DIR));

// Lightweight in-process abuse protection for unauthenticated/high-cost
// endpoints. Production deployments should still put a shared gateway/WAF in
// front of autoscaled instances, but this prevents a single instance from
// being trivially exhausted and fails closed for malformed bursts.
const RATE_LIMIT_BUCKETS = new Map();
const RATE_LIMIT_MAX_BUCKETS = 20_000;
let lastRateLimitPruneAt = 0;
function requestIpKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}
function pruneRateLimitBuckets(now) {
  if (now - lastRateLimitPruneAt < 15_000 && RATE_LIMIT_BUCKETS.size <= RATE_LIMIT_MAX_BUCKETS) {
    return;
  }
  lastRateLimitPruneAt = now;
  for (const [bucketKey, bucket] of RATE_LIMIT_BUCKETS) {
    if (bucket.resetAt <= now) RATE_LIMIT_BUCKETS.delete(bucketKey);
  }
  if (RATE_LIMIT_BUCKETS.size > RATE_LIMIT_MAX_BUCKETS) {
    const excess = RATE_LIMIT_BUCKETS.size - RATE_LIMIT_MAX_BUCKETS;
    let removed = 0;
    for (const bucketKey of RATE_LIMIT_BUCKETS.keys()) {
      RATE_LIMIT_BUCKETS.delete(bucketKey);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}
function rateLimit({ name = 'default', windowMs, max, key = requestIpKey }) {
  return (req, res, next) => {
    const now = Date.now();
    pruneRateLimitBuckets(now);
    const bucketKey = `${name}:${key(req)}`;
    const current = RATE_LIMIT_BUCKETS.get(bucketKey);
    if (!current || current.resetAt <= now) {
      RATE_LIMIT_BUCKETS.set(bucketKey, { count: 1, resetAt: now + windowMs });
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - 1)));
      res.setHeader('RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));
      return next();
    }
    current.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - current.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));
    if (current.count > max) {
      res.setHeader('Retry-After', Math.ceil((current.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    return next();
  };
}
const identityRateKey = req => `${requestIpKey(req)}:${String(
  req.body?.email || req.body?.username || req.body?.phone || ''
).trim().toLowerCase() || 'anonymous'}`;
app.use('/api', rateLimit({
  name: 'api-ip',
  windowMs: 60 * 1000,
  max: 600,
  key: requestIpKey
}));
app.use(['/api/auth/login', '/api/admin/login', '/api/admin/sub-user/login'],
  rateLimit({ name: 'auth-login', windowMs: 15 * 60 * 1000, max: 12, key: identityRateKey }));
app.use(['/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/admin/forgot-password'],
  rateLimit({ name: 'auth-recovery', windowMs: 15 * 60 * 1000, max: 10, key: identityRateKey }));
app.use('/api/auth/phone-otp/request',
  rateLimit({ name: 'auth-phone-otp', windowMs: 10 * 60 * 1000, max: 5, key: identityRateKey }));
app.use('/api/geocode', rateLimit({ name: 'geocode', windowMs: 60 * 1000, max: 120 }));
app.use('/api/fare/calculate', rateLimit({ name: 'fare-calculate', windowMs: 60 * 1000, max: 120 }));
app.use('/api/sos', rateLimit({ name: 'sos', windowMs: 10 * 60 * 1000, max: 20 }));
app.post('/api/rides', rateLimit({
  name: 'ride-create',
  windowMs: 10 * 60 * 1000,
  max: 10,
  key: requestIpKey
}));

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

async function compressImage(bytes) {
  return sharp(bytes)
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

async function writeCompressedImage(dataUrl, fieldName, destinationDir) {
  const { bytes } = parseImageDataUrl(dataUrl);
  const fname = `${fieldName}_${Date.now()}_${crypto.randomBytes(10).toString('hex')}.jpg`;
  try {
    const compressed = await compressImage(bytes);
    fs.writeFileSync(path.join(destinationDir, fname), compressed, { mode: 0o600 });
  }
  catch (err) {
    throw new Error(`Unable to save ${fieldName} document: ${err.message}`);
  }
  return fname;
}

async function saveDriverProfilePhoto(dataUrl) {
  const filename = await writeCompressedImage(dataUrl, 'profile', DRIVER_PROFILE_UPLOADS_DIR);
  return `/uploads/driver_profiles/${filename}`;
}

async function savePrivateDriverDocument(dataUrl, fieldName) {
  return writeCompressedImage(dataUrl, fieldName, DRIVER_ID_UPLOADS_DIR);
}

function driverDocumentDirectories(fieldName) {
  const isProfile = fieldName === 'profilePhoto';
  return isProfile
    ? [
        DRIVER_PROFILE_UPLOADS_DIR,
        LEGACY_DRIVER_PROFILE_UPLOADS_DIR,
        PERSISTENT_DRIVER_DOCS_DIR,
        LEGACY_DRIVER_DOCS_DIR
      ]
    : [
        DRIVER_ID_UPLOADS_DIR,
        LEGACY_DRIVER_ID_UPLOADS_DIR,
        PERSISTENT_DRIVER_DOCS_DIR,
        LEGACY_DRIVER_DOCS_DIR
      ];
}

function customerIdentityDirectories() {
  return [CUSTOMER_ID_UPLOADS_DIR, LEGACY_CUSTOMER_ID_UPLOADS_DIR];
}

function findStoredFile(value, directories) {
  const filename = path.basename(String(value || ''));
  if (!filename) return '';
  for (const directory of directories) {
    const candidate = path.join(directory, filename);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return '';
}

function resolveStoredDriverDocument(value, fieldName) {
  return findStoredFile(value, driverDocumentDirectories(fieldName));
}

function resolveStoredCustomerIdentityDocument(value) {
  return findStoredFile(value, customerIdentityDirectories());
}

function deleteStoredFiles(value, directories) {
  const filename = path.basename(String(value || ''));
  if (!filename) return;
  for (const directory of directories) {
    try {
      fs.unlinkSync(path.join(directory, filename));
    } catch {}
  }
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
    deleteStoredFiles(filename, customerIdentityDirectories());
  }
}

function deleteStoredAccountFiles(account = {}) {
  deletePrivateIdentityDocuments([
    account.customerIdFront,
    account.customerIdBack,
    account.studentIdImage
  ]);
  for (const [fieldName, value] of Object.entries({
    profilePhoto: account.profilePhoto,
    cnicFront: account.cnicFront,
    cnicBack: account.cnicBack,
    licensePhoto: account.licensePhoto,
    vehicleRegPhoto: account.vehicleRegPhoto
  })) {
    deleteStoredFiles(value, driverDocumentDirectories(fieldName));
  }
}

function loadPage(file) {
  const full = path.resolve(PUBLIC_DIR, file);
  try {
    const html = fs.readFileSync(full, 'utf8');
    const mapboxBootstrap = `<script>window.__MYRIDE_MAPBOX_PUBLIC_TOKEN__=${JSON.stringify(getMapboxAccessToken())};</script>`;
    return html.replace('</head>', `${mapboxBootstrap}</head>`);
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

const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'ride-hailing-secret-fallback';
let dbConnected  = false;
let adminSecurityInitializationPromise = null;
let mongoConnectionHandlersInstalled = false;

const MONGO_DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 30_000;
const MONGO_DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MONGO_DEFAULT_HEARTBEAT_FREQUENCY_MS = 10_000;
const MONGO_DEFAULT_INITIAL_RETRY_DELAY_MS = 5_000;
const MONGO_DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

function positiveIntegerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function getMongoConnectionOptions() {
  const serverSelectionTimeoutMS = positiveIntegerEnv(
    'MONGO_SERVER_SELECTION_TIMEOUT_MS',
    MONGO_DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
    { min: 5_000, max: 120_000 }
  );
  return {
    serverSelectionTimeoutMS,
    connectTimeoutMS: positiveIntegerEnv(
      'MONGO_CONNECT_TIMEOUT_MS',
      MONGO_DEFAULT_CONNECT_TIMEOUT_MS,
      { min: 5_000, max: 120_000 }
    ),
    // Mongoose requires heartbeatFrequencyMS to be lower than the server
    // selection timeout. Keep a safe margin even when operators customize it.
    heartbeatFrequencyMS: Math.min(
      positiveIntegerEnv(
        'MONGO_HEARTBEAT_FREQUENCY_MS',
        MONGO_DEFAULT_HEARTBEAT_FREQUENCY_MS,
        { min: 5_000, max: 60_000 }
      ),
      Math.max(5_000, serverSelectionTimeoutMS - 1_000)
    )
  };
}

function getMongoRetryOptions() {
  return {
    // Zero means retry indefinitely. A finite value is useful for controlled
    // deployments/tests that prefer startup to give up after a fixed budget.
    maxAttempts: positiveIntegerEnv('MONGO_INITIAL_RETRY_ATTEMPTS', 0, { min: 0, max: 100 }),
    initialDelayMS: positiveIntegerEnv(
      'MONGO_INITIAL_RETRY_DELAY_MS',
      MONGO_DEFAULT_INITIAL_RETRY_DELAY_MS,
      { min: 1_000, max: 60_000 }
    ),
    maxDelayMS: positiveIntegerEnv(
      'MONGO_MAX_RETRY_DELAY_MS',
      MONGO_DEFAULT_MAX_RETRY_DELAY_MS,
      { min: 1_000, max: 300_000 }
    )
  };
}

const MONGO_URI_ENV_KEYS = Object.freeze([
  'MONGO_URI',
  'MONGODB_URI',
  'MONGO_URL',
  'MONGODB_URL'
]);

function getConfiguredMongoUri() {
  for (const key of MONGO_URI_ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) return { uri: value, source: key };
  }

  // Replit's DATABASE_URL is normally PostgreSQL and must not be passed to
  // Mongoose. Accept it only when an operator has explicitly put a Mongo URI
  // in that legacy variable.
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (/^mongodb(?:\+srv)?:\/\//i.test(databaseUrl)) {
    return { uri: databaseUrl, source: 'DATABASE_URL' };
  }

  return { uri: '', source: '' };
}

function getDatabaseStatus() {
  if (dbConnected || mongoose.connection.readyState === 1) return 'connected';
  if (getConfiguredMongoUri().uri) return 'connecting';
  if (process.env.DEMO_ACCOUNTS_ENABLED === 'true' && process.env.NODE_ENV !== 'production') {
    return 'testing-mode';
  }
  return 'unconfigured';
}

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
  'Car Mini AC',
  'Car Mini Non-AC',
  'Riksha',
  'Bike',
  'Car SUV',
  'Van Seven Seats',
  'Cary Dibba',
  'Toyota Highroof',
  'Toyota Saloon Coaster',
  'Old Cars',
  'Off-Road Dalla (Pickup)',
  'Toyota Land Cruiser V8',
  'Electric Scooty'
];
const FARE_VEHICLE_ALIASES = {
  Sedan: 'Car Sedan',
  'Car AC': 'Car Sedan',
  Rickshaw: 'Riksha',
  // Existing Mini vehicles were never marked with their air-conditioning
  // status. Keep them serviceable as Non-AC while every new selection uses
  // one of the two explicit canonical categories.
  'Car Mini': 'Car Mini Non-AC',
  'Car Mini Non AC': 'Car Mini Non-AC',
  'Car Mini NonAC': 'Car Mini Non-AC',
  'Car Mini A/C': 'Car Mini AC',
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

const LEGACY_CAR_MINI_CATEGORY = 'Car Mini';
function isSplitCarMiniCategory(category) {
  return category === 'Car Mini AC' || category === 'Car Mini Non-AC';
}

function legacyCarMiniSetting(value, category) {
  return isSplitCarMiniCategory(category) ? value?.[LEGACY_CAR_MINI_CATEGORY] : undefined;
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
    const source = value?.[category] ?? (legacyAlias ? value[legacyAlias] : undefined) ??
      legacyCarMiniSetting(value, category);
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

const WALLET_FUNDING_SOURCES = Object.freeze({
  REAL: 'real',
  BONUS: 'bonus',
  MIXED: 'mixed',
  EARNINGS: 'earnings',
  UNKNOWN: 'unknown'
});

function roundWalletAmount(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function isBonusTransactionDescription(description = '') {
  return /bonus|trial|promotional/i.test(String(description));
}

function isRideEarningsTransaction(transaction) {
  return String(transaction?.fundingSource || '').toLowerCase() === WALLET_FUNDING_SOURCES.EARNINGS
    || String(transaction?.description || '').trim().toLowerCase() === 'ride earnings';
}

function isLegacyRideEarningsTransaction(transaction) {
  return isRideEarningsTransaction(transaction)
    && String(transaction?.fundingSource || '').toLowerCase() !== WALLET_FUNDING_SOURCES.EARNINGS;
}

function getWalletSourceBalances(wallet) {
  const trackedReal = Number(wallet?.realCashAvailable);
  const trackedBonus = Number(wallet?.bonusAvailable);
  const transactions = Array.isArray(wallet?.transactions) ? wallet.transactions : [];
  const hasLegacyRideEarningsTransactions = transactions.some(isLegacyRideEarningsTransaction);
  const hasLegacyTransactions = transactions.some(transaction => {
    if (isRideEarningsTransaction(transaction)) return false;
    const source = String(transaction.fundingSource || '').toLowerCase();
    return ![WALLET_FUNDING_SOURCES.REAL, WALLET_FUNDING_SOURCES.BONUS, WALLET_FUNDING_SOURCES.MIXED].includes(source);
  });

  if (Number.isFinite(trackedReal) && Number.isFinite(trackedBonus) && !hasLegacyTransactions && !hasLegacyRideEarningsTransactions) {
    // Some old test/manual wallets contain an aggregate balance but no ledger
    // credits. Treat that unclassified balance as real rather than allowing a
    // zero-valued default source bucket to misclassify a new fee as bonus.
    if (!transactions.length && trackedReal === 0 && trackedBonus === 0 && Number(wallet?.balance) > 0
      && Number(wallet?.realCashWallet || 0) === 0 && Number(wallet?.bonusWallet || 0) === 0) {
      return { realCashAvailable: roundWalletAmount(wallet.balance), bonusAvailable: 0 };
    }
    return {
      realCashAvailable: Math.max(0, roundWalletAmount(trackedReal)),
      bonusAvailable: Math.max(0, roundWalletAmount(trackedBonus))
    };
  }

  let realCashAvailable = 0;
  let bonusAvailable = 0;
  let hasCreditLedger = false;
  for (const transaction of transactions) {
    if (isRideEarningsTransaction(transaction)) continue;
    const amount = Math.max(0, roundWalletAmount(transaction.amount));
    const source = String(transaction.fundingSource || '').toLowerCase();
    if (transaction.type === 'credit') {
      hasCreditLedger = true;
      if (source === WALLET_FUNDING_SOURCES.BONUS || (!source && isBonusTransactionDescription(transaction.description))) {
        bonusAvailable += amount;
      } else {
        realCashAvailable += amount;
      }
      continue;
    }

    if (transaction.type !== 'debit') continue;
    const explicitReal = Number(transaction.realAmount);
    const explicitBonus = Number(transaction.bonusAmount);
    if (Number.isFinite(explicitReal) || Number.isFinite(explicitBonus)
      || [WALLET_FUNDING_SOURCES.REAL, WALLET_FUNDING_SOURCES.BONUS, WALLET_FUNDING_SOURCES.MIXED].includes(source)) {
      bonusAvailable = Math.max(0, bonusAvailable - Math.max(0, Number.isFinite(explicitBonus) ? explicitBonus : source === WALLET_FUNDING_SOURCES.BONUS ? amount : 0));
      realCashAvailable = Math.max(0, realCashAvailable - Math.max(0, Number.isFinite(explicitReal) ? explicitReal : source === WALLET_FUNDING_SOURCES.REAL ? amount : 0));
      continue;
    }

    // Legacy debits do not carry their source. Consume bonus first so an
    // unknown historical debit can never be overstated as real revenue.
    const legacyBonusDebit = Math.min(bonusAvailable, amount);
    bonusAvailable -= legacyBonusDebit;
    realCashAvailable = Math.max(0, realCashAvailable - (amount - legacyBonusDebit));
  }

  if (!hasCreditLedger && hasLegacyRideEarningsTransactions
    && Number.isFinite(trackedReal) && Number.isFinite(trackedBonus)) {
    // Old settlements were mislabeled as real wallet credits. If there is no
    // credit ledger to reconstruct from, remove those historical earnings from
    // the tracked real-cash bucket while preserving later debit effects.
    const legacyEarnings = transactions
      .filter(isLegacyRideEarningsTransaction)
      .reduce((sum, transaction) => sum + Math.max(0, roundWalletAmount(transaction.amount)), 0);
    return {
      realCashAvailable: Math.max(0, roundWalletAmount(trackedReal - legacyEarnings)),
      bonusAvailable: Math.max(0, roundWalletAmount(trackedBonus))
    };
  }

  if (!hasCreditLedger && !transactions.length) {
    const legacyBonus = Math.max(0, roundWalletAmount(wallet?.bonusWallet));
    const legacyReal = Math.max(0, roundWalletAmount(wallet?.realCashWallet));
    if (legacyBonus || legacyReal) {
      return { realCashAvailable: legacyReal, bonusAvailable: legacyBonus };
    }
    return { realCashAvailable: Math.max(0, roundWalletAmount(wallet?.balance)), bonusAvailable: 0 };
  }

  return {
    realCashAvailable: roundWalletAmount(realCashAvailable),
    bonusAvailable: roundWalletAmount(bonusAvailable)
  };
}

function getCombinedWalletBalance(wallet) {
  const balances = getWalletSourceBalances(wallet);
  return roundWalletAmount(balances.realCashAvailable + balances.bonusAvailable);
}

function walletMeetsCombinedRequirement(wallet, requiredAmount) {
  const required = Math.max(0, roundWalletAmount(requiredAmount));
  return getCombinedWalletBalance(wallet) >= required;
}

const ADMIN_WALLET_BALANCE_FIELDS = 'user balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions';

function getAdminWalletBalances(wallet) {
  const sourceBalances = getWalletSourceBalances(wallet);
  const realWalletBalance = roundWalletAmount(Math.max(0, sourceBalances.realCashAvailable));
  const bonusCreditBalance = roundWalletAmount(Math.max(0, sourceBalances.bonusAvailable));
  return {
    realWalletBalance,
    bonusCreditBalance,
    advanceDeposit: realWalletBalance
  };
}

async function getDriverWalletSnapshots(driverIds = null) {
  const ids = driverIds || (await User.find({ role: 'driver' }).select('_id').lean()).map(driver => driver._id);
  if (!ids.length) return [];
  return Wallet.find({ user: { $in: ids } })
    .select(ADMIN_WALLET_BALANCE_FIELDS)
    .lean();
}

async function getCurrentDriverAdvanceDeposits() {
  const wallets = await getDriverWalletSnapshots();
  return Number(wallets.reduce((total, wallet) => (
    total + getAdminWalletBalances(wallet).advanceDeposit
  ), 0).toFixed(2));
}

function allocateWalletDebit(wallet, amount) {
  const total = Math.max(0, roundWalletAmount(amount));
  const sourceBalances = getWalletSourceBalances(wallet);
  const realAmount = Math.min(total, sourceBalances.realCashAvailable);
  const bonusAmount = total - realAmount;
  const fundingSource = bonusAmount > 0 && realAmount > 0
    ? WALLET_FUNDING_SOURCES.MIXED
    : bonusAmount > 0
      ? WALLET_FUNDING_SOURCES.BONUS
      : WALLET_FUNDING_SOURCES.REAL;
  return {
    ...sourceBalances,
    amount: total,
    realAmount: roundWalletAmount(realAmount),
    bonusAmount: roundWalletAmount(bonusAmount),
    fundingSource,
    remainingReal: roundWalletAmount(sourceBalances.realCashAvailable - realAmount),
    remainingBonus: roundWalletAmount(sourceBalances.bonusAvailable - bonusAmount)
  };
}

async function ensureWalletSourceBalances(userId, { session } = {}) {
  if (!mongoose.isValidObjectId(userId)) return null;
  const walletQuery = Wallet.findOne({ user: userId })
    .select('balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions');
  if (session) walletQuery.session(session);
  const wallet = await walletQuery.lean();
  if (!wallet) return null;

  const balances = getWalletSourceBalances(wallet);
  const hasLegacyRideEarningsTransactions = wallet.transactions?.some(isLegacyRideEarningsTransaction);
  const hasTrackedFields = Number.isFinite(Number(wallet.realCashAvailable))
    && Number.isFinite(Number(wallet.bonusAvailable))
    && !hasLegacyRideEarningsTransactions
    && !wallet.transactions?.some(transaction => {
      if (isRideEarningsTransaction(transaction)) return false;
      const source = String(transaction.fundingSource || '').toLowerCase();
      return ![WALLET_FUNDING_SOURCES.REAL, WALLET_FUNDING_SOURCES.BONUS, WALLET_FUNDING_SOURCES.MIXED].includes(source);
    });
  const hasUnclassifiedAggregate = !wallet.transactions?.length
    && Number(wallet.balance) > 0
    && Number(wallet.realCashAvailable || 0) === 0
    && Number(wallet.bonusAvailable || 0) === 0
    && Number(wallet.realCashWallet || 0) === 0
    && Number(wallet.bonusWallet || 0) === 0;
  const canonicalBalance = roundWalletAmount(balances.realCashAvailable + balances.bonusAvailable);
  const aggregateNeedsRepair = !Number.isFinite(Number(wallet.balance))
    || roundWalletAmount(wallet.balance) !== canonicalBalance;
  if (!hasTrackedFields || hasUnclassifiedAggregate || aggregateNeedsRepair) {
    const updateQuery = Wallet.updateOne(
      { _id: wallet._id },
      {
        $set: {
          balance: canonicalBalance,
          realCashAvailable: balances.realCashAvailable,
          bonusAvailable: balances.bonusAvailable
        }
      }
    );
    if (session) updateQuery.session(session);
    await updateQuery;
  }
  return {
    ...wallet,
    realCashAvailable: balances.realCashAvailable,
    bonusAvailable: balances.bonusAvailable
  };
}

const DAILY_FEE_UNPAID_MESSAGE = 'You cannot receive rides. Your fee is unpaid. The Accept button is disabled until you clear your balance.';

function applySession(query, session) {
  return session && typeof query?.session === 'function' ? query.session(session) : query;
}

async function chargeDailyFeeForOnlineDriverCore(driverId, driver, dailyFeeSettings = null, session = null) {
  if (isLongRangeOnlyDriver(driver)) {
    return { allowed: true, charged: false, rate: null, exempt: true, reason: 'Long Range Only drivers are exempt from the Daily Fee' };
  }
  const rate = await getDailyFeeForVehicle(driver.vehicleType, dailyFeeSettings);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { allowed: true, charged: false, rate: null };
  }

  const now = new Date();
  const activePassCutoff = new Date(now.getTime() - ACTIVE_FEE_PASS_MS);
  const paidUntilDate = driver.paidUntilDate ? new Date(driver.paidUntilDate) : null;
  if (paidUntilDate && !Number.isNaN(paidUntilDate.getTime()) && paidUntilDate >= now) {
    return { allowed: true, charged: false, rate, alreadyPaid: true, paidUntilDate };
  }

  // The transaction path also repairs legacy/stale aggregate balances before
  // the conditional debit. Keep the disconnected test seam read-only because
  // its lightweight wallet doubles intentionally do not implement updateOne.
  if (session) await ensureWalletSourceBalances(driverId, { session });
  const walletSnapshotQuery = Wallet.findOne({ user: driverId })
    .select('fee_paid_at balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions');
  const walletSnapshot = await applySession(walletSnapshotQuery, session).lean();
  // Only the wallet's fee marker can authorize a wallet-paid pass. A User
  // lastDailyFeePaidAt value is legacy display state and may exist without the
  // corresponding debit (for example after an interrupted old approval flow).
  const previousFeePaidAt = walletSnapshot?.fee_paid_at;
  if (previousFeePaidAt && new Date(previousFeePaidAt) > activePassCutoff) {
    return {
      allowed: true,
      charged: false,
      rate,
      alreadyPaid: true,
      feePaidAt: previousFeePaidAt,
      paidUntilDate: new Date(new Date(previousFeePaidAt).getTime() + ACTIVE_FEE_PASS_MS)
    };
  }

  const allocation = allocateWalletDebit(walletSnapshot, rate);
  if (!walletMeetsCombinedRequirement(walletSnapshot, rate)) {
    return { allowed: false, charged: false, rate, reason: DAILY_FEE_UNPAID_MESSAGE, balance: walletSnapshot?.balance || 0 };
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
      $set: {
        balance: roundWalletAmount(allocation.remainingReal + allocation.remainingBonus),
        fee_paid_at: now,
        dailyFeeChargedDate: todayUTC(),
        realCashAvailable: allocation.remainingReal,
        bonusAvailable: allocation.remainingBonus
      },
      $push: {
        transactions: {
          amount: rate,
          type: 'debit',
          description: `Automatic daily fee for going online (${driver.vehicleType || 'Car'})`,
          fundingSource: allocation.fundingSource,
          realAmount: allocation.realAmount,
          bonusAmount: allocation.bonusAmount
        }
      }
    },
    { new: true, ...(session ? { session } : {}) }
  );

  if (!wallet) {
    const currentWalletQuery = Wallet.findOne({ user: driverId })
      .select('balance fee_paid_at');
    const currentWallet = await applySession(currentWalletQuery, session).lean();
    if (currentWallet?.fee_paid_at && new Date(currentWallet.fee_paid_at) > activePassCutoff) {
      return { allowed: true, charged: false, rate, alreadyCharged: true, balance: currentWallet.balance, feePaidAt: currentWallet.fee_paid_at };
    }
    return { allowed: false, charged: false, rate, balance: currentWallet?.balance || 0, reason: DAILY_FEE_UNPAID_MESSAGE };
  }

  const driverUpdate = await User.updateOne(
    { _id: driverId },
    {
      lastDailyFeePaidAt: now,
      paidUntilDate: new Date(now.getTime() + ACTIVE_FEE_PASS_MS),
      isFreeTrial: false
    },
    session ? { session } : undefined
  );
  if (driverUpdate.matchedCount === 0 && driverUpdate.n === 0) {
    throw financialError('Driver account could not be updated; the Daily Fee was not charged.', 503, 'DRIVER_UPDATE_FAILED');
  }
  return {
    allowed: true,
    charged: true,
    rate,
    balance: wallet.balance,
    feePaidAt: now,
    paidUntilDate: new Date(now.getTime() + ACTIVE_FEE_PASS_MS),
    wallet,
    fundingSource: allocation.fundingSource,
    realAmount: allocation.realAmount,
    bonusAmount: allocation.bonusAmount
  };
}

async function chargeDailyFeeForOnlineDriver(driverId, driver, dailyFeeSettings = null) {
  // Production financial writes must commit the wallet debit, ledger entry, and
  // Driver pass together. The disconnected branch preserves the lightweight
  // unit-test seam used by lifecycle tests; the real application never reaches
  // it because database readiness is required before financial operations.
  if (mongoose.connection.readyState !== 1) {
    return chargeDailyFeeForOnlineDriverCore(driverId, driver, dailyFeeSettings);
  }
  return runFinancialTransaction(session =>
    chargeDailyFeeForOnlineDriverCore(driverId, driver, dailyFeeSettings, session)
  );
}

async function getDriverDailyFeeEligibility(driver) {
  if (isLongRangeOnlyDriver(driver)) {
    return { allowed: true, exempt: true, rate: null, reason: null };
  }
  const rate = await getDailyFeeForVehicle(driver?.vehicleType);
  const paidUntilDate = driver?.paidUntilDate ? new Date(driver.paidUntilDate) : null;
  const paid = paidUntilDate && !Number.isNaN(paidUntilDate.getTime()) && paidUntilDate >= new Date();
  return {
    allowed: Boolean(paid) || !Number.isFinite(rate) || rate <= 0,
    rate: Number.isFinite(rate) && rate > 0 ? rate : null,
    reason: paid ? null : Number.isFinite(rate) && rate > 0
      ? DAILY_FEE_UNPAID_MESSAGE
      : 'Daily Fee is not configured; contact Admin.'
  };
}

const DEFAULT_PER_KM_RATES = {
  Bike: 30,
  Riksha: 40,
  'Car Mini AC': 50,
  'Car Mini Non-AC': 50,
  'Car Sedan': 70,
  'Cary Dibba': 80,
  'Car SUV': 100,
  'Van Seven Seats': 100,
  'Toyota Highroof': 120,
  'Toyota Saloon Coaster': 140,
  'Old Cars': 70,
  'Off-Road Dalla (Pickup)': 110,
  'Toyota Land Cruiser V8': 180,
  'Electric Scooty': 25
};

const VEHICLE_CATEGORY_SETTINGS_KEY = 'vehicle_category_settings';
const DEFAULT_VEHICLE_CATEGORY_SETTINGS = Object.freeze(
  Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, { active: true }]))
);
const SETTINGS_MEMORY_CACHE_TTL_MS = 5_000;
const settingsMemoryCache = new Map();
const settingsCacheEnabled = () => Boolean(String(process.env.REDIS_URL || '').trim());

async function getCachedAdminSetting({
  key,
  fallback,
  normalize,
  load
}) {
  const cachingEnabled = settingsCacheEnabled();
  const now = Date.now();
  const memoryEntry = settingsMemoryCache.get(key);
  if (cachingEnabled && memoryEntry && now - memoryEntry.cachedAt < SETTINGS_MEMORY_CACHE_TTL_MS) {
    return memoryEntry.value;
  }

  if (cachingEnabled) {
    const redisValue = await redisGetJson(key);
    if (redisValue !== null) {
      const value = normalize(redisValue);
      settingsMemoryCache.set(key, { value, cachedAt: now });
      return value;
    }
  }

  // Unit tests replace the model method with an in-memory loader while the
  // real Mongoose connection remains disconnected. Treat that explicit test
  // double as readable, but keep the production no-database fallback.
  const databaseReady = dbConnected
    || mongoose.connection.readyState === 1
    || Settings.findOne !== nativeSettingsFindOne;
  const rawValue = databaseReady ? await load() : fallback;
  const value = normalize(rawValue);
  if (cachingEnabled) {
    settingsMemoryCache.set(key, { value, cachedAt: now });
    void redisSetJson(key, value);
  }
  return value;
}

function primeCachedAdminSetting(key, value) {
  if (!settingsCacheEnabled()) return;
  settingsMemoryCache.set(key, { value, cachedAt: Date.now() });
  void redisSetJson(key, value);
}

function invalidateCachedAdminSetting(key) {
  settingsMemoryCache.delete(key);
  void redisDelete(key);
}

function normalizeVehicleCategorySettings(value = {}) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
    const source = value?.[category];
    const active = typeof source === 'boolean' ? source : source?.active !== false;
    return [category, { active }];
  }));
}

function isVehicleCategoryActive(settings, vehicleType) {
  const category = normalizeFareVehicle(vehicleType);
  return FARE_VEHICLE_CATEGORIES.includes(category)
    && normalizeVehicleCategorySettings(settings)[category].active;
}

async function getVehicleCategorySettings() {
  return getCachedAdminSetting({
    key: VEHICLE_CATEGORY_SETTINGS_KEY,
    fallback: DEFAULT_VEHICLE_CATEGORY_SETTINGS,
    normalize: normalizeVehicleCategorySettings,
    load: async () => (await Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean())?.value
  });
}

const WAITING_RATE_SETTINGS_KEY = 'waiting_rate_settings';
const DEFAULT_WAITING_GRACE_MINUTES = 5;
const WAITING_STOP_DISTANCE_KM = 0.03;
const DEFAULT_WAITING_RATE_SETTINGS = Object.freeze(
  Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, {
    enabled: false,
    ratePerMinute: 0,
    graceMinutes: DEFAULT_WAITING_GRACE_MINUTES
  }]))
);
let waitingRateSettingsCache = null;
let waitingRateSettingsCacheAt = 0;
const WAITING_RATE_CACHE_TTL_MS = 5000;

function normalizeWaitingRateSettings(value = {}) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
    const source = value?.[category];
    const ratePerMinute = Number(source?.ratePerMinute ?? source?.perMinuteRate ?? 0);
    const graceMinutes = Number(source?.graceMinutes ?? DEFAULT_WAITING_GRACE_MINUTES);
    return [category, {
      enabled: source?.enabled === true,
      ratePerMinute: Number.isFinite(ratePerMinute) && ratePerMinute >= 0 ? ratePerMinute : 0,
      graceMinutes: Number.isFinite(graceMinutes) && graceMinutes >= 0 ? graceMinutes : DEFAULT_WAITING_GRACE_MINUTES
    }];
  }));
}

function validateWaitingRateSettings(value) {
  const settings = normalizeWaitingRateSettings(value);
  const errors = [];
  for (const category of FARE_VEHICLE_CATEGORIES) {
    const source = value?.[category] || {};
    const setting = settings[category];
    const rawRate = source.ratePerMinute ?? source.perMinuteRate;
    const rawGrace = source.graceMinutes;
    if (rawRate !== undefined && rawRate !== '' && (!Number.isFinite(Number(rawRate)) || Number(rawRate) < 0)) {
      errors.push(`${category}: Waiting rate must be zero or greater`);
    }
    if (rawGrace !== undefined && rawGrace !== '' && (!Number.isFinite(Number(rawGrace)) || Number(rawGrace) < 0 || Number(rawGrace) > 1440)) {
      errors.push(`${category}: Grace period must be between 0 and 1440 minutes`);
    }
    if (rawRate !== undefined && rawRate !== '' && Math.round(Number(rawRate) * 100) !== Number(rawRate) * 100) {
      errors.push(`${category}: Waiting rate can have at most two decimal places`);
    }
    if (rawGrace !== undefined && rawGrace !== '' && Math.round(Number(rawGrace) * 100) !== Number(rawGrace) * 100) {
      errors.push(`${category}: Grace period can have at most two decimal places`);
    }
    if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
      errors.push(`${category}: Waiting toggle must be true or false`);
    }
  }
  return { settings, errors };
}

async function getWaitingRateSettings({ force = false } = {}) {
  if (!force && waitingRateSettingsCache && Date.now() - waitingRateSettingsCacheAt < WAITING_RATE_CACHE_TTL_MS) {
    return waitingRateSettingsCache;
  }
  const databaseReady = dbConnected || mongoose.connection.readyState === 1;
  if (!databaseReady) {
    waitingRateSettingsCache = normalizeWaitingRateSettings(DEFAULT_WAITING_RATE_SETTINGS);
    waitingRateSettingsCacheAt = Date.now();
    return waitingRateSettingsCache;
  }
  const doc = await Settings.findOne({ key: WAITING_RATE_SETTINGS_KEY }).lean();
  waitingRateSettingsCache = normalizeWaitingRateSettings(doc?.value);
  waitingRateSettingsCacheAt = Date.now();
  return waitingRateSettingsCache;
}

function clearWaitingRateSettingsCache() {
  waitingRateSettingsCache = null;
  waitingRateSettingsCacheAt = 0;
}

function calculateWaitingFare(settings, vehicleType, waitingSeconds = 0) {
  const category = normalizeFareVehicle(vehicleType);
  const config = normalizeWaitingRateSettings(settings)[category] || {
    enabled: false,
    ratePerMinute: 0,
    graceMinutes: DEFAULT_WAITING_GRACE_MINUTES
  };
  const seconds = Number(waitingSeconds);
  const normalizedSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const enabled = config.enabled && config.ratePerMinute > 0;
  const waitingMinutes = enabled ? normalizedSeconds / 60 : 0;
  const waitingFare = waitingMinutes * config.ratePerMinute;
  return {
    waitingEnabled: enabled,
    waitingSeconds: Number(normalizedSeconds.toFixed(2)),
    waitingMinutes: Number(waitingMinutes.toFixed(2)),
    waitingRatePerMinute: config.ratePerMinute,
    waitingGraceMinutes: config.graceMinutes,
    waitingFare: Number(waitingFare.toFixed(2))
  };
}

function normalizePerKmRates(value = {}) {
  return Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
    const aliases = Object.keys(FARE_VEHICLE_ALIASES).filter(alias => FARE_VEHICLE_ALIASES[alias] === category);
    const raw = value?.[category] ?? aliases.map(alias => value?.[alias]).find(item => item !== undefined) ??
      legacyCarMiniSetting(value, category);
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
    const source = input[category] || legacyCarMiniSetting(input, category) || {};
    const normalized = {
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
    if (source.perMinuteRate !== undefined) {
      normalized.perMinuteRate = Number.isFinite(Number(source.perMinuteRate)) && Number(source.perMinuteRate) >= 0
        ? Number(source.perMinuteRate) : 0;
    }
    output[category] = normalized;
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
const LONG_RANGE_COMMISSION_TIMINGS = Object.freeze(['started', 'completed']);
const DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES = Object.freeze(
  Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 500]))
);
const DEFAULT_LONG_RANGE_SETTINGS = Object.freeze({
  enabled: false,
  distanceCutoffKm: 50,
  minimumWalletBalances: DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES,
  broadcastRadiusKm: 30,
  commissionDeductionTiming: 'started',
  // Long Range platform commissions are percentages configured by Admin for
  // each vehicle category. Keep the setting key stable for persisted data and
  // existing Admin API clients.
  manualCommissionAmounts: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, 0])),
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
      const configuredMinimum = source.minimumWalletBalances?.[category] ??
        legacyCarMiniSetting(source.minimumWalletBalances, category) ?? legacyMinimum;
      return [category, numberInRange(configuredMinimum, DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES[category], 0, 1000000)];
    })),
    broadcastRadiusKm: numberInRange(source.broadcastRadiusKm, DEFAULT_LONG_RANGE_SETTINGS.broadcastRadiusKm, 0.5, 500),
    commissionDeductionTiming: LONG_RANGE_COMMISSION_TIMINGS.includes(source.commissionDeductionTiming)
      ? source.commissionDeductionTiming
      : DEFAULT_LONG_RANGE_SETTINGS.commissionDeductionTiming,
    manualCommissionAmounts: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
      const amount = source.manualCommissionAmounts?.[category] ??
        legacyCarMiniSetting(source.manualCommissionAmounts, category);
      return [category, numberInRange(amount, 0, 0, 1000000)];
    })),
    perKmRates: Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => {
      const rate = Number(source.perKmRates?.[category] ?? legacyCarMiniSetting(source.perKmRates, category));
      return [category, Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(2)) : null];
    }))
  };
}

function validateLongRangeSettings(input) {
  const settings = normalizeLongRangeSettings(input);
  const errors = [];
  if (
    input?.commissionDeductionTiming !== undefined
    && !LONG_RANGE_COMMISSION_TIMINGS.includes(input.commissionDeductionTiming)
  ) {
    errors.push('Commission deduction timing must be started or completed');
  }
  if (input?.enabled === true) {
    for (const category of FARE_VEHICLE_CATEGORIES) {
      if (!settings.perKmRates[category]) errors.push(`${category}: Long Range /km rate must be greater than zero`);
      if (!Number.isFinite(settings.manualCommissionAmounts[category]) || settings.manualCommissionAmounts[category] <= 0) {
        errors.push(`${category}: Manual Long Range commission percentage must be greater than zero`);
      }
      if (!Number.isFinite(settings.minimumWalletBalances[category]) || settings.minimumWalletBalances[category] < 0) {
        errors.push(`${category}: Minimum Wallet Balance must be zero or greater`);
      }
    }
  }
  return { settings, errors };
}

async function getLongRangeSettings() {
  return getCachedAdminSetting({
    key: LONG_RANGE_SETTINGS_KEY,
    fallback: DEFAULT_LONG_RANGE_SETTINGS,
    normalize: normalizeLongRangeSettings,
    load: async () => (await Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean())?.value
  });
}

const CUSTOMER_FARE_DISPLAY_SETTINGS_KEY = 'customer_fare_display_settings';
const DEFAULT_CUSTOMER_FARE_DISPLAY_SETTINGS = Object.freeze({
  showVehicleRates: true,
  showFareBreakdown: true
});

const STUDENT_DISCOUNT_SETTINGS_KEY = 'student_discount_settings';
const DEFAULT_STUDENT_DISCOUNT_SETTINGS = Object.freeze({
  enabled: true,
  discountPercent: 10,
  maxDiscountedRidesPerDay: 2,
  startTime: '06:00',
  endTime: '17:00'
});
const STUDENT_FAIR_QUOTA_SETTINGS_KEY = 'student_fair_quota_settings';
const DEFAULT_STUDENT_FAIR_QUOTA_SETTINGS = Object.freeze({ dailyQuota: 2 });

function customerRegistrationAccountStatus(isStudent, identityVerified) {
  return isStudent ? 'pending' : (identityVerified ? 'active' : 'pending');
}

function normalizeStudentDiscountSettings(input = {}) {
  const value = Number(input?.discountPercent);
  const rideLimit = Number(input?.maxDiscountedRidesPerDay);
  const normalizeTime = (candidate, fallback) => {
    const value = String(candidate ?? '');
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
  };
  return {
    enabled: input?.enabled !== false,
    discountPercent: Number.isFinite(value)
      ? Number(Math.min(100, Math.max(0, value)).toFixed(2))
      : DEFAULT_STUDENT_DISCOUNT_SETTINGS.discountPercent,
    maxDiscountedRidesPerDay: Number.isFinite(rideLimit)
      ? Math.min(1000, Math.max(0, Math.floor(rideLimit)))
      : DEFAULT_STUDENT_DISCOUNT_SETTINGS.maxDiscountedRidesPerDay,
    startTime: normalizeTime(input?.startTime, DEFAULT_STUDENT_DISCOUNT_SETTINGS.startTime),
    endTime: normalizeTime(input?.endTime, DEFAULT_STUDENT_DISCOUNT_SETTINGS.endTime)
  };
}

async function getStudentDiscountSettings() {
  const doc = await Settings.findOne({ key: STUDENT_DISCOUNT_SETTINGS_KEY }).lean();
  return normalizeStudentDiscountSettings(doc?.value);
}

function normalizeStudentFairQuotaSettings(input = {}) {
  const dailyQuota = Number(input?.dailyQuota);
  return {
    dailyQuota: Number.isFinite(dailyQuota)
      ? Math.min(100, Math.max(0, Math.floor(dailyQuota)))
      : DEFAULT_STUDENT_FAIR_QUOTA_SETTINGS.dailyQuota
  };
}

async function getStudentFairQuotaSettings() {
  const doc = await Settings.findOne({ key: STUDENT_FAIR_QUOTA_SETTINGS_KEY }).lean();
  return normalizeStudentFairQuotaSettings(doc?.value);
}

function studentDiscountTimeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function isStudentDiscountWithinTimeWindow(at, settings) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  const start = studentDiscountTimeToMinutes(settings.startTime);
  const end = studentDiscountTimeToMinutes(settings.endTime);
  const current = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

async function getCompletedStudentDiscountRideCount(userId, at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  if (!userId || Number.isNaN(date.getTime())) return 0;
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const count = await Ride.countDocuments({
    passenger: userId,
    status: 'completed',
    'fareQuote.studentDiscountPercent': { $gt: 0 },
    settledAt: { $gte: dayStart, $lt: nextDay }
  });
  return Number.isFinite(Number(count)) ? Number(count) : 0;
}

async function getVerifiedStudentDiscountPercent(userId, requestedAt = new Date()) {
  if (!userId) return 0;
  const user = await User.findById(userId)
    .select('role isStudent studentVerificationStatus')
    .lean()
    .catch(() => null);
  if (!user || user.role !== 'customer' || user.isStudent !== true || user.studentVerificationStatus !== 'approved') {
    return 0;
  }
  const settings = await getStudentDiscountSettings();
  if (!settings.enabled || settings.discountPercent <= 0 || settings.maxDiscountedRidesPerDay <= 0) return 0;
  if (!isStudentDiscountWithinTimeWindow(requestedAt, settings)) return 0;
  const completedDiscountedRides = await getCompletedStudentDiscountRideCount(userId, requestedAt);
  return completedDiscountedRides < settings.maxDiscountedRidesPerDay ? settings.discountPercent : 0;
}

function applyStudentDiscountToFareQuote(fareQuote, discountPercent = 0) {
  if (!fareQuote || fareQuote.error) return fareQuote;
  const totalBeforeDiscount = Number(fareQuote.totalFare || 0);
  const percent = Number.isFinite(Number(discountPercent))
    ? Math.min(100, Math.max(0, Number(discountPercent)))
    : 0;
  const studentDiscountAmount = Math.round(totalBeforeDiscount * percent / 100);
  const payableFare = Math.max(0, totalBeforeDiscount - studentDiscountAmount);
  return {
    ...fareQuote,
    totalBeforeDiscount,
    studentDiscountPercent: Number(percent.toFixed(2)),
    studentDiscountAmount,
    payableFare,
    totalFare: payableFare
  };
}

function normalizeCustomerFareDisplaySettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    showVehicleRates: source.showVehicleRates !== false,
    showFareBreakdown: source.showFareBreakdown !== false
  };
}

async function getCustomerFareDisplaySettings() {
  const doc = await Settings.findOne({ key: CUSTOMER_FARE_DISPLAY_SETTINGS_KEY }).lean();
  return normalizeCustomerFareDisplaySettings(doc?.value);
}

function isLongRangeDistance(distanceKm, settings) {
  return settings.enabled && Number(distanceKm) >= settings.distanceCutoffKm;
}

function getLongRangeMinimumWalletBalance(settings, vehicleType) {
  const category = normalizeFareVehicle(vehicleType || 'Car Mini Non-AC');
  return Number(settings?.minimumWalletBalances?.[category] ?? DEFAULT_LONG_RANGE_MINIMUM_WALLET_BALANCES[category] ?? 0);
}

function getLongRangeCommissionPercentage(settings, vehicleType) {
  const category = normalizeFareVehicle(vehicleType || 'Car Mini Non-AC');
  return Number(settings?.manualCommissionAmounts?.[category] || 0);
}

function getLongRangeCommissionAmount(settings, vehicleType, finalFare) {
  const percentage = getLongRangeCommissionPercentage(settings, vehicleType);
  const fare = Number(finalFare);
  if (!Number.isFinite(fare) || fare < 0) return 0;
  return Number((fare * percentage / 100).toFixed(2));
}

function getLongRangeRequiredWalletBalance(settings, vehicleType, finalFare) {
  return Math.max(
    getLongRangeMinimumWalletBalance(settings, vehicleType),
    getLongRangeCommissionAmount(settings, vehicleType, finalFare)
  );
}

function calculateRideFare(
  fareSettings,
  longRangeSettings,
  vehicleType,
  distanceKm,
  at,
  perKmRates,
  durationMinutes = 0,
  waitingRateSettings = DEFAULT_WAITING_RATE_SETTINGS,
  waitingSeconds = 0
) {
  if (!isLongRangeDistance(distanceKm, longRangeSettings)) {
    return calculateFareFromSettings(
      fareSettings,
      vehicleType,
      distanceKm,
      at,
      perKmRates,
      durationMinutes,
      waitingRateSettings,
      waitingSeconds
    );
  }
  const category = normalizeFareVehicle(vehicleType);
  const distance = Number(distanceKm);
  const duration = Number(durationMinutes);
  const rate = Number(longRangeSettings.perKmRates[category]);
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(rate) || rate <= 0) {
    return { error: `Long Range fare settings are not configured for ${category}` };
  }
  const perMinuteRate = Number(fareSettings?.[category]?.perMinuteRate || 0);
  const timeFare = Number.isFinite(duration) && duration > 0 ? duration * perMinuteRate : 0;
  const waiting = calculateWaitingFare(waitingRateSettings, category, waitingSeconds);
  const subtotal = distance * rate + timeFare + waiting.waitingFare;
  const totalFare = Math.round(subtotal);
  return {
    vehicleType: category,
    distanceKm: Number(distance.toFixed(2)),
    isLongRange: true,
    longRangeRatePerKm: rate,
    durationMinutes: Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(2)) : 0,
    perMinuteRate,
    timeFare: Number(timeFare.toFixed(2)),
    ...waiting,
    subtotal,
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

function calculateFareFromSettings(
  settings,
  vehicleType,
  distanceKm,
  at = new Date(),
  perKmRates = DEFAULT_PER_KM_RATES,
  durationMinutes = 0,
  waitingRateSettings = DEFAULT_WAITING_RATE_SETTINGS,
  waitingSeconds = 0
) {
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
  const perKmRate = Number(perKmRates[category] ?? legacyCarMiniSetting(perKmRates, category));
  if (!Number.isFinite(perKmRate) || perKmRate <= 0) {
    return { error: `/km rate is not configured for ${category}` };
  }
  const distanceFare = distance * perKmRate;
  const duration = Number(durationMinutes);
  const normalizedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const perMinuteRate = Number(rule.perMinuteRate || 0);
  const timeFare = normalizedDuration * perMinuteRate;
  const waiting = calculateWaitingFare(waitingRateSettings, category, waitingSeconds);
  const subtotal = rule.baseFare + distanceFare + timeFare + waiting.waitingFare;
  const total = Math.max(0, Math.round(subtotal * (1 + adjustmentPercent / 100)));
  return {
    vehicleType: category,
    distanceKm: Number(distance.toFixed(2)),
    baseFare: rule.baseFare,
    perKmRate,
    distanceFare: Number(distanceFare.toFixed(2)),
    durationMinutes: Number(normalizedDuration.toFixed(2)),
    perMinuteRate,
    timeFare: Number(timeFare.toFixed(2)),
    ...waiting,
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
  const waitingRateSettings = await getWaitingRateSettings();
  const studentDiscountSettings = await getStudentDiscountSettings();
  const pendingRides = await Ride.find({ status: 'requested' });
  for (const ride of pendingRides) {
    let fareQuote = calculateRideFare(
      settings,
      longRangeSettings,
      ride.vehicleType,
      ride.distance,
      new Date(),
      currentPerKmRates,
      ride.durationMinutes,
      waitingRateSettings,
      ride.waitingSeconds
    );
    fareQuote = applyStudentDiscountToFareQuote(
      fareQuote,
      !studentDiscountSettings.enabled
        ? 0
        : Number.isFinite(Number(ride.fareQuote?.studentDiscountPercent))
        ? Number(ride.fareQuote.studentDiscountPercent)
        : await getVerifiedStudentDiscountPercent(ride.passenger, ride.createdAt)
    );
    if (fareQuote.error || (
      ride.fare === fareQuote.totalFare
      && ride.fareQuote?.waitingEnabled === fareQuote.waitingEnabled
      && ride.fareQuote?.waitingRatePerMinute === fareQuote.waitingRatePerMinute
    )) continue;
    ride.fare = fareQuote.totalFare;
    ride.fareQuote = fareQuote;
    ride.waitingMinutes = fareQuote.waitingMinutes;
    ride.waitingFare = fareQuote.waitingFare;
    await ride.save();
    const payload = { id: ride._id, fare: ride.fare, fareQuote: ride.fareQuote };
    io.to(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini Non-AC')}`).emit('ride:fare-updated', payload);
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
  email:   { type: String, required: false, unique: false, lowercase: true, trim: true, default: null },
  password:{ type: String, required: true },
  phone:   { type: String, default: '', trim: true },
  role:    { type: String, enum: ['customer', 'driver'], default: 'customer' },
  // Keep the retired value in the schema enum so legacy documents can still be
  // loaded and migrated through the explicit Non-AC compatibility alias.
  vehicleType:  { type: String, enum: [...FARE_VEHICLE_CATEGORIES, 'Car Mini', 'Rickshaw', 'Car AC', ''], default: '' },
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
  onlineStartedAt: { type: Date, default: null },
  onlineTimeDate: { type: String, default: '' },
  onlineTimeTodaySeconds: { type: Number, default: 0 },
  studentRideLastAssignedAt: { type: Date, default: null },
  expoPushToken:       { type: String, default: '' },
  expoPushTokenUpdatedAt: { type: Date, default: null },
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
  activeSessionDeviceHash: { type: String, default: null, select: false },
  // Device binding stores only a keyed digest. The client sends an app-scoped
  // installation identifier; the raw identifier is never persisted or returned.
  deviceBindingEnabled: { type: Boolean, default: false },
  deviceBindingHash: { type: String, default: null, select: false },
  deviceBindingRegisteredAt: { type: Date, default: null, select: false },
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
  nationalIdHash:  { type: String, unique: true, sparse: true, select: false },
  nationalIdLast4: { type: String, default: '' },
  customerIdFront: { type: String, default: '', select: false },
  customerIdBack:  { type: String, default: '', select: false },
  studentIdNumber: { type: String, default: '' },
  studentInstitution: { type: String, default: '' },
  studentIdImage: { type: String, default: '', select: false },
  isStudent: { type: Boolean, default: false },
  studentVerificationStatus: { type: String, enum: ['not_applicable', 'pending', 'approved', 'rejected'], default: 'not_applicable' },
  studentVerifiedAt: { type: Date, default: null },
  identityVerifiedAt: { type: Date, default: null },
  identityVerificationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: null }
}, { timestamps: true });

const customerSchema = userSchema.clone();
customerSchema.path('role').default('customer');
customerSchema.path('email').options.required = false;
customerSchema.path('email').options.unique = false;
customerSchema.index(
  { email: 1 },
  {
    unique: true,
    name: 'customer_email_unique',
    partialFilterExpression: { email: { $type: 'string' } }
  }
);
customerSchema.remove('isAdmin');
const driverSchema = userSchema.clone();
driverSchema.path('role').default('driver');
driverSchema.remove('isAdmin');
driverSchema.index(
  { email: 1 },
  {
    unique: true,
    name: 'driver_email_unique',
    partialFilterExpression: { email: { $type: 'string' } }
  }
);
// Dispatch and recovery both filter by live availability and pickup distance.
// Keep those reads indexable even though the final Haversine check remains in
// application code for exact-radius correctness.
driverSchema.index({ isOnline: 1, accountStatus: 1, vehicleType: 1, lastOnlineHeartbeat: 1 });
driverSchema.index({ 'currentLocation.lat': 1, 'currentLocation.lng': 1 });

// Super Admin credentials are deliberately independent from both the generic
// settings store and all Customer/Driver identity records. The stable id keeps
// bootstrap and session-version checks independent of the configured email.
const adminSchema = new mongoose.Schema({
  _id: { type: String, default: 'super-admin' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, default: '' },
  recoveryKeyHash: { type: String, default: '' },
  sessionVersion: { type: Number, default: 0, min: 0 }
}, { timestamps: true, collection: 'admins' });

const ADVANCE_BOOKING_MIN_LEAD_MS = 20 * 60 * 1000;
const ADVANCE_BOOKING_MAX_DAYS = 30;
const ADVANCE_BOOKING_REMINDER_LEAD_MS = 45 * 60 * 1000;
const ADVANCE_BOOKING_REMINDER_LOCK_MS = 2 * 60 * 1000;

const rideSchema = new mongoose.Schema({
  passenger: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  driver:    { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
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
  passengerCount: { type: Number, default: 1, min: 1, max: 8 },
  fare:        { type: Number, required: true },
  // Customer negotiation is stored separately from the Admin quote so the
  // final price can always be reconstructed as quote.totalFare + offset.
  customerFareOffset: { type: Number, default: 0 },
  fareQuote: {
    vehicleType: String,
    distanceKm: Number,
    baseFare: Number,
    durationMinutes: Number,
    perMinuteRate: Number,
    timeFare: Number,
    waitingEnabled: Boolean,
    waitingMinutes: Number,
    waitingRatePerMinute: Number,
    waitingGraceMinutes: Number,
    waitingFare: Number,
    slab: { minKm: Number, maxKm: Number, rate: Number },
    activeRules: [{ start: String, end: String, adjustmentPercent: Number }],
    adjustmentPercent: Number,
    subtotal: Number,
    totalBeforeDiscount: Number,
    studentDiscountPercent: Number,
    studentDiscountAmount: Number,
    payableFare: Number,
    totalFare: Number,
    calculatedAt: Date
  },
  isLongRange: { type: Boolean, default: false },
  longRangeCommissionAmount: { type: Number, default: 0 },
  longRangeCommissionChargedAt: { type: Date, default: null },
  longRangeCommissionDeductionTiming: { type: String, enum: LONG_RANGE_COMMISSION_TIMINGS, default: null },
  distance:    { type: Number, default: 0 },
  durationMinutes: { type: Number, default: 0 },
  // Once a Driver accepts, this keeps the agreed fare immutable while
  // server-side waiting charges are added on top.
  agreedFareBeforeWaiting: { type: Number, default: null },
  waitingSeconds: { type: Number, default: 0, min: 0 },
  waitingAccumulatedSeconds: { type: Number, default: 0, min: 0 },
  waitingStartedAt: { type: Date, default: null },
  waitingMinutes: { type: Number, default: 0, min: 0 },
  waitingFare: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['requested', 'accepted', 'arrived', 'in-progress', 'completed', 'cancelled'],
    default: 'requested'
  },
  driverLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  // A passenger location exists only while an active ride explicitly shares it.
  // It is not a background location trail for Customer accounts.
  passengerLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  passengerLocationUpdatedAt: { type: Date, default: null },
  vehicleType:   { type: String, default: 'Car Mini Non-AC' },
  notes:         { type: String, default: '' },
  paymentMethod: { type: String, enum: ['cash', 'easypaisa', 'jazzcash', 'wallet'], default: 'cash' },
  mobileAccount: { type: String, default: '' },
  counterOffers: [{
    driver:       { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
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
  verificationPin: { type: String,  default: null },  // 4-digit PIN for ride start
  // Set only after the server verifies the assigned Driver is at pickup.
  // This is the authoritative gate for PIN release and Customer cancellation.
  pickupReachedAt: { type: Date, default: null },
  // The exact driver audience that received ride:new. Lifecycle retirement
  // events target these personal rooms too, so a room-membership race cannot
  // leave a delivered offer actionable after it is cancelled or taken.
  notifiedDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
  isStudentRide: { type: Boolean, default: false },
  studentRideOfferRecipients: [{
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
    distanceFromPickupKm: { type: Number, default: null },
    notifiedAt: { type: Date, default: Date.now }
  }],
  // The response window is persisted with each request. This makes expiry
  // authoritative across server restarts and lets reconnecting drivers render
  // the remaining time rather than restarting a local countdown.
  broadcastDurationSeconds: { type: Number, default: null },
  broadcastExpiresAt: { type: Date, default: null },
  // Scheduled reservations are converted into ordinary Ride documents only
  // when their execution window opens. Existing live rides keep these fields
  // unset, so all legacy matching and lifecycle behavior remains unchanged.
  isAdvanceBooking: { type: Boolean, default: false },
  scheduledTime: { type: Date, default: null },
  scheduledFor: { type: Date, default: null },
  advanceBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdvanceBooking', default: null },
  // Financial settlement is committed in the same MongoDB transaction as the
  // ride transition and both wallet ledger entries. This marker makes a
  // retried completion request a read-only idempotent replay.
  settlementStatus: { type: String, enum: ['pending', 'settled'], default: 'pending' },
  settledAt: { type: Date, default: null },
  settledFare: { type: Number, default: null },
  settledDriverEarnings: { type: Number, default: null }
}, { timestamps: true });

rideSchema.index({ status: 1, vehicleType: 1, createdAt: -1 });
rideSchema.index({ 'pickupLocation.lat': 1, 'pickupLocation.lng': 1 });
rideSchema.index({ scheduledFor: 1, advanceBookingId: 1 });

const advanceBookingSchema = new mongoose.Schema({
  passenger: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
  pickupLocation: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, default: 'Pickup Point' }
  },
  dropoffLocation: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, default: 'Dropoff Point' }
  },
  dropoffLocations: [{
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String, default: 'Stop' }
  }],
  passengerCount: { type: Number, default: 1, min: 1, max: 8 },
  scheduledFor: {
    type: Date,
    required: true,
    validate: {
      validator: value => {
        const timestamp = new Date(value).getTime();
        const now = Date.now();
        return Number.isFinite(timestamp)
          && timestamp >= now + ADVANCE_BOOKING_MIN_LEAD_MS
          && timestamp <= now + ADVANCE_BOOKING_MAX_DAYS * 24 * 60 * 60 * 1000;
      },
      message: `Advance bookings must be between ${ADVANCE_BOOKING_MIN_LEAD_MS / 60000} minutes and ${ADVANCE_BOOKING_MAX_DAYS} days ahead.`
    }
  },
  fare: { type: Number, required: true },
  customerFareOffset: { type: Number, default: 0 },
  fareQuote: { type: mongoose.Schema.Types.Mixed, default: null },
  distance: { type: Number, default: 0 },
  durationMinutes: { type: Number, default: 0 },
  vehicleType: { type: String, required: true },
  paymentMethod: { type: String, enum: ['cash', 'easypaisa', 'jazzcash', 'wallet'], default: 'cash' },
  mobileAccount: { type: String, default: '' },
  notes: { type: String, default: '' },
  isLongRange: { type: Boolean, default: false },
  isStudentRide: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['pending', 'assigned', 'dispatching', 'converted', 'cancelled', 'failed'],
    default: 'pending'
  },
  counterOffers: [{
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
    driverName: String,
    vehicleModel: String,
    vehiclePlate: String,
    rating: Number,
    price: Number,
    type: { type: String, enum: ['accept', 'counter'], default: 'accept' },
    timestamp: { type: Date, default: Date.now }
  }],
  notifiedDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
  declinedDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
  broadcastExpiresAt: { type: Date, default: null },
  broadcastLastAttemptAt: { type: Date, default: null },
  ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
  assignedAt: { type: Date, default: null },
  dispatchingAt: { type: Date, default: null },
  dispatchedAt: { type: Date, default: null },
  reminderSentAt: { type: Date, default: null },
  reminderLastSentAt: { type: Date, default: null },
  reminderInFlightAt: { type: Date, default: null },
  reminderCount: { type: Number, default: 0 },
  reminderLastError: { type: String, default: '' },
  failureReason: { type: String, default: '' }
}, { timestamps: true });

advanceBookingSchema.index({ status: 1, scheduledFor: 1 });
advanceBookingSchema.index({ passenger: 1, status: 1, scheduledFor: 1 });
advanceBookingSchema.index({ driver: 1, status: 1, scheduledFor: 1 });

const walletSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', unique: true },
  balance:        { type: Number, default: 0 },             // current spendable wallet total (recharge cash + bonus)
  realCashWallet: { type: Number, default: 0 },             // legacy cumulative real-cash funding marker
  bonusWallet:    { type: Number, default: 0 },             // promotional bonuses only
  realCashAvailable: { type: Number, default: 0 },           // current spendable real-cash bucket
  bonusAvailable: { type: Number, default: 0 },              // current spendable bonus bucket
  dailyFeeChargedDate: { type: String, default: '' },       // legacy calendar-day marker
  fee_paid_at:      { type: Date, default: null },          // rolling 24-hour pass start
  transactions: [{
    amount:        Number,
    type:          { type: String, enum: ['credit', 'debit'] },
    description:   String,
    paymentMethod: { type: String, default: '' },
    mobileAccount: { type: String, default: '' },
    rideId: { type: String, default: '' },
    operationId: { type: String, default: '' },
    revenueCategory: { type: String, default: '' },
    fundingSource: { type: String, enum: Object.values(WALLET_FUNDING_SOURCES), default: WALLET_FUNDING_SOURCES.UNKNOWN },
    realAmount: { type: Number, default: 0 },
    bonusAmount: { type: Number, default: 0 },
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
  { key: 'viewAdvanceBookings',   group: 'Rides',              label: 'View Advance / Scheduled Bookings' },
  { key: 'manageAdvanceBookings', group: 'Rides',              label: 'Assign Advance / Scheduled Bookings' },
  { key: 'manageAdvanceBookingReminders', group: 'Rides',       label: 'Send scheduled-ride reminders' },
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
  { key: 'manageLocationAliases', group: 'System configuration', label: 'Manage Customer location aliases' },
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

const MAX_DEVICE_IDENTIFIER_LENGTH = 256;
function normalizeDeviceIdentifier(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_DEVICE_IDENTIFIER_LENGTH ? normalized : '';
}

function hashDeviceIdentifier(deviceId) {
  const normalized = normalizeDeviceIdentifier(deviceId);
  return normalized
    ? crypto.createHmac('sha256', JWT_SECRET).update(normalized).digest('hex')
    : '';
}

// Sub-Admin schema — granular-permission secondary admin accounts (max 200)
const subAdminSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  password:  { type: String, required: true },
  isBlocked: { type: Boolean, default: false },
  permissions: { type: mongoose.Schema.Types.Mixed, default: () => ({ ...SUB_ADMIN_PERMISSION_DEFAULTS }) }
}, { timestamps: true });
const SubAdmin = mongoose.model('SubAdmin', subAdminSchema);

const sosSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, refPath: 'userModel' },
  userModel: { type: String, enum: ['Customer', 'Driver'], default: 'Customer' },
  location: { lat: Number, lng: Number },
  message:  { type: String, default: 'SOS Emergency Alert!' },
  ride:     { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
  resolved: { type: Boolean, default: false }
}, { timestamps: true });

const ticketSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, refPath: 'userModel', required: true },
  role:       { type: String, enum: ['customer','driver'], required: true },
  userModel:  { type: String, enum: ['Customer', 'Driver'], required: true },
  subject:    { type: String, required: true, trim: true },
  message:    { type: String, required: true, trim: true },
  status:     { type: String, enum: ['open','resolved'], default: 'open' },
  adminReply: { type: String, default: '' },
  repliedAt:  { type: Date,    default: null },
  readByUser: { type: Boolean, default: false }
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  driver:          { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true },
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
  }],
  // Approval and wallet credit are committed together. Retries return the
  // committed result instead of crediting the Driver a second time.
  walletCreditedAt: { type: Date, default: null },
  walletCreditOperationId: { type: String, default: null },
  paidUntilDate: { type: Date, default: null }
}, { timestamps: true });

// Database-enforced protections against repeated payment references and daily spam.
paymentSchema.index({ trxId: 1 }, { unique: true });
paymentSchema.index({ driver: 1, submittedDate: 1 }, { unique: true });
paymentSchema.index({ walletCreditOperationId: 1 }, { unique: true, sparse: true });

// Persisted request-level idempotency records make wallet mutations safe across
// process restarts and mobile retries. The financial mutation and the completed
// result marker are committed in the same MongoDB transaction.
const financialOperationSchema = new mongoose.Schema({
  scope:       { type: String, required: true, trim: true },
  actorId:     { type: String, required: true, trim: true },
  key:         { type: String, required: true, trim: true },
  requestHash: { type: String, required: true },
  status:      { type: String, enum: ['processing', 'completed'], required: true, default: 'processing' },
  result:      { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });
financialOperationSchema.index({ scope: 1, actorId: 1, key: 1 }, { unique: true });
financialOperationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Key-value settings store
const settingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

// Web-Push subscriptions per driver
const pushSubSchema = new mongoose.Schema({
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true },
  endpoint:     { type: String, required: true },
  keys:         { p256dh: String, auth: String },
  updatedAt:    { type: Date, default: Date.now }
});
pushSubSchema.index({ user: 1, endpoint: 1 }, { unique: true });

const LegacyUser = mongoose.model('LegacyUser', userSchema, 'users');
const Customer = mongoose.model('Customer', customerSchema, 'customers');
const Driver   = mongoose.model('Driver', driverSchema, 'drivers');
const Admin    = mongoose.model('Admin', adminSchema, 'admins');
const Ride     = mongoose.model('Ride',     rideSchema);
const AdvanceBooking = mongoose.model('AdvanceBooking', advanceBookingSchema, 'advance_bookings');
const Wallet   = mongoose.model('Wallet',   walletSchema);
const SOS      = mongoose.model('SOS',      sosSchema);
const Payment  = mongoose.model('Payment',  paymentSchema);
const FinancialOperation = mongoose.model('FinancialOperation', financialOperationSchema);
const Ticket   = mongoose.model('Ticket',   ticketSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const PushSub  = mongoose.model('PushSub',  pushSubSchema);
const studentRideResponseLogSchema = new mongoose.Schema({
  ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true },
  driverName: { type: String, default: '' },
  driverPhone: { type: String, default: '' },
  pickupLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    address: { type: String, default: '' }
  },
  distanceFromPickupKm: { type: Number, default: null },
  responseType: { type: String, enum: ['rejected', 'timeout'], required: true },
  occurredAt: { type: Date, default: Date.now }
}, { timestamps: true });
studentRideResponseLogSchema.index({ ride: 1, driver: 1 }, { unique: true });
studentRideResponseLogSchema.index({ occurredAt: -1 });
const StudentRideResponseLog = mongoose.model('StudentRideResponseLog', studentRideResponseLogSchema);
const accountDeletionTombstoneSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  role: { type: String, enum: ['customer', 'driver'], required: true },
  email: { type: String, default: null, lowercase: true, trim: true },
  phone: { type: String, default: '' },
  seedKey: { type: String, default: undefined },
  deletedAt: { type: Date, default: Date.now }
}, { timestamps: true });
accountDeletionTombstoneSchema.index(
  { seedKey: 1 },
  { unique: true, sparse: true, name: 'account_deletion_seed_key_unique' }
);
const AccountDeletionTombstone = mongoose.model('AccountDeletionTombstone', accountDeletionTombstoneSchema);
const nativeSettingsFindOne = Settings.findOne;

// Compatibility facade for the pre-partition server surface. It deliberately
// never queries the legacy users collection. Existing route code and tests can
// continue to use User while the actual persistence target is determined by
// role or by the preserved document id.
function userModelsForFilter(filter = {}) {
  const role = filter.role;
  if (role === 'customer' || role?.$eq === 'customer') return [Customer];
  if (role === 'driver' || role?.$eq === 'driver') return [Driver];
  if (Array.isArray(role?.$in) && role.$in.length === 1) {
    return role.$in[0] === 'driver' ? [Driver] : [Customer];
  }
  return [Customer, Driver];
}

function filterForUserModel(filter = {}, model) {
  const scopedModels = userModelsForFilter(filter);
  if (scopedModels.length !== 1 || scopedModels[0] !== model) return filter;
  const scopedFilter = { ...filter };
  delete scopedFilter.role;
  return scopedFilter;
}

async function findUserModel(filter = {}) {
  for (const model of userModelsForFilter(filter)) {
    const found = await model.findOne(filterForUserModel(filter, model)).select('_id').lean();
    if (found) return model;
  }
  return null;
}

class PartitionedUserQuery {
  constructor(executor) {
    this.executor = executor;
  }
  select(fields) { this.selectFields = fields; return this; }
  lean() { this.asLean = true; return this; }
  sort(spec) { this.sortSpec = spec; return this; }
  limit(value) { this.limitValue = value; return this; }
  async exec() { return this.executor(this); }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
}

function applyUserQueryOptions(query, options) {
  if (options.selectFields) query.select(options.selectFields);
  if (options.asLean) query.lean();
  if (options.sortSpec) query.sort(options.sortSpec);
  if (options.limitValue !== undefined) query.limit(options.limitValue);
  return query;
}

function compareUserDocuments(a, b, spec = {}) {
  for (const [field, direction] of Object.entries(spec)) {
    const left = a?.[field] instanceof Date ? a[field].getTime() : a?.[field];
    const right = b?.[field] instanceof Date ? b[field].getTime() : b?.[field];
    if (left === right) continue;
    const order = left > right ? 1 : -1;
    return order * (Number(direction) < 0 ? -1 : 1);
  }
  return 0;
}

const User = {
  find(filter = {}) {
    return new PartitionedUserQuery(async options => {
      const values = await Promise.all(userModelsForFilter(filter).map(async model => {
        const query = applyUserQueryOptions(model.find(filterForUserModel(filter, model)), {
          ...options,
          // Global sorting/limiting happens after the role collections merge.
          limitValue: undefined
        });
        return query.exec();
      }));
      const merged = values.flat();
      if (options.sortSpec) merged.sort((a, b) => compareUserDocuments(a, b, options.sortSpec));
      return options.limitValue === undefined ? merged : merged.slice(0, options.limitValue);
    });
  },
  findOne(filter = {}) {
    return new PartitionedUserQuery(async options => {
      for (const model of userModelsForFilter(filter)) {
        const query = applyUserQueryOptions(model.findOne(filterForUserModel(filter, model)), options);
        const result = await query.exec();
        if (result) return result;
      }
      return null;
    });
  },
  findById(id) {
    return new PartitionedUserQuery(async options => {
      for (const model of [Customer, Driver]) {
        const query = applyUserQueryOptions(model.findById(id), options);
        const result = await query.exec();
        if (result) return result;
      }
      return null;
    });
  },
  create(value) {
    return (value?.role === 'driver' ? Driver : Customer).create(value);
  },
  updateOne(filter, update, options = {}) {
    return new PartitionedUserQuery(async () => {
      const model = await findUserModel(filter);
      if (model) return model.updateOne(filterForUserModel(filter, model), update, options);
      if (options.upsert) {
        const target = userModelsForFilter(filter)[0];
        return target.updateOne(filterForUserModel(filter, target), update, options);
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    });
  },
  updateMany(filter, update, options = {}) {
    return new PartitionedUserQuery(async () => {
      const results = await Promise.all(userModelsForFilter(filter).map(model =>
        model.updateMany(filterForUserModel(filter, model), update, options)
      ));
      return {
        acknowledged: results.every(result => result.acknowledged !== false),
        matchedCount: results.reduce((sum, result) => sum + (result.matchedCount || 0), 0),
        modifiedCount: results.reduce((sum, result) => sum + (result.modifiedCount || 0), 0)
      };
    });
  },
  findOneAndUpdate(filter, update, options = {}) {
    return new PartitionedUserQuery(async queryOptions => {
      const model = options.upsert
        ? userModelsForFilter(filter)[0]
        : await findUserModel(filter);
      if (!model) return null;
      return applyUserQueryOptions(
        model.findOneAndUpdate(filterForUserModel(filter, model), update, options),
        queryOptions
      ).exec();
    });
  },
  findByIdAndUpdate(id, update, options = {}) {
    return new PartitionedUserQuery(async queryOptions => {
      const model = await findUserModel({ _id: id });
      if (!model) return null;
      return applyUserQueryOptions(model.findByIdAndUpdate(id, update, options), queryOptions).exec();
    });
  },
  deleteOne(filter, options = {}) {
    return new PartitionedUserQuery(async () => {
      const model = await findUserModel(filter);
      return model
        ? model.deleteOne(filterForUserModel(filter, model), options)
        : { acknowledged: true, deletedCount: 0 };
    });
  },
  countDocuments(filter = {}) {
    return Promise.all(userModelsForFilter(filter).map(model =>
      model.countDocuments(filterForUserModel(filter, model))
    ))
      .then(counts => counts.reduce((sum, count) => sum + count, 0));
  }
};

function accountSeedKey(account = {}) {
  const role = account.role;
  if (!['customer', 'driver'].includes(role)) return null;
  const email = String(account.email || '').trim().toLowerCase();
  const phoneValues = new Set(phoneLookupValues(account.phone));
  const definitions = [
    ...Object.entries(DEMO_ACCOUNTS).map(([definitionRole, value]) => ({
      key: `demo:${definitionRole}`,
      role: definitionRole,
      email: value.email,
      phone: value.phone
    })),
    ...Object.entries(TEST_ACCOUNTS).map(([definitionRole, value]) => ({
      key: `test:${definitionRole}`,
      role: definitionRole,
      email: value.email,
      phone: value.phone
    }))
  ];
  const match = definitions.find(definition =>
    definition.role === role
    && (
      (email && email === String(definition.email || '').trim().toLowerCase())
      || phoneValues.has(normalizePhoneNumber(definition.phone))
    )
  );
  return match?.key || null;
}

function buildAccountDeletionTombstoneUpdate(account, seedKey = accountSeedKey(account)) {
  const tombstoneSet = {
    role: account.role,
    email: account.email || null,
    phone: account.phone || '',
    deletedAt: new Date()
  };
  if (seedKey) tombstoneSet.seedKey = seedKey;
  return {
    $set: tombstoneSet,
    ...(seedKey ? {} : { $unset: { seedKey: 1 } })
  };
}

async function accountDeletionTombstoneFor(account) {
  if (!account?._id) return null;
  const seedKey = accountSeedKey(account);
  const filters = [{ accountId: account._id }];
  if (seedKey) filters.push({ seedKey });
  return AccountDeletionTombstone.findOne({ $or: filters }).lean();
}

// Copy legacy role records into their isolated collections without changing
// their ObjectIds. Deleted records are removed from the legacy source and
// never copied back into the active collections.
async function migrateLegacyUserData() {
  const legacyUsers = await LegacyUser.find().lean();
  let migrated = 0;
  for (const legacy of legacyUsers) {
    if (!['customer', 'driver'].includes(legacy.role)) continue;
    const target = legacy.role === 'driver' ? Driver : Customer;
    const tombstone = await accountDeletionTombstoneFor(legacy);
    if (tombstone) {
      await Promise.all([
        LegacyUser.deleteOne({ _id: legacy._id }),
        Customer.deleteOne({ _id: legacy._id }),
        Driver.deleteOne({ _id: legacy._id })
      ]);
      continue;
    }
    const { _id, isAdmin, createdAt, updatedAt, ...safeLegacy } = legacy;
    const insertValue = {
      ...safeLegacy,
      _id,
      role: legacy.role,
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {})
    };
    await target.updateOne(
      { _id },
      { $setOnInsert: insertValue },
      { upsert: true, timestamps: false }
    );
    migrated++;
  }
  if (migrated) console.log(`✓ Migrated ${migrated} legacy Customer/Driver record(s) into isolated collections`);
  return migrated;
}

async function removeCustomerEmailIndex() {
  if (mongoose.connection.readyState !== 1) return;
  for (const collectionName of ['customers', 'drivers']) {
    try {
      const collection = mongoose.connection.collection(collectionName);
      const indexes = await collection.indexes();
      if (indexes.some(index => index.name === 'email_1')) {
        await collection.dropIndex('email_1');
        console.log(`✓ Removed invalid ${collectionName}.email_1 index`);
      }
    } catch (error) {
      // A fresh preview database does not have either collection until the
      // first account is seeded. Continue so the other role is still cleaned.
      if (!/ns does not exist|namespace .* not found/i.test(error.message)) {
        console.warn(`${collectionName} optional email index cleanup skipped:`, error.message);
      }
    }
  }
}

const CUSTOMER_LOCATION_ALIASES_KEY = 'customer_location_aliases';
const CUSTOMER_LOCATION_ALIAS_LIMIT = 1000;
const CUSTOMER_LOCATION_ALIAS_VARIANT_LIMIT = 40;
const CUSTOMER_LOCATION_ALIAS_TEXT_LIMIT = 160;
const CUSTOMER_LOCATION_ALIAS_CONFIDENCE_MIN = 0.85;
const PAKISTAN_LOCATION_BOUNDS = Object.freeze({ minLat: 23, maxLat: 37.5, minLng: 60, maxLng: 78.5 });

function normalizeCustomerLocationAliasText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    // Urdu text is often pasted or transcribed with Arabic glyph variants,
    // tatweel, or invisible joiners. Canonicalize those only for alias
    // matching; the original query is still sent unchanged to live providers.
    .replace(/[\u0640\u200B-\u200D\u2060]/g, '')
    .replace(/[ىیي]/g, 'ی')
    .replace(/[كک]/g, 'ک')
    .replace(/[هةھ]/g, 'ہ')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/['’`"“”.,،؛;:()[\]{}|/\\_+=*&^%$#@!?<>~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasConfidenceValue(value, fallback = 0) {
  if (typeof value === 'string') {
    const named = { high: 0.95, medium: 0.75, low: 0.45 };
    const normalized = value.trim().toLocaleLowerCase();
    if (named[normalized] !== undefined) return named[normalized];
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function normalizeCustomerLocationAlias(input = {}, { preserveId = true } = {}) {
  const coordinates = input.coordinates && typeof input.coordinates === 'object'
    ? input.coordinates
    : input;
  const lat = Number(coordinates.lat);
  const lng = Number(coordinates.lng ?? coordinates.lon);
  const hasCoordinates = hasValidCoordinates({ lat, lng })
    && lat >= PAKISTAN_LOCATION_BOUNDS.minLat && lat <= PAKISTAN_LOCATION_BOUNDS.maxLat
    && lng >= PAKISTAN_LOCATION_BOUNDS.minLng && lng <= PAKISTAN_LOCATION_BOUNDS.maxLng;
  const variants = Array.isArray(input.variants)
    ? input.variants
      .map(value => String(value || '').slice(0, CUSTOMER_LOCATION_ALIAS_TEXT_LIMIT).trim())
      .filter(Boolean)
    : [];
  const displayName = String(input.displayName ?? input.officialName ?? input.name ?? '')
    .slice(0, CUSTOMER_LOCATION_ALIAS_TEXT_LIMIT).trim();
  const canonicalQuery = String(input.canonicalQuery ?? input.providerQuery ?? displayName)
    .slice(0, CUSTOMER_LOCATION_ALIAS_TEXT_LIMIT).trim();
  const normalizedVariants = [...new Set([
    displayName,
    ...variants
  ].map(normalizeCustomerLocationAliasText).filter(Boolean))].slice(0, CUSTOMER_LOCATION_ALIAS_VARIANT_LIMIT);
  return {
    ...(preserveId && (input.id || input._id) ? { id: String(input.id || input._id) } : {}),
    displayName,
    canonicalQuery,
    variants: normalizedVariants,
    cityHint: String(input.cityHint || '').slice(0, 80).trim(),
    confidence: aliasConfidenceValue(input.confidence ?? input.confidenceLevel, 0),
    enabled: input.enabled !== false,
    ...(hasCoordinates ? { coordinates: { lat, lng } } : {})
  };
}

function validateCustomerLocationAlias(input) {
  const alias = normalizeCustomerLocationAlias(input);
  const errors = [];
  if (!alias.displayName) errors.push('displayName is required');
  if (!alias.canonicalQuery) errors.push('canonicalQuery is required');
  if (!alias.variants.length) errors.push('At least one searchable variant is required');
  if (Number(input?.confidence) < 0 || Number(input?.confidence) > 1) errors.push('confidence must be between 0 and 1');
  if (input?.coordinates && !alias.coordinates) errors.push('coordinates must be valid Pakistan coordinates');
  return { alias, errors };
}

function normalizeCustomerLocationAliases(value) {
  const raw = Array.isArray(value) ? value : value?.aliases;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, CUSTOMER_LOCATION_ALIAS_LIMIT)
    .map(item => normalizeCustomerLocationAlias(item))
    .filter(item => item.displayName && item.canonicalQuery && item.variants.length);
}

async function getCustomerLocationAliases() {
  // Geocoding must remain available in no-database test/preview mode.
  if (!dbConnected && mongoose.connection.readyState !== 1) return [];
  try {
    const doc = await Settings.findOne({ key: CUSTOMER_LOCATION_ALIASES_KEY }).lean();
    return normalizeCustomerLocationAliases(doc?.value);
  } catch (error) {
    console.warn('[location-aliases] settings read failed:', error.message);
    return [];
  }
}

function boundedLevenshtein(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let rowMinimum = current[0];
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + cost);
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function customerLocationAliasMatch(query, alias) {
  const normalizedQuery = normalizeCustomerLocationAliasText(query);
  if (!normalizedQuery || !alias.enabled) return null;
  const exact = alias.variants.includes(normalizedQuery)
    || normalizeCustomerLocationAliasText(alias.displayName) === normalizedQuery;
  if (exact) return { alias, score: 1, exact: true, matchedBy: 'exact alias' };
  const maxDistance = normalizedQuery.length <= 7 ? 1 : normalizedQuery.length <= 18 ? 2 : 3;
  let bestDistance = maxDistance + 1;
  let bestVariant = '';
  for (const variant of alias.variants) {
    if (Math.abs(variant.length - normalizedQuery.length) > maxDistance) continue;
    const distance = boundedLevenshtein(normalizedQuery, variant, maxDistance);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestVariant = variant;
    }
  }
  if (bestDistance > maxDistance) return null;
  const score = 1 - bestDistance / Math.max(normalizedQuery.length, bestVariant.length, 1);
  if (score < 0.78) return null;
  return { alias, score, exact: false, matchedBy: 'close spelling' };
}

function matchCustomerLocationAliases(query, aliases) {
  return (aliases || [])
    .map(alias => customerLocationAliasMatch(query, alias))
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.exact) - Number(left.exact)
      || right.alias.confidence - left.alias.confidence
      || right.score - left.score
    )
    .slice(0, 8);
}

function isSafeDirectCustomerAlias(match) {
  const coordinates = match?.alias?.coordinates;
  return Boolean(
    match?.exact &&
    match.alias.enabled &&
    match.alias.confidence >= CUSTOMER_LOCATION_ALIAS_CONFIDENCE_MIN &&
    coordinates &&
    hasValidCoordinates(coordinates) &&
    coordinates.lat >= PAKISTAN_LOCATION_BOUNDS.minLat &&
    coordinates.lat <= PAKISTAN_LOCATION_BOUNDS.maxLat &&
    coordinates.lng >= PAKISTAN_LOCATION_BOUNDS.minLng &&
    coordinates.lng <= PAKISTAN_LOCATION_BOUNDS.maxLng
  );
}

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
const CUSTOMER_SHARED_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const CUSTOMER_OFFER_MIN_MULTIPLIER = 0.5;
const CUSTOMER_OFFER_MAX_MULTIPLIER = 2;
const CUSTOMER_OFFER_INCREMENT = 10;
const DEFAULT_RIDE_BROADCAST_RADIUS_KM = 5;
const MIN_RIDE_BROADCAST_RADIUS_KM = 0.5;
const MAX_RIDE_BROADCAST_RADIUS_KM = 100;
const DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS = 60;
const MIN_RIDE_BROADCAST_REQUEST_DURATION_SECONDS = 30;
const MAX_RIDE_BROADCAST_REQUEST_DURATION_SECONDS = 120;
const ADVANCE_BOOKING_CANCELLATION_CUTOFF_MS = 60 * 60 * 1000;
const PICKUP_PIN_REVEAL_DISTANCE_KM = 0.1;
const NATIVE_RIDE_ALERT_CHANNEL_ID = 'ride-alerts-critical-v2';

async function sendExpoPush(tokens, message) {
  const recipients = [...new Set(tokens.filter(token => /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(String(token || ''))))];
  if (!recipients.length) return { sent: 0, failed: 0 };
  const batchSize = 100;
  let sent = 0;
  let failed = 0;
  for (let offset = 0; offset < recipients.length; offset += batchSize) {
    const batch = recipients.slice(offset, offset + batchSize);
    let response;
    let responseBody;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
           body: JSON.stringify(batch.map(to => ({
             ...message,
             to,
             sound: 'default',
             priority: 'high',
             ttl: Math.min(120, Math.max(1, Number(message.ttl) || 60)),
             channelId: NATIVE_RIDE_ALERT_CHANNEL_ID,
           })))
        });
        responseBody = await response.json().catch(() => ({}));
        if (response.ok || response.status < 500 || attempt === 1) break;
      } catch (err) {
        if (attempt === 1) {
          console.warn(`[expo-push] delivery request failed after retry: ${err.message}`);
        }
      }
    }
    if (!response?.ok) {
      failed += batch.length;
      console.warn(`[expo-push] delivery request failed: ${response?.status || 'network error'}`);
      continue;
    }
    const tickets = Array.isArray(responseBody?.data) ? responseBody.data : [];
    tickets.forEach((ticket, index) => {
      if (ticket?.status === 'ok') {
        sent += 1;
        return;
      }
      failed += 1;
      const providerError = ticket?.details?.error || ticket?.message || 'unknown provider error';
      console.warn(`[expo-push] provider rejected token ${batch[index]}: ${providerError}`);
      if (providerError === 'DeviceNotRegistered') {
        User.updateOne({ expoPushToken: batch[index] }, { $set: { expoPushToken: '' } }).catch(() => {});
      }
    });
    if (tickets.length < batch.length) failed += batch.length - tickets.length;
    const receiptTokenById = new Map(
      tickets.flatMap((ticket, index) =>
        ticket?.status === 'ok' && ticket.id ? [[ticket.id, batch[index]]] : [])
    );
    const receiptIds = [...receiptTokenById.keys()];
    if (receiptIds.length) {
      const checkReceipts = async () => {
        try {
          const receiptResponse = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ids: receiptIds })
          });
          const receiptBody = await receiptResponse.json().catch(() => ({}));
          for (const [receiptId, receipt] of Object.entries(receiptBody?.data || {})) {
            if (receipt?.status === 'ok') continue;
            const providerError = receipt?.details?.error || receipt?.message || 'unknown receipt error';
            console.warn(`[expo-push] receipt ${receiptId} failed: ${providerError}`);
            if (providerError === 'DeviceNotRegistered') {
              const token = receiptTokenById.get(receiptId);
              if (token) User.updateOne({ expoPushToken: token }, { $set: { expoPushToken: '' } }).catch(() => {});
            }
          }
        } catch (err) {
          console.warn(`[expo-push] receipt check failed: ${err.message}`);
        }
      };
      const receiptTimer = setTimeout(() => void checkReceipts(), 15_000);
      receiptTimer.unref?.();
    }
  }
  if (failed) console.warn(`[expo-push] ride alert result: ${sent} accepted, ${failed} failed`);
  return { sent, failed };
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
  const source = typeof value === 'object' && value !== null ? value : {};
  const rawRadius = typeof value === 'object' && value !== null
    ? source.maximumRideBroadcastRadiusKm
    : value;
  const radius = Number(rawRadius);
  const duration = Number(source.broadcastRequestDurationSeconds);
  const normalizedDuration = Number.isInteger(duration)
    && duration >= MIN_RIDE_BROADCAST_REQUEST_DURATION_SECONDS
    && duration <= MAX_RIDE_BROADCAST_REQUEST_DURATION_SECONDS
    ? duration
    : DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS;
  if (!Number.isFinite(radius) || radius < MIN_RIDE_BROADCAST_RADIUS_KM || radius > MAX_RIDE_BROADCAST_RADIUS_KM) {
    return {
      maximumRideBroadcastRadiusKm: DEFAULT_RIDE_BROADCAST_RADIUS_KM,
      broadcastRequestDurationSeconds: normalizedDuration
    };
  }
  return {
    maximumRideBroadcastRadiusKm: Number(radius.toFixed(2)),
    broadcastRequestDurationSeconds: normalizedDuration
  };
}

function validateRideBroadcastSettings(value) {
  const rawRadius = value?.maximumRideBroadcastRadiusKm;
  const radius = Number(rawRadius);
  const duration = Number(value?.broadcastRequestDurationSeconds);
  const errors = [];
  if (!Number.isFinite(radius)) errors.push('Maximum Ride Broadcast Radius must be a number');
  else if (radius < MIN_RIDE_BROADCAST_RADIUS_KM || radius > MAX_RIDE_BROADCAST_RADIUS_KM) {
    errors.push(`Maximum Ride Broadcast Radius must be between ${MIN_RIDE_BROADCAST_RADIUS_KM} and ${MAX_RIDE_BROADCAST_RADIUS_KM} km`);
  } else if (Math.round(radius * 100) !== radius * 100) {
    errors.push('Maximum Ride Broadcast Radius can have at most two decimal places');
  }
  if (!Number.isInteger(duration)) errors.push('Broadcast Request Duration must be a whole number of seconds');
  else if (duration < MIN_RIDE_BROADCAST_REQUEST_DURATION_SECONDS || duration > MAX_RIDE_BROADCAST_REQUEST_DURATION_SECONDS) {
    errors.push(`Broadcast Request Duration must be between ${MIN_RIDE_BROADCAST_REQUEST_DURATION_SECONDS} and ${MAX_RIDE_BROADCAST_REQUEST_DURATION_SECONDS} seconds`);
  }
  return {
    settings: normalizeRideBroadcastSettings({
      maximumRideBroadcastRadiusKm: radius,
      broadcastRequestDurationSeconds: duration
    }),
    errors
  };
}

function rideOfferIsStillOpenQuery(now = new Date()) {
  const legacyCutoff = new Date(now.getTime() - DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS * 1000);
  return {
    $or: [
      { broadcastExpiresAt: { $gt: now } },
      { broadcastExpiresAt: null, createdAt: { $gte: legacyCutoff } }
    ]
  };
}

async function getRideBroadcastSettings() {
  return getCachedAdminSetting({
    key: 'ride_broadcast_settings',
    fallback: {},
    normalize: normalizeRideBroadcastSettings,
    load: async () => (await Settings.findOne({ key: 'ride_broadcast_settings' }).lean())?.value
  });
}

function utcDayStart(date = new Date()) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

async function selectFairStudentRideDrivers(drivers) {
  if (!drivers.length) return [];
  const settings = await getStudentFairQuotaSettings();
  const studentDiscountSettings = await getStudentDiscountSettings();
  if (!studentDiscountSettings.enabled) return drivers;
  const driverIds = drivers.map(driver => driver._id);
  const completedCounts = await getStudentRideCompletedCounts(driverIds);
  const countByDriver = completedCounts;
  const ranked = drivers
    .map(driver => ({
      driver,
      completedStudentRides: countByDriver.get(String(driver._id)) || 0,
      lastAssignedAt: driver.studentRideLastAssignedAt
        ? new Date(driver.studentRideLastAssignedAt).getTime()
        : 0
    }))
    .sort((a, b) =>
      a.completedStudentRides - b.completedStudentRides
      || a.lastAssignedAt - b.lastAssignedAt
      || String(a.driver._id).localeCompare(String(b.driver._id))
    );

  // Keep a small fallback group so one ignored request does not strand the
  // Customer, while still giving the least-served Drivers first opportunity.
  const underQuota = settings.dailyQuota > 0
    ? ranked.filter(entry => entry.completedStudentRides < settings.dailyQuota)
    : ranked;
  const pool = underQuota.length ? underQuota : ranked;
  const selected = pool.slice(0, Math.min(3, pool.length)).map(entry => entry.driver);
  if (selected.length) {
    await User.updateMany(
      { _id: { $in: selected.map(driver => driver._id) } },
      { $set: { studentRideLastAssignedAt: new Date() } }
    );
  }
  return selected;
}

async function getStudentRideCompletedCounts(driverIds) {
  if (!driverIds.length) return new Map();
  const rows = await Ride.aggregate([
    {
      $match: {
        isStudentRide: true,
        status: 'completed',
        settledAt: { $gte: utcDayStart() },
        driver: { $in: driverIds }
      }
    },
    { $group: { _id: '$driver', count: { $sum: 1 } } }
  ]);
  return new Map(rows.map(row => [String(row._id), Number(row.count || 0)]));
}

async function recordStudentRideResponse(ride, driverId, responseType) {
  if (!ride?.isStudentRide || !['rejected', 'timeout'].includes(responseType)) return null;
  const studentDiscountSettings = await getStudentDiscountSettings();
  if (!studentDiscountSettings.enabled) return null;
  const recipient = (ride.studentRideOfferRecipients || []).find(
    entry => String(entry.driver?._id || entry.driver) === String(driverId)
  );
  if (!recipient) return null;
  const driver = await User.findById(driverId).select('name phone').lean();
  if (!driver) return null;

  const log = await StudentRideResponseLog.findOneAndUpdate(
    { ride: ride._id, driver: driverId },
    {
      $setOnInsert: {
        ride: ride._id,
        driver: driverId,
        driverName: driver.name || '',
        driverPhone: driver.phone || '',
        pickupLocation: {
          lat: Number(ride.pickupLocation?.lat) || null,
          lng: Number(ride.pickupLocation?.lng) || null,
          address: ride.pickupLocation?.address || ''
        },
        distanceFromPickupKm: Number.isFinite(Number(recipient.distanceFromPickupKm))
          ? Number(recipient.distanceFromPickupKm)
          : null,
        responseType,
        occurredAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  io.to('admin-room').emit('student-ride-log:updated', {
    id: String(log._id),
    rideId: String(ride._id),
    driverId: String(driverId),
    responseType: log.responseType,
    occurredAt: log.occurredAt
  });
  return log;
}

async function recordExpiredStudentRideResponses() {
  const studentDiscountSettings = await getStudentDiscountSettings();
  if (!studentDiscountSettings.enabled) return;
  const expiredRides = await Ride.find({
    isStudentRide: true,
    status: 'requested',
    broadcastExpiresAt: { $lte: new Date() },
    'studentRideOfferRecipients.0': { $exists: true }
  }).select('_id isStudentRide pickupLocation studentRideOfferRecipients').lean();
  for (const ride of expiredRides) {
    for (const recipient of ride.studentRideOfferRecipients || []) {
      await recordStudentRideResponse(ride, recipient.driver, 'timeout');
    }
  }
}

function hasValidCoordinates(location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lng) && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

function coordinateBoundsQuery(path, center, radiusKm) {
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  const radius = Number(radiusKm);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) return {};

  // A latitude degree is nearly constant. Longitude degrees narrow toward the
  // poles, so use a conservative longitude window and keep the exact
  // Haversine check below as the final authority.
  const latDelta = radius / 110.574;
  const cosLatitude = Math.max(Math.abs(Math.cos(lat * Math.PI / 180)), 0.01);
  const lngDelta = radius / (111.320 * cosLatitude);
  const bounds = {
    [`${path}.lat`]: {
      $gte: Math.max(-90, lat - latDelta),
      $lte: Math.min(90, lat + latDelta)
    }
  };
  // A window crossing the international date line needs a more complex $or.
  // Skip only that optional prefilter; exact Haversine filtering still applies.
  if (lngDelta < 180) {
    bounds[`${path}.lng`] = {
      $gte: Math.max(-180, lng - lngDelta),
      $lte: Math.min(180, lng + lngDelta)
    };
  }
  return bounds;
}

function isAtRidePickup(ride, location) {
  if (!ride?.pickupLocation || !hasValidCoordinates(location) || !hasValidCoordinates(ride.pickupLocation)) {
    return false;
  }
  return haversineKm(
    Number(location.lat),
    Number(location.lng),
    Number(ride.pickupLocation.lat),
    Number(ride.pickupLocation.lng)
  ) <= PICKUP_PIN_REVEAL_DISTANCE_KM;
}

function rideResponseForUser(ride, role) {
  const payload = typeof ride?.toObject === 'function' ? ride.toObject() : { ...ride };
  // Never expose the PIN before the server has persisted the pickup-arrival
  // gate. The Driver learns it from the passenger in person, not from an API.
  // Once released, only the Customer needs the PIN in a response payload.
  if (role !== 'customer' || !payload.pickupReachedAt) delete payload.verificationPin;
  return payload;
}

const CUSTOMER_ACTIVE_RIDE_STATUSES = ['requested', 'accepted', 'arrived', 'in-progress'];

async function rideResponseForUserWithContact(ride, role) {
  const payload = rideResponseForUser(ride, role);
  const field = role === 'customer' ? 'driver' : 'passenger';
  const participant = payload[field];
  let participantId = participant?._id || participant?.id || participant;
  if (!participantId && ride?._id) {
    const rawRide = await Ride.findById(ride._id).select(field).lean().catch(() => null);
    participantId = rawRide?.[field] || null;
  }
  if (!participantId) return payload;

  const contact = await User.findById(participantId)
    .select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto')
    .lean()
    .catch(() => null);
  const participantSnapshot = participant && typeof participant === 'object' ? participant : {};
  const resolvedContact = contact || participantSnapshot;
  const contactPhone = String(resolvedContact.phone || '').trim();
  if (!resolvedContact || (!participantSnapshot && !contact)) return payload;

  payload[field] = {
    ...participantSnapshot,
    ...resolvedContact,
    _id: resolvedContact._id || participantSnapshot._id || participantId,
    id: String(resolvedContact._id || participantSnapshot._id || participantId),
    phone: contactPhone
  };
  // Keep an explicit contact snapshot beside the populated participant. This
  // survives partial population and makes the REST/realtime/native bridge
  // unambiguous for the two contact actions.
  payload.contact = {
    id: String(resolvedContact._id || participantSnapshot._id || participantId),
    name: resolvedContact.name || participantSnapshot.name || '',
    phone: contactPhone,
    vehicleType: resolvedContact.vehicleType || participantSnapshot.vehicleType || '',
    vehicleModel: resolvedContact.vehicleModel || participantSnapshot.vehicleModel || '',
    vehiclePlate: resolvedContact.vehiclePlate || participantSnapshot.vehiclePlate || '',
    rating: resolvedContact.rating ?? participantSnapshot.rating ?? null,
    profilePhoto: resolvedContact.profilePhoto || participantSnapshot.profilePhoto || ''
  };
  payload.contactPhone = contactPhone;
  return payload;
}

function roundFareOfferBoundary(amount) {
  return Math.max(
    CUSTOMER_OFFER_INCREMENT,
    Math.ceil(Number(amount || 0) / CUSTOMER_OFFER_INCREMENT) * CUSTOMER_OFFER_INCREMENT
  );
}

function resolveCustomerFareOffer(value, authoritativeFare, offsetValue = undefined) {
  const hasOffset = offsetValue !== undefined && offsetValue !== null && offsetValue !== '';
  const hasOffer = value !== undefined && value !== null && value !== '';
  if (!hasOffset && !hasOffer) {
    return { value: authoritativeFare, offset: 0 };
  }

  const min = roundFareOfferBoundary(authoritativeFare * CUSTOMER_OFFER_MIN_MULTIPLIER);
  const max = roundFareOfferBoundary(authoritativeFare * CUSTOMER_OFFER_MAX_MULTIPLIER);
  let proposed;
  let offset;
  if (hasOffset) {
    offset = Number(offsetValue);
    if (!Number.isFinite(offset) || !Number.isInteger(offset)) {
      return { error: 'Fare adjustment must be a whole-number offset.' };
    }
    proposed = authoritativeFare + offset;
  } else {
    // Backward compatibility for older web clients that sent the final offer
    // as customerOffer instead of sending the offset separately.
    proposed = Number(value);
    if (!Number.isFinite(proposed) || !Number.isInteger(proposed)) {
      return { error: 'Enter a whole-number fare offer.' };
    }
    offset = proposed - authoritativeFare;
  }
  if (!Number.isFinite(proposed) || proposed <= 0 || proposed < min || proposed > max) {
    return { error: `Fare offer must be between Rs ${min.toLocaleString()} and Rs ${max.toLocaleString()}.` };
  }
  return { value: proposed, offset };
}

// Driver records created before the Customer/Driver collection split may
// still live in the Customer collection with an explicit driver role. The
// realtime audience must see both that legacy shape and current Driver
// records, while all other user queries remain on the compatibility facade.
async function findDriverDocuments(filter = {}, { select = '_id', lean = true } = {}) {
  // Unit and preview doubles may replace the shared User facade before a
  // database connection exists. Preserve that seam instead of buffering a
  // direct collection query for ten seconds.
  if (!(dbConnected || mongoose.connection.readyState === 1)) {
    let query = User.find({
      ...filter,
      role: { $in: ['customer', 'driver'] }
    });
    if (select) query = query.select(select);
    if (lean) query = query.lean();
    const values = await query;
    return Array.isArray(values)
      ? values.filter(value => !value.role || value.role === 'driver')
      : [];
  }
  const driverFilter = { ...filter };
  delete driverFilter.role;
  const legacyDriverFilter = { ...filter, role: 'driver' };
  const queries = [
    Driver.find(driverFilter),
    Customer.find(legacyDriverFilter)
  ];
  if (select) queries.forEach(query => query.select(select));
  if (lean) queries.forEach(query => query.lean());
  const values = await Promise.all(queries.map(query => query.exec()));
  return [...new Map(
    values.flat().map(value => [String(value._id), value])
  ).values()];
}

async function syncRedisDriverPresence(driverId) {
  if (!isRedisReady()) return false;
  const [driver] = await findDriverDocuments(
    { _id: driverId },
    { select: '_id vehicleType ridePreference longRangeEnabled isOnline accountStatus lastOnlineHeartbeat currentLocation' }
  ).catch(() => []);
  const heartbeatIsFresh = driver?.lastOnlineHeartbeat
    && Date.now() - new Date(driver.lastOnlineHeartbeat).getTime() <= DRIVER_HEARTBEAT_MAX_AGE_MS;
  if (!driver || !driver.isOnline || driver.accountStatus !== 'active' || !heartbeatIsFresh
      || !hasValidCoordinates(driver.currentLocation)) {
    return removeDriverPresence(driverId);
  }
  return upsertDriverPresence({
    driverId: driver._id,
    lat: driver.currentLocation.lat,
    lng: driver.currentLocation.lng,
    vehicleType: driver.vehicleType,
    ridePreference: driver.ridePreference,
    longRangeEnabled: driver.longRangeEnabled
  });
}

async function rebuildRedisDriverIndex() {
  if (!isRedisReady() || !(dbConnected || mongoose.connection.readyState === 1)) return false;
  const drivers = await findDriverDocuments({
    isOnline: true,
    accountStatus: 'active',
    lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
    'currentLocation.lat': { $ne: 0 },
    'currentLocation.lng': { $ne: 0 }
  }, {
    select: '_id vehicleType ridePreference longRangeEnabled currentLocation'
  }).catch(() => null);
  if (!drivers) return false;
  const rebuilt = await rebuildDriverGeoIndex(drivers);
  if (rebuilt) console.log(`[redis] rebuilt Driver GEO index (${drivers.length} fresh online driver(s))`);
  return rebuilt;
}

async function findRideBroadcastDrivers(
  pickupLocation,
  vehicleType,
  settings = null,
  vehicleCategorySettings = null,
  { isStudentRide = false } = {}
) {
  const rideSettings = settings || await getRideBroadcastSettings();
  const radiusKm = rideSettings.maximumRideBroadcastRadiusKm;
  if (!hasValidCoordinates(pickupLocation)) return { drivers: [], radiusKm };
  if (!isVehicleCategoryActive(
    vehicleCategorySettings || await getVehicleCategorySettings(),
    vehicleType
  )) return { drivers: [], radiusKm };

  const redisCandidateIds = await searchDriverIds({
    lat: pickupLocation.lat,
    lng: pickupLocation.lng,
    radiusKm
  });
  const locationFilter = redisCandidateIds?.length
    ? { _id: { $in: redisCandidateIds } }
    : coordinateBoundsQuery('currentLocation', pickupLocation, radiusKm);
  const candidates = await findDriverDocuments({
    isOnline: true,
    accountStatus: 'active',
    ridePreference: { $ne: 'Long Range Only' },
    vehicleType: { $in: storedVehicleTypesForFareCategory(vehicleType) },
    lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
    'currentLocation.lat': { $ne: 0 },
    'currentLocation.lng': { $ne: 0 },
    ...locationFilter
  }, {
    select: '_id currentLocation expoPushToken studentRideLastAssignedAt'
  });

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
  const selectedDrivers = isStudentRide
    ? await selectFairStudentRideDrivers(drivers)
    : drivers;
  return { drivers: selectedDrivers, radiusKm };
}

async function findLongRangeBroadcastDrivers(
  pickupLocation,
  vehicleType,
  longRangeSettings,
  vehicleCategorySettings = null,
  { isStudentRide = false } = {}
) {
  const radiusKm = longRangeSettings.broadcastRadiusKm;
  if (!hasValidCoordinates(pickupLocation)) return { drivers: [], radiusKm };
  if (!isVehicleCategoryActive(
    vehicleCategorySettings || await getVehicleCategorySettings(),
    vehicleType
  )) return { drivers: [], radiusKm };
  const redisCandidateIds = await searchDriverIds({
    lat: pickupLocation.lat,
    lng: pickupLocation.lng,
    radiusKm
  });
  const locationFilter = redisCandidateIds?.length
    ? { _id: { $in: redisCandidateIds } }
    : coordinateBoundsQuery('currentLocation', pickupLocation, radiusKm);
  const candidates = await findDriverDocuments({
    isOnline: true, longRangeEnabled: true, accountStatus: 'active',
    ridePreference: { $ne: 'Short Range Only' },
    vehicleType: { $in: storedVehicleTypesForFareCategory(vehicleType) },
    lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
    'currentLocation.lat': { $ne: 0 }, 'currentLocation.lng': { $ne: 0 },
    ...locationFilter
  }, {
    select: '_id currentLocation expoPushToken longRangeEnabled studentRideLastAssignedAt'
  });
  const drivers = candidates.filter(driver => driver.longRangeEnabled === true
      && hasValidCoordinates(driver.currentLocation))
    .map(driver => ({ ...driver, distanceFromPickupKm: haversineKm(
      Number(pickupLocation.lat), Number(pickupLocation.lng),
      Number(driver.currentLocation.lat), Number(driver.currentLocation.lng)
    ) })).filter(driver => driver.distanceFromPickupKm <= radiusKm);
  const selectedDrivers = isStudentRide
    ? await selectFairStudentRideDrivers(drivers)
    : drivers;
  return { drivers: selectedDrivers, radiusKm };
}

// Scheduled rides are future reservations, not immediate proximity requests.
// Do not gate their distribution on the Driver's current GPS radius, Redis GEO
// membership, or an already-created Wallet document. A Driver can be online
// now while being away from the future pickup, and online availability already
// passed the daily-fee gate. Persisting this audience is what makes the booking
// visible in /api/advance-bookings/available even if the Driver misses the
// Socket.io event.
async function findAdvanceBookingBroadcastDrivers(vehicleType, { excludeDriverIds = [] } = {}) {
  const excludedDriverIds = new Set(excludeDriverIds.map(id => String(id)));
  const drivers = await findDriverDocuments({
    isOnline: true,
    accountStatus: 'active',
    vehicleType: { $in: storedVehicleTypesForFareCategory(vehicleType) },
    lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) }
  }, {
    select: '_id name phone vehicleType ridePreference longRangeEnabled expoPushToken studentRideLastAssignedAt'
  });

  // Advance bookings are future reservations. Broadcast to every currently
  // online, active Driver in the requested vehicle category; do not apply
  // proximity, ride-preference, student-fairness, or long-range gates here.
  return drivers.filter(driver => !excludedDriverIds.has(String(driver._id)));
}

async function chargeLongRangeCommissionCore(ride, driverId, longRangeSettings, { session } = {}) {
  if (!ride.isLongRange || ride.longRangeCommissionChargedAt) {
    return { ok: true, alreadyCharged: !!ride.longRangeCommissionChargedAt };
  }
  const finalFare = Number(ride.fare);
  if (!Number.isFinite(finalFare) || finalFare < 0) {
    return { ok: false, error: 'The final Long Range ride fare is unavailable for commission calculation.' };
  }
  const percentage = getLongRangeCommissionPercentage(longRangeSettings, ride.vehicleType);
  const amount = getLongRangeCommissionAmount(longRangeSettings, ride.vehicleType, finalFare);
  if (!percentage) {
    return { ok: false, error: 'A manual Long Range commission percentage is not configured for this vehicle category.' };
  }
  const walletSnapshot = await ensureWalletSourceBalances(driverId, { session });
  const allocation = allocateWalletDebit(walletSnapshot, amount);
  const debited = await Wallet.findOneAndUpdate({
    user: driverId, balance: { $gte: amount },
    transactions: { $not: { $elemMatch: { rideId: String(ride._id), description: 'Long Range commission' } } }
  }, {
    $inc: { balance: -amount },
    $set: {
      realCashAvailable: allocation.remainingReal,
      bonusAvailable: allocation.remainingBonus
    },
    $push: {
      transactions: {
        amount,
        type: 'debit',
        description: 'Long Range commission',
        rideId: String(ride._id),
        operationId: `ride:${ride._id}:long-range-commission`,
        revenueCategory: 'manual-long-range',
        fundingSource: allocation.fundingSource,
        realAmount: allocation.realAmount,
        bonusAmount: allocation.bonusAmount
      }
    }
  }, { new: true, ...(session ? { session } : {}) });
  if (!debited) {
    const alreadyQuery = Wallet.exists({
      user: driverId,
      transactions: { $elemMatch: { rideId: String(ride._id), description: 'Long Range commission' } }
    });
    if (session) alreadyQuery.session(session);
    const already = await alreadyQuery;
    if (!already) return { ok: false, error: 'Wallet balance is insufficient for the Long Range commission.' };
    const chargedAt = ride.longRangeCommissionChargedAt || new Date();
    await Ride.updateOne(
      { _id: ride._id, longRangeCommissionChargedAt: null },
      { $set: { longRangeCommissionAmount: amount, longRangeCommissionChargedAt: chargedAt } },
      session ? { session } : undefined
    );
    return {
      ok: true,
      alreadyCharged: true,
      amount,
      chargedAt,
      fundingSource: allocation.fundingSource,
      realAmount: allocation.realAmount,
      bonusAmount: allocation.bonusAmount
    };
  }
  const chargedAt = new Date();
  await Ride.updateOne(
    { _id: ride._id, longRangeCommissionChargedAt: null },
    { $set: { longRangeCommissionAmount: amount, longRangeCommissionChargedAt: chargedAt } },
    session ? { session } : undefined
  );
  return {
    ok: true,
    charged: true,
    amount,
    chargedAt,
    fundingSource: allocation.fundingSource,
    realAmount: allocation.realAmount,
    bonusAmount: allocation.bonusAmount
  };
}

async function chargeLongRangeCommission(ride, driverId, longRangeSettings, options = {}) {
  if (options?.session || mongoose.connection.readyState !== 1) {
    return chargeLongRangeCommissionCore(ride, driverId, longRangeSettings, options);
  }
  // Direct callers must receive the same atomic guarantee as ride settlement
  // callers that already provide a session. The disconnected branch preserves
  // the existing lightweight unit-test seam.
  return runFinancialTransaction(session =>
    chargeLongRangeCommissionCore(ride, driverId, longRangeSettings, { session })
  );
}

async function startLongRangeRideWithCommission(rideId, driverId, longRangeSettings) {
  return runFinancialTransaction(async session => {
    const ride = await Ride.findOne({
      _id: rideId,
      driver: driverId,
      status: 'arrived'
    }).session(session);
    if (!ride) return null;

    const commission = await chargeLongRangeCommissionCore(
      ride,
      driverId,
      longRangeSettings,
      { session }
    );
    if (!commission.ok) {
      throw financialError(commission.error, 409, 'LONG_RANGE_COMMISSION_FAILED');
    }
    ride.longRangeCommissionAmount = commission.amount || ride.longRangeCommissionAmount || 0;
    ride.longRangeCommissionChargedAt =
      commission.chargedAt || ride.longRangeCommissionChargedAt || new Date();
    ride.status = 'in-progress';
    await ride.save({ session });
    return { ride, commission };
  });
}

class FinancialTransactionRequiredError extends Error {
  constructor(message = 'A transaction-capable MongoDB connection is required for financial operations.') {
    super(message);
    this.name = 'FinancialTransactionRequiredError';
    this.code = 'FINANCIAL_TRANSACTION_REQUIRED';
    this.statusCode = 503;
  }
}

function isTransactionUnsupportedError(error) {
  const message = String(error?.message || '');
  return error?.code === 20
    || error?.code === 263
    || error?.codeName === 'IllegalOperation'
    || /Transaction numbers are only allowed|transactions are not supported|Transaction not supported/i.test(message);
}

async function runFinancialTransaction(work) {
  if (mongoose.connection.readyState !== 1) {
    throw new FinancialTransactionRequiredError('Financial operations are temporarily unavailable until MongoDB is connected.');
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 10_000
      }
    );
    return result;
  } catch (error) {
    if (isTransactionUnsupportedError(error)) {
      throw new FinancialTransactionRequiredError();
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
function requestIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key') || req.body?.idempotencyKey || '';
  const key = String(raw).trim();
  if (!key) return '';
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw financialError(
      `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters using letters, numbers, ".", "_", ":", or "-".`,
      400,
      'INVALID_IDEMPOTENCY_KEY'
    );
  }
  return key;
}

function hashFinancialRequest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyConflict(message, code = 'IDEMPOTENCY_KEY_REUSED') {
  return financialError(message, 409, code);
}

function financialOperationReplay(existing, requestHash) {
  if (existing.requestHash !== requestHash) {
    throw idempotencyConflict('This Idempotency-Key was already used for a different wallet request.');
  }
  if (existing.status !== 'completed') {
    throw idempotencyConflict('This wallet request is still being processed. Retry with the same Idempotency-Key shortly.', 'IDEMPOTENCY_OPERATION_IN_PROGRESS');
  }
  return { replayed: true, result: existing.result };
}

async function runIdempotentFinancialOperation({
  req,
  scope,
  actorId,
  request,
  work
}) {
  const key = requestIdempotencyKey(req);
  const normalizedActorId = String(actorId || 'unknown-actor');
  if (!key) {
    // Preserve the existing disconnected unit-test seam. A real financial
    // operation with Mongo connected always takes the transaction branch.
    if (mongoose.connection.readyState !== 1) {
      return { replayed: false, result: await work(null) };
    }
    return { replayed: false, result: await runFinancialTransaction(work) };
  }

  const filter = { scope, actorId: normalizedActorId, key };
  const requestHash = hashFinancialRequest(request);
  const existing = await FinancialOperation.findOne(filter).lean();
  if (existing) return financialOperationReplay(existing, requestHash);

  try {
    const result = await runFinancialTransaction(async session => {
      const [operation] = await FinancialOperation.create([{
        ...filter,
        requestHash,
        status: 'processing'
      }], { session });
      const operationResult = await work(session);
      operation.status = 'completed';
      operation.result = operationResult;
      await operation.save({ session });
      return operationResult;
    });
    return { replayed: false, result };
  } catch (error) {
    // Two retries can both observe no record before one transaction inserts it.
    // The losing transaction rolls back; replay the committed winner instead
    // of applying the financial work a second time.
    if (error?.code === 11000) {
      const committed = await FinancialOperation.findOne(filter).lean();
      if (committed) return financialOperationReplay(committed, requestHash);
    }
    throw error;
  }
}

function financialError(message, statusCode = 500, code = 'FINANCIAL_OPERATION_FAILED') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function getRideCommissionDeductionTiming(ride, longRangeSettings) {
  return LONG_RANGE_COMMISSION_TIMINGS.includes(ride?.longRangeCommissionDeductionTiming)
    ? ride.longRangeCommissionDeductionTiming
    : longRangeSettings?.commissionDeductionTiming || DEFAULT_LONG_RANGE_SETTINGS.commissionDeductionTiming;
}

async function completeRideFinancialSettlement(rideId, driverId, waitingRateSettings, longRangeSettings = null) {
  return runFinancialTransaction(async session => {
    const ride = await Ride.findOne({ _id: rideId, driver: driverId }).session(session);
    if (!ride) return { ride: null, alreadySettled: false };
    if (ride.status === 'completed' && ride.settlementStatus === 'settled') {
      return { ride, alreadySettled: true };
    }
    if (ride.status !== 'in-progress') return { ride: null, alreadySettled: false };

    applyWaitingStateToRide(
      ride,
      observeRideWaiting(ride, ride.driverLocation, waitingRateSettings, new Date())
    );
    const fareQuote = await refreshRideFareFromCurrentSettings(ride, waitingRateSettings);
    if (fareQuote?.error) {
      // Older rides may not contain the distance/settings fields needed for a
      // recalculation, while their persisted fare is still authoritative.
      // Preserve that valid fare; never invent a replacement or settle a ride
      // with no usable fare at all.
      if (!Number.isFinite(Number(ride.fare)) || Number(ride.fare) < 0) {
        throw financialError(fareQuote.error, 422, 'FARE_CALCULATION_FAILED');
      }
    }

    const fare = Number(ride.fare);
    if (ride.isLongRange && getRideCommissionDeductionTiming(ride, longRangeSettings) === 'completed') {
      const commission = await chargeLongRangeCommission(ride, driverId, longRangeSettings, { session });
      if (!commission.ok) {
        throw financialError(commission.error, 409, 'LONG_RANGE_COMMISSION_FAILED');
      }
      ride.longRangeCommissionAmount = commission.amount || ride.longRangeCommissionAmount || 0;
      ride.longRangeCommissionChargedAt = commission.chargedAt || ride.longRangeCommissionChargedAt || new Date();
    }
    // Daily Fees are the normal platform revenue. Ordinary ride fares are
    // paid to the Driver in full; only the separately charged Long Range
    // percentage commission is a platform ride charge.
    const earnings = fare;
    const operationId = `ride:${ride._id}:settlement`;
    const customerWallet = await Wallet.findOneAndUpdate(
      { user: ride.passenger },
      {
        $inc: { balance: -fare },
        $push: {
          transactions: {
            amount: fare,
            type: 'debit',
            description: 'Ride fare',
            rideId: String(ride._id),
            operationId
          }
        }
      },
      // Customer wallets are normally provisioned at registration. Upsert
      // here keeps legacy/manual accounts settleable while still recording
      // the debit in the same transaction as the ride completion.
      { new: true, upsert: true, session }
    );
    if (!customerWallet) {
      throw financialError('Customer wallet is unavailable; the ride was not completed.', 503, 'CUSTOMER_WALLET_UNAVAILABLE');
    }

    const driverWallet = await Wallet.findOneAndUpdate(
      { user: ride.driver },
      {
        $setOnInsert: {
          balance: 0,
          realCashWallet: 0,
          bonusWallet: 0,
          realCashAvailable: 0,
          bonusAvailable: 0
        },
        $push: {
          transactions: {
            amount: earnings,
            type: 'credit',
            description: 'Ride earnings',
            rideId: String(ride._id),
            operationId,
            fundingSource: WALLET_FUNDING_SOURCES.EARNINGS,
            realAmount: 0,
            bonusAmount: 0
          }
        }
      },
      { new: true, upsert: true, session }
    );
    if (!driverWallet) {
      throw financialError('Driver wallet is unavailable; the ride was not completed.', 503, 'DRIVER_WALLET_UNAVAILABLE');
    }

    const settledAt = new Date();
    ride.status = 'completed';
    ride.settlementStatus = 'settled';
    ride.settledAt = settledAt;
    ride.settledFare = fare;
    ride.settledDriverEarnings = earnings;
    await ride.save({ session });

    const driverUpdate = await User.updateOne(
      { _id: ride.driver },
      { $inc: { totalRides: 1 } },
      { session }
    );
    const passengerUpdate = await User.updateOne(
      { _id: ride.passenger },
      { $inc: { totalRides: 1 } },
      { session }
    );
    if ((driverUpdate.matchedCount === 0 && driverUpdate.n === 0)
      || (passengerUpdate.matchedCount === 0 && passengerUpdate.n === 0)) {
      throw financialError('Ride participants could not be updated; the ride was not completed.', 503, 'RIDE_PARTICIPANT_UPDATE_FAILED');
    }

    return { ride, alreadySettled: false };
  });
}

async function validateLongRangeDriverEligibility(driverId, settings, finalFare = null) {
  const [driver, wallet] = await Promise.all([
    User.findById(driverId).select('longRangeEnabled accountStatus vehicleType').lean(),
    Wallet.findOne({ user: driverId })
      .select('balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions')
      .lean()
  ]);
  return !!(settings.enabled && driver?.accountStatus === 'active' && driver.longRangeEnabled
     && walletMeetsCombinedRequirement(
       wallet,
       getLongRangeRequiredWalletBalance(settings, driver.vehicleType, finalFare)
     ));
}

function emitRideRequestToDrivers(drivers, payload) {
  for (const driver of drivers) {
    io.to(`user:${driver._id}`).emit('ride:new', payload);
  }
}

function driverRidePayload(ride) {
  return {
    id: String(ride._id),
    _id: String(ride._id),
    pickupLocation: ride.pickupLocation,
    dropoffLocation: ride.dropoffLocation,
    dropoffLocations: ride.dropoffLocations,
    passengerCount: ride.passengerCount || 1,
    fare: ride.fare,
    distance: ride.distance,
    duration: ride.duration || (ride.durationMinutes ? ride.durationMinutes * 60 : 0),
    paymentMethod: ride.paymentMethod,
    vehicleType: normalizeFareVehicle(ride.vehicleType),
    scheduledFor: ride.scheduledFor || undefined,
    advanceBookingId: ride.advanceBookingId ? String(ride.advanceBookingId) : undefined,
    isLongRange: !!ride.isLongRange,
    isStudentRide: !!ride.isStudentRide,
    broadcastExpiresAt: ride.broadcastExpiresAt,
    offerExpiresAt: ride.offerExpiresAt,
    passenger: ride.passenger,
    acceptanceEligibility: ride.acceptanceEligibility || undefined
  };
}

async function getAvailableRidesForDriver(driver) {
  if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) return [];
  if (!isVehicleCategoryActive(await getVehicleCategorySettings(), driver.vehicleType)) return [];
  const hasFreshHeartbeat = driver.lastOnlineHeartbeat &&
    new Date(driver.lastOnlineHeartbeat).getTime() >= Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS;
  if (!hasFreshHeartbeat || !hasValidCoordinates(driver.currentLocation)) return [];

  const [{ maximumRideBroadcastRadiusKm: radiusKm }, longRangeSettings] = await Promise.all([
    getRideBroadcastSettings(),
    getLongRangeSettings()
  ]);
  const studentDiscountSettings = await getStudentDiscountSettings();
  const recoveryRadiusKm = Math.max(radiusKm, longRangeSettings.broadcastRadiusKm);
  const rides = await Ride.find({
    status: 'requested',
    vehicleType: { $in: storedVehicleTypesForFareCategory(driver.vehicleType) },
    ...rideOfferIsStillOpenQuery(),
    ...coordinateBoundsQuery('pickupLocation', driver.currentLocation, recoveryRadiusKm)
  })
    .populate('passenger', 'name phone rating')
    .sort({ createdAt: -1 });
  const hasLongRangeRides = rides.some(ride => ride.isLongRange);
  const wallet = hasLongRangeRides
    ? await Wallet.findOne({ user: driver._id })
      .select('balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions')
      .lean()
    : null;
  const combinedWalletBalance = getCombinedWalletBalance(wallet);
  const feeState = await getDriverDailyFeeEligibility(driver);

  return rides.filter(ride => hasValidCoordinates(ride.pickupLocation)
    && (!ride.isStudentRide
      || !studentDiscountSettings.enabled
      || (ride.notifiedDriverIds || []).some(driverId => String(driverId) === String(driver._id)))
    && canDriverReceiveRideForPreference(driver.ridePreference, ride.isLongRange)
    && (!ride.isLongRange || (longRangeSettings.enabled && driver.longRangeEnabled))
    && haversineKm(
      Number(driver.currentLocation.lat),
      Number(driver.currentLocation.lng),
      Number(ride.pickupLocation.lat),
      Number(ride.pickupLocation.lng)
     ) <= (ride.isLongRange ? longRangeSettings.broadcastRadiusKm : radiusKm))
    .map(ride => {
      const longRangeRequiredWalletBalance = getLongRangeRequiredWalletBalance(
        longRangeSettings,
        driver.vehicleType,
        ride.fare
      );
      const longRangeCommissionAmount = getLongRangeCommissionAmount(
        longRangeSettings,
        driver.vehicleType,
        ride.fare
      );
      return {
        ...(typeof ride.toObject === 'function' ? ride.toObject() : ride),
        acceptanceEligibility: {
          allowed: feeState.allowed && (!ride.isLongRange || (
            longRangeSettings.enabled
            && driver.longRangeEnabled
            && walletMeetsCombinedRequirement(wallet, longRangeRequiredWalletBalance)
          )),
          reason: !feeState.allowed
            ? feeState.reason
            : ride.isLongRange && combinedWalletBalance < longRangeRequiredWalletBalance
              ? `Wallet balance must cover the Long Range commission of Rs ${longRangeCommissionAmount.toLocaleString()}.`
              : null,
          dailyFeeDue: !feeState.allowed,
          dailyFeeRate: feeState.rate,
          longRangeCommissionAmount: ride.isLongRange ? longRangeCommissionAmount : 0
        }
      };
    });
}

async function rehydrateDriverSocket(socket, driverId, { replayOffers = true } = {}) {
  if (socket._driverRecoveryPromise) {
    // The client normally sends driver:status immediately after connect. If
    // that refresh races the initial DB read, run one more pass after the
    // status update instead of replaying the stale pre-refresh result.
    socket._driverRecoveryQueued = true;
    return socket._driverRecoveryPromise;
  }
  const recovery = (async () => {
    const [driver, activeRide] = await Promise.all([
      User.findById(driverId)
        .select('isOnline accountStatus vehicleType ridePreference longRangeEnabled lastOnlineHeartbeat onlineStartedAt onlineTimeDate onlineTimeTodaySeconds currentLocation paidUntilDate lastDailyFeePaidAt')
        .lean()
        .catch(() => null),
      Ride.findOne({ driver: driverId, status: { $in: ['accepted', 'arrived', 'in-progress'] } })
        .select('_id')
        .lean()
        .catch(() => null)
    ]);
    const hasFreshHeartbeat = driver?.lastOnlineHeartbeat &&
      new Date(driver.lastOnlineHeartbeat).getTime() >= Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS;
    const isOnline = !!(driver && driver.accountStatus === 'active' && driver.isOnline && hasFreshHeartbeat);
    const vehicleType = normalizeFareVehicle(driver?.vehicleType || socket.vehicleType || 'Car Mini Non-AC');

    if (driver?.vehicleType) socket.vehicleType = vehicleType;
    if (isOnline) {
      socket.join('drivers-online');
      socket.join(`drivers:${vehicleType}`);
    } else {
      socket.leave('drivers-online');
      socket.leave(`drivers:${vehicleType}`);
    }
    if (activeRide) socket.join(`ride:${activeRide._id}`);

    const pendingRides = isOnline && replayOffers
      ? await getAvailableRidesForDriver(driver).catch(() => [])
      : [];
    socket.emit('driver:rehydrate', {
      isOnline,
      vehicleType,
      onlineStartedAt: isOnline ? driver?.onlineStartedAt || null : null,
      onlineTimeDate: driver?.onlineTimeDate || '',
      onlineTimeTodaySeconds: driver?.onlineTimeTodaySeconds || 0,
      nextFeeDeductionAt: isOnline ? driver?.paidUntilDate || null : null,
      activeRideId: activeRide ? String(activeRide._id) : null,
      pendingRideIds: pendingRides.map(ride => String(ride._id))
    });
    // Replay the same ride:new contract used for first delivery. Clients
    // deduplicate by ride id, so reconnects cannot duplicate alert effects.
    for (const ride of pendingRides) {
      if (socket.connected) socket.emit('ride:new', driverRidePayload(ride));
    }
    return { isOnline, activeRide };
  })();
  socket._driverRecoveryPromise = recovery.finally(() => {
    socket._driverRecoveryPromise = null;
    if (socket._driverRecoveryQueued && socket.connected) {
      socket._driverRecoveryQueued = false;
      void rehydrateDriverSocket(socket, driverId, { replayOffers }).catch(() => {});
    }
  });
  return socket._driverRecoveryPromise;
}

// Ride state can be visible through a personal room, an active ride room, and
// the vehicle broadcast room at the same time. Emit each lifecycle mutation to
// their union so every recipient sees one authoritative, idempotent update.
function emitRideLifecycle(ride, event, detail = {}, { notifyVehicleDrivers = false, notifyDriverIds = [] } = {}) {
  const revision = new Date(ride.updatedAt || Date.now()).toISOString();
  const referenceId = value => value?._id || value?.id || value;
  const payload = {
    rideId: String(ride._id),
    eventId: `${event}:${ride._id}:${revision}`,
    revision,
    ...detail
  };
  const passengerId = referenceId(ride.passenger);
  const driverId = referenceId(ride.driver);
  const rooms = [`ride:${ride._id}`];
  if (passengerId) rooms.push(`user:${passengerId}`);
  if (driverId) rooms.push(`user:${driverId}`);
  notifyDriverIds.forEach(driverId => {
    const recipientId = referenceId(driverId);
    if (recipientId) rooms.push(`user:${recipientId}`);
  });
  if (notifyVehicleDrivers) rooms.push(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini Non-AC')}`);
  io.to([...new Set(rooms)]).emit(event, payload);
  // The Admin dashboard does not join individual ride rooms. Give it a
  // lightweight invalidation event so its database-backed overview counters
  // stay current for accept, arrival, start, completion, and cancellation.
  io.sockets.to('admin-room').emit('admin:stats:refresh', { reason: event, rideId: payload.rideId });
  return payload;
}

function emitRideAccepted(ride, verificationPin, driver) {
  // The PIN is deliberately not part of acceptance. It is released only by
  // emitRidePickupReached after the server verifies pickup proximity.
  emitRideLifecycle(ride, 'ride:accepted', { driver });
  // This intentionally reaches every eligible driver, including drivers who
  // never joined the ride room because they had only received ride:new.
  emitRideLifecycle(ride, 'ride:taken', {}, {
    notifyVehicleDrivers: true,
    notifyDriverIds: ride.notifiedDriverIds || []
  });
}

function emitRideOffers(ride) {
  const referenceId = value => value?._id || value?.id || value;
  const passengerId = referenceId(ride?.passenger);
  const rooms = [`ride:${ride._id}`];
  if (passengerId) rooms.push(`user:${passengerId}`);
  const offers = (ride.counterOffers || []).map(o => ({
    driverId:     String(o.driver?._id || o.driver),
    driverName:   o.driverName,
    vehicleModel: o.vehicleModel,
    vehiclePlate: o.vehiclePlate,
    rating:       o.rating,
    price:        o.price,
    type:         o.type,
    timestamp:    o.timestamp
  }));
  // The ride room is the normal path. The passenger room closes the brief
  // race between POST /api/rides returning and the Customer's ride:join being
  // processed, while the union keeps the existing event contract unchanged.
  io.to([...new Set(rooms)]).emit('ride:offers', offers);
  return offers;
}

function emitRidePickupReached(ride) {
  const referenceId = value => value?._id || value?.id || value;
  const passengerId = referenceId(ride?.passenger);
  if (!passengerId || !ride?.verificationPin) return null;
  const revision = new Date(ride.updatedAt || Date.now()).toISOString();
  const payload = {
    rideId: String(ride._id),
    eventId: `ride:pickup-reached:${ride._id}:${revision}`,
    revision,
    pickupReachedAt: ride.pickupReachedAt,
    verificationPin: ride.verificationPin
  };
  // Send the usable PIN only to the Customer's personal room. The Driver
  // receives no PIN from the server and must obtain it from the passenger.
  io.to(`user:${passengerId}`).emit('ride:pickup-reached', payload);
  return payload;
}

async function releaseRidePinAtPickup(ride, location) {
  if (!ride || ride.pickupReachedAt || !isAtRidePickup(ride, location)) return false;
  const pickupReachedAt = new Date();
  const updatedRide = await Ride.findOneAndUpdate(
    {
      _id: ride._id,
      driver: ride.driver,
      status: { $in: ['accepted', 'arrived'] },
      pickupReachedAt: null
    },
    {
      $set: {
        'driverLocation.lat': Number(location.lat),
        'driverLocation.lng': Number(location.lng),
        pickupReachedAt
      }
    },
    { new: true }
  );
  if (!updatedRide) return false;
  emitRidePickupReached(updatedRide);
  return true;
}

function observeRideWaiting(ride, location, waitingSettings, at = new Date()) {
  const category = normalizeFareVehicle(ride?.vehicleType);
  const config = normalizeWaitingRateSettings(waitingSettings)[category];
  const now = new Date(at);
  let accumulatedSeconds = Math.max(0, Number(ride?.waitingAccumulatedSeconds || 0));
  let waitingStartedAt = ride?.waitingStartedAt ? new Date(ride.waitingStartedAt) : null;
  const previousLocation = ride?.driverLocation;
  const isEnabled = ride?.status === 'in-progress' && config?.enabled && config.ratePerMinute > 0;

  if (!isEnabled) {
    return {
      waitingSeconds: Math.max(0, Number(ride?.waitingSeconds || accumulatedSeconds)),
      waitingAccumulatedSeconds: accumulatedSeconds,
      waitingStartedAt: null
    };
  }

  const remainedStopped = hasValidCoordinates(previousLocation)
    && haversineKm(
      Number(previousLocation.lat),
      Number(previousLocation.lng),
      Number(location.lat),
      Number(location.lng)
    ) <= WAITING_STOP_DISTANCE_KM;

  if (!remainedStopped) {
    if (waitingStartedAt) {
      accumulatedSeconds += Math.max(
        0,
        (now.getTime() - waitingStartedAt.getTime()) / 1000 - config.graceMinutes * 60
      );
    }
    waitingStartedAt = null;
  } else if (!waitingStartedAt) {
    waitingStartedAt = now;
  }

  const currentStopSeconds = waitingStartedAt
    ? Math.max(0, (now.getTime() - waitingStartedAt.getTime()) / 1000 - config.graceMinutes * 60)
    : 0;
  return {
    waitingSeconds: Number((accumulatedSeconds + currentStopSeconds).toFixed(2)),
    waitingAccumulatedSeconds: Number(accumulatedSeconds.toFixed(2)),
    waitingStartedAt
  };
}

function applyWaitingStateToRide(ride, waitingState) {
  ride.waitingSeconds = waitingState.waitingSeconds;
  ride.waitingAccumulatedSeconds = waitingState.waitingAccumulatedSeconds;
  ride.waitingStartedAt = waitingState.waitingStartedAt;
}

async function refreshRideFareFromCurrentSettings(ride, waitingRateSettings = null, at = new Date()) {
  const [settingsDoc, ratesDoc, longRangeDoc] = await Promise.all([
    Settings.findOne({ key: 'daily_fare_settings' }).lean(),
    Settings.findOne({ key: 'per_km_rates' }).lean(),
    Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean()
  ]);
  let fareQuote = calculateRideFare(
    normalizeFareSettings(settingsDoc?.value),
    normalizeLongRangeSettings(longRangeDoc?.value),
    ride.vehicleType,
    ride.distance,
    at,
    normalizePerKmRates(ratesDoc?.value),
    ride.durationMinutes,
    waitingRateSettings || await getWaitingRateSettings(),
    ride.waitingSeconds
  );
  if (fareQuote.error) return fareQuote;
  const persistedDiscount = Number(ride.fareQuote?.studentDiscountPercent);
  fareQuote = applyStudentDiscountToFareQuote(
    fareQuote,
    Number.isFinite(persistedDiscount)
      ? persistedDiscount
      : await getVerifiedStudentDiscountPercent(ride.passenger, ride.createdAt)
  );
  const isActiveRide = ['accepted', 'arrived', 'in-progress'].includes(ride.status);
  if (isActiveRide && !Number.isFinite(Number(ride.agreedFareBeforeWaiting))) {
    ride.agreedFareBeforeWaiting = Math.max(0, Number(ride.fare || 0) - Number(ride.waitingFare || 0));
  }
  ride.fareQuote = fareQuote;
  ride.fare = isActiveRide
    ? Math.max(0, Number(ride.agreedFareBeforeWaiting || 0) + Number(fareQuote.waitingFare || 0))
    : fareQuote.totalFare + Number(ride.customerFareOffset || 0);
  ride.waitingMinutes = fareQuote.waitingMinutes;
  ride.waitingFare = fareQuote.waitingFare;
  return fareQuote;
}

async function refreshActiveRideWaitingFares(waitingRateSettings) {
  const activeRides = await Ride.find({ status: 'in-progress' });
  for (const ride of activeRides) {
    const fareQuote = await refreshRideFareFromCurrentSettings(ride, waitingRateSettings);
    if (fareQuote.error) continue;
    await ride.save();
    io.to(`ride:${ride._id}`).emit('ride:fare-updated', {
      id: ride._id,
      fare: ride.fare,
      fareQuote: ride.fareQuote
    });
  }
}

const ADMIN_RECOVERY_ATTEMPTS = new Map();
const ADMIN_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_RECOVERY_MAX_ATTEMPTS = 5;
const ADMIN_SECURITY_OTP_TTL_MS = 10 * 60 * 1000;
const ADMIN_SECURITY_OTP_MAX_ATTEMPTS = 5;
const ADMIN_SECURITY_OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_SECURITY_OTP_MAX_REQUESTS = 3;
const ADMIN_SECURITY_OTP_CHALLENGES = new Map();
const ADMIN_SECURITY_OTP_REQUESTS = new Map();

function normalizeAdminSecurityOtpAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  return ['password', 'recovery-key', 'password-recovery'].includes(normalized)
    ? normalized
    : '';
}

function adminSecurityOtpChallengeKey(action, email, sessionVersion) {
  return `${action}:${String(email || '').trim().toLowerCase()}:${Number(sessionVersion || 0)}`;
}

function adminSecurityOtpRateKey(action, email, ip) {
  return `${action}:${String(email || '').trim().toLowerCase()}:${String(ip || 'unknown')}`;
}

function pruneAdminSecurityOtpState(now = Date.now()) {
  for (const [key, challenge] of ADMIN_SECURITY_OTP_CHALLENGES) {
    if (challenge.expiresAt <= now || challenge.used) ADMIN_SECURITY_OTP_CHALLENGES.delete(key);
  }
  for (const [key, request] of ADMIN_SECURITY_OTP_REQUESTS) {
    if (request.resetAt <= now) ADMIN_SECURITY_OTP_REQUESTS.delete(key);
  }
}

function takeAdminSecurityOtpRequestSlot(key, now = Date.now()) {
  const current = ADMIN_SECURITY_OTP_REQUESTS.get(key);
  if (!current || current.resetAt <= now) {
    ADMIN_SECURITY_OTP_REQUESTS.set(key, {
      count: 1,
      resetAt: now + ADMIN_SECURITY_OTP_REQUEST_WINDOW_MS
    });
    return true;
  }
  if (current.count >= ADMIN_SECURITY_OTP_MAX_REQUESTS) return false;
  current.count += 1;
  return true;
}

async function sendAdminSecurityOtp({ action, email, sessionVersion = 0, ip = 'unknown' }) {
  const normalizedAction = normalizeAdminSecurityOtpAction(action);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedAction || !normalizedEmail) {
    return { ok: false, status: 400, error: 'A valid Admin security action and email are required' };
  }
  if (!emailOtpConfigured()) {
    return { ok: false, status: 503, error: 'Admin email OTP service is not configured' };
  }

  pruneAdminSecurityOtpState();
  const rateKey = adminSecurityOtpRateKey(normalizedAction, normalizedEmail, ip);
  if (!takeAdminSecurityOtpRequestSlot(rateKey)) {
    return { ok: false, status: 429, error: 'Too many verification-code requests. Try again later.' };
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = await bcrypt.hash(otp, 10);
  const actionLabel = normalizedAction === 'recovery-key'
    ? 'Secret Recovery Key change'
    : normalizedAction === 'password-recovery'
      ? 'password recovery'
      : 'password change';

  try {
    await emailSender.sendMail({
      from: currentEmailFrom(),
      to: normalizedEmail,
      subject: 'My Ride Admin security verification code',
      text: `Your My Ride Admin ${actionLabel} verification code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your My Ride Admin ${actionLabel} verification code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`
    });
  } catch (err) {
    console.error('Admin security OTP delivery failed:', err);
    return { ok: false, status: 503, error: 'Unable to send the Admin verification code' };
  }

  const now = Date.now();
  ADMIN_SECURITY_OTP_CHALLENGES.set(
    adminSecurityOtpChallengeKey(normalizedAction, normalizedEmail, sessionVersion),
    {
      otpHash,
      expiresAt: now + ADMIN_SECURITY_OTP_TTL_MS,
      attempts: 0,
      used: false,
      verifying: false,
      email: normalizedEmail,
      action: normalizedAction,
      sessionVersion: Number(sessionVersion || 0)
    }
  );
  return { ok: true };
}

async function consumeAdminSecurityOtp({ action, email, sessionVersion = 0, otp }) {
  const normalizedAction = normalizeAdminSecurityOtpAction(action);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedOtp = String(otp || '').trim();
  if (!normalizedAction || !normalizedEmail || !/^\d{6}$/.test(normalizedOtp)) {
    return { ok: false, error: 'A valid 6-digit Admin verification code is required' };
  }

  pruneAdminSecurityOtpState();
  const key = adminSecurityOtpChallengeKey(normalizedAction, normalizedEmail, sessionVersion);
  const challenge = ADMIN_SECURITY_OTP_CHALLENGES.get(key);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) {
    ADMIN_SECURITY_OTP_CHALLENGES.delete(key);
    return { ok: false, error: 'Invalid or expired Admin verification code' };
  }
  if (challenge.verifying) {
    return { ok: false, error: 'Verification already in progress' };
  }
  if (challenge.attempts >= ADMIN_SECURITY_OTP_MAX_ATTEMPTS) {
    ADMIN_SECURITY_OTP_CHALLENGES.delete(key);
    return { ok: false, error: 'Too many verification attempts. Request a new code.' };
  }

  challenge.verifying = true;
  challenge.attempts += 1;
  const matches = await bcrypt.compare(normalizedOtp, challenge.otpHash).catch(() => false);
  challenge.verifying = false;
  if (!matches) {
    if (challenge.attempts >= ADMIN_SECURITY_OTP_MAX_ATTEMPTS) {
      ADMIN_SECURITY_OTP_CHALLENGES.delete(key);
      return { ok: false, error: 'Too many verification attempts. Request a new code.' };
    }
    return { ok: false, error: 'Invalid or expired Admin verification code' };
  }

  challenge.used = true;
  ADMIN_SECURITY_OTP_CHALLENGES.delete(key);
  return { ok: true };
}

function normalizeNationalId(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhoneNumber(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  const digits = input.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  let normalized = digits;
  if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
  if (normalized.startsWith('0')) normalized = `+92${normalized.slice(1)}`;
  else if (/^92\d+$/.test(normalized)) normalized = `+${normalized}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return '';
  return normalized;
}

function phoneLookupValues(value) {
  const raw = String(value || '').trim();
  const normalized = normalizePhoneNumber(raw);
  return [...new Set([normalized, raw].filter(Boolean))];
}

const PHONE_OTP_TTL_MS = 10 * 60 * 1000;
const PHONE_OTP_MAX_ATTEMPTS = 5;
const PHONE_OTP_CHALLENGES = new Map();

function phoneOtpIsAvailable() {
  // This is deliberately a mock/test flow until a real SMS provider is
  // selected. Never accept the fixed test code in production.
  return process.env.NODE_ENV !== 'production';
}

function phoneOtpKey(role, purpose, phone) {
  return `${role}:${purpose}:${phone}`;
}

async function issuePhoneOtp({ role, purpose, phone }) {
  const fixedTestCode = phoneOtpIsAvailable() && (
    process.env.NODE_ENV === 'test' ||
    process.env.DEMO_ACCOUNTS_ENABLED === 'true' ||
    process.env.PHONE_OTP_TEST_MODE === 'true'
  );
  const code = fixedTestCode
    ? '1234'
    : String(crypto.randomInt(1000, 10000));
  const key = phoneOtpKey(role, purpose, phone);
  PHONE_OTP_CHALLENGES.set(key, {
    otpHash: await bcrypt.hash(code, 10),
    expiresAt: Date.now() + PHONE_OTP_TTL_MS,
    attempts: 0
  });
  if (phoneOtpIsAvailable()) {
    console.info(`[phone-otp] ${purpose} ${role} code for ${phone}: ${code}`);
  }
}

async function consumePhoneOtp({ role, purpose, phone, otp }) {
  if (!phoneOtpIsAvailable()) return { ok: false, error: 'Phone OTP authentication is not available in production yet' };
  const key = phoneOtpKey(role, purpose, phone);
  const challenge = PHONE_OTP_CHALLENGES.get(key);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    PHONE_OTP_CHALLENGES.delete(key);
    return { ok: false, error: 'OTP has expired — request a new code' };
  }
  challenge.attempts += 1;
  if (challenge.attempts > PHONE_OTP_MAX_ATTEMPTS) {
    PHONE_OTP_CHALLENGES.delete(key);
    return { ok: false, error: 'Too many OTP attempts. Request a new code.' };
  }
  const normalizedOtp = String(otp || '').trim();
  const fixedCodeAccepted = phoneOtpIsAvailable() && normalizedOtp === '1234';
  const matches = fixedCodeAccepted || await bcrypt.compare(normalizedOtp, challenge.otpHash).catch(() => false);
  if (!matches) return { ok: false, error: 'Invalid or expired OTP' };
  PHONE_OTP_CHALLENGES.delete(key);
  return { ok: true };
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

function configuredAdminEmail(_persistedEmail = '') {
  // The Admin identity is environment-controlled. Never inherit an email from
  // another collection or silently fall back to a hardcoded address.
  return String(process.env.ADMIN_EMAIL || process.env.GMAIL_USER || '').trim();
}

function adminEnvironmentModeEnabled() {
  return process.env.NODE_ENV === 'production' ||
    Boolean(getConfiguredMongoUri().uri) ||
    process.env.DEMO_ACCOUNTS_ENABLED === 'true';
}

function environmentAdminPasswordIsAuthoritative() {
  const password = String(process.env.ADMIN_PASSWORD || '');
  return adminEnvironmentModeEnabled() && validateStrongPassword(password);
}

function environmentAdminRecoveryKeyIsAuthoritative() {
  const recoveryKey = String(process.env.ADMIN_RECOVERY_KEY || '').trim();
  return adminEnvironmentModeEnabled() && validateRecoveryKey(recoveryKey);
}

function validateAdminCredentialEnvironment() {
  const configuredEmail = configuredAdminEmail();
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '');
  const configuredRecoveryKey = String(process.env.ADMIN_RECOVERY_KEY || '').trim();
  const errors = [];

  if (!configuredEmail) {
    errors.push('ADMIN_EMAIL or GMAIL_USER must be configured');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuredEmail)) {
    errors.push('ADMIN_EMAIL or GMAIL_USER must be a valid email address');
  }
  if (configuredPassword && !validateStrongPassword(configuredPassword)) {
    errors.push('ADMIN_PASSWORD must be at least 10 characters');
  }
  if (configuredRecoveryKey && !validateRecoveryKey(configuredRecoveryKey)) {
    errors.push('ADMIN_RECOVERY_KEY must be at least 12 characters');
  }
  return errors;
}

async function getAdminSecurity() {
  const doc = await Admin.findById('super-admin').lean();
  return {
    email: String(doc?.email || '').trim(),
    passwordHash: doc?.passwordHash || '',
    recoveryKeyHash: doc?.recoveryKeyHash || '',
    sessionVersion: Number.isInteger(doc?.sessionVersion) ? doc.sessionVersion : 0,
    exists: Boolean(doc)
  };
}

async function saveAdminSecurity(security) {
  const value = {
    email: String(security.email || '').trim() || configuredAdminEmail(),
    passwordHash: String(security.passwordHash || ''),
    recoveryKeyHash: String(security.recoveryKeyHash || ''),
    sessionVersion: Number.isInteger(security.sessionVersion) ? security.sessionVersion : 0
  };
  await Admin.findOneAndUpdate(
    { _id: 'super-admin' },
    { $set: value, $setOnInsert: { _id: 'super-admin' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { ...value, exists: true };
}

// Reconcile the environment-managed Admin identity into MongoDB after every
// database connection. Passwords and recovery keys are never stored in
// plaintext. Existing database-managed credentials remain untouched when the
// corresponding environment value is absent.
async function syncAdminSecurity() {
  const configurationErrors = validateAdminCredentialEnvironment();
  if (configurationErrors.length) {
    throw new Error(configurationErrors.join('; '));
  }

  const current = await getAdminSecurity();
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '');
  const configuredRecoveryKey = String(process.env.ADMIN_RECOVERY_KEY || '').trim();
  const next = {
    email: current.email,
    passwordHash: current.passwordHash,
    recoveryKeyHash: current.recoveryKeyHash,
    sessionVersion: current.sessionVersion
  };
  let changed = false;
  let invalidateSessions = false;

  const authoritativeEmail = configuredAdminEmail();
  if (next.email !== authoritativeEmail) {
    invalidateSessions = Boolean(next.email);
    next.email = authoritativeEmail;
    changed = true;
  }

  if (configuredPassword) {
    const passwordMatches = next.passwordHash &&
      await bcrypt.compare(configuredPassword, next.passwordHash).catch(() => false);
    if (!passwordMatches) {
      invalidateSessions = Boolean(next.passwordHash);
      next.passwordHash = await bcrypt.hash(configuredPassword, 12);
      changed = true;
    }
  }

  if (configuredRecoveryKey) {
    const recoveryKeyMatches = next.recoveryKeyHash &&
      await bcrypt.compare(configuredRecoveryKey, next.recoveryKeyHash).catch(() => false);
    if (!recoveryKeyMatches) {
      next.recoveryKeyHash = await bcrypt.hash(configuredRecoveryKey, 12);
      changed = true;
    }
  }

  if (invalidateSessions) {
    next.sessionVersion += 1;
  }

  if (!changed) {
    return {
      ...current,
      passwordConfigured: Boolean(next.passwordHash),
      recoveryKeyConfigured: Boolean(next.recoveryKeyHash),
      updated: false
    };
  }

  const saved = await saveAdminSecurity(next);
  return {
    ...saved,
    passwordConfigured: Boolean(saved.passwordHash),
    recoveryKeyConfigured: Boolean(saved.recoveryKeyHash),
    updated: true
  };
}

async function initializeAdminSecurity() {
  if (adminSecurityInitializationPromise) return adminSecurityInitializationPromise;
  adminSecurityInitializationPromise = (async () => {
    try {
      const result = await syncAdminSecurity();
      if (result.updated) console.log('✓ Admin credential record synchronized');
      if (!result.passwordConfigured) {
        console.warn('⚠ Admin password is not initialized; configure ADMIN_PASSWORD or provision the dedicated Admin record');
      }
      if (!result.recoveryKeyConfigured) {
        console.warn('⚠ Admin recovery key is not initialized; configure ADMIN_RECOVERY_KEY or set one from Admin Security');
      }
      return result;
    } catch (err) {
      console.error('⚠ Admin credential synchronization failed:', err.message);
      return null;
    } finally {
      adminSecurityInitializationPromise = null;
    }
  })();
  return adminSecurityInitializationPromise;
}

async function verifySuperAdminPassword(candidate, security = null) {
  const current = security || await getAdminSecurity();
  // When a deployment or preview explicitly provides ADMIN_PASSWORD, it is
  // the recovery/bootstrap authority. This repairs stale restored hashes
  // through syncAdminSecurity while also allowing login during a DB outage.
  if (environmentAdminPasswordIsAuthoritative()) {
    return constantTimeEqual(candidate, process.env.ADMIN_PASSWORD);
  }
  if (current.passwordHash) return bcrypt.compare(String(candidate || ''), current.passwordHash);
  return false;
}

async function verifyCustomerIdentityDocuments({ name, nationalId, front, back }) {
  const expectedId = normalizeNationalId(nationalId);
  const expectedName = normalizeNameForMatch(name);
  if (!/^\d{13}$/.test(expectedId) || expectedName.length < 4) return false;
  const [frontImage, backImage] = [parseImageDataUrl(front), parseImageDataUrl(back)];
  try {
    const [frontMetadata, backMetadata] = await Promise.all([
      sharp(frontImage.bytes).metadata(),
      sharp(backImage.bytes).metadata()
    ]);
    if (!frontMetadata.width || !frontMetadata.height || !backMetadata.width || !backMetadata.height) return false;
  } catch {
    return false;
  }
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
    if (req.user.role === 'customer' || req.user.role === 'driver') {
      const clientSession = req.headers['x-session-token'];
      if (typeof clientSession !== 'string' || !clientSession) {
        return res.status(401).json({ error: 'LOGGED_IN_ELSEWHERE' });
      }
      const user = await User.findById(req.user.id).select('activeSessionToken').lean();
      if (!user || !user.activeSessionToken || user.activeSessionToken !== clientSession) {
        return res.status(401).json({ error: 'LOGGED_IN_ELSEWHERE' });
      }
    }
    next();
  } catch (err) {
    if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.warn(`[auth] session validation failed: ${err.message}`);
    return res.status(503).json({ error: 'Session validation is temporarily unavailable' });
  }
}

async function optionalCustomerAuth(req, _res, next) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.role === 'customer') req.user = payload;
    } catch {
      // Keep public fare calculation available when an optional token is stale.
    }
  }
  next();
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

// Road geometry is requested through the authenticated app server rather than
// exposing pickup, drop-off, or live driver coordinates to a public router
// directly from a browser. Mapbox Directions remains behind this boundary.
app.get('/api/routing/road', authMiddleware, async (req, res) => {
  const rawPoints = String(req.query.points || '').split(';').filter(Boolean);
  if (rawPoints.length < 2 || rawPoints.length > 8) {
    return res.status(400).json({ error: 'Provide between 2 and 8 route points' });
  }
  const points = rawPoints.map(raw => {
    const [lng, lat] = raw.split(',').map(Number);
    return hasValidCoordinates({ lat, lng }) ? { lat, lng } : null;
  });
  if (points.some(point => !point)) {
    return res.status(422).json({ error: 'Invalid coordinates', code: 'INVALID_COORDINATES' });
  }
  const coordinates = points.map(point => `${point.lng},${point.lat}`).join(';');
  try {
    const token = getMapboxAccessToken();
    if (!token) return res.status(503).json({ error: 'Mapbox routing is not configured' });
    const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'geojson');
    url.searchParams.set('steps', 'false');
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: 'Road routing service unavailable' });
    const payload = await response.json();
    const route = payload.routes?.[0];
    if (!route?.geometry?.coordinates?.length) return res.status(502).json({ error: 'No road route found' });
    return res.json({
      coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distanceMeters: Number(route.distance) || 0,
      durationSeconds: Number(route.duration) || 0
    });
  } catch (error) {
    console.warn(`[routing] road route failed: ${error.message}`);
    return res.status(502).json({ error: 'Road routing service unavailable' });
  }
});

// Legacy: used by /api/payments/* routes (needs authMiddleware first)
async function adminMiddleware(req, res, next) {
  // Kept as a compatibility name for older payment-route wiring. Admin
  // authorization is never inferred from Customer/Driver records.
  return adminJwt(req, res, next);
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

function adminSearchableRoles(admin) {
  return admin?.isSuperAdmin
    ? ['customer', 'driver']
    : [
        hasAdminPermission(admin, 'viewCustomers') && 'customer',
        hasAdminPermission(admin, 'viewDrivers') && 'driver'
      ].filter(Boolean);
}

function adminCanViewUserLocation(admin, role) {
  return !!admin?.isSuperAdmin || (
    role === 'driver'
      ? hasAdminPermission(admin, 'viewDrivers')
      : hasAdminPermission(admin, 'viewCustomers')
  );
}

function liveLocationSearchFields(matcher) {
  return [
    { name: matcher }, { phone: matcher }, { email: matcher },
    { cnicNumber: matcher }, { nationalIdLast4: matcher },
    { vehicleType: matcher }, { vehicleModel: matcher }, { vehiclePlate: matcher }
  ];
}

async function getAdminMapLocationForUser(user, now = new Date()) {
  if (user.role === 'driver') {
    const heartbeat = user.lastOnlineHeartbeat ? new Date(user.lastOnlineHeartbeat) : null;
    if (
      user.accountStatus !== 'active' || !user.isOnline || !heartbeat ||
      heartbeat.getTime() < now.getTime() - DRIVER_HEARTBEAT_MAX_AGE_MS ||
      !hasValidCoordinates(user.currentLocation)
    ) return null;
    return {
      _id: user._id,
      name: user.name,
      role: 'driver',
      phone: user.phone || '',
      vehicleType: user.vehicleType || '',
      vehicleModel: user.vehicleModel || '',
      vehiclePlate: user.vehiclePlate || '',
      status: 'online',
      location: { lat: Number(user.currentLocation.lat), lng: Number(user.currentLocation.lng) },
      updatedAt: heartbeat
    };
  }

  if (user.role !== 'customer' || user.accountStatus !== 'active') return null;
  const sharedAfter = new Date(now.getTime() - CUSTOMER_SHARED_LOCATION_MAX_AGE_MS);
  const ride = await Ride.findOne({
    passenger: user._id,
    status: { $in: ['accepted', 'arrived', 'in-progress'] },
    passengerLocationUpdatedAt: { $gte: sharedAfter }
  }).select('passengerLocation passengerLocationUpdatedAt status').sort('-passengerLocationUpdatedAt').lean();
  if (!ride || !hasValidCoordinates(ride.passengerLocation)) return null;
  return {
    _id: user._id,
    name: user.name,
    role: 'customer',
    phone: user.phone || '',
    status: ride.status,
    location: { lat: Number(ride.passengerLocation.lat), lng: Number(ride.passengerLocation.lng) },
    updatedAt: ride.passengerLocationUpdatedAt
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/phone-otp/request', async (req, res) => {
  try {
    if (!phoneOtpIsAvailable()) {
      return res.status(503).json({ error: 'Phone OTP authentication is not configured for production yet' });
    }
    const role = String(req.body?.role || 'customer').trim().toLowerCase();
    const purpose = String(req.body?.purpose || 'login').trim().toLowerCase();
    const phone = normalizePhoneNumber(req.body?.phone);
    if (!['customer', 'driver'].includes(role)) {
      return res.status(400).json({ error: 'Account type must be Customer or Driver' });
    }
    if (!['login', 'signup'].includes(purpose)) {
      return res.status(400).json({ error: 'OTP purpose must be login or signup' });
    }
    if (!phone) return res.status(400).json({ error: 'Enter a valid mobile number' });
    const existingUser = await User.findOne({ phone: { $in: phoneLookupValues(phone) } })
      .select('role').lean();
    if (purpose === 'signup' && existingUser) {
      return res.status(409).json({ error: 'Phone number already registered' });
    }
    if (purpose === 'login' && existingUser && existingUser.role !== role) {
      return res.status(409).json({ error: 'Use the app for your registered account type' });
    }
    await issuePhoneOtp({ role, purpose, phone });
    res.json({
      success: true,
      message: 'A phone verification code has been issued. In development/test mode, check the server log for the generated code.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to issue phone verification code' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, role, vehicleType, vehicleModel, vehiclePlate, ridePreference,
             profilePhoto, licensePhoto, cnicFront, cnicBack, cnicNumber, vehicleRegPhoto, deviceId,
             isStudent, studentIdNumber, studentIdImage, studentInstitution, otp } = req.body;
    const resolvedRoleEarly = role || 'customer';
    const phoneOtp = String(otp || '').trim();
    const usingPhoneOtp = Boolean(phoneOtp);
    if (!['customer', 'driver'].includes(resolvedRoleEarly)) {
      return res.status(400).json({ error: 'Account type must be Customer or Driver' });
    }
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Full name is required' });
    if (!usingPhoneOtp && !password) return res.status(400).json({ error: 'Password or phone OTP is required' });
    if (!usingPhoneOtp && String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const resolvedEmail = typeof email === 'string' && email.trim() ? email.toLowerCase().trim() : null;
    if (resolvedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resolvedEmail))
      return res.status(400).json({ error: 'Enter a valid email address' });
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'Enter a valid mobile number' });
    const resolvedRidePreference = resolvedRoleEarly === 'driver' ? normalizeRidePreference(ridePreference) : 'Both';
    const registeringAsStudent = resolvedRoleEarly === 'customer' && isStudent === true;
    if (registeringAsStudent && !(await getStudentDiscountSettings()).enabled) {
      return res.status(403).json({ error: 'Student registration is currently disabled by Admin' });
    }
    const normalizedCustomerId = normalizeNationalId(cnicNumber);
    if (resolvedRoleEarly === 'customer') {
      if (!cnicNumber) return res.status(400).json({ error: 'CNIC / NIC number is required' });
      if (!/^\d{13}$/.test(normalizedCustomerId)) {
        return res.status(400).json({ error: 'Enter a valid 13-digit CNIC / NIC number' });
      }
      if (!cnicFront) return res.status(400).json({ error: 'National ID Front is required' });
      if (!cnicBack) return res.status(400).json({ error: 'National ID Back is required' });
      if (registeringAsStudent) {
        if (!String(studentIdNumber || '').trim()) return res.status(400).json({ error: 'Student ID number is required' });
        if (!String(studentInstitution || '').trim()) return res.status(400).json({ error: 'Institution is required' });
        if (!studentIdImage) return res.status(400).json({ error: 'Student ID image is required' });
      }
    }
    if (resolvedRoleEarly === 'driver') {
      if (!String(vehicleModel || '').trim()) return res.status(400).json({ error: 'Vehicle model is required' });
      if (!String(vehiclePlate || '').trim()) return res.status(400).json({ error: 'Number plate is required' });
      if (!profilePhoto) return res.status(400).json({ error: 'Profile Photo is required' });
      if (!licensePhoto) return res.status(400).json({ error: 'Driving License is required' });
      if (!cnicFront) return res.status(400).json({ error: 'CNIC Front is required' });
      if (!cnicBack) return res.status(400).json({ error: 'CNIC Back is required' });
      if (!vehicleRegPhoto) return res.status(400).json({ error: 'Vehicle Registration Document is required' });
    }
    if (resolvedRoleEarly === 'driver' && !FARE_VEHICLE_CATEGORIES.includes(normalizeFareVehicle(vehicleType))) {
      return res.status(400).json({ error: 'Choose a valid vehicle category' });
    }
    if (usingPhoneOtp) {
      const verification = await consumePhoneOtp({
        role: resolvedRoleEarly,
        purpose: 'signup',
        phone: normalizedPhone,
        otp: phoneOtp
      });
      if (!verification.ok) return res.status(401).json({ error: verification.error });
    }
    const registrationDocuments = resolvedRoleEarly === 'customer'
      ? [
          [cnicFront, 'National ID Front'],
          [cnicBack, 'National ID Back'],
          ...(registeringAsStudent ? [[studentIdImage, 'Student ID Image']] : [])
        ]
      : [
          [profilePhoto, 'Profile Photo'],
          [licensePhoto, 'Driving License'],
          [cnicFront, 'CNIC Front'],
          [cnicBack, 'CNIC Back'],
          [vehicleRegPhoto, 'Vehicle Registration Document']
        ];
    for (const [document, label] of registrationDocuments) {
      try {
        parseImageDataUrl(document);
      } catch (err) {
        return res.status(400).json({ error: `${label}: ${err.message}` });
      }
    }

    if (resolvedEmail && await User.findOne({ email: resolvedEmail }))
      return res.status(409).json({ error: 'Email already registered' });
    if (await User.findOne({ phone: { $in: phoneLookupValues(phone) } }))
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
      if (!identityVerified) {
        return res.status(422).json({ error: 'Wrong Documents / Document Verification Failed' });
      }
    }

    const hash = usingPhoneOtp
      ? await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)
      : await bcrypt.hash(password, 12);
    const resolvedRole = role || 'customer';
    const registrationDeviceHash = resolvedRole === 'driver' ? hashDeviceIdentifier(deviceId) : '';
    let customerFrontFile = '';
    let customerBackFile = '';
    let studentIdFile = '';
    try {
      customerFrontFile = resolvedRole === 'customer' ? await savePrivateIdentityDocument(cnicFront, 'customer_id_front') : '';
      customerBackFile = resolvedRole === 'customer' ? await savePrivateIdentityDocument(cnicBack, 'customer_id_back') : '';
      studentIdFile = registeringAsStudent ? await savePrivateIdentityDocument(studentIdImage, 'student_id') : '';
    } catch (err) {
      deletePrivateIdentityDocuments([customerFrontFile, customerBackFile, studentIdFile]);
      throw new Error(`Identity document upload failed: ${err.message}`);
    }
    const user = await User.create({
      name,
      email:         resolvedEmail,
      phone:         normalizedPhone,
       password:      hash,
      role:          resolvedRole,
      accountStatus: resolvedRole === 'driver'
        ? 'pending'
        : customerRegistrationAccountStatus(registeringAsStudent, identityVerified),
      vehicleType:   resolvedRole === 'driver' ? normalizeFareVehicle(vehicleType) : '',
      ridePreference: resolvedRidePreference,
      vehicleModel:  vehicleModel   || '',
      vehiclePlate:  vehiclePlate   || '',
      profilePhoto:  resolvedRole === 'driver' ? await saveDriverProfilePhoto(profilePhoto) : '',
      licensePhoto:  resolvedRole === 'driver' ? await savePrivateDriverDocument(licensePhoto, 'license') : '',
      vehicleRegPhoto: resolvedRole === 'driver' ? await savePrivateDriverDocument(vehicleRegPhoto, 'vehicleReg') : '',
      cnicFront:     resolvedRole === 'driver' ? await savePrivateDriverDocument(cnicFront, 'cnicFront') : '',
      cnicBack:      resolvedRole === 'driver' ? await savePrivateDriverDocument(cnicBack, 'cnicBack') : '',
      cnicNumber:    resolvedRole === 'customer' ? normalizedCustomerId : (cnicNumber || ''),
      nationalIdHash: nationalIdHash || undefined,
      nationalIdLast4: resolvedRole === 'customer' ? normalizedCustomerId.slice(-4) : '',
      customerIdFront: customerFrontFile,
      customerIdBack: customerBackFile,
      isStudent: registeringAsStudent,
      studentIdNumber: registeringAsStudent ? String(studentIdNumber).trim() : '',
      studentInstitution: registeringAsStudent ? String(studentInstitution).trim() : '',
      studentIdImage: studentIdFile,
      studentVerificationStatus: registeringAsStudent ? 'pending' : 'not_applicable',
      identityVerifiedAt: resolvedRole === 'customer' ? new Date() : null,
      identityVerificationStatus: resolvedRole === 'customer' ? (identityVerified ? 'approved' : 'rejected') : null,
      deviceBindingHash: registrationDeviceHash || undefined,
      deviceBindingRegisteredAt: registrationDeviceHash ? new Date() : null
    });
    if (user.role === 'driver') {
      await Wallet.create({ user: user._id, balance: 0, transactions: [] });
    }

    // Single-device session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await User.updateOne({ _id: user._id }, {
      activeSessionToken: sessionToken,
      activeSessionDeviceHash: registrationDeviceHash || null
    });

    const token = jwt.sign(
        { id: user._id, email: user.email || '', role: user.role, name: user.name, accountStatus: user.accountStatus },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.status(201).json({
      token,
      sessionToken,
      user: { id: user._id, name: user.name, email: user.email || '', phone: user.phone,
               role: user.role, accountStatus: user.accountStatus, identityVerificationStatus: user.identityVerificationStatus,
              isStudent: user.isStudent, studentVerificationStatus: user.studentVerificationStatus,
              vehicleType: user.vehicleType,
              ridePreference: user.ridePreference || 'Both',
              vehicleModel: user.vehicleModel, vehiclePlate: user.vehiclePlate,
               lastDailyFeePaidAt: null, dailyFeeAmount: await getDailyFeeForVehicle(user.vehicleType),
               paidUntilDate: null, dailyFeeRate: await getDailyFeeForVehicle(user.vehicleType),
                onlineStartedAt: null, onlineTimeDate: '', onlineTimeTodaySeconds: 0, nextFeeDeductionAt: null }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    // Accept { identifier, password } (new) or { email, password } (legacy)
    const identifier = (req.body.identifier || req.body.email || '').trim();
    const { password, otp } = req.body;
    const phoneOtp = String(otp || '').trim();
    const usingPhoneOtp = Boolean(phoneOtp);
    if (!identifier || (!password && !usingPhoneOtp)) return res.status(400).json({ error: 'Phone/email and password or OTP required' });
    if (usingPhoneOtp && identifier.includes('@')) return res.status(400).json({ error: 'Phone OTP login requires a mobile number' });

    // Look up by email if it contains @, otherwise by phone
    const normalizedPhone = identifier.includes('@') ? '' : normalizePhoneNumber(identifier);
    if (!identifier.includes('@') && !normalizedPhone) {
      return res.status(400).json({ error: 'Enter a valid mobile number' });
    }
    const user = identifier.includes('@')
      ? await User.findOne({ email: identifier.toLowerCase() }).select('+deviceBindingHash')
      : await User.findOne({ phone: { $in: phoneLookupValues(identifier) } }).select('+deviceBindingHash');

    if (!user) return res.status(404).json({ error: 'No account found with this phone number or email' });
    if (req.body?.role && req.body.role !== user.role) {
      return res.status(403).json({ error: 'Use the app for your registered account type' });
    }
    if (usingPhoneOtp) {
      const verification = await consumePhoneOtp({
        role: user.role,
        purpose: 'login',
        phone: normalizePhoneNumber(user.phone) || normalizedPhone,
        otp: phoneOtp
      });
      if (!verification.ok) return res.status(401).json({ error: verification.error });
    } else if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    if (user.role === 'driver') {
      const loginDeviceHash = hashDeviceIdentifier(req.body?.deviceId);
      if (user.deviceBindingEnabled && !loginDeviceHash) {
        return res.status(403).json({
          error: 'This Driver account requires its registered device. Please sign in from that device.'
        });
      }
      if (user.deviceBindingEnabled && user.deviceBindingHash && loginDeviceHash !== user.deviceBindingHash) {
        return res.status(403).json({
          error: 'This Driver account is locked to its registered device. Please use that device or contact Admin.'
        });
      }
      // Capture the first app/browser installation that signs in. This gives
      // Admin a safe enrollment path for legacy Drivers with no binding yet,
      // while OFF still allows an account to move to a new device later.
      if (loginDeviceHash && !user.deviceBindingHash) {
        const bindingResult = await User.updateOne(
          {
            _id: user._id,
            role: 'driver',
            $or: [{ deviceBindingHash: null }, { deviceBindingHash: { $exists: false } }]
          },
          { $set: { deviceBindingHash: loginDeviceHash, deviceBindingRegisteredAt: new Date() } }
        );
        if (bindingResult?.matchedCount === 0) {
          const currentBinding = await User.findOne({ _id: user._id, role: 'driver' })
            .select('+deviceBindingHash').lean();
          if (currentBinding?.deviceBindingHash && currentBinding.deviceBindingHash !== loginDeviceHash && user.deviceBindingEnabled) {
            return res.status(403).json({
              error: 'This Driver account is locked to its registered device. Please use that device or contact Admin.'
            });
          }
        } else {
          user.deviceBindingHash = loginDeviceHash;
        }
      }
      user._loginDeviceHash = loginDeviceHash;
    }
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
    await User.updateOne({ _id: user._id }, {
      activeSessionToken: sessionToken,
      activeSessionDeviceHash: user._loginDeviceHash || null
    });
    io.in(`user:${user._id}`).disconnectSockets(true);

    const token = jwt.sign(
       { id: user._id, email: user.email || '', role: user.role, name: user.name, accountStatus: user.accountStatus },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
      token,
      sessionToken,
      user: { id: user._id, name: user.name, email: user.email || '', phone: user.phone,
               role: user.role, accountStatus: user.accountStatus, identityVerificationStatus: user.identityVerificationStatus,
              isStudent: user.isStudent, studentVerificationStatus: user.studentVerificationStatus,
              profilePhoto: user.profilePhoto || '',
               vehicleType: user.vehicleType,
               ridePreference: user.ridePreference || 'Both',
              vehicleModel: user.vehicleModel, vehiclePlate: user.vehiclePlate, rating: user.rating,
              lastDailyFeePaidAt: user.lastDailyFeePaidAt || null,
               dailyFeeAmount: await getDailyFeeForVehicle(user.vehicleType),
              paidUntilDate:  user.paidUntilDate  || null,
               dailyFeeRate:   await getDailyFeeForVehicle(user.vehicleType),
               onlineStartedAt: user.onlineStartedAt || null,
                onlineTimeDate: user.onlineTimeDate || '',
                onlineTimeTodaySeconds: user.onlineTimeTodaySeconds || 0,
               nextFeeDeductionAt: user.paidUntilDate || null,
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

// ── Forgot Password (Email OTP) ────────────────────────────────────────────

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ error: 'Enter your registered email address' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Enter a valid email address' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Wrong email' });
    if (!emailOtpConfigured()) return res.status(503).json({ error: 'Email OTP service is not configured' });
    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = await bcrypt.hash(otp, 10);
    await emailSender.sendMail({
      from: currentEmailFrom(),
      to: email,
      subject: 'My Ride password reset code',
      text: `Your My Ride password reset code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your My Ride password reset code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`
    });
    await User.updateOne({ _id: user._id }, {
      otpCode: otpHash,
      otpExpiry: new Date(Date.now() + 10 * 60 * 1000)
    });
    return res.json({ success: true, message: 'A verification code was sent to your email address' });
  } catch (err) {
    console.error('Customer/Driver password reset email delivery failed:', err);
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const { otp, newPassword } = req.body;
    if (!email || typeof otp !== 'string' || !otp.trim() || typeof newPassword !== 'string' || !newPassword)
      return res.status(400).json({ error: 'Email, OTP, and new password required' });
    const user = await User.findOne({ email });
    if (!user || !user.otpCode || !(await bcrypt.compare(otp.trim(), user.otpCode)))
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    if (!user.otpExpiry || user.otpExpiry < new Date())
      return res.status(400).json({ error: 'OTP has expired — request a new one' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const hash = await bcrypt.hash(newPassword, 12);
    await User.updateOne(
      { _id: user._id },
      {
        password: hash,
        otpCode: null,
        otpExpiry: null,
        activeSessionToken: crypto.randomBytes(32).toString('hex')
      }
    );
    io.in(`user:${user._id}`).disconnectSockets(true);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
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
app.post('/api/fare/calculate', optionalCustomerAuth, async (req, res) => {
  try {
    const requestedAt = new Date();
    const [settingsDoc, ratesDoc, longRangeDoc, vehicleCategoryDoc, waitingRateDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: WAITING_RATE_SETTINGS_KEY }).lean()
    ]);
    const vehicleType = normalizeFareVehicle(req.body?.vehicleType);
    if (!isVehicleCategoryActive(vehicleCategoryDoc?.value, vehicleType)) {
      return res.status(422).json({ error: 'This vehicle category is currently unavailable' });
    }
    const result = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      normalizeLongRangeSettings(longRangeDoc?.value),
      vehicleType,
      req.body?.distanceKm,
      new Date(),
      normalizePerKmRates(ratesDoc?.value),
      req.body?.durationMinutes,
      normalizeWaitingRateSettings(waitingRateDoc?.value),
      req.body?.waitingSeconds
    );
    if (result.error) return res.status(422).json({ error: result.error });
    const discountPercent = await getVerifiedStudentDiscountPercent(req.user?.id, requestedAt);
    res.json(applyStudentDiscountToFareQuote(result, discountPercent));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fare-settings', async (req, res) => {
  try {
    const settingsDoc = await Settings.findOne({ key: 'daily_fare_settings' }).lean();
    res.json(normalizeFareSettings(settingsDoc?.value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customer/vehicle-config', async (req, res) => {
  try {
    const [vehicleCategorySettings, fareDoc, ratesDoc] = await Promise.all([
      getVehicleCategorySettings(),
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean()
    ]);
    const fareSettings = normalizeFareSettings(fareDoc?.value);
    const perKmRates = normalizePerKmRates(ratesDoc?.value);
    res.json({
      categories: FARE_VEHICLE_CATEGORIES.map(category => ({
        category,
        active: vehicleCategorySettings[category].active,
        baseFare: fareSettings[category].baseFare,
        perKmRate: perKmRates[category],
        perMinuteRate: fareSettings[category].perMinuteRate
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ride Routes
// ─────────────────────────────────────────────────────────────────────────────

function parseAdvanceBookingDate(value, now = new Date()) {
  const scheduledFor = new Date(value);
  if (!value || Number.isNaN(scheduledFor.getTime())) {
    return { error: 'Choose a valid future date and time.' };
  }
  if (scheduledFor.getTime() < now.getTime() + ADVANCE_BOOKING_MIN_LEAD_MS) {
    return { error: 'Advance bookings must be at least 20 minutes in the future.' };
  }
  if (scheduledFor.getTime() > now.getTime() + ADVANCE_BOOKING_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return { error: `Advance bookings can be made up to ${ADVANCE_BOOKING_MAX_DAYS} days ahead.` };
  }
  return { value: scheduledFor };
}

function advanceBookingCancellationCutoff(now = new Date()) {
  return new Date(now.getTime() + ADVANCE_BOOKING_CANCELLATION_CUTOFF_MS);
}

function canCancelAdvanceBooking(booking, now = new Date()) {
  const scheduledFor = new Date(booking?.scheduledFor);
  return Number.isFinite(scheduledFor.getTime())
    && scheduledFor.getTime() - now.getTime() >= ADVANCE_BOOKING_CANCELLATION_CUTOFF_MS;
}

function advanceBookingResponse(booking) {
  const payload = typeof booking?.toObject === 'function' ? booking.toObject() : { ...booking };
  delete payload.__v;
  payload.passengerCount = Math.min(8, Math.max(1, Math.trunc(Number(payload.passengerCount) || 1)));
  return payload;
}

function advanceBookingDriverResponse(booking, driverId) {
  const payload = advanceBookingResponse(booking);
  const ownOffer = (payload.counterOffers || []).find(
    offer => String(offer?.driver?._id || offer?.driver || '') === String(driverId)
  );
  return {
    ...payload,
    myOffer: ownOffer || null
  };
}

async function broadcastAdvanceBooking(booking) {
  const [rideBroadcastSettings, vehicleCategoryDoc, longRangeSettings, customer] = await Promise.all([
    getRideBroadcastSettings(),
    Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean(),
    getLongRangeSettings(),
    User.findById(booking.passenger).select('name').lean()
  ]);
  const scheduledDrivers = await findAdvanceBookingBroadcastDrivers(
    booking.vehicleType,
    { excludeDriverIds: booking.declinedDriverIds || [] }
  );
  const broadcast = {
    drivers: scheduledDrivers,
    radiusKm: booking.isLongRange
      ? longRangeSettings.broadcastRadiusKm
      : rideBroadcastSettings.maximumRideBroadcastRadiusKm
  };

  booking.notifiedDriverIds = broadcast.drivers.map(driver => driver._id);
  booking.broadcastLastAttemptAt = new Date();
  await booking.save();
  if (!broadcast.drivers.length) {
    console.warn(
      `[advance-booking] no eligible online Drivers for ${booking._id} ` +
      `(vehicle=${booking.vehicleType}, longRange=${!!booking.isLongRange})`
    );
  } else {
    console.log(
      `[advance-booking] broadcasting ${booking._id} to ` +
      `${broadcast.drivers.length} online Driver(s)`
    );
  }

  const payload = advanceBookingResponse(booking);
  payload.id = String(booking._id);
  payload.advanceBookingId = String(booking._id);
  payload.passenger = {
    id: String(booking.passenger),
    name: customer?.name || 'Customer'
  };
  payload.broadcastRadiusKm = broadcast.radiusKm;
  payload.broadcastExpiresAt = booking.broadcastExpiresAt || booking.scheduledFor;
  const scheduledTime = formatAdvanceBookingReminderTime(booking.scheduledFor);
  const pickup = booking.pickupLocation?.address || 'Nearby pickup';
  const dropoff = booking.dropoffLocation?.address || 'Drop-off';
  const body = `${pickup} → ${dropoff} · ${scheduledTime} · ${booking.passengerCount || 1} passenger${booking.passengerCount === 1 ? '' : 's'} · Rs ${(booking.fare || 0).toLocaleString()}`;

  for (const driver of broadcast.drivers) {
    io.to(`user:${String(driver._id)}`).emit('advance-booking:new', payload);
  }

  if (global._vapidPublicKey && broadcast.drivers.length) {
    void PushSub.find({ user: { $in: broadcast.drivers.map(driver => driver._id) } }).lean()
      .then(subscriptions => Promise.all(subscriptions.map(subscription =>
        webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify({
            type: 'advance-booking:new',
            title: 'Scheduled ride request',
            body,
            url: '/driver',
            bookingId: String(booking._id),
            advanceBookingId: String(booking._id),
            booking: payload
          }),
          { urgency: 'high', TTL: 120 }
        ).catch(error => {
          if (error.statusCode === 410) return PushSub.deleteOne({ _id: subscription._id }).catch(() => {});
          console.warn(`[web-push] advance booking alert failed: ${error.message}`);
          return undefined;
        })
      )))
      .catch(error => console.warn(`[web-push] advance booking lookup failed: ${error.message}`));
  }

  if (broadcast.drivers.length) {
    void sendExpoPush(broadcast.drivers.map(driver => driver.expoPushToken), {
      title: 'Scheduled ride request',
      body,
      data: {
        type: 'advance-booking:new',
        bookingId: String(booking._id),
        advanceBookingId: String(booking._id),
        booking: payload
      },
      categoryId: 'ride-request',
      interruptionLevel: 'timeSensitive',
      ttl: 120
    });
  }
  return { booking, drivers: broadcast.drivers, radiusKm: broadcast.radiusKm };
}

function emitAdvanceBookingAssignment(booking, payload) {
  const driverIds = new Set([
    ...(booking.notifiedDriverIds || []).map(id => String(id)),
    booking.driver ? String(booking.driver?._id || booking.driver) : ''
  ].filter(Boolean));
  for (const driverId of driverIds) {
    io.to(`user:${driverId}`).emit('advance-booking:assigned', payload);
  }
}

async function runAdvanceBookingBroadcastRecovery() {
  if (!(dbConnected || mongoose.connection.readyState === 1)) return;
  const retryBefore = new Date(Date.now() - 30_000);
  for (let attempt = 0; attempt < 25; attempt++) {
    const booking = await AdvanceBooking.findOneAndUpdate(
      {
        status: 'pending',
        scheduledFor: { $gt: new Date() },
        $and: [
          {
            $or: [
              { notifiedDriverIds: { $exists: false } },
              { notifiedDriverIds: { $size: 0 } }
            ]
          },
          {
            $or: [
              { broadcastLastAttemptAt: null },
              { broadcastLastAttemptAt: { $lte: retryBefore } }
            ]
          }
        ]
      },
      { $set: { broadcastLastAttemptAt: new Date() } },
      { new: true, sort: { scheduledFor: 1, createdAt: 1 } }
    );
    if (!booking) break;
    try {
      await broadcastAdvanceBooking(booking);
    } catch (error) {
      console.warn(`[advance-booking] broadcast recovery failed for ${booking._id}: ${error.message}`);
    }
  }
}

function formatAdvanceBookingReminderTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'the scheduled time';
  return date.toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

async function sendAdvanceBookingReminder(bookingId, { force = false, notifyCustomer = true } = {}) {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - ADVANCE_BOOKING_REMINDER_LOCK_MS);
  const claimFilter = {
    _id: bookingId,
    status: 'assigned',
    driver: { $ne: null },
    scheduledFor: { $gt: now },
    $or: [
      { reminderInFlightAt: null },
      { reminderInFlightAt: { $exists: false } },
      { reminderInFlightAt: { $lt: staleLockBefore } }
    ]
  };
  if (!force) {
    claimFilter.$and = [
      { $or: [{ reminderSentAt: null }, { reminderSentAt: { $exists: false } }] }
    ];
  }
  const booking = await AdvanceBooking.findOneAndUpdate(
    claimFilter,
    { $set: { reminderInFlightAt: now } },
    { new: true }
  );
  if (!booking) {
    const current = await AdvanceBooking.findById(bookingId).select('status driver reminderSentAt').lean();
    if (current?.reminderSentAt && !force) return { alreadySent: true, sent: 0, failed: 0 };
    if (!current) throw new Error('Advance booking not found');
    if (current.status !== 'assigned' || !current.driver) {
      throw new Error('A reminder can only be sent after a Driver is assigned.');
    }
    throw new Error('A reminder is already being sent. Please try again shortly.');
  }

  try {
    const [driver, customer] = await Promise.all([
      User.findById(booking.driver).select('name phone expoPushToken').lean(),
      notifyCustomer
        ? User.findById(booking.passenger).select('name phone expoPushToken').lean()
        : null
    ]);
    if (!driver) throw new Error('The assigned Driver account could not be found.');

    const pickup = booking.pickupLocation?.address || 'the pickup location';
    const scheduledTime = formatAdvanceBookingReminderTime(booking.scheduledFor);
    const reminderPayload = {
      type: 'advance-booking:reminder',
      bookingId: String(booking._id),
      scheduledFor: booking.scheduledFor,
      pickupLocation: booking.pickupLocation,
      dropoffLocation: booking.dropoffLocation,
      passengerCount: booking.passengerCount || 1,
      message: `Reminder: scheduled ride at ${scheduledTime} from ${pickup}.`
    };
    io.to(`user:${booking.driver}`).emit('advance-booking:reminder', reminderPayload);
    const driverPush = await sendExpoPush([driver.expoPushToken], {
      title: 'Scheduled ride reminder',
      body: reminderPayload.message,
      data: reminderPayload,
      categoryId: 'ride-request',
      interruptionLevel: 'timeSensitive',
      ttl: 120
    });

    let customerPush = { sent: 0, failed: 0 };
    if (notifyCustomer && customer) {
      io.to(`user:${booking.passenger}`).emit('advance-booking:reminder', reminderPayload);
      customerPush = await sendExpoPush([customer.expoPushToken], {
        title: 'Scheduled ride reminder',
        body: reminderPayload.message,
        data: reminderPayload,
        ttl: 120
      });
    }

    await AdvanceBooking.updateOne(
      { _id: booking._id, reminderInFlightAt: now },
      {
        $set: {
          reminderSentAt: booking.reminderSentAt || now,
          reminderLastSentAt: now,
          reminderInFlightAt: null,
          reminderLastError: ''
        },
        $inc: { reminderCount: 1 }
      }
    );
    return {
      alreadySent: false,
      sent: driverPush.sent + customerPush.sent,
      failed: driverPush.failed + customerPush.failed,
      driverNotified: true,
      customerNotified: !!customer
    };
  } catch (error) {
    await AdvanceBooking.updateOne(
      { _id: booking._id, reminderInFlightAt: now },
      { $set: { reminderInFlightAt: null, reminderLastError: 'Reminder delivery failed' } }
    ).catch(() => {});
    throw error;
  }
}

async function runAdvanceBookingReminderSweep() {
  if (!(dbConnected || mongoose.connection.readyState === 1)) return;
  const now = new Date();
  const reminderWindowEnd = new Date(now.getTime() + ADVANCE_BOOKING_REMINDER_LEAD_MS);
  const bookings = await AdvanceBooking.find({
    status: 'assigned',
    driver: { $ne: null },
    scheduledFor: { $gt: now, $lte: reminderWindowEnd },
    $or: [{ reminderSentAt: null }, { reminderSentAt: { $exists: false } }]
  }).select('_id').sort({ scheduledFor: 1 }).limit(100).lean();
  for (const booking of bookings) {
    try {
      await sendAdvanceBookingReminder(booking._id);
    } catch (error) {
      console.warn(`[advance-booking] reminder failed for ${booking._id}: ${error.message}`);
    }
  }
}

function adminAdvanceBookingResponse(booking, customer, driver, ride = null) {
  const payload = advanceBookingResponse(booking);
  return {
    ...payload,
    status: booking.status === 'converted' && ride?.status ? ride.status : payload.status,
    reservationStatus: payload.status,
    rideStatus: ride?.status || null,
    passengerCount: Math.min(8, Math.max(1, Math.trunc(Number(payload.passengerCount) || 1))),
    customer: customer ? {
      id: String(customer._id),
      name: customer.name || '',
      phone: customer.phone || '',
      email: customer.email || ''
    } : null,
    driver: driver ? {
      id: String(driver._id),
      name: driver.name || '',
      phone: driver.phone || '',
      vehicleType: driver.vehicleType || '',
      vehicleModel: driver.vehicleModel || '',
      vehiclePlate: driver.vehiclePlate || '',
      rating: driver.rating ?? null
    } : null
  };
}

async function dispatchAdvanceBooking(booking) {
  const existingRide = await Ride.findOne({ advanceBookingId: booking._id });
  if (existingRide) {
    await AdvanceBooking.updateOne(
      { _id: booking._id, status: 'dispatching' },
      { $set: { status: 'converted', ride: existingRide._id, dispatchedAt: existingRide.createdAt || new Date() } }
    );
    const activatedPayload = {
      bookingId: String(booking._id),
      rideId: String(existingRide._id),
      scheduledFor: booking.scheduledFor
    };
    io.to(`user:${booking.passenger}`).emit('advance-booking:converted', activatedPayload);
    if (booking.driver) io.to(`user:${booking.driver}`).emit('advance-booking:converted', activatedPayload);
    io.to('admin-room').emit('advance-booking:converted', activatedPayload);
    return existingRide;
  }
  const [rideBroadcastSettings, vehicleCategoryDoc, longRangeSettings] = await Promise.all([
    getRideBroadcastSettings(),
    Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean(),
    getLongRangeSettings()
  ]);
  const scheduledFor = new Date(booking.scheduledFor);
  const broadcastExpiresAt = new Date(
    Math.max(Date.now() + rideBroadcastSettings.broadcastRequestDurationSeconds * 1000, scheduledFor.getTime())
  );
  const assignedDriverId = booking.driver || null;
  const verificationPin = assignedDriverId ? String(Math.floor(1000 + Math.random() * 9000)) : null;
  const ride = await Ride.create({
    passenger: booking.passenger,
    driver: assignedDriverId,
    pickupLocation: booking.pickupLocation,
    dropoffLocation: booking.dropoffLocation,
    dropoffLocations: booking.dropoffLocations,
    passengerCount: booking.passengerCount || 1,
    fare: booking.fare,
    customerFareOffset: booking.customerFareOffset || 0,
    fareQuote: booking.fareQuote,
    isLongRange: !!booking.isLongRange,
    isStudentRide: !!booking.isStudentRide,
    distance: booking.distance || 0,
    durationMinutes: booking.durationMinutes || 0,
    vehicleType: booking.vehicleType,
    notes: booking.notes || '',
    paymentMethod: booking.paymentMethod || 'cash',
    mobileAccount: booking.mobileAccount || '',
    status: assignedDriverId ? 'accepted' : 'requested',
    isAdvanceBooking: true,
    scheduledTime: booking.scheduledFor,
    verificationPin,
    advanceBookingId: booking._id,
    scheduledFor: booking.scheduledFor,
    broadcastDurationSeconds: assignedDriverId ? null : rideBroadcastSettings.broadcastRequestDurationSeconds,
    broadcastExpiresAt: assignedDriverId ? null : broadcastExpiresAt
  });

  if (assignedDriverId) {
    const driver = await User.findById(assignedDriverId)
      .select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto')
      .lean();
    emitRideAccepted(ride, verificationPin, {
      id: String(assignedDriverId),
      name: driver?.name || '',
      phone: driver?.phone || '',
      vehicleType: driver?.vehicleType || ride.vehicleType,
      vehicleModel: driver?.vehicleModel || '',
      vehiclePlate: driver?.vehiclePlate || '',
      rating: driver?.rating || 5,
      profilePhoto: driver?.profilePhoto || ''
    });
    io.to(`user:${assignedDriverId}`).emit('advance-booking:assigned', {
      bookingId: String(booking._id),
      rideId: String(ride._id),
      scheduledFor: booking.scheduledFor
    });
  } else {
    const broadcast = booking.isLongRange
      ? await findLongRangeBroadcastDrivers(
        booking.pickupLocation,
        booking.vehicleType,
        longRangeSettings,
        vehicleCategoryDoc?.value,
        { isStudentRide: booking.isStudentRide }
      )
      : await findRideBroadcastDrivers(
        booking.pickupLocation,
        booking.vehicleType,
        rideBroadcastSettings,
        vehicleCategoryDoc?.value,
        { isStudentRide: booking.isStudentRide }
      );
    ride.notifiedDriverIds = broadcast.drivers.map(driver => driver._id);
    await ride.save();
    emitRideRequestToDrivers(broadcast.drivers, {
      ...driverRidePayload(ride),
      scheduledFor: booking.scheduledFor,
      advanceBookingId: String(booking._id)
    });
    if (broadcast.drivers.length) {
      void sendExpoPush(broadcast.drivers.map(driver => driver.expoPushToken), {
        title: 'Advance ride request',
        body: `${booking.pickupLocation?.address || 'Future pickup'} · Rs ${(booking.fare || 0).toLocaleString()}`,
        data: {
          type: 'ride:new',
          rideId: String(ride._id),
          advanceBookingId: String(booking._id),
          ride: { ...driverRidePayload(ride), scheduledFor: booking.scheduledFor, advanceBookingId: String(booking._id) }
        },
        categoryId: 'ride-request',
        interruptionLevel: 'timeSensitive',
        ttl: Math.max(1, Math.ceil((new Date(ride.broadcastExpiresAt).getTime() - Date.now()) / 1000))
      });
    }
  }
  await AdvanceBooking.updateOne(
    { _id: booking._id, status: 'dispatching' },
    { $set: { status: 'converted', ride: ride._id, dispatchedAt: new Date() } }
  );
  const activatedPayload = {
    bookingId: String(booking._id),
    rideId: String(ride._id),
    scheduledFor: booking.scheduledFor
  };
  io.to(`user:${booking.passenger}`).emit('advance-booking:converted', activatedPayload);
  if (assignedDriverId) io.to(`user:${assignedDriverId}`).emit('advance-booking:converted', activatedPayload);
  io.to('admin-room').emit('advance-booking:converted', activatedPayload);
  return ride;
}

async function runAdvanceBookingDispatcher() {
  // Advance bookings are intentionally not activated by a timer. They remain
  // assigned in the dedicated scheduled-rides section until the assigned
  // Driver explicitly presses Start Ride at or after scheduledFor.
  return { processed: 0, automaticActivationDisabled: true };
}

app.post('/api/advance-bookings', authMiddleware, customerOnly, customerCanBook, async (req, res) => {
  try {
    const schedule = parseAdvanceBookingDate(req.body?.scheduledFor);
    if (schedule.error) return res.status(422).json({ error: schedule.error });
    const { pickupLocation, dropoffLocation, dropoffLocations, distance, vehicleType, notes, paymentMethod, mobileAccount, customerOffer, customerFareOffset } = req.body;
    const passengerCount = Math.min(8, Math.max(1, Math.trunc(Number(req.body?.passengerCount) || 1)));
    if (!pickupLocation) return res.status(400).json({ error: 'Pickup is required' });
    const stops = Array.isArray(dropoffLocations) && dropoffLocations.length
      ? dropoffLocations
      : (dropoffLocation ? [dropoffLocation] : []);
    if (!stops.length) return res.status(400).json({ error: 'At least one dropoff stop is required' });
    if (!hasValidCoordinates(pickupLocation) || stops.some(stop => !hasValidCoordinates(stop))) {
      return res.status(422).json({ error: 'Invalid coordinates', code: 'INVALID_COORDINATES' });
    }
    const [settingsDoc, ratesDoc, longRangeDoc, vehicleCategoryDoc, waitingRateDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: WAITING_RATE_SETTINGS_KEY }).lean()
    ]);
    const normalizedVehicleType = normalizeFareVehicle(vehicleType);
    if (!isVehicleCategoryActive(vehicleCategoryDoc?.value, normalizedVehicleType)) {
      return res.status(422).json({ error: 'This vehicle category is currently unavailable' });
    }
    const fareQuote = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      normalizeLongRangeSettings(longRangeDoc?.value),
      normalizedVehicleType,
      distance,
      schedule.value,
      normalizePerKmRates(ratesDoc?.value),
      req.body?.durationMinutes,
      normalizeWaitingRateSettings(waitingRateDoc?.value)
    );
    if (fareQuote.error) return res.status(422).json({ error: fareQuote.error });
    const discountPercent = await getVerifiedStudentDiscountPercent(req.user.id, schedule.value);
    const discountedFareQuote = applyStudentDiscountToFareQuote(fareQuote, discountPercent);
    const offerResult = resolveCustomerFareOffer(customerOffer, discountedFareQuote.totalFare, customerFareOffset);
    if (offerResult.error) return res.status(422).json({ error: offerResult.error });
    const [precisePickupLocation, preciseStops, studentProfile, studentDiscountSettings] = await Promise.all([
      resolveRideLocationAddress(pickupLocation),
      Promise.all(stops.map(stop => resolveRideLocationAddress(stop))),
      User.findById(req.user.id).select('isStudent studentVerificationStatus').lean(),
      getStudentDiscountSettings()
    ]);
    const booking = await AdvanceBooking.create({
      passenger: req.user.id,
      pickupLocation: precisePickupLocation,
      dropoffLocation: preciseStops[0],
      dropoffLocations: preciseStops,
      passengerCount,
      scheduledFor: schedule.value,
      broadcastExpiresAt: schedule.value,
      fare: offerResult.value,
      customerFareOffset: offerResult.offset,
      fareQuote: discountedFareQuote,
      distance: discountedFareQuote.distanceKm,
      durationMinutes: discountedFareQuote.durationMinutes || 0,
      vehicleType: discountedFareQuote.vehicleType,
      paymentMethod: paymentMethod || 'cash',
      mobileAccount: mobileAccount || '',
      notes: notes || '',
      isLongRange: !!discountedFareQuote.isLongRange,
      isStudentRide: studentDiscountSettings.enabled
        && studentProfile?.isStudent === true
        && studentProfile?.studentVerificationStatus === 'approved'
    });
    await broadcastAdvanceBooking(booking);
    res.status(201).json(advanceBookingResponse(booking));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/advance-bookings/my', authMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    const query = req.user.role === 'driver'
      ? { driver: req.user.id }
      : { passenger: req.user.id };
    const bookings = await AdvanceBooking.find(query)
      .populate('passenger driver', 'name phone vehicleType vehicleModel vehiclePlate rating')
      .sort({ scheduledFor: 1, createdAt: -1 })
      .limit(50);
    res.json(bookings.map(advanceBookingResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/advance-bookings/available', authMiddleware, driverOnly, async (req, res) => {
  try {
    const driver = await User.findById(req.user.id).select('vehicleType accountStatus ridePreference longRangeEnabled paidUntilDate lastDailyFeePaidAt').lean();
    if (!driver || driver.accountStatus !== 'active') return res.status(403).json({ error: 'Approved Driver access is required' });
    const fee = await getDriverDailyFeeEligibility(driver);
    const bookings = await AdvanceBooking.find({
      $or: [
        {
          status: 'pending',
          notifiedDriverIds: req.user.id,
          declinedDriverIds: { $ne: req.user.id },
          vehicleType: { $in: storedVehicleTypesForFareCategory(driver.vehicleType) },
          scheduledFor: { $gt: new Date() }
        },
        {
          driver: req.user.id,
          status: 'assigned'
        }
      ]
    }).populate('passenger', 'name phone').sort({ scheduledFor: 1 }).limit(50);
    res.json(bookings.map(booking => ({
        ...advanceBookingDriverResponse(booking, req.user.id),
        acceptanceEligibility: { allowed: fee.allowed, reason: fee.reason, dailyFeeDue: !fee.allowed, dailyFeeRate: fee.rate }
      })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/advance-bookings/:id/accept', authMiddleware, driverOnly, async (req, res) => {
  try {
    const driver = await User.findById(req.user.id).select('name phone vehicleType vehicleModel vehiclePlate rating accountStatus ridePreference longRangeEnabled paidUntilDate lastDailyFeePaidAt isOnline').lean();
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) return res.status(403).json({ error: 'Only active online Drivers can submit advance-booking offers' });
    const fee = await getDriverDailyFeeEligibility(driver);
    if (!fee.allowed) return res.status(403).json({ error: fee.reason, code: 'DAILY_FEE_REQUIRED' });
    const booking = await AdvanceBooking.findOne({
      _id: req.params.id,
      status: 'pending',
      notifiedDriverIds: req.user.id,
      declinedDriverIds: { $ne: req.user.id },
      vehicleType: { $in: storedVehicleTypesForFareCategory(driver.vehicleType) },
      scheduledFor: { $gt: new Date() }
    });
    if (!booking) return res.status(409).json({ error: 'Advance booking is no longer available' });
    const overlap = await AdvanceBooking.exists({
      driver: req.user.id,
      status: 'assigned',
      scheduledFor: {
        $gte: new Date(booking.scheduledFor.getTime() - 90 * 60 * 1000),
        $lte: new Date(booking.scheduledFor.getTime() + 90 * 60 * 1000)
      }
    });
    if (overlap) return res.status(409).json({ error: 'You already have an advance booking near this time.' });

    const existingOffer = booking.counterOffers.find(
      offer => String(offer.driver) === String(req.user.id)
    );
    const acceptOffer = {
      driver: req.user.id,
      driverName: driver.name,
      vehicleModel: driver.vehicleModel || '',
      vehiclePlate: driver.vehiclePlate || '',
      rating: driver.rating || 5,
      price: booking.fare,
      type: 'accept'
    };
    const assignmentUpdate = {
      $set: {
        driver: req.user.id,
        status: 'assigned',
        assignedAt: new Date(),
        fare: existingOffer?.type === 'counter' && Number(existingOffer.price) > 0
          ? Number(existingOffer.price)
          : booking.fare
      }
    };
    if (!existingOffer) assignmentUpdate.$push = { counterOffers: acceptOffer };

    const assignedBooking = await AdvanceBooking.findOneAndUpdate(
      {
        _id: booking._id,
        status: 'pending',
        driver: null,
        notifiedDriverIds: req.user.id,
        scheduledFor: { $gt: new Date() }
      },
      assignmentUpdate,
      { new: true }
    )
      .populate('passenger', 'name phone')
      .populate('driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    if (!assignedBooking) {
      return res.status(409).json({ error: 'Advance booking was already assigned to another Driver' });
    }

    const response = advanceBookingResponse(assignedBooking);
    emitAdvanceBookingAssignment(assignedBooking, response);
    io.to(`user:${assignedBooking.passenger?._id || booking.passenger}`).emit('advance-booking:assigned', response);
    io.to('admin-room').emit('advance-booking:assigned', response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/advance-bookings/:id/start', authMiddleware, driverOnly, async (req, res) => {
  try {
    const now = new Date();
    const staleDispatchBefore = new Date(now.getTime() - 5 * 60 * 1000);
    const current = await AdvanceBooking.findOne({
      _id: req.params.id,
      driver: req.user.id
    });
    if (!current) return res.status(404).json({ error: 'Assigned advance booking not found' });

    if (current.status === 'converted' && current.ride) {
      const ride = await Ride.findById(current.ride);
      if (!ride) return res.status(409).json({ error: 'The activated ride could not be recovered' });
      return res.json({
        booking: advanceBookingResponse(current),
        ride: await rideResponseForUserWithContact(ride, 'driver')
      });
    }

    if (!['assigned', 'dispatching'].includes(current.status)) {
      return res.status(409).json({ error: 'This advance booking is not ready to start' });
    }
    if (new Date(current.scheduledFor).getTime() > now.getTime()) {
      return res.status(409).json({
        error: `This scheduled ride can start at ${formatAdvanceBookingReminderTime(current.scheduledFor)}.`,
        code: 'ADVANCE_BOOKING_NOT_DUE',
        scheduledFor: current.scheduledFor
      });
    }

    const claimFilter = current.status === 'assigned'
      ? { _id: current._id, driver: req.user.id, status: 'assigned' }
      : {
        _id: current._id,
        driver: req.user.id,
        status: 'dispatching',
        dispatchingAt: { $lte: staleDispatchBefore }
      };
    const claimedBooking = await AdvanceBooking.findOneAndUpdate(
      claimFilter,
      { $set: { status: 'dispatching', dispatchingAt: now } },
      { new: true }
    );
    if (!claimedBooking) {
      return res.status(409).json({ error: 'Ride activation is already in progress. Refresh your Advance Rides tab.' });
    }

    let ride;
    try {
      ride = await dispatchAdvanceBooking(claimedBooking);
    } catch (error) {
      await AdvanceBooking.updateOne(
        { _id: claimedBooking._id, status: 'dispatching', ride: null },
        { $set: { status: 'assigned', dispatchingAt: null, failureReason: 'Activation failed; try again.' } }
      ).catch(() => {});
      throw error;
    }

    const activatedBooking = await AdvanceBooking.findById(claimedBooking._id)
      .populate('passenger driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    res.json({
      booking: advanceBookingResponse(activatedBooking || claimedBooking),
      ride: await rideResponseForUserWithContact(ride, 'driver')
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.patch('/api/advance-bookings/:id/counter', authMiddleware, driverOnly, async (req, res) => {
  try {
    const price = Number(req.body?.price);
    if (!Number.isFinite(price) || price < 1 || price > 1000000) return res.status(400).json({ error: 'Valid price required' });
    const booking = await AdvanceBooking.findOne({
      _id: req.params.id,
      status: 'pending',
      notifiedDriverIds: req.user.id,
      declinedDriverIds: { $ne: req.user.id },
      scheduledFor: { $gt: new Date() }
    });
    if (!booking) return res.status(404).json({ error: 'Advance booking is no longer available' });
    const driver = await User.findById(req.user.id).select('name vehicleType vehicleModel vehiclePlate rating accountStatus isOnline').lean();
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline || !storedVehicleTypesForFareCategory(booking.vehicleType).includes(driver.vehicleType)) {
      return res.status(403).json({ error: 'This booking is not available for your vehicle category' });
    }
    if (booking.counterOffers.some(offer => String(offer.driver) === String(req.user.id))) {
      return res.json({ ...advanceBookingDriverResponse(booking, req.user.id), ok: true, alreadySent: true });
    }
    booking.counterOffers.push({
      driver: req.user.id, driverName: driver.name, vehicleModel: driver.vehicleModel || '',
      vehiclePlate: driver.vehiclePlate || '', rating: driver.rating || 5, price, type: 'counter'
    });
    await booking.save();
    const response = advanceBookingDriverResponse(booking, req.user.id);
    io.to(`user:${booking.passenger}`).emit('advance-booking:offer', response);
    io.to(`user:${req.user.id}`).emit('advance-booking:offer-submitted', response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/advance-bookings/:id/decline', authMiddleware, driverOnly, async (req, res) => {
  try {
    const booking = await AdvanceBooking.findOneAndUpdate(
      {
        _id: req.params.id,
        status: 'pending',
        notifiedDriverIds: req.user.id,
        declinedDriverIds: { $ne: req.user.id },
        scheduledFor: { $gt: new Date() }
      },
      {
        $addToSet: { declinedDriverIds: req.user.id },
        $pull: { counterOffers: { driver: req.user.id } }
      },
      { new: true }
    );
    if (!booking) return res.status(409).json({ error: 'Advance booking is no longer available to decline' });

    io.to(`user:${req.user.id}`).emit('advance-booking:declined', {
      bookingId: String(booking._id),
      advanceBookingId: String(booking._id),
      declined: true
    });
    res.json({ ok: true, bookingId: String(booking._id), declined: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/advance-bookings/:id/accept-driver', authMiddleware, customerOnly, customerCanBook, async (req, res) => {
  try {
    const driverId = String(req.body?.driverId || '');
    if (!mongoose.isValidObjectId(driverId)) return res.status(400).json({ error: 'Valid driverId required' });
    const booking = await AdvanceBooking.findOne({
      _id: req.params.id, passenger: req.user.id, status: 'pending',
      counterOffers: { $elemMatch: { driver: driverId, type: { $in: ['accept', 'counter'] } } }
    });
    if (!booking) return res.status(409).json({ error: 'That Driver offer is no longer available' });
    const driver = await User.findOne({ _id: driverId, role: 'driver', accountStatus: 'active' })
      .select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto ridePreference longRangeEnabled paidUntilDate lastDailyFeePaidAt isOnline')
      .lean();
    if (!driver) return res.status(409).json({ error: 'Selected Driver is no longer available' });
    const dailyFee = await getDriverDailyFeeEligibility(driver);
    if (!dailyFee.allowed) {
      return res.status(403).json({ error: dailyFee.reason, code: 'DAILY_FEE_REQUIRED', dailyFee });
    }
    const overlap = await AdvanceBooking.exists({
      driver: driverId,
      status: 'assigned',
      scheduledFor: {
        $gte: new Date(booking.scheduledFor.getTime() - 90 * 60 * 1000),
        $lte: new Date(booking.scheduledFor.getTime() + 90 * 60 * 1000)
      }
    });
    if (overlap) return res.status(409).json({ error: 'That Driver already has an advance booking near this time.' });
    const offer = booking.counterOffers.find(item => String(item.driver) === driverId);
    if (!offer) return res.status(409).json({ error: 'That Driver has not offered this booking' });
    const assignedAt = new Date();
    const assignedBooking = await AdvanceBooking.findOneAndUpdate(
      {
        _id: booking._id,
        passenger: req.user.id,
        status: 'pending',
        driver: null,
        declinedDriverIds: { $ne: driverId },
        counterOffers: { $elemMatch: { driver: driverId, type: { $in: ['accept', 'counter'] } } }
      },
      {
        $set: {
          driver: driverId,
          status: 'assigned',
          assignedAt,
          ...(offer.price ? { fare: offer.price } : {})
        }
      },
      { new: true }
    )
      .populate('passenger', 'name phone')
      .populate('driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    if (!assignedBooking) return res.status(409).json({ error: 'That Driver offer is no longer available' });
    const response = advanceBookingResponse(assignedBooking);
    emitAdvanceBookingAssignment(assignedBooking, response);
    io.to('admin-room').emit('advance-booking:assigned', response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/advance-bookings/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const isCustomer = req.user.role === 'customer';
    const isDriver = req.user.role === 'driver';
    if (!isCustomer && !isDriver) return res.status(403).json({ error: 'Only the Customer or assigned Driver can cancel this booking' });
    const now = new Date();
    const actorFilter = isCustomer
      ? { passenger: req.user.id }
      : { driver: req.user.id, status: 'assigned' };
    const booking = await AdvanceBooking.findOneAndUpdate(
      {
        _id: req.params.id,
        ...actorFilter,
        status: isCustomer ? { $in: ['pending', 'assigned'] } : 'assigned',
        scheduledFor: { $gte: advanceBookingCancellationCutoff(now) }
      },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!booking) {
      const existing = await AdvanceBooking.findOne({ _id: req.params.id, ...actorFilter }).select('scheduledFor status').lean();
      if (existing && !canCancelAdvanceBooking(existing, now)) {
        return res.status(409).json({ error: 'Advance bookings cannot be cancelled within one hour of pickup' });
      }
      return res.status(409).json({ error: 'Advance booking cannot be cancelled now' });
    }
    const response = advanceBookingResponse(booking);
    const driverIds = new Set([
      ...(booking.notifiedDriverIds || []).map(id => String(id)),
      booking.driver ? String(booking.driver) : ''
    ].filter(Boolean));
    for (const driverId of driverIds) {
      io.to(`user:${driverId}`).emit('advance-booking:cancelled', response);
    }
    io.to(`user:${booking.passenger}`).emit('advance-booking:cancelled', response);
    io.to('admin-room').emit('advance-booking:cancelled', response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides', authMiddleware, customerOnly, customerCanBook, async (req, res) => {
  try {
    const existingActiveRide = mongoose.isValidObjectId(req.user.id)
      ? await Ride.findOne({
        passenger: req.user.id,
        status: { $in: CUSTOMER_ACTIVE_RIDE_STATUSES }
      }).select('_id status').sort({ updatedAt: -1, createdAt: -1 }).lean()
      : null;
    if (existingActiveRide) {
      return res.status(409).json({
        error: 'You already have an active ride. Reopen it before booking another ride.',
        code: 'ACTIVE_RIDE_EXISTS',
        activeRideId: String(existingActiveRide._id),
        activeRideStatus: existingActiveRide.status
      });
    }
    const requestedAt = new Date();
    const { pickupLocation, dropoffLocation, dropoffLocations, distance, vehicleType, notes, paymentMethod, mobileAccount, customerOffer, customerFareOffset } = req.body;
    if (!pickupLocation) {
      return res.status(400).json({ error: 'Pickup is required' });
    }
    // Resolve stops: prefer dropoffLocations array; fall back to single dropoffLocation
    const stops = Array.isArray(dropoffLocations) && dropoffLocations.length
      ? dropoffLocations
      : (dropoffLocation ? [dropoffLocation] : []);
    if (!stops.length) return res.status(400).json({ error: 'At least one dropoff stop is required' });
    if (!hasValidCoordinates(pickupLocation) || stops.some(stop => !hasValidCoordinates(stop))) {
      return res.status(422).json({ error: 'Invalid coordinates', code: 'INVALID_COORDINATES' });
    }
    const [settingsDoc, ratesDoc, longRangeDoc, rideBroadcastDoc, vehicleCategoryDoc, waitingRateDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: 'ride_broadcast_settings' }).lean(),
      Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: WAITING_RATE_SETTINGS_KEY }).lean()
    ]);
    const normalizedVehicleType = normalizeFareVehicle(vehicleType);
    if (!isVehicleCategoryActive(vehicleCategoryDoc?.value, normalizedVehicleType)) {
      return res.status(422).json({ error: 'This vehicle category is currently unavailable' });
    }
    const longRangeSettings = normalizeLongRangeSettings(longRangeDoc?.value);
    const rideBroadcastSettings = normalizeRideBroadcastSettings(rideBroadcastDoc?.value);
    let fareQuote = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      longRangeSettings,
      normalizedVehicleType,
      distance,
      new Date(),
      normalizePerKmRates(ratesDoc?.value),
      req.body?.durationMinutes,
      normalizeWaitingRateSettings(waitingRateDoc?.value)
    );
    if (fareQuote.error) return res.status(422).json({ error: fareQuote.error });
    const [discountPercent, studentProfile, studentDiscountSettings] = await Promise.all([
      getVerifiedStudentDiscountPercent(req.user.id, requestedAt),
      User.findById(req.user.id).select('isStudent studentVerificationStatus').lean(),
      getStudentDiscountSettings()
    ]);
    const isStudentRide = studentDiscountSettings.enabled
      && studentProfile?.isStudent === true
      && studentProfile?.studentVerificationStatus === 'approved';
    const discountedFareQuote = applyStudentDiscountToFareQuote(fareQuote, discountPercent);
    const offerResult = resolveCustomerFareOffer(customerOffer, discountedFareQuote.totalFare, customerFareOffset);
    if (offerResult.error) return res.status(422).json({ error: offerResult.error });
    const precisePickupLocation = await resolveRideLocationAddress(pickupLocation);
    const preciseStops = await Promise.all(stops.map(stop => resolveRideLocationAddress(stop)));
    const broadcastExpiresAt = new Date(Date.now() + rideBroadcastSettings.broadcastRequestDurationSeconds * 1000);
    const ride = await Ride.create({
      passenger:        req.user.id,
      pickupLocation: precisePickupLocation,
      dropoffLocation:  preciseStops[0],        // primary stop
      dropoffLocations: preciseStops,
      // The quote remains the server-authoritative pricing baseline. A customer
      // may publish a bounded negotiation offer, which drivers can accept or
      // counter through the existing offer flow.
      fare:          offerResult.value,
      customerFareOffset: offerResult.offset,
      fareQuote: discountedFareQuote,
      isLongRange:       !!discountedFareQuote.isLongRange,
      distance:      discountedFareQuote.distanceKm,
      durationMinutes: discountedFareQuote.durationMinutes || 0,
      waitingMinutes: discountedFareQuote.waitingMinutes || 0,
      waitingFare: discountedFareQuote.waitingFare || 0,
      vehicleType:   discountedFareQuote.vehicleType,
      notes:         notes         || '',
      paymentMethod: paymentMethod || 'cash',
      mobileAccount: mobileAccount || '',
      isStudentRide,
      broadcastDurationSeconds: rideBroadcastSettings.broadcastRequestDurationSeconds,
      broadcastExpiresAt
    });

    const ridePayload = {
      id:               ride._id,
      pickupLocation:   ride.pickupLocation,
      dropoffLocation:  ride.dropoffLocation,
      dropoffLocations: ride.dropoffLocations,   // full multi-stop list
      passengerCount:   ride.passengerCount || 1,
      fare:             ride.fare,
      distance:         ride.distance,
      fareQuote:        ride.fareQuote,
      isLongRange:      ride.isLongRange,
      isStudentRide:    ride.isStudentRide,
      vehicleType:      ride.vehicleType,
      paymentMethod:    ride.paymentMethod,
      notes:            ride.notes,
      createdAt:        ride.createdAt,
      broadcastDurationSeconds: ride.broadcastDurationSeconds,
      broadcastExpiresAt: ride.broadcastExpiresAt
    };

    // Every delivery channel receives the exact same eligible, geo-filtered
    // driver set. This prevents a distant socket or push recipient from seeing
    // an offer that is outside the Admin-configured broadcast radius.
    // Tests may attach an in-memory Mongoose connection after importing this
    // module, so use the connection's live state alongside the startup flag.
    const databaseReady = dbConnected || mongoose.connection.readyState === 1;
    const broadcast = databaseReady
      ? (ride.isLongRange
        ? await findLongRangeBroadcastDrivers(
          ride.pickupLocation,
          ride.vehicleType,
          longRangeSettings,
          vehicleCategoryDoc?.value,
          { isStudentRide: ride.isStudentRide }
        )
        : await findRideBroadcastDrivers(
          ride.pickupLocation,
          ride.vehicleType,
          rideBroadcastSettings,
          vehicleCategoryDoc?.value,
          { isStudentRide: ride.isStudentRide }
        ))
      : { drivers: [], radiusKm: DEFAULT_RIDE_BROADCAST_RADIUS_KM };
    ridePayload.broadcastRadiusKm = broadcast.radiusKm;
    ride.notifiedDriverIds = broadcast.drivers.map(driver => driver._id);
    if (ride.isStudentRide) {
      ride.studentRideOfferRecipients = broadcast.drivers.map(driver => ({
        driver: driver._id,
        distanceFromPickupKm: driver.distanceFromPickupKm,
        notifiedAt: new Date()
      }));
    }
    await ride.save();
    emitRideRequestToDrivers(broadcast.drivers, ridePayload);
    if (ride.isStudentRide && broadcast.drivers.length) {
      void recordExpiredStudentRideResponses().catch(err =>
        console.warn(`[student-ride-log] expiry sweep failed: ${err.message}`)
      );
    }

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
        ride: ridePayload,
        broadcastDurationSeconds: ridePayload.broadcastDurationSeconds,
        broadcastExpiresAt: ridePayload.broadcastExpiresAt,
        actions: [
          { action: 'accept', title: '✅ Accept Ride' },
          { action: 'reject', title: '❌ Reject Ride' },
          { action: 'open',   title: '📱 Go to App'  }
        ]
      };
      // Push delivery is a fallback and must never hold the booking response
      // open. Socket.io has already delivered the live event above.
      void PushSub.find({
        user: { $in: broadcast.drivers.map(driver => driver._id) }
      }).lean().then(subscriptions => Promise.all(subscriptions.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(pushData),
          { urgency: 'high', TTL: 60 }
        ).catch(err => {
          // 410 Gone = subscription expired — clean it up
          if (err.statusCode === 410) return PushSub.deleteOne({ _id: sub._id }).catch(() => {});
          console.warn(`[web-push] ride alert failed: ${err.message}`);
          return undefined;
        })
      ))).catch(err => console.warn(`[web-push] subscription lookup failed: ${err.message}`));
    }

    // Native Driver installs do not rely on a browser tab or service worker.
    // Send a high-priority platform notification too, so Android/iOS can wake
    // the driver with an actionable alert while the UI is backgrounded.
    if (broadcast.drivers.length) {
      void sendExpoPush(broadcast.drivers.map(driver => driver.expoPushToken), {
        title: 'New ride request',
        body: `${ride.pickupLocation?.address || 'Nearby pickup'} · Rs ${(ride.fare || 0).toLocaleString()}`,
        data: { type: 'ride:new', ride: ridePayload, rideId: String(ride._id) },
        categoryId: 'ride-request',
        interruptionLevel: 'timeSensitive',
        ttl: Math.max(1, Math.ceil((new Date(ridePayload.broadcastExpiresAt).getTime() - Date.now()) / 1000))
      });
    }

    res.status(201).json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/available', authMiddleware, driverOnly, async (req, res) => {
  try {
    const driver = await User.findById(req.user.id).select('vehicleType ridePreference accountStatus isOnline longRangeEnabled lastOnlineHeartbeat currentLocation paidUntilDate lastDailyFeePaidAt').lean();
    const rides = await getAvailableRidesForDriver(driver);
    const hasFreshHeartbeat = driver?.lastOnlineHeartbeat &&
      new Date(driver.lastOnlineHeartbeat).getTime() >= Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS;
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline || !hasFreshHeartbeat || !hasValidCoordinates(driver.currentLocation)) {
      return res.status(403).json({ error: 'You must be an approved online driver to receive rides' });
    }
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rides/:id/student-response', authMiddleware, driverOnly, async (req, res) => {
  try {
    if (req.body?.responseType !== 'rejected') {
      return res.status(422).json({ error: 'responseType must be rejected' });
    }
    const ride = await Ride.findOne({
      _id: req.params.id,
      isStudentRide: true,
      notifiedDriverIds: req.user.id
    }).lean();
    if (!ride) return res.status(404).json({ error: 'Student ride offer not found' });
    const log = await recordStudentRideResponse(ride, req.user.id, 'rejected');
    res.json({ ok: true, logged: !!log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function onlineTimeDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function onlineTimeDayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function onlineSecondsSinceDayStart(startedAt, now) {
  const start = new Date(startedAt).getTime();
  const end = new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const dayStart = onlineTimeDayStart(now).getTime();
  return Math.max(0, Math.floor((end - Math.max(start, dayStart)) / 1000));
}

function getOnlineTimeTransition(driver, isOnline, now = new Date()) {
  const dayKey = onlineTimeDayKey(now);
  const storedSeconds = driver?.onlineTimeDate === dayKey
    ? Math.max(0, Number(driver.onlineTimeTodaySeconds) || 0)
    : 0;
  const activeStartedAt = driver?.isOnline && driver?.onlineStartedAt
    ? new Date(driver.onlineStartedAt)
    : null;

  if (isOnline) {
    return {
      onlineStartedAt: activeStartedAt || now,
      onlineTimeDate: dayKey,
      onlineTimeTodaySeconds: storedSeconds
    };
  }

  return {
    onlineStartedAt: null,
    onlineTimeDate: dayKey,
    onlineTimeTodaySeconds: storedSeconds + (
      activeStartedAt ? onlineSecondsSinceDayStart(activeStartedAt, now) : 0
    )
  };
}

// Native driver runtime endpoints. Background location tasks use REST because
// mobile operating systems may wake them without restoring the JS Socket.io app.
app.post('/api/driver/availability', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Access denied: driver accounts only' });
    }
    const isOnline = req.body?.isOnline === true;
    const driver = await User.findById(req.user.id)
      .select('accountStatus vehicleType ridePreference paidUntilDate lastDailyFeePaidAt isFreeTrial longRangeEnabled isOnline onlineStartedAt onlineTimeDate onlineTimeTodaySeconds').lean();
    if (!driver || driver.accountStatus !== 'active') {
      return res.status(403).json({ error: 'Your driver account is not approved for online availability' });
    }
    let feeResult = null;
    if (isOnline) {
      if (!isVehicleCategoryActive(await getVehicleCategorySettings(), driver.vehicleType)) {
        return res.status(403).json({ error: 'This vehicle category is currently inactive. Contact Admin before going online.' });
      }
      feeResult = await chargeDailyFeeForOnlineDriver(req.user.id, driver);
      if (!feeResult.allowed) {
        await User.updateOne(
          { _id: req.user.id },
          { isOnline: false, lastOnlineHeartbeat: null, onlineStartedAt: null }
        );
        return res.status(403).json({
          error: DAILY_FEE_UNPAID_MESSAGE,
          code: 'DAILY_FEE_REQUIRED',
          dailyFee: feeResult
        });
      }
    }
    const onlineNow = new Date();
    const onlineTime = getOnlineTimeTransition(driver, isOnline, onlineNow);
    const onlineStartedAt = onlineTime.onlineStartedAt;
    const update = isOnline
      ? { isOnline: true, lastOnlineHeartbeat: onlineNow, ...onlineTime }
      : { isOnline: false, lastOnlineHeartbeat: null, ...onlineTime };
    await User.updateOne({ _id: req.user.id }, update);
    const paidUntilDate = feeResult?.paidUntilDate || driver.paidUntilDate || null;
    res.json({
      isOnline,
      onlineStartedAt,
      paidUntilDate,
      nextFeeDeductionAt: paidUntilDate,
      onlineTimeDate: onlineTime.onlineTimeDate,
      onlineTimeTodaySeconds: onlineTime.onlineTimeTodaySeconds,
      vehicleType: normalizeFareVehicle(driver.vehicleType || 'Car Mini Non-AC'),
      ridePreference: normalizeRidePreference(driver.ridePreference),
      longRangeEnabled: !!driver.longRangeEnabled
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/driver/long-range', authMiddleware, driverOnly, async (req, res) => {
  try {
    const [driver, wallet, settings] = await Promise.all([
      User.findById(req.user.id).select('longRangeEnabled vehicleType ridePreference').lean(),
      Wallet.findOne({ user: req.user.id })
        .select('balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions')
        .lean(),
      getLongRangeSettings()
    ]);
    res.json({
      enabled: !!driver?.longRangeEnabled,
      walletBalance: getCombinedWalletBalance(wallet),
      realCashAvailable: getWalletSourceBalances(wallet).realCashAvailable,
      bonusAvailable: getWalletSourceBalances(wallet).bonusAvailable,
      vehicleType: normalizeFareVehicle(driver?.vehicleType || 'Car Mini Non-AC'),
      ridePreference: normalizeRidePreference(driver?.ridePreference),
      settings
    });
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
        Wallet.findOne({ user: req.user.id })
          .select('balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions')
          .lean()
      ]);
      const category = normalizeFareVehicle(driver?.vehicleType || 'Car Mini Non-AC');
      const minimumWalletBalance = getLongRangeMinimumWalletBalance(settings, category);
      if (!walletMeetsCombinedRequirement(wallet, minimumWalletBalance)) {
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
    void syncRedisDriverPresence(req.user.id);
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
    if (!hasValidCoordinates({ lat, lng })) {
      return res.status(422).json({ error: 'Invalid coordinates', code: 'INVALID_COORDINATES' });
    }
    const driver = await User.findById(req.user.id).select('accountStatus isOnline').lean();
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) {
      return res.status(403).json({ error: 'Driver availability is no longer active' });
    }
    const updates = { 'currentLocation.lat': lat, 'currentLocation.lng': lng, lastOnlineHeartbeat: new Date() };
    await User.updateOne({ _id: req.user.id }, updates);
    void syncRedisDriverPresence(req.user.id);
    if (rideId) {
      const ride = await Ride.findOne({
        _id: rideId,
        driver: req.user.id,
        status: { $in: ['accepted', 'arrived', 'in-progress'] }
      }).select('_id driver passenger pickupLocation status pickupReachedAt verificationPin driverLocation').lean();
      if (ride) {
        await Ride.updateOne({ _id: rideId }, { 'driverLocation.lat': lat, 'driverLocation.lng': lng });
        await releaseRidePinAtPickup(ride, { lat, lng });
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
  await User.updateOne({ _id: req.user.id }, { expoPushToken: token, expoPushTokenUpdatedAt: new Date() });
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
    res.json(rides.map(ride => rideResponseForUser(ride, req.user.role)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/active', authMiddleware, customerOnly, async (req, res) => {
  try {
    const ride = await Ride.findOne({
      passenger: req.user.id,
      status: { $in: CUSTOMER_ACTIVE_RIDE_STATUSES }
    })
      .populate('passenger driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto currentLocation')
      .sort({ updatedAt: -1, createdAt: -1 });
    res.json(ride ? await rideResponseForUserWithContact(ride, 'customer') : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/:id', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('passenger driver', 'name phone vehicleType rating currentLocation');
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    const isPassenger = String(ride.passenger?._id || ride.passenger) === String(req.user.id);
    const isDriver = String(ride.driver?._id || ride.driver) === String(req.user.id);
    if (!isPassenger && !isDriver) {
      return res.status(403).json({ error: 'You are not authorized to view this ride' });
    }
    res.json(await rideResponseForUserWithContact(ride, isPassenger ? 'customer' : 'driver'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rides/:id/accept', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can accept rides' });
    }
    // A direct API call must not let a driver claim a ride they were never
    // offered. The recipient snapshot is created before ride:new delivery and
    // is the authoritative acceptance audience for this request.
    const driverUser = await User.findOne({
      _id: req.user.id,
      accountStatus: 'active',
      isOnline: true
    }).select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto paidUntilDate lastDailyFeePaidAt ridePreference longRangeEnabled');
    if (!driverUser) {
      return res.status(403).json({ error: 'Only active online drivers can accept rides' });
    }
    const dailyFee = await getDriverDailyFeeEligibility(driverUser);
    if (!dailyFee.allowed) {
      return res.status(403).json({ error: dailyFee.reason, code: 'DAILY_FEE_REQUIRED', dailyFee });
    }
    const ride = await Ride.findOneAndUpdate(
      {
        _id: req.params.id,
        status: 'requested',
        driver: null,
        notifiedDriverIds: req.user.id,
        ...rideOfferIsStillOpenQuery()
      },
      { $set: { driver: req.user.id, status: 'accepted' } },
      { new: true }
    )
      .populate('passenger', 'name phone')
      .populate('driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');

    if (!ride) return res.status(409).json({ error: 'Ride no longer available' });
    ride.agreedFareBeforeWaiting = ride.fare;
    let longRangeSettings = null;
    if (ride.isLongRange) {
      longRangeSettings = await getLongRangeSettings();
      if (!await validateLongRangeDriverEligibility(req.user.id, longRangeSettings, ride.fare)) {
        await Ride.updateOne({ _id: ride._id, driver: req.user.id, status: 'accepted' }, { $set: { driver: null, status: 'requested' } });
        return res.status(403).json({ error: 'You are not currently eligible for Long Range rides.' });
      }
      ride.longRangeCommissionDeductionTiming = longRangeSettings.commissionDeductionTiming;
    }

    // Generate 4-digit verification PIN for ride start
    const verificationPin = String(Math.floor(1000 + Math.random() * 9000));
    ride.verificationPin = verificationPin;
    await ride.save();

    // Fetch full driver profile for the acceptance payload
    emitRideAccepted(ride, verificationPin, {
      id:           req.user.id,
      name:         driverUser.name,
      phone:        driverUser.phone || '',
      vehicleType:  driverUser.vehicleType,
      vehicleModel: driverUser.vehicleModel || '',
      vehiclePlate: driverUser.vehiclePlate || '',
      rating:       driverUser.rating || 5.0,
      profilePhoto: driverUser.profilePhoto || ''
    });

    res.json(await rideResponseForUserWithContact(ride, 'driver'));
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
    let ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    // Only the assigned driver may advance the ride status
    if (String(ride.driver) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You are not the driver for this ride' });
    }

    // A retried completion after a committed settlement is a successful
    // read-only replay. Never send it through the financial writes again.
    if (status === 'completed' && ride.status === 'completed' && ride.settlementStatus === 'settled') {
      return res.json(ride);
    }

    const allowed = STATUS_TRANSITIONS[ride.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from "${ride.status}" to "${status}"` });
    }

    // A Driver may not claim arrival while still outside the pickup gate.
    // A recent GPS fix can satisfy the gate here if the location event and
    // button press race each other.
    if (status === 'arrived' && !ride.pickupReachedAt) {
      if (!isAtRidePickup(ride, ride.driverLocation)) {
        return res.status(409).json({ error: 'PICKUP_NOT_REACHED', message: 'You must reach the pickup point before marking arrival.' });
      }
      await releaseRidePinAtPickup(ride, ride.driverLocation);
      ride = await Ride.findById(ride._id);
      if (!ride) return res.status(404).json({ error: 'Ride not found' });
    }

    // Validate verification PIN before starting the ride
    if (ride.status === 'arrived' && status === 'in-progress') {
      const { pin } = req.body;
      if (!pin) return res.status(400).json({ error: 'PIN_REQUIRED' });
      if (String(pin).trim() !== String(ride.verificationPin)) {
        return res.status(400).json({ error: 'WRONG_PIN' });
      }
    }

    if (status === 'in-progress' && ride.isLongRange) {
      const longRangeSettings = await getLongRangeSettings();
      if (getRideCommissionDeductionTiming(ride, longRangeSettings) === 'started') {
        const started = await startLongRangeRideWithCommission(
          ride._id,
          req.user.id,
          longRangeSettings
        );
        if (!started) return res.status(409).json({ error: 'Ride is no longer at the pickup point.' });
        ride = started.ride;
      }
    }

    if (status === 'completed') {
      const waitingRateSettings = await getWaitingRateSettings({ force: true });
      const longRangeSettings = ride.isLongRange ? await getLongRangeSettings() : null;
      const settlement = await completeRideFinancialSettlement(
        ride._id,
        req.user.id,
        waitingRateSettings,
        longRangeSettings
      );
      if (!settlement.ride) {
        return res.status(409).json({ error: 'Ride is no longer in progress.' });
      }
      if (settlement.alreadySettled) return res.json(settlement.ride);

      emitRideLifecycle(settlement.ride, 'ride:status', {
        status: 'completed',
        fare: settlement.ride.fare,
        fareQuote: settlement.ride.fareQuote,
        waitingMinutes: settlement.ride.waitingMinutes,
        waitingFare: settlement.ride.waitingFare
      });
      return res.json(settlement.ride);
    }
    ride.status = status;
    await ride.save();

    emitRideLifecycle(ride, 'ride:status', {
      status,
      ...(status === 'completed' ? {
        fare: ride.fare,
        fareQuote: ride.fareQuote,
        waitingMinutes: ride.waitingMinutes,
        waitingFare: ride.waitingFare
      } : {})
    });

    res.json(ride);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.patch('/api/rides/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (!['requested', 'accepted'].includes(ride.status) || ride.pickupReachedAt) {
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
    // Requested riders are usually only in their vehicle room, not the ride
    // room, so cancellation must fan out to both audiences immediately.
    const cancellationDetail = {
      status: 'cancelled',
      cancelledBy: isPassenger ? 'customer' : 'driver'
    };
    const cancellationAudience = {
      notifyVehicleDrivers: true,
      notifyDriverIds: ride.notifiedDriverIds || []
    };
    emitRideLifecycle(ride, 'ride:status', cancellationDetail, cancellationAudience);
    // Keep a dedicated event for the Driver incoming-offer surface. This is
    // emitted in addition to ride:status for backwards compatibility with
    // existing Customer and Driver ride lifecycle consumers.
    if (isPassenger) {
      emitRideLifecycle(ride, 'ride_cancelled', cancellationDetail, cancellationAudience);
    }
    res.json(await rideResponseForUserWithContact(ride, isPassenger ? 'customer' : 'driver'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emergency cancellation is deliberately separate from the normal Customer
// cancellation rules. It is an idempotent, driver-authorized terminal
// transition that also clears live location bindings while retaining the
// passenger/driver references needed for ride history and audit.
async function cancelRideForDriverEmergency(rideId, driverId) {
  if (!mongoose.isValidObjectId(rideId)) {
    const error = new Error('Invalid ride ID');
    error.statusCode = 400;
    throw error;
  }

  const ride = await Ride.findOneAndUpdate(
    {
      _id: rideId,
      driver: driverId,
      status: { $in: ['accepted', 'arrived', 'in-progress'] }
    },
    {
      $set: {
        status: 'cancelled',
        verificationPin: null
      },
      $unset: {
        pickupReachedAt: 1,
        driverLocation: 1,
        passengerLocation: 1,
        passengerLocationUpdatedAt: 1,
        waitingStartedAt: 1
      }
    },
    { new: true }
  )
    .populate('passenger', 'name phone')
    .populate('driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');

  if (!ride) {
    const existing = await Ride.findById(rideId);
    if (!existing) {
      const error = new Error('Ride not found');
      error.statusCode = 404;
      throw error;
    }
    if (String(existing.driver) !== String(driverId)) {
      const error = new Error('You are not the driver for this ride');
      error.statusCode = 403;
      throw error;
    }
    if (existing.status === 'cancelled') return existing;

    const error = new Error('Ride is no longer active');
    error.statusCode = 409;
    throw error;
  }

  const cancellationDetail = {
    status: 'cancelled',
    cancelledBy: 'driver',
    cancellationReason: 'emergency',
    emergency: true
  };
  const cancellationAudience = {
    notifyVehicleDrivers: true,
    notifyDriverIds: ride.notifiedDriverIds || []
  };

  // Emit the dedicated event first. The generic status event remains for
  // older clients, and all consumers are idempotent by ride ID.
  emitRideLifecycle(ride, 'ride_cancelled', cancellationDetail, cancellationAudience);
  emitRideLifecycle(ride, 'ride:status', cancellationDetail, cancellationAudience);
  return ride;
}

app.post('/api/rides/:id/emergency-cancel', authMiddleware, driverOnly, async (req, res) => {
  try {
    const ride = await cancelRideForDriverEmergency(req.params.id, req.user.id);
    res.json(await rideResponseForUserWithContact(ride, 'driver'));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/counter — driver submits an offer or counter-offer
app.patch('/api/rides/:id/counter', authMiddleware, driverOnly, async (req, res) => {
  try {
    const { price, type } = req.body;           // type: 'accept' | 'counter'
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 1 || numericPrice > 1000000) {
      return res.status(400).json({ error: 'Valid price required' });
    }

    const ride = await Ride.findOne({ _id: req.params.id, status: 'requested', ...rideOfferIsStillOpenQuery() });
    if (!ride) return res.status(404).json({ error: 'Ride not available' });
    if (ride.isLongRange) {
      const [driverLongRange, settings, wallet] = await Promise.all([
        User.findById(req.user.id).select('longRangeEnabled vehicleType').lean(),
        getLongRangeSettings(),
        Wallet.findOne({ user: req.user.id })
          .select('balance realCashWallet bonusWallet realCashAvailable bonusAvailable transactions')
          .lean()
      ]);
      if (!settings.enabled
        || !driverLongRange?.longRangeEnabled
        || !walletMeetsCombinedRequirement(
          wallet,
          getLongRangeMinimumWalletBalance(settings, driverLongRange.vehicleType)
        )) {
        return res.status(403).json({ error: 'You are not currently eligible for Long Range rides.' });
      }
    }

    // Prevent duplicate offers from same driver
    const already = ride.counterOffers.some(o => String(o.driver) === String(req.user.id));
    if (already) {
      // Make retries safe when a mobile network times out after MongoDB has
      // committed the first offer. Re-emitting the current list also repairs
      // a missed Customer event without creating a duplicate offer.
      emitRideOffers(ride);
      return res.json({ ok: true, alreadySent: true });
    }

    const driver = await User.findById(req.user.id).select('name vehicleModel vehiclePlate rating');
    const offer = {
      driver:       req.user.id,
      driverName:   driver.name,
      vehicleModel: driver.vehicleModel || '',
      vehiclePlate: driver.vehiclePlate || '',
      rating:       driver.rating || 5.0,
      price:        numericPrice,
      type:         type === 'counter' ? 'counter' : 'accept',
      timestamp:    new Date()
    };
    ride.counterOffers.push(offer);
    await ride.save();

    // Emit updated offers list to both the ride and passenger rooms. The
    // passenger-room path prevents a fast Driver response from being lost
    // before the Customer finishes joining the newly-created ride room.
    emitRideOffers(ride);

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
    res.json({ ride: ride ? await rideResponseForUserWithContact(ride, 'driver') : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/accept-driver — customer selects a specific driver
app.patch('/api/rides/:id/accept-driver', authMiddleware, customerOnly, customerCanBook, async (req, res) => {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(driverId)) {
      return res.status(400).json({ error: 'Invalid ride or driver ID' });
    }

    const ride = await Ride.findOneAndUpdate(
      {
        _id: req.params.id,
        passenger: req.user.id,
        status: 'requested',
        driver: null,
        ...rideOfferIsStillOpenQuery(),
        counterOffers: { $elemMatch: { driver: driverId } }
      },
      { $set: { driver: driverId, status: 'accepted' } },
      { new: true }
     )
       .populate('passenger', 'name phone')
       .populate('driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    if (!ride) return res.status(409).json({ error: 'Ride no longer available' });

    // Find the agreed price from the offer
    const offer = ride.counterOffers.find(o => String(o.driver) === String(driverId));
    if (!offer) return res.status(409).json({ error: 'That Driver has not offered this ride' });
    const selectedDriver = await User.findById(driverId)
      .select('vehicleType accountStatus isOnline paidUntilDate lastDailyFeePaidAt ridePreference longRangeEnabled')
      .lean();
    const dailyFee = await getDriverDailyFeeEligibility(selectedDriver);
    if (!dailyFee.allowed) {
      await Ride.updateOne(
        { _id: ride._id, driver: driverId, status: 'accepted' },
        { $set: { driver: null, status: 'requested', verificationPin: null } }
      );
      return res.status(403).json({ error: dailyFee.reason, code: 'DAILY_FEE_REQUIRED', dailyFee });
    }
    if (offer.price && offer.price !== ride.fare) {
      ride.fare = offer.price;
    }
    ride.agreedFareBeforeWaiting = ride.fare;
    let longRangeSettings = null;
    if (ride.isLongRange) {
      longRangeSettings = await getLongRangeSettings();
      if (!await validateLongRangeDriverEligibility(driverId, longRangeSettings, ride.fare)) {
        await Ride.updateOne({ _id: ride._id, driver: driverId, status: 'accepted' }, { $set: { driver: null, status: 'requested', verificationPin: null } });
        return res.status(403).json({ error: 'Selected Driver is no longer eligible for Long Range rides.' });
      }
      ride.longRangeCommissionDeductionTiming = longRangeSettings.commissionDeductionTiming;
    }

    // Generate 4-digit verification PIN for ride start
    const verificationPin = String(Math.floor(1000 + Math.random() * 9000));
    ride.verificationPin = verificationPin;
    await ride.save();

    const driverUser = await User.findById(driverId)
      .select('name phone role accountStatus isOnline lastOnlineHeartbeat vehicleType vehicleModel vehiclePlate rating profilePhoto');
    const driverHeartbeatIsFresh = driverUser?.lastOnlineHeartbeat &&
      new Date(driverUser.lastOnlineHeartbeat).getTime() >= Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS;
    if (!driverUser || driverUser.role !== 'driver' || driverUser.accountStatus !== 'active' ||
        !driverUser.isOnline || !driverHeartbeatIsFresh) {
      await Ride.updateOne(
        { _id: ride._id, driver: driverId, status: 'accepted' },
        { $set: { driver: null, status: 'requested', verificationPin: null } }
      );
      return res.status(409).json({ error: 'Selected Driver is no longer available' });
    }
    emitRideAccepted(ride, verificationPin, {
      id:           String(driverId),
      name:         driverUser.name,
      phone:        driverUser.phone || '',
      vehicleType:  driverUser.vehicleType,
      vehicleModel: driverUser.vehicleModel || '',
      vehiclePlate: driverUser.vehiclePlate || '',
      rating:       driverUser.rating || 5.0,
      profilePhoto: driverUser.profilePhoto || ''
    });

    res.json(await rideResponseForUserWithContact(ride, 'customer'));
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
    const [settingsDoc, ratesDoc, longRangeDoc, waitingRateDoc] = await Promise.all([
      Settings.findOne({ key: 'daily_fare_settings' }).lean(),
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: WAITING_RATE_SETTINGS_KEY }).lean()
    ]);
    let fareQuote = calculateRideFare(
      normalizeFareSettings(settingsDoc?.value),
      normalizeLongRangeSettings(longRangeDoc?.value),
      ride.vehicleType,
      ride.distance,
      new Date(),
      normalizePerKmRates(ratesDoc?.value),
      ride.durationMinutes,
      normalizeWaitingRateSettings(waitingRateDoc?.value),
      ride.waitingSeconds
    );
    if (fareQuote.error) return res.status(422).json({ error: fareQuote.error });
    fareQuote = applyStudentDiscountToFareQuote(
      fareQuote,
      Number.isFinite(Number(ride.fareQuote?.studentDiscountPercent))
        ? Number(ride.fareQuote.studentDiscountPercent)
        : await getVerifiedStudentDiscountPercent(req.user.id, ride.createdAt)
    );
    ride.fare = fareQuote.totalFare;
    ride.customerFareOffset = 0;
    ride.fareQuote = fareQuote;
    await ride.save();

    // Re-broadcast updated fare only to drivers of the same vehicle category
    io.to(`drivers:${normalizeFareVehicle(ride.vehicleType || 'Car Mini Non-AC')}`).emit('ride:fare-updated', {
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
      const category = normalizeFareVehicle(vehicleType || user.vehicleType || 'Car Mini Non-AC');
      if (!model || !plate || !vehicleRegPhoto) {
        return res.status(400).json({ error: 'Vehicle model, number plate, and a new vehicle registration or ownership document are required' });
      }
      if (!FARE_VEHICLE_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'A valid vehicle category is required' });
      }
      // A vehicle document must be a freshly supplied image. Validate before
      // writing the file or changing any persisted driver state.
      parseImageDataUrl(vehicleRegPhoto);
      const replacementDocument = await savePrivateDriverDocument(vehicleRegPhoto, 'vehicleReg');
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
  'Car Mini AC': 5500,
  'Car Mini Non-AC': 5500,
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
    const submittedAmount = Number(amount);
    if (!Number.isFinite(submittedAmount) || submittedAmount <= 0) {
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

    const dateStr = todayUTC();
    const validTypes = ['jazzcash', 'easypaisa', 'bank', 'sadapay'];
    const normalizedPaymentType = validTypes.includes(paymentType) ? paymentType : 'jazzcash';
    const operation = await runIdempotentFinancialOperation({
      req,
      scope: 'driver-payment-submit',
      actorId: req.user.id,
      request: {
        trxId: cleanTrx,
        amount: submittedAmount,
        paymentType: normalizedPaymentType,
        vehicleCategory: normalizeFareVehicle(driver.vehicleType || 'Car Mini Non-AC'),
        submittedDate: dateStr,
        proofHash: hashFinancialRequest(proofScreenshot)
      },
      work: async session => {
        // These checks are repeated inside the transaction so two concurrent
        // submissions cannot both pass the preflight reads.
        const trxDuplicate = await Payment.findOne({ trxId: cleanTrx }).session(session);
        if (trxDuplicate) {
          throw financialError(
            'This Transaction ID has already been used. If you believe this is an error, contact admin.',
            409,
            'PAYMENT_TID_ALREADY_USED'
          );
        }
        const existing = await Payment.findOne({
          driver: req.user.id,
          submittedDate: dateStr
        }).session(session);
        if (existing) {
          throw financialError(
            'You have already submitted a payment for today. Wait for admin review before resubmitting.',
            409,
            'PAYMENT_ALREADY_SUBMITTED'
          );
        }

        const [payment] = await Payment.create([{
          driver:          req.user.id,
          trxId:           cleanTrx,
          amount:          submittedAmount,
          paymentType:     normalizedPaymentType,
          vehicleCategory: normalizeFareVehicle(driver.vehicleType || 'Car Mini Non-AC'),
          status:          'pending',
          submittedDate:   dateStr,
          proofScreenshot,
          auditLog: [{
            action: 'pending',
            actorId: String(req.user.id),
            actorRole: 'driver',
            reason: 'Driver submitted payment proof'
          }]
        }], { session });
        return { paymentId: String(payment._id) };
      }
    });

    const payment = await Payment.findById(operation.result.paymentId)
      .select('+proofScreenshot');
    if (!payment) {
      return res.status(503).json({ error: 'Payment submission could not be reloaded.' });
    }
    res.status(operation.replayed ? 200 : 201).json(payment);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This TRX ID or today’s payment submission already exists.' });
    }
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
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

async function approveDriverPaymentCore(paymentId, admin, adminNote = '', session) {
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment) return null;

    const existingApproval = payment.status === 'approved' && payment.walletCreditedAt;
    if (existingApproval) {
      const wallet = await Wallet.findOne({ user: payment.driver }).session(session);
      if (!wallet) {
        throw financialError('Approved payment wallet is unavailable and requires reconciliation.', 503, 'APPROVED_PAYMENT_RECONCILIATION_REQUIRED');
      }
      const passValidUntil = payment.paidUntilDate
        || [...(payment.auditLog || [])].reverse().find(entry => entry.action === 'approved')?.passValidUntil
        || new Date(new Date(payment.approvedAt || payment.walletCreditedAt).getTime() + ACTIVE_FEE_PASS_MS);
      return {
        payment,
        wallet,
        passValidUntil,
        actor: paymentAdminActor({ id: payment.approvedBy })
      };
    }
    if (payment.status !== 'pending') return null;

    const now = new Date();
    const actor = paymentAdminActor(admin);
    const operationId = `payment:${payment._id}:wallet-credit`;
    await ensureWalletSourceBalances(payment.driver, { session });
    const walletBeforeDoc = await Wallet.findOne({ user: payment.driver }).session(session);
    const balanceBefore = Number(walletBeforeDoc?.balance || 0);
    const creditedWallet = await Wallet.findOneAndUpdate(
      { user: payment.driver },
      {
        $inc: {
          balance: payment.amount,
          realCashWallet: payment.amount,
          realCashAvailable: payment.amount
        },
        $push: {
          transactions: {
            amount: payment.amount,
            type: 'credit',
            description: `Approved driver recharge (TRX ${payment.trxId})`,
            paymentMethod: payment.paymentType,
            mobileAccount: payment.trxId,
            operationId,
            fundingSource: WALLET_FUNDING_SOURCES.REAL,
            realAmount: payment.amount,
            bonusAmount: 0
          }
        }
      },
      { new: true, upsert: true, session }
    );
    if (!creditedWallet) {
      throw financialError('Driver wallet is unavailable; the payment was not approved.', 503, 'DRIVER_WALLET_UNAVAILABLE');
    }

    const driverQuery = User.findById(payment.driver)
      .select('vehicleType ridePreference paidUntilDate lastDailyFeePaidAt isFreeTrial');
    const driver = await applySession(driverQuery, session).lean();
    if (!driver) {
      throw financialError('Driver account could not be found; the payment was not approved.', 404, 'DRIVER_NOT_FOUND');
    }

    const feeResult = await chargeDailyFeeForOnlineDriverCore(
      payment.driver,
      driver,
      await getDailyFeeSettings(),
      session
    );
    const feeConfigured = Number.isFinite(feeResult.rate) && feeResult.rate > 0;
    const passValidUntil = feeResult.paidUntilDate
      || (!feeConfigured ? new Date(now.getTime() + ACTIVE_FEE_PASS_MS) : null);

    const approvedPayment = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'pending' },
      {
        $set: {
          status: 'approved',
          adminNote: String(adminNote || '').trim(),
          approvedBy: actor.id,
          approvedAt: now,
          walletCreditedAt: now,
          walletCreditOperationId: operationId,
           ...(passValidUntil ? { paidUntilDate: passValidUntil } : {})
        },
        $push: {
          auditLog: {
            action: 'approved',
            actorId: actor.id,
            actorRole: actor.role,
            reason: String(adminNote || '').trim(),
            balanceBefore,
            balanceAfter: Number(feeResult.wallet?.balance ?? creditedWallet.balance),
            ...(passValidUntil ? { passValidUntil } : {}),
            createdAt: now
          }
        }
      },
      { new: true, session }
    );
    if (!approvedPayment) return null;

    // The configured-fee path writes the Driver pass inside the same
    // transaction as the wallet debit. If no fee is configured, preserve the
    // legacy approval behavior without inventing a revenue entry.
    if (!feeConfigured) {
      const driverUpdate = await User.updateOne(
        { _id: payment.driver },
        { paidUntilDate: passValidUntil },
        { session }
      );
      if (driverUpdate.matchedCount === 0 && driverUpdate.n === 0) {
        throw financialError('Driver account could not be updated; the payment was not approved.', 503, 'DRIVER_UPDATE_FAILED');
      }
    }
    if (feeConfigured && !feeResult.allowed) {
      // A recharge can be approved even when it does not yet cover the fee,
      // but it must not create a paid pass.
      approvedPayment.paidUntilDate = null;
    }
    return {
      payment: approvedPayment,
      wallet: feeResult.wallet || creditedWallet,
      passValidUntil,
      balanceBefore,
      feeResult,
      actor
    };
}

async function approveDriverPayment(paymentId, admin, adminNote = '', options = {}) {
  if (options?.session) {
    return approveDriverPaymentCore(paymentId, admin, adminNote, options.session);
  }
  return runFinancialTransaction(session =>
    approveDriverPaymentCore(paymentId, admin, adminNote, session)
  );
}

async function rejectDriverPaymentCore(paymentId, admin, reason = '', session) {
  const actor = paymentAdminActor(admin);
  const paymentQuery = Payment.findById(paymentId).select('driver');
  const paymentRecord = await applySession(paymentQuery, session).lean();
  if (!paymentRecord) return null;
  const walletQuery = Wallet.findOne({ user: paymentRecord?.driver }).select('balance');
  const wallet = await applySession(walletQuery, session).lean();
  const balance = Number(wallet?.balance || 0);
  const updateQuery = Payment.findOneAndUpdate(
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
  return applySession(updateQuery, session);
}

async function rejectDriverPayment(paymentId, admin, reason = '', options = {}) {
  if (options?.session) {
    return rejectDriverPaymentCore(paymentId, admin, reason, options.session);
  }
  return runFinancialTransaction(session =>
    rejectDriverPaymentCore(paymentId, admin, reason, session)
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
    const category = normalizeFareVehicle(driver?.vehicleType || 'Car Mini Non-AC');
    const target   = DAILY_TARGETS[category] || 5500;

    // Sum all approved payments ever
    const result = await Payment.aggregate([
      { $match: { driver: new mongoose.Types.ObjectId(req.user.id), status: 'approved' } },
      { $group: { _id: null, totalApproved: { $sum: '$amount' } } }
    ]);
    const totalApproved = result[0]?.totalApproved || 0;

    // Ride income is independent from the Driver's spendable wallet. Read it
    // from settled Ride records instead of wallet credits.
    const { todayIncome: todayRideEarnings } = await getDriverTodayIncome(req.user.id);

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
    if (!location || !hasValidCoordinates(location)) {
      return res.status(400).json({ error: 'Valid SOS coordinates are required' });
    }
    if (rideId && !mongoose.isValidObjectId(rideId)) {
      return res.status(400).json({ error: 'Invalid ride ID' });
    }
    let ownedRide = null;
    if (rideId) {
      ownedRide = await Ride.findOne({
        _id: rideId,
        $or: [{ passenger: req.user.id }, { driver: req.user.id }]
      }).select('_id');
      if (!ownedRide) return res.status(403).json({ error: 'You are not a participant in this ride' });
    }
    // Fetch user's emergency contacts for the alert
    const userDoc = await User.findById(req.user.id).select('emergencyContacts name phone');
    const sos = await SOS.create({
      user:     req.user.id,
      location,
      message:  String(message || 'SOS Emergency Alert!').slice(0, 1000),
      ride:     ownedRide?._id || null
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
    // SOS location and driver details are private operational data. Never
    // broadcast them to every connected Customer/Driver.
    io.to('admin-room').emit('sos:alert', sosPayload);
    res.status(201).json({
      success: true, sos,
      emergencyContacts: userDoc?.emergencyContacts || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Geocode Proxy — merges Mapbox and Nominatim for Customer autocomplete
// Mapbox provides strong POI and autocomplete coverage while Nominatim adds
// open address, street, locality, and Urdu/Roman Urdu coverage. Both providers
// are filtered to Pakistan on the server; proximity only ranks nearby results
// and never filters another city out.
// ─────────────────────────────────────────────────────────────────────────────

const MAPBOX_GEOCODE_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places/';
const MAPBOX_RESULT_LIMIT = 10;
const NOMINATIM_GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_RESULT_LIMIT = 20;
const NOMINATIM_MAX_RESPONSE_BYTES = 1_048_576;
const NOMINATIM_DEFAULT_USER_AGENT = 'MyRide/1.0 (Pakistan ride-hailing location search)';
const GEOCODE_CACHE_TTL_MS = 60 * 1000;
const GEOCODE_CACHE_MAX_ENTRIES = 250;
const GEOCODE_MAX_RESULTS = 50;
const MAPBOX_MAX_RESPONSE_BYTES = 1_048_576;
const PAKISTAN_GEOCODE_BOUNDS = {
  minLat: 23,
  maxLat: 38.5,
  minLng: 60,
  maxLng: 78.5
};

function geocodeProviderType(result) {
  const address = result?.address && typeof result.address === 'object' ? result.address : {};
  return String(
    result?.providerType ||
    result?.type ||
    result?.category ||
    result?.class ||
    address.amenity ||
    address.public_transport ||
    address.aeroway ||
    address.highway ||
    ''
  ).trim();
}

function mapboxAddress(feature) {
  const properties = feature?.properties && typeof feature.properties === 'object'
    ? feature.properties
    : {};
  const context = Array.isArray(feature?.context) ? feature.context : [];
  const address = {};
  const valuesById = new Map();
  for (const item of context) {
    if (item?.id) valuesById.set(String(item.id).split('.')[0], item);
  }
  const directText = (key) => String(feature?.[key] || '').trim();
  const contextText = (...ids) => {
    for (const id of ids) {
      const item = valuesById.get(id);
      if (item?.text) return String(item.text).trim();
    }
    return '';
  };
  const set = (key, value) => {
    const text = String(value || '').trim();
    if (text) address[key] = text;
  };
  const placeTypes = Array.isArray(feature?.place_type) ? feature.place_type : [];
  set('name', directText('text') || properties.name);
  set('road', contextText('street') || (placeTypes.includes('address') ? directText('text') : ''));
  set('house_number', directText('address'));
  set('suburb', contextText('neighborhood', 'locality'));
  set('district', contextText('district'));
  set('city', contextText('place', 'locality')
    || (placeTypes.includes('place') || placeTypes.includes('locality') ? directText('text') : ''));
  set('state', contextText('region'));
  set('postcode', contextText('postcode'));
  set('country', contextText('country'));
  const country = valuesById.get('country');
  set('country_code', country?.short_code);
  if (properties.category) set('category', properties.category);
  return address;
}

function mapboxDisplayName(feature, address) {
  const street = [address.house_number, address.road].filter(Boolean).join(' ');
  const parts = [
    address.name || feature?.text,
    street,
    address.suburb,
    address.district,
    address.city,
    address.state,
    address.country
  ].map(value => String(value || '').trim()).filter(Boolean);
  return parts.filter((part, index) => parts.findIndex(candidate => candidate.toLocaleLowerCase() === part.toLocaleLowerCase()) === index)
    .join(', ');
}

function isPakistanMapboxFeature(feature, [lng, lat]) {
  const context = Array.isArray(feature?.context) ? feature.context : [];
  const countryContext = context.find(item => String(item?.id || '').startsWith('country.'));
  const countryCode = String(countryContext?.short_code || '').trim().toLocaleLowerCase();
  const country = String(countryContext?.text || '').trim().toLocaleLowerCase();
  const hasPakistanCountry = countryCode === 'pk'
    || country.includes('pakistan')
    || country.includes('پاکستان')
    || country.includes('پاكستان');
  return hasPakistanCountry
    && Number.isFinite(Number(lat))
    && Number.isFinite(Number(lng))
    && Number(lat) >= PAKISTAN_GEOCODE_BOUNDS.minLat
    && Number(lat) <= PAKISTAN_GEOCODE_BOUNDS.maxLat
    && Number(lng) >= PAKISTAN_GEOCODE_BOUNDS.minLng
    && Number(lng) <= PAKISTAN_GEOCODE_BOUNDS.maxLng;
}

function normalizeMapboxFeature(feature) {
  const coordinates = feature?.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : [];
  const [lng, lat] = coordinates;
  if (!isPakistanMapboxFeature(feature, [lng, lat])
    || !hasValidCoordinates({ lat, lng })) return null;

  const address = mapboxAddress(feature);
  const providerType = String(
    feature?.properties?.category ||
    feature?.place_type?.[0] ||
    ''
  ).trim();
  const displayName = mapboxDisplayName(feature, address);
  return {
    display_name: String(feature?.place_name || displayName || 'Pakistan location').trim(),
    name: String(feature?.text || address.name || '').trim(),
    lat: String(lat),
    lon: String(lng),
    type: providerType,
    category: providerType,
    providerType,
    address,
    mapbox_id: feature?.id || '',
    provider: 'mapbox'
  };
}

function isNominatimEnabled() {
  return String(process.env.NOMINATIM_ENABLED || 'true').trim().toLocaleLowerCase() !== 'false';
}

function nominatimUserAgent() {
  return String(process.env.NOMINATIM_USER_AGENT || NOMINATIM_DEFAULT_USER_AGENT).trim()
    || NOMINATIM_DEFAULT_USER_AGENT;
}

function nominatimAddress(result) {
  const source = result?.address && typeof result.address === 'object' ? result.address : {};
  const address = {};
  const set = (key, value) => {
    const text = String(value || '').trim();
    if (text) address[key] = text;
  };
  set('name', result?.name);
  set('house_number', source.house_number);
  set('road', source.road || source.pedestrian || source.footway || source.cycleway);
  set('suburb', source.suburb || source.neighbourhood || source.quarter);
  set('district', source.city_district || source.district || source.county || source.state_district);
  set('city', source.city || source.town || source.village || source.municipality);
  set('state', source.state || source.province);
  set('postcode', source.postcode);
  set('country', source.country);
  set('country_code', source.country_code);
  set('category', result?.type || result?.class);
  return address;
}

function isPakistanNominatimResult(result, lat, lng) {
  const address = result?.address && typeof result.address === 'object' ? result.address : {};
  const countryCode = String(address.country_code || '').trim().toLocaleLowerCase();
  const country = String(address.country || '').trim().toLocaleLowerCase();
  const hasPakistanCountry = countryCode === 'pk'
    || country.includes('pakistan')
    || country.includes('پاکستان')
    || country.includes('پاكستان');
  return hasPakistanCountry
    && Number.isFinite(Number(lat))
    && Number.isFinite(Number(lng))
    && Number(lat) >= PAKISTAN_GEOCODE_BOUNDS.minLat
    && Number(lat) <= PAKISTAN_GEOCODE_BOUNDS.maxLat
    && Number(lng) >= PAKISTAN_GEOCODE_BOUNDS.minLng
    && Number(lng) <= PAKISTAN_GEOCODE_BOUNDS.maxLng;
}

function normalizeNominatimResult(result) {
  const lat = Number(result?.lat);
  const lng = Number(result?.lon);
  if (!isPakistanNominatimResult(result, lat, lng)
    || !hasValidCoordinates({ lat, lng })) return null;

  const address = nominatimAddress(result);
  const providerType = String(result?.type || result?.class || 'place').trim();
  const displayName = String(result?.display_name || '').trim();
  const name = String(result?.name || displayName.split(',')[0] || 'Pakistan location').trim();
  return {
    display_name: displayName || `${name}, Pakistan`,
    name,
    lat: String(lat),
    lon: String(lng),
    type: providerType,
    category: providerType,
    providerType,
    address,
    nominatim_id: result?.place_id || `${result?.osm_type || 'place'}:${result?.osm_id || ''}`,
    provider: 'nominatim'
  };
}

function uniqueReverseAddressParts(parts) {
  const seen = new Set();
  return parts
    .map(part => String(part || '').trim())
    .filter(part => {
      if (!part || part.toLocaleLowerCase() === 'pakistan') return false;
      const key = part.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function detailedReverseDisplayName(address = {}, displayName = '') {
  const street = [address.house_number, address.road].filter(Boolean).join(' ');
  const structured = uniqueReverseAddressParts([
    street,
    !street || String(address.name || '').toLocaleLowerCase() !== street.toLocaleLowerCase()
      ? address.name
      : '',
    address.suburb || address.neighbourhood || address.quarter,
    address.district,
    address.city || address.town || address.municipality,
    address.state || address.province,
    address.postcode
  ]);
  const providerParts = uniqueReverseAddressParts(String(displayName || '').split(','));
  const parts = structured.length >= 2
    ? structured
    : uniqueReverseAddressParts([...structured, ...providerParts]);
  return parts.slice(0, 8).join(', ');
}

function reverseAddressIsDetailed(address = {}) {
  const city = String(address.city || address.town || address.municipality || '').trim().toLocaleLowerCase();
  const localParts = [
    address.house_number,
    address.road,
    address.suburb,
    address.neighbourhood,
    address.quarter,
    address.district,
    address.name && String(address.name).trim().toLocaleLowerCase() !== city
      ? address.name
      : ''
  ];
  return localParts.some(part => String(part || '').trim());
}

async function reverseNominatimLocation(lat, lng) {
  if (!isNominatimEnabled()) return null;
  return queueNominatimRequest(async () => {
    const url = new URL(NOMINATIM_REVERSE_URL);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('zoom', '18');
    url.searchParams.set('accept-language', 'en');
    const headers = {
      'Accept': 'application/json',
      'Accept-Language': 'en',
      'User-Agent': nominatimUserAgent()
    };
    const referrer = String(process.env.NOMINATIM_REFERRER || '').trim();
    if (referrer) headers.Referer = referrer;
    const upstream = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (!upstream.ok) throw new Error(`Nominatim reverse upstream ${upstream.status}`);
    const result = await readJsonResponseWithLimit(upstream, NOMINATIM_MAX_RESPONSE_BYTES);
    if (!isPakistanNominatimResult(result, lat, lng)) return null;
    const address = nominatimAddress(result);
    return {
      display_name: String(result?.display_name || '').trim(),
      address,
      lat: Number(lat),
      lng: Number(lng),
      provider: 'nominatim'
    };
  });
}

function isGenericRideLocationAddress(value) {
  const parts = String(value || '')
    .split(',')
    .map(part => part.trim().toLocaleLowerCase())
    .filter(Boolean);
  const genericParts = new Set([
    'lahore', 'punjab', 'pakistan', 'karachi', 'sindh', 'islamabad',
    'rawalpindi', 'peshawar', 'khyber pakhtunkhwa', 'quetta', 'balochistan',
    'faisalabad', 'multan', 'hyderabad', 'capital territory'
  ]);
  return !parts.length || (parts.length <= 2 && parts.every(part => genericParts.has(part)));
}

async function resolveRideLocationAddress(location) {
  const original = { ...(location || {}) };
  const lat = Number(original.lat);
  const lng = Number(original.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || !isGenericRideLocationAddress(original.address)) return original;

  let mapboxResult = null;
  const token = getMapboxAccessToken();
  if (token) {
    try {
      const url = new URL(`${MAPBOX_GEOCODE_URL}${encodeURIComponent(`${lng},${lat}`)}.json`);
      url.searchParams.set('access_token', token);
      url.searchParams.set('language', 'en');
      url.searchParams.set('types', 'address,poi,neighborhood,locality,place,postcode');
      const upstream = await fetch(url, {
        headers: { 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(5000)
      });
      if (upstream.ok) {
        const data = await readJsonResponseWithLimit(upstream, MAPBOX_MAX_RESPONSE_BYTES);
        const results = (data?.features || []).map(normalizeMapboxFeature).filter(Boolean);
        mapboxResult = results.find(result => reverseAddressIsDetailed(result.address)) || results[0] || null;
      }
    } catch (error) {
      console.warn('Ride location Mapbox reverse lookup failed:', error.message);
    }
  }

  if (mapboxResult && reverseAddressIsDetailed(mapboxResult.address)) {
    return {
      ...original,
      address: detailedReverseDisplayName(mapboxResult.address, mapboxResult.display_name)
    };
  }

  try {
    const nominatimResult = await reverseNominatimLocation(lat, lng);
    if (nominatimResult && reverseAddressIsDetailed(nominatimResult.address)) {
      return {
        ...original,
        address: detailedReverseDisplayName(nominatimResult.address, nominatimResult.display_name)
      };
    }
  } catch (error) {
    console.warn('Ride location Nominatim reverse lookup failed:', error.message);
  }

  // Never persist a city-only label. The Driver card will fall back to the
  // validated coordinates, which is more honest and actionable than a false
  // "Lahore, Punjab" pickup.
  return { ...original, address: '' };
}

async function readJsonResponseWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Geocode upstream response is too large');
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error('Geocode upstream response is too large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Geocode upstream response is too large');
    }
    return JSON.parse(text);
  }

  // Lightweight test doubles and older fetch implementations may only expose
  // json(). Real Node fetch responses use the bounded body path above.
  return response.json();
}

async function readMapboxErrorMessage(response) {
  try {
    if (typeof response?.json !== 'function') return '';
    const payload = await response.json();
    const message = payload?.message || payload?.error?.message || payload?.error || '';
    return String(message).replace(/\s+/g, ' ').trim().slice(0, 240);
  } catch {
    return '';
  }
}

async function geocodeProviderSearch(query, center = null) {
  const token = getMapboxAccessToken();
  if (!token) throw new Error('Mapbox public token is not configured');
  const url = new URL(`${MAPBOX_GEOCODE_URL}${encodeURIComponent(query)}.json`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('autocomplete', 'true');
  url.searchParams.set('country', 'pk');
  // Keep the original query text unchanged so Urdu/Roman Urdu searches still
  // reach Mapbox; English is the supported response language for this endpoint.
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', String(MAPBOX_RESULT_LIMIT));
  url.searchParams.set('types', 'address,poi,neighborhood,locality,place,postcode');
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0)) {
    url.searchParams.set('proximity', `${lng},${lat}`);
  }
  const headers = {
    'Accept-Language': 'en'
  };
  const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!upstream.ok) {
    const detail = await readMapboxErrorMessage(upstream);
    throw new Error(`Geocode upstream ${upstream.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await readJsonResponseWithLimit(upstream, MAPBOX_MAX_RESPONSE_BYTES);
  if (!Array.isArray(data?.features)) return [];
  return data.features.map(normalizeMapboxFeature).filter(Boolean).map(result => ({
    ...result,
    providerType: geocodeProviderType(result)
  }));
}

let nominatimRequestChain = Promise.resolve();
let nominatimLastRequestAt = 0;

function nominatimMinIntervalMs() {
  const configured = Number(process.env.NOMINATIM_MIN_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1100;
}

function queueNominatimRequest(task) {
  const request = nominatimRequestChain.then(async () => {
    const waitMs = Math.max(0, nominatimLastRequestAt + nominatimMinIntervalMs() - Date.now());
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    nominatimLastRequestAt = Date.now();
    return task();
  });
  nominatimRequestChain = request.catch(() => undefined);
  return request;
}

async function geocodeNominatimSearch(query, center = null) {
  if (!isNominatimEnabled()) return [];
  return queueNominatimRequest(async () => {
    const url = new URL(NOMINATIM_GEOCODE_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('limit', String(NOMINATIM_RESULT_LIMIT));
    url.searchParams.set('countrycodes', 'pk');
    url.searchParams.set('accept-language', 'ur,en');

    const lat = Number(center?.lat);
    const lng = Number(center?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
      && !(lat === 0 && lng === 0)) {
      const delta = 1.5;
      url.searchParams.set('viewbox', `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`);
      // A viewbox is a ranking hint, not a city boundary.
      url.searchParams.set('bounded', '0');
    }

    const headers = {
      'Accept': 'application/json',
      'Accept-Language': 'ur,en',
      'User-Agent': nominatimUserAgent()
    };
    const referrer = String(process.env.NOMINATIM_REFERRER || '').trim();
    if (referrer) headers.Referer = referrer;
    const upstream = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (!upstream.ok) {
      throw new Error(`Nominatim upstream ${upstream.status}`);
    }
    const data = await readJsonResponseWithLimit(upstream, NOMINATIM_MAX_RESPONSE_BYTES);
    if (!Array.isArray(data)) return [];
    return data.map(normalizeNominatimResult).filter(Boolean);
  });
}

function isValidGeocodeCenter(center) {
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

function parseGeocodeCenter(query) {
  const rawProximity = String(query?.proximity || '').trim();
  if (rawProximity) {
    const [rawLng, rawLat] = rawProximity.split(',');
    const proximityCenter = { lat: Number(rawLat), lng: Number(rawLng) };
    if (isValidGeocodeCenter(proximityCenter)) return proximityCenter;
  }

  const legacyCenter = {
    lat: Number(query?.lat),
    lng: Number(query?.lng)
  };
  return isValidGeocodeCenter(legacyCenter) ? legacyCenter : null;
}

function mergeGeocodeResults(rawResults, aliasResults) {
  const seen = new Set();
  return [...rawResults, ...aliasResults].filter(result => {
    const lat = Number(result.lat);
    const lon = Number(result.lon ?? result.lng);
    const name = String(result.display_name || result.primary || result.aliasOf || '').toLocaleLowerCase();
    const key = `${name}|${lat.toFixed(5)}|${lon.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, GEOCODE_MAX_RESULTS);
}

const geocodeCache = new Map();

function geocodeCacheKey(query, center) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  return `${normalizedQuery}|${Number.isFinite(lat) ? lat.toFixed(4) : ''}|${Number.isFinite(lng) ? lng.toFixed(4) : ''}`;
}

function readGeocodeCache(key) {
  const cached = geocodeCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    geocodeCache.delete(key);
    return null;
  }
  return cached.results.map(result => ({ ...result }));
}

function writeGeocodeCache(key, results) {
  if (geocodeCache.size >= GEOCODE_CACHE_MAX_ENTRIES) {
    const oldestKey = geocodeCache.keys().next().value;
    if (oldestKey) geocodeCache.delete(oldestKey);
  }
  geocodeCache.set(key, {
    expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS,
    results: results.map(result => ({ ...result }))
  });
}

async function geocodeAllProviders(query, center) {
  const cacheKey = geocodeCacheKey(query, center);
  const cached = readGeocodeCache(cacheKey);
  if (cached) return cached;

  const outcomes = await Promise.allSettled([
    geocodeProviderSearch(query, center),
    geocodeNominatimSearch(query, center)
  ]);
  const successfulResults = outcomes
    .filter(outcome => outcome.status === 'fulfilled')
    .flatMap(outcome => outcome.value || []);
  if (!successfulResults.length
    && outcomes.every(outcome => outcome.status === 'rejected')) {
    throw outcomes.find(outcome => outcome.status === 'rejected')?.reason
      || new Error('All geocoding providers failed');
  }
  const results = mergeGeocodeResults(successfulResults, []);
  writeGeocodeCache(cacheKey, results);
  return results;
}

app.get('/api/geocode', async (req, res) => {
  // Preserve the user's exact text for the raw nationwide lookup. Normalizing
  // is only for matching configured aliases, never for the provider query.
  const q = String(req.query.q || '');
  if (!q.trim()) return res.json([]);
  const center = parseGeocodeCenter(req.query);

  try {
    const aliases = await getCustomerLocationAliases();
    const matches = matchCustomerLocationAliases(q, aliases);
    const canonicalQueries = [...new Set(matches
      .filter(match =>
        (match.exact || match.alias.confidence >= CUSTOMER_LOCATION_ALIAS_CONFIDENCE_MIN) &&
        match.alias.canonicalQuery &&
        match.alias.canonicalQuery !== q
      )
      .map(match => match.alias.canonicalQuery)
    )].slice(0, 4);
    const directResults = matches
      .filter(isSafeDirectCustomerAlias)
      .map(match => ({
        display_name: `${match.alias.displayName}${match.alias.cityHint ? `, ${match.alias.cityHint}` : ''}, Pakistan`,
        name: match.alias.displayName,
        lat: String(match.alias.coordinates.lat),
        lon: String(match.alias.coordinates.lng),
        type: 'alias',
        providerType: 'alias',
        address: { city: match.alias.cityHint || '' },
        aliasMatch: true,
        aliasOf: match.alias.displayName,
        aliasMatchedBy: match.matchedBy,
        aliasConfidence: match.alias.confidence
      }));
    const providerResults = await Promise.all([
      geocodeAllProviders(q, center).catch(error => {
        if (directResults.length) {
          console.warn('[location-aliases] raw lookup failed; returning vetted direct alias:', error.message);
          return [];
        }
        throw error;
      }),
      ...canonicalQueries.map(query => geocodeAllProviders(query, center).catch(error => {
        console.warn(`[location-aliases] canonical lookup failed for "${query}":`, error.message);
        return [];
      }))
    ]);
    const rawResults = providerResults[0] || [];
    const aliasResults = providerResults.slice(1).flatMap((results, index) => {
      const match = matches.find(candidate => candidate.alias.canonicalQuery === canonicalQueries[index]);
      return (results || []).map(result => ({
        ...result,
        aliasMatch: true,
        aliasOf: match?.alias.displayName || '',
        aliasMatchedBy: match?.matchedBy || 'configured alias',
        aliasConfidence: match?.alias.confidence || 0
      }));
    });
     res.json(mergeGeocodeResults(rawResults, [...aliasResults, ...directResults]));
  } catch (err) {
    console.error('Geocode error:', err.message);
    res.status(502).json({ error: 'Geocoding is temporarily unavailable' });
  }
});

app.get('/api/geocode/reverse', authMiddleware, async (req, res) => {
  // Pickup labels must always correspond to the latest pin coordinates; do
  // not allow an intermediary or browser cache to serve an older city label.
  res.set('Cache-Control', 'no-store');
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180
    || (lat === 0 && lng === 0)) {
    return res.status(400).json({ error: 'Valid latitude and longitude are required' });
  }

  try {
    const token = getMapboxAccessToken();
    let mapboxResult = null;
    let mapboxError = null;
    if (token) {
      try {
        const url = new URL(`${MAPBOX_GEOCODE_URL}${encodeURIComponent(`${lng},${lat}`)}.json`);
        url.searchParams.set('access_token', token);
        url.searchParams.set('language', 'en');
        url.searchParams.set('types', 'address,poi,neighborhood,locality,place,postcode');
        const upstream = await fetch(url, {
          headers: { 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(5000)
        });
        if (!upstream.ok) {
          const detail = await readMapboxErrorMessage(upstream);
          throw new Error(`Reverse geocode upstream ${upstream.status}${detail ? `: ${detail}` : ''}`);
        }
        const data = await readJsonResponseWithLimit(upstream, MAPBOX_MAX_RESPONSE_BYTES);
        const mapboxResults = (data?.features || [])
          .map(normalizeMapboxFeature)
          .filter(Boolean);
        // Mapbox often puts a city/place feature before the detailed
        // address/road feature. Prefer the most specific valid result so a
        // pickup never degrades to only "Lahore, Punjab".
        mapboxResult = mapboxResults.find(result => reverseAddressIsDetailed(result.address))
          || mapboxResults[0]
          || null;
      } catch (error) {
        mapboxError = error;
      }
    }

    const mapboxAddress = mapboxResult?.address || {};
    if (mapboxResult && reverseAddressIsDetailed(mapboxAddress)) {
      const displayName = detailedReverseDisplayName(mapboxAddress, mapboxResult.display_name);
      return res.json({
        city: String(mapboxAddress.city || mapboxAddress.district || mapboxAddress.state || '').trim(),
        display_name: displayName || mapboxResult.display_name || '',
        address: mapboxAddress,
        lat,
        lng,
        provider: 'mapbox'
      });
    }

    try {
      const nominatimResult = await reverseNominatimLocation(lat, lng);
      if (nominatimResult) {
        const address = nominatimResult.address || {};
        return res.json({
          city: String(address.city || address.district || address.state || '').trim(),
          display_name: detailedReverseDisplayName(address, nominatimResult.display_name),
          address,
          lat,
          lng,
          provider: 'nominatim'
        });
      }
    } catch (error) {
      if (!mapboxResult) mapboxError = error;
    }

    if (mapboxResult) {
      const displayName = detailedReverseDisplayName(mapboxAddress, mapboxResult.display_name);
      return res.json({
        city: String(mapboxAddress.city || mapboxAddress.district || mapboxAddress.state || '').trim(),
        display_name: displayName || mapboxResult.display_name || '',
        address: mapboxAddress,
        lat,
        lng,
        provider: 'mapbox'
      });
    }
    throw mapboxError || new Error('No reverse-geocoding provider returned a result');
  } catch (err) {
    console.error('Reverse geocode error:', err.message);
    res.status(502).json({ error: 'Reverse geocoding is temporarily unavailable' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin Routes  (/api/admin/*)
// ─────────────────────────────────────────────────────────────────────────────

// Pre-login configuration intentionally returns only the Admin email. It does
// not expose a password, recovery key, credential hash, or session metadata.
// This keeps the login form aligned with the same source of truth used by the
// login handler across preview and persistent MongoDB deployments.
app.get('/api/admin/login-config', async (_req, res) => {
  try {
    const security = await getAdminSecurity();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ email: configuredAdminEmail(security.email) });
  } catch (err) {
    console.error('Admin login configuration unavailable:', err.message);
    // The fallback keeps the form usable while the database is unavailable;
    // the login handler remains the authority for accepting credentials.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ email: configuredAdminEmail() });
  }
});

// POST /api/admin/login — password is persisted only as a hash after setup.
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const security = await getAdminSecurity();
    const adminEmail = configuredAdminEmail(security.email);
    if (!email || !password || String(email).trim().toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    if (!(await verifySuperAdminPassword(password, security))) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const token = jwt.sign(
      {
        id: 'super-admin',
        isAdmin: true,
        isSuperAdmin: true,
        email: adminEmail,
        adminSessionVersion: security.sessionVersion
      },
      JWT_SECRET, { expiresIn: '12h' }
    );
    res.json({ token, admin: { email: adminEmail, recoveryKeyConfigured: !!security.recoveryKeyHash } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.post('/api/admin/security/otp/request', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const action = normalizeAdminSecurityOtpAction(req.body?.action);
    if (!['password', 'recovery-key'].includes(action)) {
      return res.status(400).json({ error: 'Choose a password or recovery-key change' });
    }
    const security = await getAdminSecurity();
    const email = configuredAdminEmail(security.email);
    const result = await sendAdminSecurityOtp({
      action,
      email,
      sessionVersion: security.sessionVersion,
      ip: req.ip
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      success: true,
      message: 'A verification code was sent to the configured Admin email. It expires in 10 minutes.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to start Admin security verification' });
  }
});

app.get('/api/admin/security/status', adminJwt, requireSuperAdmin, async (_req, res) => {
  try {
    const security = await getAdminSecurity();
    res.json({
      recoveryKeyConfigured: !!security.recoveryKeyHash,
      passwordManaged: environmentAdminPasswordIsAuthoritative(),
      recoveryKeyManaged: environmentAdminRecoveryKeyIsAuthoritative()
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.patch('/api/admin/security/password', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword, otp } = req.body || {};
    if (!validateStrongPassword(newPassword)) {
      return res.status(422).json({ error: 'New password must be at least 10 characters' });
    }
    if (environmentAdminPasswordIsAuthoritative()) {
      return res.status(409).json({
        error: 'Admin password is managed by the ADMIN_PASSWORD environment secret. Update that secret instead.'
      });
    }
    if (!/^\d{6}$/.test(String(otp || '').trim())) {
      return res.status(400).json({ error: 'Enter the 6-digit Admin verification code sent to your email' });
    }
    const security = await getAdminSecurity();
    if (!(await verifySuperAdminPassword(currentPassword, security))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const verification = await consumeAdminSecurityOtp({
      action: 'password',
      email: configuredAdminEmail(security.email),
      sessionVersion: security.sessionVersion,
      otp
    });
    if (!verification.ok) return res.status(401).json({ error: verification.error });
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
    const { currentPassword, recoveryKey, otp } = req.body || {};
    if (!validateRecoveryKey(recoveryKey)) {
      return res.status(422).json({ error: 'Secret Recovery Key must be at least 12 characters' });
    }
    if (environmentAdminRecoveryKeyIsAuthoritative()) {
      return res.status(409).json({
        error: 'Recovery key is managed by the ADMIN_RECOVERY_KEY environment secret. Update that secret instead.'
      });
    }
    if (!/^\d{6}$/.test(String(otp || '').trim())) {
      return res.status(400).json({ error: 'Enter the 6-digit Admin verification code sent to your email' });
    }
    const security = await getAdminSecurity();
    if (!(await verifySuperAdminPassword(currentPassword, security))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const verification = await consumeAdminSecurityOtp({
      action: 'recovery-key',
      email: configuredAdminEmail(security.email),
      sessionVersion: security.sessionVersion,
      otp
    });
    if (!verification.ok) return res.status(401).json({ error: verification.error });
    await saveAdminSecurity({
      ...security,
      recoveryKeyHash: await bcrypt.hash(recoveryKey.trim(), 12),
      sessionVersion: security.sessionVersion + 1
    });
    res.json({ success: true, recoveryKeyConfigured: true, message: 'Secret Recovery Key changed. Please sign in again.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function verifyAdminFlushPassword(password) {
  if (typeof password !== 'string' || !password) return false;
  const security = await getAdminSecurity();
  return verifySuperAdminPassword(password, security);
}

async function findAccountForPurge(accountId) {
  const [customer, driver, legacy] = await Promise.all([
    Customer.findById(accountId)
      .select('name role email phone profilePhoto cnicFront cnicBack licensePhoto vehicleRegPhoto +customerIdFront +customerIdBack +studentIdImage')
      .lean(),
    Driver.findById(accountId)
      .select('name role email phone profilePhoto cnicFront cnicBack licensePhoto vehicleRegPhoto +customerIdFront +customerIdBack +studentIdImage')
      .lean(),
    LegacyUser.findById(accountId)
      .select('name role email phone profilePhoto cnicFront cnicBack licensePhoto vehicleRegPhoto +customerIdFront +customerIdBack +studentIdImage')
      .lean()
  ]);
  return {
    target: driver || customer || legacy,
    records: [customer, driver, legacy].filter(Boolean)
  };
}

function clearAccountOtpState(account = {}) {
  const role = String(account.role || '');
  const phones = new Set(phoneLookupValues(account.phone));
  if (!role || !phones.size) return;
  for (const key of PHONE_OTP_CHALLENGES.keys()) {
    const [keyRole, _purpose, ...phoneParts] = key.split(':');
    if (keyRole === role && phones.has(phoneParts.join(':'))) {
      PHONE_OTP_CHALLENGES.delete(key);
    }
  }
}

async function purgeUserAccount(accountId) {
  const { target, records } = await findAccountForPurge(accountId);
  if (!target) return null;
  const role = target.role;
  if (!['customer', 'driver'].includes(role)) {
    throw new Error('Only Customer and Driver accounts can be deleted');
  }
  const seedKey = accountSeedKey(target);
  const result = {
    users: 0,
    legacyUsers: 0,
    wallets: 0,
    payments: 0,
    pushSubscriptions: 0,
    supportTickets: 0,
    sosAlerts: 0,
    rides: 0,
    studentRideResponses: 0
  };

  await runFinancialTransaction(async session => {
    const userId = target._id;
    const identityFilters = [];
    const email = String(target.email || '').trim().toLowerCase();
    const phoneValues = phoneLookupValues(target.phone);
    if (email) identityFilters.push({ email });
    if (phoneValues.length) identityFilters.push({ phone: { $in: phoneValues } });
    if (identityFilters.length) {
      const duplicateFilter = {
        _id: { $ne: userId },
        role,
        $or: identityFilters
      };
      const legacyDuplicates = await LegacyUser.find(duplicateFilter).session(session).lean();
      for (const duplicate of legacyDuplicates) {
        const duplicateSeedKey = accountSeedKey(duplicate);
        if (!duplicateSeedKey || duplicateSeedKey !== seedKey) {
          await AccountDeletionTombstone.updateOne(
            { accountId: duplicate._id },
            buildAccountDeletionTombstoneUpdate(duplicate, duplicateSeedKey),
            { upsert: true, session }
          );
        }
      }
      const duplicateResult = await LegacyUser.deleteMany(duplicateFilter, { session });
      result.legacyUsers += duplicateResult.deletedCount || 0;
    }
    const customerResult = await Customer.deleteOne({ _id: userId }, { session });
    const driverResult = await Driver.deleteOne({ _id: userId }, { session });
    const legacyResult = await LegacyUser.deleteOne({ _id: userId }, { session });
    result.users = (customerResult.deletedCount || 0) + (driverResult.deletedCount || 0);
    result.legacyUsers = legacyResult.deletedCount || 0;

    const walletResult = await Wallet.deleteMany({ user: userId }, { session });
    const paymentResult = await Payment.deleteMany({ driver: userId }, { session });
    const pushResult = await PushSub.deleteMany({ user: userId }, { session });
    const ticketResult = await Ticket.deleteMany({ user: userId }, { session });
    const sosResult = await SOS.deleteMany({ user: userId }, { session });
    const rideResult = await Ride.deleteMany({
      $or: [{ passenger: userId }, { driver: userId }]
    }, { session });
    const studentResponseResult = await StudentRideResponseLog.deleteMany({ driver: userId }, { session });
    result.wallets = walletResult.deletedCount || 0;
    result.payments = paymentResult.deletedCount || 0;
    result.pushSubscriptions = pushResult.deletedCount || 0;
    result.supportTickets = ticketResult.deletedCount || 0;
    result.sosAlerts = sosResult.deletedCount || 0;
    result.rides = rideResult.deletedCount || 0;
    result.studentRideResponses = studentResponseResult.deletedCount || 0;

    await AccountDeletionTombstone.updateOne(
      { accountId: userId },
      buildAccountDeletionTombstoneUpdate(target, seedKey),
      { upsert: true, session }
    );
  });

  io.to(`user:${accountId}`).emit('account:deleted', {
    reason: 'Your account has been permanently deleted.'
  });
  io.in(`user:${accountId}`).disconnectSockets(true);
  clearAccountOtpState(target);
  if (role === 'driver') await removeDriverPresence(accountId).catch(() => false);
  records.forEach(deleteStoredAccountFiles);
  return { name: target.name, role, counts: result };
}

async function flushRoleData(role) {
  const roleFilter = { role };
  const [customerUsers, driverUsers, legacyUsers] = await Promise.all([
    Customer.find(roleFilter).lean(),
    Driver.find(roleFilter).lean(),
    LegacyUser.find(roleFilter).lean()
  ]);
  const allUsers = [...customerUsers, ...driverUsers, ...legacyUsers];
  const ids = [...new Map(allUsers.map(user => [String(user._id), user._id])).values()];
  const seedRecords = allUsers
    .map(user => ({ user, seedKey: accountSeedKey(user) }))
    .filter(entry => entry.seedKey);
  for (const { user, seedKey } of seedRecords) {
    await AccountDeletionTombstone.updateOne(
      { accountId: user._id },
      {
        $set: {
          role,
          email: user.email || null,
          phone: user.phone || '',
          seedKey,
          deletedAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  const userResult = await Customer.deleteMany(roleFilter);
  const driverResult = await Driver.deleteMany(roleFilter);
  const legacyResult = await LegacyUser.deleteMany(roleFilter);
  const walletResult = await Wallet.deleteMany({ user: { $in: ids } });
  const paymentResult = await Payment.deleteMany({ driver: { $in: ids } });
  const pushResult = await PushSub.deleteMany({ user: { $in: ids } });
  const ticketResult = await Ticket.deleteMany({ user: { $in: ids } });
  const sosResult = await SOS.deleteMany({ user: { $in: ids } });
  const studentResponseResult = await StudentRideResponseLog.deleteMany({ driver: { $in: ids } });

  if (role === 'driver') {
    await Promise.all(ids.map(id => {
      io.in(`user:${id}`).emit('account:deleted', { reason: 'Your account has been permanently deleted.' });
      io.in(`user:${id}`).disconnectSockets(true);
      return removeDriverPresence(id).catch(() => undefined);
    }));
  } else {
    ids.forEach(id => {
      io.in(`user:${id}`).emit('account:deleted', { reason: 'Your account has been permanently deleted.' });
      io.in(`user:${id}`).disconnectSockets(true);
    });
  }
  allUsers.forEach(deleteStoredAccountFiles);
  return {
    users: (userResult.deletedCount || 0) + (driverResult.deletedCount || 0),
    legacyUsers: legacyResult.deletedCount || 0,
    wallets: walletResult.deletedCount || 0,
    payments: paymentResult.deletedCount || 0,
    pushSubscriptions: pushResult.deletedCount || 0,
    supportTickets: ticketResult.deletedCount || 0,
    sosAlerts: sosResult.deletedCount || 0,
    studentRideResponses: studentResponseResult.deletedCount || 0
  };
}

app.post('/api/admin/data/flush-drivers', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    if (!(await verifyAdminFlushPassword(req.body?.password))) {
      return res.status(401).json({ error: 'Current Admin password is incorrect' });
    }
    const counts = await flushRoleData('driver');
    res.json({ success: true, role: 'driver', counts, message: `Driver data flushed. ${counts.users} Driver account(s) removed.` });
  } catch (err) {
    console.error('Driver data flush failed:', err.message);
    res.status(500).json({ error: 'Unable to flush Driver data' });
  }
});

app.post('/api/admin/data/flush-customers', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    if (!(await verifyAdminFlushPassword(req.body?.password))) {
      return res.status(401).json({ error: 'Current Admin password is incorrect' });
    }
    const counts = await flushRoleData('customer');
    res.json({ success: true, role: 'customer', counts, message: `Customer data flushed. ${counts.users} Customer account(s) removed.` });
  } catch (err) {
    console.error('Customer data flush failed:', err.message);
    res.status(500).json({ error: 'Unable to flush Customer data' });
  }
});

app.post('/api/admin/forgot-password/request-otp', async (req, res) => {
  try {
    const genericError = 'Unable to send a verification code with those recovery details';
    if (!throttleAdminRecovery(req)) {
      return res.status(429).json({ error: 'Too many recovery attempts. Try again later.' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    const recoveryKey = req.body?.recoveryKey;
    const security = await getAdminSecurity();
    const adminEmail = configuredAdminEmail(security.email);
    if (!email || email !== adminEmail.toLowerCase() ||
        !validateRecoveryKey(recoveryKey) ||
        !security.recoveryKeyHash ||
        !(await bcrypt.compare(String(recoveryKey).trim(), security.recoveryKeyHash))) {
      return res.status(401).json({ error: genericError });
    }
    const result = await sendAdminSecurityOtp({
      action: 'password-recovery',
      email: adminEmail,
      sessionVersion: security.sessionVersion,
      ip: req.ip
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      success: true,
      message: 'A verification code was sent to the configured Admin email. It expires in 10 minutes.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to start password recovery verification' });
  }
});

app.post('/api/admin/forgot-password', async (req, res) => {
  try {
    const genericError = 'Unable to reset the password with those recovery details';
    if (!throttleAdminRecovery(req)) return res.status(429).json({ error: 'Too many recovery attempts. Try again later.' });
    const { email, recoveryKey, newPassword, otp } = req.body || {};
    const security = await getAdminSecurity();
    const adminEmail = configuredAdminEmail(security.email);
    if (!validateStrongPassword(newPassword) || !validateRecoveryKey(recoveryKey) ||
        String(email || '').trim().toLowerCase() !== adminEmail.toLowerCase()) {
      return res.status(401).json({ error: genericError });
    }
    if (environmentAdminPasswordIsAuthoritative()) {
      return res.status(409).json({
        error: 'Admin password is managed by the ADMIN_PASSWORD environment secret. Update that secret instead.'
      });
    }
    if (!/^\d{6}$/.test(String(otp || '').trim())) {
      return res.status(400).json({ error: 'Enter the 6-digit Admin verification code sent to your email' });
    }
    if (!security.recoveryKeyHash || !(await bcrypt.compare(recoveryKey.trim(), security.recoveryKeyHash))) {
      return res.status(401).json({ error: genericError });
    }
    const verification = await consumeAdminSecurityOtp({
      action: 'password-recovery',
      email: adminEmail,
      sessionVersion: security.sessionVersion,
      otp
    });
    if (!verification.ok) return res.status(401).json({ error: verification.error });
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
    const filePath = resolveStoredCustomerIdentityDocument(filename);
    if (!filePath) return res.status(404).json({ error: 'Identity document not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(filePath);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/student-approvals', adminJwt, requirePerm('manageCustomers'), async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const filter = { role: 'customer', isStudent: true };
    if (['pending', 'approved', 'rejected'].includes(status)) filter.studentVerificationStatus = status;
    const students = await User.find(filter)
      .select('name email phone cnicNumber nationalIdLast4 studentIdNumber studentInstitution isStudent studentVerificationStatus studentVerifiedAt createdAt +customerIdFront +customerIdBack +studentIdImage')
      .sort('-createdAt').limit(200).lean();
    res.json(students.map(student => ({
      ...student,
      hasCnicFront: !!student.customerIdFront,
      hasCnicBack: !!student.customerIdBack,
      hasStudentIdImage: !!student.studentIdImage,
      customerIdFront: undefined,
      customerIdBack: undefined,
      studentIdImage: undefined
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/student-documents/:userId/:field', adminJwt, requirePerm('manageCustomers'), async (req, res) => {
  const fields = { cnicFront: 'customerIdFront', cnicBack: 'customerIdBack', studentIdImage: 'studentIdImage' };
  const field = fields[req.params.field];
  if (!field) return res.status(404).json({ error: 'Document not found' });
  try {
    const student = await User.findOne({ _id: req.params.userId, role: 'customer', isStudent: true })
      .select(`+${field}`);
    const filename = student?.[field];
    const filePath = resolveStoredCustomerIdentityDocument(filename);
    if (!filePath) return res.status(404).json({ error: 'Document not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('image/jpeg').sendFile(filePath);
  } catch (err) { res.status(500).json({ error: 'Unable to retrieve document' }); }
});

app.patch('/api/admin/student-approvals/:id', adminJwt, requirePerm('manageCustomers'), async (req, res) => {
  try {
    const status = String(req.body?.status || '').trim();
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Student status must be approved or rejected' });
    const student = await User.findOneAndUpdate(
      {
        _id: req.params.id,
        role: 'customer',
        isStudent: true,
        identityVerificationStatus: 'approved'
      },
      {
        studentVerificationStatus: status,
        studentVerifiedAt: status === 'approved' ? new Date() : null,
        accountStatus: status === 'approved' ? 'active' : 'pending'
      },
      { new: true }
    ).select('-password');
    if (!student) return res.status(404).json({ error: 'Student application not found' });
    io.to(`user:${student._id}`).emit('student-verification:updated', {
      status,
      accountStatus: student.accountStatus
    });
    res.json({ success: true, user: student });
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

// POST /api/admin/sub-users/create — super-admin only; enforces 200-user cap
app.post('/api/admin/sub-users/create', adminJwt, requireSuperAdmin, async (req, res) => {
  try {
    const count = await SubAdmin.countDocuments();
    if (count >= 200) return res.status(400).json({ error: 'Maximum limit of 200 sub-admin users reached.' });
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

// A requested ride is still an open booking offer, not an ongoing trip. The
// Overview "Active Rides" metric follows the same assigned/ongoing states used
// by the Customer and Driver active-ride surfaces.
const ADMIN_ACTIVE_RIDE_STATUSES = ['accepted', 'arrived', 'in-progress'];

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
        Ride.countDocuments({ status: { $in: ADMIN_ACTIVE_RIDE_STATUSES } }),
        Payment.countDocuments({ status: 'pending' }),
        SOS.countDocuments({ resolved: false })
      ]);
    const [earningsAgg, currentAdvanceDeposits] = await Promise.all([
      Payment.aggregate([
      { $match: { status: 'approved', updatedAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      getCurrentDriverAdvanceDeposits()
    ]);
    res.json({
      totalDrivers, pendingDrivers, suspendedDrivers, totalPassengers,
      blockedPassengers, activeRides, pendingPayments, unresolvedSOS,
      todayEarnings: earningsAgg[0]?.total || 0,
      currentAdvanceDeposits
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/advance-bookings — permission-scoped scheduled ride operations.
// Customer and Driver contact details are returned only to authenticated Admins;
// push tokens and private identity documents never leave the server.
app.get('/api/admin/advance-bookings', adminJwt, requirePerm('viewAdvanceBookings'), async (req, res) => {
  try {
    const allowedStatuses = new Set(['pending', 'assigned', 'dispatching', 'converted', 'cancelled', 'failed']);
    const requestedStatus = String(req.query.status || 'all').trim().toLowerCase();
    if (requestedStatus !== 'all' && !allowedStatuses.has(requestedStatus)) {
      return res.status(400).json({ error: 'Unsupported advance-booking status' });
    }
    const query = requestedStatus === 'all' ? {} : { status: requestedStatus };
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    if (from && Number.isNaN(from.getTime())) return res.status(400).json({ error: 'Invalid start date' });
    if (to && Number.isNaN(to.getTime())) return res.status(400).json({ error: 'Invalid end date' });
    if (from || to) {
      query.scheduledFor = {};
      if (from) query.scheduledFor.$gte = from;
      if (to) {
        to.setHours(23, 59, 59, 999);
        query.scheduledFor.$lte = to;
      }
    }

    const bookings = await AdvanceBooking.find(query)
      .sort({ scheduledFor: 1, createdAt: -1 })
      .limit(500)
      .lean();
    const customerIds = bookings.map(booking => booking.passenger).filter(id => mongoose.isValidObjectId(id));
    const rideIds = bookings.map(booking => booking.ride).filter(id => mongoose.isValidObjectId(id));
    const [customers, rides] = await Promise.all([
      Customer.find({ _id: { $in: customerIds } }).select('name phone email').lean(),
      Ride.find({ _id: { $in: rideIds } }).select('status driver').lean()
    ]);
    const driverIds = [
      ...bookings.map(booking => booking.driver),
      ...rides.map(ride => ride.driver)
    ].filter(id => mongoose.isValidObjectId(id));
    const drivers = await Driver.find({ _id: { $in: driverIds } })
      .select('name phone email vehicleType vehicleModel vehiclePlate rating')
      .lean();
    const customerMap = new Map(customers.map(customer => [String(customer._id), customer]));
    const driverMap = new Map(drivers.map(driver => [String(driver._id), driver]));
    const rideMap = new Map(rides.map(ride => [String(ride._id), ride]));
    res.json(bookings.map(booking => adminAdvanceBookingResponse(
      booking,
      customerMap.get(String(booking.passenger)),
      driverMap.get(String(booking.driver || rideMap.get(String(booking.ride))?.driver)),
      rideMap.get(String(booking.ride))
    )));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/advance-bookings/:id/assignment-options', adminJwt, requirePerm('manageAdvanceBookings'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Valid booking id required' });
    const booking = await AdvanceBooking.findOne({
      _id: req.params.id,
      status: 'pending',
      driver: null
    }).lean();
    if (!booking) return res.status(409).json({ error: 'Only unassigned pending bookings can be assigned' });
    const vehicleTypes = storedVehicleTypesForFareCategory(booking.vehicleType);
    const drivers = await findDriverDocuments({
      accountStatus: 'active',
      isOnline: true,
      lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
      vehicleType: { $in: vehicleTypes }
    }, {
      select: '_id name phone vehicleType vehicleModel vehiclePlate rating ridePreference longRangeEnabled paidUntilDate lastDailyFeePaidAt isOnline lastOnlineHeartbeat'
    });
    const feeEligibleDrivers = [];
    for (const driver of drivers) {
      if (!canDriverReceiveRideForPreference(driver.ridePreference, booking.isLongRange)) continue;
      const fee = await getDriverDailyFeeEligibility(driver);
      if (fee.allowed) {
        feeEligibleDrivers.push({
          id: String(driver._id),
          name: driver.name || 'Driver',
          phone: driver.phone || '',
          vehicleType: driver.vehicleType || '',
          vehicleModel: driver.vehicleModel || '',
          vehiclePlate: driver.vehiclePlate || '',
          rating: driver.rating ?? null
        });
      }
    }
    res.json(feeEligibleDrivers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/advance-bookings/:id/assign', adminJwt, requirePerm('manageAdvanceBookings'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Valid booking id required' });
    const driverId = String(req.body?.driverId || '');
    if (!mongoose.isValidObjectId(driverId)) return res.status(400).json({ error: 'Valid driverId required' });
    const booking = await AdvanceBooking.findOne({
      _id: req.params.id,
      status: 'pending',
      driver: null,
      scheduledFor: { $gt: new Date() }
    }).lean();
    if (!booking) return res.status(409).json({ error: 'Advance booking is no longer available for assignment' });
    const [driver] = await findDriverDocuments({
      _id: driverId,
      accountStatus: 'active',
      isOnline: true,
      lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) }
    }, {
      select: '_id name phone vehicleType vehicleModel vehiclePlate rating ridePreference longRangeEnabled paidUntilDate lastDailyFeePaidAt isOnline lastOnlineHeartbeat'
    });
    if (!driver) return res.status(409).json({ error: 'Selected Driver is not active' });
    if (!storedVehicleTypesForFareCategory(booking.vehicleType).includes(driver.vehicleType)) {
      return res.status(409).json({ error: 'Selected Driver does not match the booking vehicle category' });
    }
    if (!canDriverReceiveRideForPreference(driver.ridePreference, booking.isLongRange)) {
      return res.status(409).json({ error: 'Selected Driver ride preference does not support this booking' });
    }
    const fee = await getDriverDailyFeeEligibility(driver);
    if (!fee.allowed) return res.status(403).json({ error: fee.reason, code: 'DAILY_FEE_REQUIRED' });
    const overlap = await AdvanceBooking.exists({
      driver: driverId,
      status: 'assigned',
      scheduledFor: {
        $gte: new Date(booking.scheduledFor.getTime() - 90 * 60 * 1000),
        $lte: new Date(booking.scheduledFor.getTime() + 90 * 60 * 1000)
      }
    });
    if (overlap) return res.status(409).json({ error: 'That Driver already has an advance booking near this time.' });
    const activeRide = await Ride.exists({
      driver: driverId,
      status: { $in: ADMIN_ACTIVE_RIDE_STATUSES }
    });
    if (activeRide) return res.status(409).json({ error: 'That Driver is currently on an active ride.' });
    const assignedBooking = await AdvanceBooking.findOneAndUpdate(
      {
        _id: booking._id,
        status: 'pending',
        driver: null,
        scheduledFor: { $gt: new Date() }
      },
      {
        $set: {
          driver: driverId,
          status: 'assigned',
          assignedAt: new Date(),
          fare: booking.fare,
          counterOffers: []
        }
      },
      { new: true }
    )
      .populate('passenger', 'name phone')
      .populate('driver', 'name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    if (!assignedBooking) return res.status(409).json({ error: 'Advance booking was already assigned to another Driver' });
    const response = advanceBookingResponse(assignedBooking);
    emitAdvanceBookingAssignment(assignedBooking, response);
    io.to(`user:${assignedBooking.passenger?._id || booking.passenger}`).emit('advance-booking:assigned', response);
    io.to('admin-room').emit('advance-booking:assigned', response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/advance-bookings/:id/reminder', adminJwt, requirePerm('manageAdvanceBookingReminders'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Valid booking id required' });
    const result = await sendAdvanceBookingReminder(req.params.id, {
      force: true,
      notifyCustomer: req.body?.notifyCustomer !== false
    });
    res.json({ bookingId: req.params.id, ...result });
  } catch (err) {
    const status = /not found|assigned|already being sent|after a Driver/i.test(err.message) ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
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
    const allowedRoles = adminSearchableRoles(req.admin);
    const users = await User.find({
      $and: [
        { role: { $in: allowedRoles } },
         { $or: liveLocationSearchFields(matcher) }
      ]
    })
      .select('name email phone role cnicNumber vehicleType vehicleModel vehiclePlate accountStatus suspendReason suspendedAt isOnline rating totalRides createdAt profilePhoto cnicFront cnicBack licensePhoto vehicleRegPhoto identityVerificationStatus identityVerifiedAt +customerIdFront +customerIdBack')
      .sort({ role: 1, name: 1 })
      .limit(50)
      .lean();
    res.json(users.map(user => ({
      ...user,
      cnicFront: user.role === 'driver' ? !!user.cnicFront : user.cnicFront,
      cnicBack: user.role === 'driver' ? !!user.cnicBack : user.cnicBack,
      licensePhoto: user.role === 'driver' ? !!user.licensePhoto : user.licensePhoto,
      vehicleRegPhoto: user.role === 'driver' ? !!user.vehicleRegPhoto : user.vehicleRegPhoto,
      hasCustomerIdentityDocuments: user.role === 'customer' && !!(user.customerIdFront || user.customerIdBack),
      customerIdFront: undefined,
      customerIdBack: undefined
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/map-search?q= — only returns users whose coordinates are both
// authorized and fresh. Customer results are limited to active rides that
// explicitly share their location; idle Customers are never tracked for Admin
// map search.
app.get('/api/admin/map-search', adminJwt, requireProfileSearchAccess, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json([]);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(escaped, 'i');
    const users = await User.find({
      role: { $in: adminSearchableRoles(req.admin) },
      accountStatus: 'active',
      $or: liveLocationSearchFields(matcher)
    })
      .select('name phone role accountStatus isOnline lastOnlineHeartbeat currentLocation vehicleType vehicleModel vehiclePlate')
      .sort({ role: 1, name: 1 })
      .limit(50)
      .lean();
    const locations = await Promise.all(users.map(user => getAdminMapLocationForUser(user)));
    res.json(locations.filter(Boolean));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/live-locations — returns the complete fresh live-location
// snapshot for the dashboard map. Drivers must be online with a fresh
// heartbeat; Customers are included only when an active ride is sharing a
// fresh passenger location with the platform.
app.get('/api/admin/live-locations', adminJwt, requireProfileSearchAccess, async (req, res) => {
  try {
    const now = new Date();
    const allowedRoles = adminSearchableRoles(req.admin);
    const locations = [];

    if (allowedRoles.includes('driver')) {
      const heartbeatAfter = new Date(now.getTime() - DRIVER_HEARTBEAT_MAX_AGE_MS);
      const drivers = await findDriverDocuments({
        accountStatus: 'active',
        isOnline: true,
        lastOnlineHeartbeat: { $gte: heartbeatAfter }
      }, {
        select: 'name phone role accountStatus isOnline lastOnlineHeartbeat currentLocation vehicleType vehicleModel vehiclePlate'
      });
      drivers.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      drivers.forEach(driver => {
        if (!hasValidCoordinates(driver.currentLocation)) return;
        locations.push({
          _id: driver._id,
          name: driver.name,
          role: 'driver',
          phone: driver.phone || '',
          vehicleType: driver.vehicleType || '',
          vehicleModel: driver.vehicleModel || '',
          vehiclePlate: driver.vehiclePlate || '',
          status: 'online',
          location: { lat: Number(driver.currentLocation.lat), lng: Number(driver.currentLocation.lng) },
          updatedAt: driver.lastOnlineHeartbeat
        });
      });
    }

    if (allowedRoles.includes('customer')) {
      const sharedAfter = new Date(now.getTime() - CUSTOMER_SHARED_LOCATION_MAX_AGE_MS);
      const rides = await Ride.find({
        status: { $in: ['accepted', 'arrived', 'in-progress'] },
        passengerLocationUpdatedAt: { $gte: sharedAfter }
      })
        .select('passenger passengerLocation passengerLocationUpdatedAt status')
        .populate('passenger', 'name phone role accountStatus')
        .sort('-passengerLocationUpdatedAt')
        .lean();
      const seenCustomers = new Set();
      rides.forEach(ride => {
        const customer = ride.passenger;
        if (
          !customer || customer.role !== 'customer' || customer.accountStatus !== 'active' ||
          seenCustomers.has(String(customer._id)) || !hasValidCoordinates(ride.passengerLocation)
        ) return;
        seenCustomers.add(String(customer._id));
        locations.push({
          _id: customer._id,
          name: customer.name,
          role: 'customer',
          phone: customer.phone || '',
          status: ride.status,
          location: { lat: Number(ride.passengerLocation.lat), lng: Number(ride.passengerLocation.lng) },
          updatedAt: ride.passengerLocationUpdatedAt
        });
      });
    }

    res.json(locations);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/map-location/:userId — refreshes the selected map pin from
// authoritative persisted coordinates. Role permissions are checked again on
// each poll so permission revocations take effect without a page reload.
app.get('/api/admin/map-location/:userId', adminJwt, requireProfileSearchAccess, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid user id' });
    const user = await User.findById(req.params.userId)
      .select('name phone role accountStatus isOnline lastOnlineHeartbeat currentLocation vehicleType vehicleModel vehiclePlate')
      .lean();
    if (!user) return res.status(404).json({ error: 'Person not found' });
    if (!adminCanViewUserLocation(req.admin, user.role)) return res.status(403).json({ error: 'Permission denied for this person' });
    const location = await getAdminMapLocationForUser(user);
    if (!location) return res.status(404).json({ error: 'No fresh live location is available for this person.' });
    res.json(location);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/drivers?status=all|pending|approved|suspended|blocked
app.get('/api/admin/drivers', adminJwt, requirePerm('viewDrivers'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'driver' };
    if (status && status !== 'all') filter.accountStatus = status;
    const driverQuery = User.find(filter)
      .select('-password -otpCode -otpExpiry')
      .sort('-createdAt').limit(200);
    const includeCounts = req.query.includeCounts === 'true';
    const [drivers, counts] = await Promise.all([
      driverQuery,
      includeCounts
        ? Promise.all([
            User.countDocuments({ role: 'driver' }),
            User.countDocuments({ role: 'driver', accountStatus: 'active' }),
            User.countDocuments({ role: 'driver', accountStatus: 'pending' }),
            User.countDocuments({ role: 'driver', accountStatus: 'suspended' }),
            User.countDocuments({ role: 'driver', accountStatus: 'blocked' })
          ]).then(([all, active, pending, suspended, blocked]) => ({
            all, active, pending, suspended, blocked
          }))
        : null
    ]);
    const wallets = await getDriverWalletSnapshots(drivers.map(driver => driver._id));
    const walletsByDriver = new Map(wallets.map(wallet => [String(wallet.user), wallet]));
    // Keep private document filenames out of list/search payloads. The Admin
    // document route below exposes bytes only after an authenticated check.
    const records = drivers.map(driver => {
      const value = driver.toObject();
      return {
        ...value,
        onlineStartedAt: value.isOnline ? value.onlineStartedAt || null : null,
        nextFeeDeductionAt: value.paidUntilDate || null,
        cnicFront: !!value.cnicFront,
        cnicBack: !!value.cnicBack,
        licensePhoto: !!value.licensePhoto,
        vehicleRegPhoto: !!value.vehicleRegPhoto,
        ...getAdminWalletBalances(walletsByDriver.get(String(value._id)))
      };
    });
    res.json(includeCounts ? { records, counts } : records);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/driver-documents/:id/:field — authenticated Admin document
// preview/download. This also supports legacy files that were written before
// driver identity documents were made private.
app.get('/api/admin/driver-documents/:id/:field', adminJwt, requirePerm('viewDrivers'), async (req, res) => {
  const allowedFields = new Set(['profilePhoto', 'cnicFront', 'cnicBack', 'licensePhoto', 'vehicleRegPhoto']);
  if (!allowedFields.has(req.params.field)) return res.status(404).json({ error: 'Document not found' });
  try {
    const driver = await User.findOne({ _id: req.params.id, role: 'driver' })
      .select('profilePhoto cnicFront cnicBack licensePhoto vehicleRegPhoto')
      .lean();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const filePath = resolveStoredDriverDocument(driver[req.params.field], req.params.field);
    if (!filePath) return res.status(404).json({ error: 'Document not found' });
    res.set('Cache-Control', 'private, no-store');
    res.type('image/jpeg').sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Unable to retrieve document' });
  }
});

// PATCH /api/admin/drivers/:id/ride-preference — an administrator can correct
// a Driver's local/Long Range scope. Switching from Long Range Only applies
// the normal Daily Fee rule immediately if the active Driver is overdue.
app.patch('/api/admin/drivers/:id/ride-preference', adminJwt, requirePerm('manageDriverStatus'), async (req, res) => {
  try {
    const ridePreference = String(req.body?.ridePreference || '').trim();
    if (!DRIVER_RIDE_PREFERENCES.includes(ridePreference)) {
      return res.status(400).json({ error: `Ride preference must be one of: ${DRIVER_RIDE_PREFERENCES.join(', ')}` });
    }
    const driver = await User.findOne({ _id: req.params.id, role: 'driver' })
      .select('name vehicleType accountStatus isOnline onlineStartedAt paidUntilDate lastDailyFeePaidAt isFreeTrial ridePreference')
      .lean();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    await User.updateOne({ _id: driver._id }, { ridePreference });
    const updatedDriver = { ...driver, ridePreference };
    const dailyFee = updatedDriver.accountStatus === 'active' && updatedDriver.isOnline !== false
      ? await chargeDailyFeeForOnlineDriver(updatedDriver._id, updatedDriver)
      : { allowed: true, charged: false };
    io.to(`user:${driver._id}`).emit('ride-preference:updated', { ridePreference, dailyFee });
    res.json({ driver: { id: driver._id, name: driver.name, ridePreference }, dailyFee });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/drivers/:id/device-binding — enable or disable the
// per-Driver app/browser installation lock. Raw device identifiers never leave
// the server and enabling invalidates the current session so an old session
// cannot bypass the newly enabled restriction.
app.patch('/api/admin/drivers/:id/device-binding', adminJwt, requirePerm('manageDriverStatus'), async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Device Binding must be ON or OFF' });
    }
    const driver = await User.findOne({ _id: req.params.id, role: 'driver' })
      .select('name deviceBindingEnabled').lean();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const update = { deviceBindingEnabled: req.body.enabled };
    if (req.body.enabled) {
      // Force a fresh login on the registered device. If this is a legacy
      // Driver without a recorded device, the next successful login enrolls it.
      update.activeSessionToken = null;
      update.activeSessionDeviceHash = null;
    }
    await User.updateOne({ _id: driver._id, role: 'driver' }, { $set: update });
    if (req.body.enabled) io.in(`user:${driver._id}`).disconnectSockets(true);
    io.to(`user:${driver._id}`).emit('driver:device-binding-updated', { enabled: req.body.enabled });
    res.json({
      driver: { id: driver._id, name: driver.name, deviceBindingEnabled: req.body.enabled },
      message: `Device Binding turned ${req.body.enabled ? 'ON' : 'OFF'}`
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/passengers?status=all|pending|active|blocked
app.get('/api/admin/passengers', adminJwt, requirePerm('viewCustomers'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'customer' };
    if (['pending', 'active', 'blocked', 'suspended'].includes(status)) filter.accountStatus = status;
    const passengerQuery = User.find(filter)
      // Keep the projection exclusion-only. Mixing inclusion fields with
      // exclusions makes Mongoose reject the query before it reaches MongoDB.
      .select('-password -otpCode -otpExpiry')
      .sort('-createdAt').limit(200);
    const includeCounts = req.query.includeCounts === 'true';
    const [passengers, counts] = await Promise.all([
      passengerQuery,
      includeCounts
        ? Promise.all([
            User.countDocuments({ role: 'customer' }),
            User.countDocuments({ role: 'customer', accountStatus: 'active' }),
            User.countDocuments({ role: 'customer', accountStatus: 'pending' }),
            User.countDocuments({ role: 'customer', accountStatus: 'suspended' }),
            User.countDocuments({ role: 'customer', accountStatus: 'blocked' })
          ]).then(([all, active, pending, suspended, blocked]) => ({
            all, active, pending, suspended, blocked
          }))
        : null
    ]);
    // Attach ride count to each passenger
    const withCounts = await Promise.all(passengers.map(async p => {
      const rideCount = await Ride.countDocuments({ passenger: p._id });
      return { ...p.toObject(), rideCount };
    }));
    res.json(includeCounts ? { records: withCounts, counts } : withCounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/users/:id/status — approve|suspend|block|unblock
app.patch('/api/admin/users/:id/status', adminJwt, async (req, res) => {
  try {
    const { action, reason } = req.body;
    const target = await User.findById(req.params.id).select('role isStudent studentVerificationStatus');
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
    if (
      target.role === 'customer'
      && target.isStudent === true
      && target.studentVerificationStatus !== 'approved'
      && ['approve', 'unblock'].includes(action)
    ) {
      return res.status(409).json({
        error: 'Student accounts must be approved from the Student Approvals panel after document review'
      });
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
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const purged = await purgeUserAccount(req.params.id);
    if (!purged) return res.status(404).json({ error: 'User not found' });
    res.json({
      success: true,
      name: purged.name,
      role: purged.role,
      counts: purged.counts
    });
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
    const adminActor = paymentAdminActor(req.admin);
    const operation = await runIdempotentFinancialOperation({
      req,
      scope: 'admin-payment-approve',
      actorId: adminActor.id,
      request: {
        paymentId: String(req.params.id),
        note: String(req.body?.note || '').trim()
      },
      work: async session => {
        const approved = await approveDriverPayment(
          req.params.id,
          req.admin,
          req.body?.note,
          { session }
        );
        if (!approved) return null;
        return {
          paymentId: String(approved.payment._id),
          balanceBefore: approved.balanceBefore,
          passValidUntil: approved.passValidUntil?.toISOString() || null,
          feeResult: approved.feeResult ? {
            charged: !!approved.feeResult.charged,
            rate: approved.feeResult.rate ?? null,
            fundingSource: approved.feeResult.fundingSource || null
          } : null
        };
      }
    });
    if (!operation.result) {
      return res.status(409).json({ error: 'Payment is no longer pending and cannot be approved again.' });
    }
    const [payment, wallet] = await Promise.all([
      Payment.findById(operation.result.paymentId),
      Wallet.findOne({ user: (await Payment.findById(operation.result.paymentId).select('driver'))?.driver })
    ]);
    if (!payment || !wallet) {
      return res.status(503).json({ error: 'Approved payment requires reconciliation before it can be displayed.' });
    }
    const approved = {
      payment,
      wallet,
      balanceBefore: operation.result.balanceBefore,
      passValidUntil: operation.result.passValidUntil
        ? new Date(operation.result.passValidUntil)
        : null,
      feeResult: operation.result.feeResult
    };
    const notification = {
      paymentId: String(approved.payment._id),
      trxId: approved.payment.trxId,
      amount: approved.payment.amount,
      status: 'approved',
      paidUntilDate: approved.passValidUntil?.toISOString() || null,
      dailyFee: approved.feeResult?.charged ? {
        amount: approved.feeResult.rate,
        fundingSource: approved.feeResult.fundingSource
      } : null
    };
    if (!operation.replayed) {
      io.to(`user:${approved.payment.driver}`).emit('payment:approved', notification);
      io.to('admin-room').emit('payment:approved', notification);
    }
    res.json({
      success: true,
      payment: approved.payment,
      balanceBefore: approved.balanceBefore,
      balanceAfter: approved.wallet.balance,
      passValidUntil: approved.passValidUntil
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.patch('/api/admin/payments/:id/reject', adminJwt, requirePerm('approveWalletTopups'), async (req, res) => {
  try {
    const { reason } = req.body;
    const operation = await runIdempotentFinancialOperation({
      req,
      scope: 'admin-payment-reject',
      actorId: paymentAdminActor(req.admin).id,
      request: {
        paymentId: String(req.params.id),
        reason: String(reason || '').trim()
      },
      work: async session => {
        const payment = await rejectDriverPayment(
          req.params.id,
          req.admin,
          reason,
          { session }
        );
        return payment ? { paymentId: String(payment._id) } : null;
      }
    });
    const payment = operation.result
      ? await Payment.findById(operation.result.paymentId)
      : null;
    if (!payment) return res.status(409).json({ error: 'Payment is no longer pending and cannot be rejected.' });
    if (!operation.replayed) {
      io.to(`user:${payment.driver}`).emit('payment:rejected', { reason: reason || 'Rejected' });
    }
    res.json({ success: true, payment });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
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
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Only Drivers can update driver documents' });
    const { profilePhoto, licensePhoto, cnicFront, cnicBack, vehicleRegPhoto } = req.body;
    const update = {};
    if (profilePhoto    !== undefined) update.profilePhoto    = await saveDriverProfilePhoto(profilePhoto);
    if (licensePhoto    !== undefined) update.licensePhoto    = await savePrivateDriverDocument(licensePhoto,    'license');
    if (cnicFront       !== undefined) update.cnicFront       = await savePrivateDriverDocument(cnicFront,       'cnicFront');
    if (cnicBack        !== undefined) update.cnicBack        = await savePrivateDriverDocument(cnicBack,        'cnicBack');
    if (vehicleRegPhoto !== undefined) update.vehicleRegPhoto = await savePrivateDriverDocument(vehicleRegPhoto, 'vehicleReg');
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No documents provided' });
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

function utcDayBounds(date = new Date()) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function walletAdvanceDepositTotal(wallet) {
  return (wallet?.transactions || []).reduce((total, transaction) => {
    const description = String(transaction.description || '');
    const isRecharge = transaction.type === 'credit'
      && /^Approved driver recharge\b/i.test(description);
    const amount = Number(transaction.amount || 0);
    const realAmount = Number(transaction.realAmount || 0);
    return total + (isRecharge ? (realAmount > 0 ? realAmount : amount) : 0);
  }, 0);
}

async function getDriverTodayIncome(driverId, day = new Date()) {
  const { start, end } = utcDayBounds(day);
  const driverObjectId = new mongoose.Types.ObjectId(String(driverId));
  const result = await Ride.aggregate([
    {
      $match: {
        driver: driverObjectId,
        status: 'completed',
        settlementStatus: 'settled'
      }
    },
    {
      $addFields: {
        payoutDate: { $ifNull: ['$settledAt', { $ifNull: ['$updatedAt', '$createdAt'] }] },
        payoutAmount: {
          $ifNull: ['$settledDriverEarnings', { $ifNull: ['$settledFare', '$fare'] }]
        }
      }
    },
    {
      $match: {
        payoutDate: { $gte: start, $lt: end }
      }
    },
    {
      $group: {
        _id: null,
        todayIncome: { $sum: '$payoutAmount' },
        todayCompletedRides: { $sum: 1 }
      }
    }
  ]);
  return {
    todayIncome: Number((result[0]?.todayIncome || 0).toFixed(2)),
    todayCompletedRides: Number(result[0]?.todayCompletedRides || 0)
  };
}

// GET /api/wallet/summary — driver's source-aware financial dashboard
app.get('/api/wallet/summary', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
    const driver = await User.findById(req.user.id).select('vehicleType');
    const vehicleType = normalizeFareVehicle(driver?.vehicleType || 'Car Mini Non-AC');

    const wallet = await Wallet.findOne({ user: req.user.id });
    const transactions = wallet?.transactions || [];

    const sourceBalances = getWalletSourceBalances(wallet);
    const { todayIncome, todayCompletedRides } = await getDriverTodayIncome(req.user.id);
    const advanceDeposits = Number(walletAdvanceDepositTotal(wallet).toFixed(2));

    // Recent ledger — last 40 entries newest first
    const ledger = [...transactions].reverse().slice(0, 40).map(t => ({
      amount: t.amount, type: t.type, description: t.description, createdAt: t.createdAt
    }));

    // Today's payment submission
    const todayPayment = await Payment.findOne({ driver: req.user.id, submittedDate: todayUTC() });

    const currentWalletBalance = sourceBalances.realCashAvailable;
    const bonusWalletAmt = sourceBalances.bonusAvailable;
    const spendableBalance = roundWalletAmount(currentWalletBalance + bonusWalletAmt);
    res.json({
      balance: spendableBalance,
      totalBonus: bonusWalletAmt,
      currentWalletBalance,
      currentBonus: bonusWalletAmt,
      todayIncome,
      todayCompletedRides,
      advanceDeposits,
      realCashRecharges: advanceDeposits,
      vehicleType,
      ledger,
      todayPayment: todayPayment || null,
      // Keep the legacy names for older Driver clients while exposing the
      // source-aware values they should render.
      realCashWallet: currentWalletBalance,
      bonusWallet: bonusWalletAmt,
      realCashAvailable: currentWalletBalance,
      bonusAvailable: bonusWalletAmt
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/support/ticket', authMiddleware, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject?.trim() || !message?.trim()) return res.status(400).json({ error: 'Subject and message required' });
    const role = req.user.role === 'driver' ? 'driver' : 'customer';
    const ticket = await Ticket.create({
      user: req.user.id,
      role,
      userModel: role === 'driver' ? 'Driver' : 'Customer',
      subject: subject.trim(), message: message.trim()
    });
    io.to('admin-room').emit('support:new', {
      ticketId: String(ticket._id),
      role: ticket.role,
      subject: ticket.subject
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
// Admin: Grant Free Bonus Credit
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/admin/drivers/grant-trial', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    const { driverIds, days, amount } = req.body;
    if (!Array.isArray(driverIds) || !driverIds.length)
      return res.status(400).json({ error: 'driverIds array required' });
    const bonusAmount = Number(amount);
    if (!Number.isFinite(bonusAmount) || bonusAmount <= 0)
      return res.status(400).json({ error: 'A valid bonus amount greater than Rs 0 is required' });
    const trialDays = Math.max(1, Math.min(365, parseInt(days) || 30));

    const trialStartDate = new Date();
    const paidUntilDate  = new Date();
    paidUntilDate.setDate(paidUntilDate.getDate() + trialDays);
    paidUntilDate.setUTCHours(23, 59, 59, 999);

    const operation = await runIdempotentFinancialOperation({
      req,
      scope: 'admin-grant-trial',
      actorId: paymentAdminActor(req.admin).id,
      request: {
        driverIds: [...new Set(driverIds.map(String))].sort(),
        trialDays,
        bonusAmount
      },
      work: async session => {
        let driverQuery = session
          ? Driver.find({ _id: { $in: driverIds } }).select('vehicleType name').session(session)
          : User.find({ _id: { $in: driverIds }, role: 'driver' }).select('vehicleType name');
        const drivers = await driverQuery;
        const driverModel = session ? Driver : User;
        const results = [];
        for (const driver of drivers) {
          const wallet = await Wallet.findOneAndUpdate(
            { user: driver._id },
            {
              $inc: {
                balance: bonusAmount,
                bonusWallet: bonusAmount,
                bonusAvailable: bonusAmount
              },
              $push: {
                transactions: {
                  amount: bonusAmount,
                  type: 'credit',
                  description: `Admin Free Bonus Credit (Rs ${bonusAmount.toLocaleString('en-PK', { maximumFractionDigits: 2 })})`,
                  fundingSource: WALLET_FUNDING_SOURCES.BONUS,
                  realAmount: 0,
                  bonusAmount
                }
              }
            },
            { upsert: true, new: true, session }
          );
          if (!wallet) {
            throw financialError('Driver wallet could not be credited; the trial grant was rolled back.', 503, 'DRIVER_WALLET_UNAVAILABLE');
          }
          const driverUpdate = await driverModel.updateOne(
            { _id: driver._id },
            { paidUntilDate, isFreeTrial: true, trialStartDate },
            { session }
          );
          if (driverUpdate.matchedCount === 0 && driverUpdate.n === 0) {
            throw financialError('Driver account could not be updated; the trial grant was rolled back.', 503, 'DRIVER_UPDATE_FAILED');
          }
          results.push({ id: String(driver._id), name: driver.name, amount: bonusAmount });
        }
        return {
          success: true,
          credited: results.length,
          results,
          trialDays,
          bonusAmount,
          paidUntilDate: paidUntilDate.toISOString()
        };
      }
    });
    if (!operation.replayed) {
      operation.result.results.forEach(result => {
        io.to(`user:${result.id}`).emit('fee:waived', {
          paidUntilDate: operation.result.paidUntilDate,
          bonusAmount,
          isFreeTrial: true,
          trialStartDate: trialStartDate.toISOString()
        });
      });
    }
    res.json(operation.result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

// POST /api/admin/drivers/grant-wallet-bonus — credit a manual amount without changing fee access
app.post('/api/admin/drivers/grant-wallet-bonus', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    const { driverIds, amount } = req.body;
    if (!Array.isArray(driverIds) || !driverIds.length)
      return res.status(400).json({ error: 'driverIds array required' });
    const bonusAmount = Number(amount);
    if (!Number.isFinite(bonusAmount) || bonusAmount <= 0)
      return res.status(400).json({ error: 'A valid bonus amount greater than Rs 0 is required' });

    const operation = await runIdempotentFinancialOperation({
      req,
      scope: 'admin-grant-wallet-bonus',
      actorId: paymentAdminActor(req.admin).id,
      request: {
        driverIds: [...new Set(driverIds.map(String))].sort(),
        bonusAmount
      },
      work: async session => {
        let driverQuery = session
          ? Driver.find({ _id: { $in: driverIds } }).select('name').session(session)
          : User.find({ _id: { $in: driverIds }, role: 'driver' }).select('name');
        const drivers = await driverQuery;
        const results = [];
        for (const driver of drivers) {
          const wallet = await Wallet.findOneAndUpdate(
            { user: driver._id },
            {
              $inc: {
                balance: bonusAmount,
                bonusWallet: bonusAmount,
                bonusAvailable: bonusAmount
              },
              $push: {
                transactions: {
                  amount: bonusAmount,
                  type: 'credit',
                  description: `Admin Wallet Bonus Credit (Rs ${bonusAmount.toLocaleString('en-PK', { maximumFractionDigits: 2 })})`,
                  fundingSource: WALLET_FUNDING_SOURCES.BONUS,
                  realAmount: 0,
                  bonusAmount
                }
              }
            },
            { upsert: true, new: true, session }
          );
          if (!wallet) {
            throw financialError('Driver wallet could not be credited; the bonus was rolled back.', 503, 'DRIVER_WALLET_UNAVAILABLE');
          }
          results.push({ id: String(driver._id), name: driver.name, amount: bonusAmount });
        }
        return { success: true, credited: results.length, results, bonusAmount };
      }
    });
    if (!operation.replayed) {
      operation.result.results.forEach(result => {
        io.to(`user:${result.id}`).emit('wallet:bonus-credited', { bonusAmount });
      });
    }
    res.json(operation.result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
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
    if (!hasValidCoordinates({ lat, lng })) {
      return res.status(422).json({ error: 'Invalid coordinates', code: 'INVALID_COORDINATES' });
    }
    const { maximumRideBroadcastRadiusKm: radiusKm } = await getRideBroadcastSettings();
    const drivers = await User.find({
      role: 'driver', isOnline: true, accountStatus: 'active',
      lastOnlineHeartbeat: { $gte: new Date(Date.now() - DRIVER_HEARTBEAT_MAX_AGE_MS) },
      'currentLocation.lat': { $ne: 0 }, 'currentLocation.lng': { $ne: 0 }
    }).select('vehicleType currentLocation').lean();
    const nearby = drivers
      .filter(d => hasValidCoordinates(d.currentLocation)
        && haversineKm(lat, lng, d.currentLocation.lat, d.currentLocation.lng) <= radiusKm)
      .map(d => ({ vehicleType: d.vehicleType, lat: d.currentLocation.lat, lng: d.currentLocation.lng }));
    res.json(nearby);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/drivers/grant-fee-waiver — set paidUntilDate for selected drivers (waiver / advance pay)
app.post('/api/admin/drivers/grant-fee-waiver', adminJwt, requirePerm('manageDriverPasses'), async (req, res) => {
  try {
    const { driverIds, paidUntilDate, days } = req.body;
    if (!Array.isArray(driverIds) || !driverIds.length)
      return res.status(400).json({ error: 'driverIds array required' });
    if (paidUntilDate) {
      const until = new Date(paidUntilDate);
      if (isNaN(until)) return res.status(400).json({ error: 'Invalid date' });
      until.setUTCHours(23, 59, 59, 999);   // include the full selected day
      await User.updateMany({ _id: { $in: driverIds }, role: 'driver' }, { paidUntilDate: until });
      // Instantly notify each driver via socket so their Accept button lights up immediately
      driverIds.forEach(id => io.to(`user:${id}`).emit('fee:waived', { paidUntilDate: until.toISOString() }));
      return res.json({ success: true, count: driverIds.length, paidUntilDate: until });
    }

    const durationDays = Number(days);
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365)
      return res.status(400).json({ error: 'Choose a valid fee period from 1 to 365 days' });
    const drivers = await User.find({ _id: { $in: driverIds }, role: 'driver' }).select('_id paidUntilDate').lean();
    const now = new Date();
    await Promise.all(drivers.map(async driver => {
      const currentUntil = driver.paidUntilDate ? new Date(driver.paidUntilDate) : null;
      const base = currentUntil && !isNaN(currentUntil) && currentUntil > now ? currentUntil : now;
      const until = new Date(base);
      until.setDate(until.getDate() + durationDays);
      until.setUTCHours(23, 59, 59, 999);
      await User.updateOne({ _id: driver._id }, { paidUntilDate: until });
      io.to(`user:${driver._id}`).emit('fee:waived', { paidUntilDate: until.toISOString() });
    }));
    res.json({ success: true, count: drivers.length, days: durationDays });
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

function aliasListWithIds(value) {
  return normalizeCustomerLocationAliases(value).map(alias => ({
    ...alias,
    id: alias.id || crypto.randomUUID()
  }));
}

async function saveCustomerLocationAliases(aliases) {
  const value = aliasListWithIds(aliases);
  await Settings.findOneAndUpdate(
    { key: CUSTOMER_LOCATION_ALIASES_KEY },
    { key: CUSTOMER_LOCATION_ALIASES_KEY, value },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return value;
}

app.get('/api/admin/customer-location-aliases', adminJwt, requirePerm('manageLocationAliases'), async (_req, res) => {
  try {
    const doc = await Settings.findOne({ key: CUSTOMER_LOCATION_ALIASES_KEY }).lean();
    res.json({ aliases: aliasListWithIds(doc?.value) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/customer-location-aliases', adminJwt, requirePerm('manageLocationAliases'), async (req, res) => {
  try {
    const validated = validateCustomerLocationAlias(req.body);
    if (validated.errors.length) return res.status(422).json({ error: 'Invalid location alias', errors: validated.errors });
    const doc = await Settings.findOne({ key: CUSTOMER_LOCATION_ALIASES_KEY }).lean();
    const current = aliasListWithIds(doc?.value);
    if (current.length >= CUSTOMER_LOCATION_ALIAS_LIMIT) {
      return res.status(422).json({ error: `At most ${CUSTOMER_LOCATION_ALIAS_LIMIT} aliases can be configured` });
    }
    const alias = { ...validated.alias, id: crypto.randomUUID() };
    const aliases = await saveCustomerLocationAliases([...current, alias]);
    res.status(201).json({ success: true, alias, aliases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/customer-location-aliases/:id', adminJwt, requirePerm('manageLocationAliases'), async (req, res) => {
  try {
    const validated = validateCustomerLocationAlias(req.body);
    if (validated.errors.length) return res.status(422).json({ error: 'Invalid location alias', errors: validated.errors });
    const doc = await Settings.findOne({ key: CUSTOMER_LOCATION_ALIASES_KEY }).lean();
    const current = aliasListWithIds(doc?.value);
    const index = current.findIndex(alias => alias.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Location alias not found' });
    const alias = { ...validated.alias, id: req.params.id };
    current[index] = alias;
    const aliases = await saveCustomerLocationAliases(current);
    res.json({ success: true, alias, aliases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/customer-location-aliases/:id', adminJwt, requirePerm('manageLocationAliases'), async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: CUSTOMER_LOCATION_ALIASES_KEY }).lean();
    const current = aliasListWithIds(doc?.value);
    if (!current.some(alias => alias.id === req.params.id)) return res.status(404).json({ error: 'Location alias not found' });
    const aliases = await saveCustomerLocationAliases(current.filter(alias => alias.id !== req.params.id));
    res.json({ success: true, aliases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    primeCachedAdminSetting('ride_broadcast_settings', validated.settings);
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

app.get('/api/admin/vehicle-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    res.json({ settings: await getVehicleCategorySettings() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/vehicle-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const category = String(req.body?.category || '').trim();
    if (!FARE_VEHICLE_CATEGORIES.includes(category)) {
      return res.status(422).json({ error: 'A valid vehicle category is required' });
    }
    if (typeof req.body?.active !== 'boolean') {
      return res.status(422).json({ error: 'Active status must be true or false' });
    }
    const existing = await getVehicleCategorySettings();
    const settings = normalizeVehicleCategorySettings({
      ...existing,
      [category]: { active: req.body.active }
    });
    await Settings.findOneAndUpdate(
      { key: VEHICLE_CATEGORY_SETTINGS_KEY },
      { key: VEHICLE_CATEGORY_SETTINGS_KEY, value: settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    primeCachedAdminSetting(VEHICLE_CATEGORY_SETTINGS_KEY, settings);
    const payload = { settings, updatedAt: new Date().toISOString(), category };
    io.emit('vehicle-settings:updated', payload);
    res.json({ success: true, ...payload });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/waiting-rate-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    res.json({ settings: await getWaitingRateSettings({ force: true }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/waiting-rate-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const input = req.body?.waitingRateSettings ?? req.body?.settings;
    const validated = validateWaitingRateSettings(input);
    if (validated.errors.length) {
      return res.status(422).json({ error: 'Invalid Waiting / Stop Rate Settings', errors: validated.errors });
    }
    await Settings.findOneAndUpdate(
      { key: WAITING_RATE_SETTINGS_KEY },
      { key: WAITING_RATE_SETTINGS_KEY, value: validated.settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    clearWaitingRateSettingsCache();
    const settings = await getWaitingRateSettings({ force: true });
    await refreshActiveRideWaitingFares(settings);
    const payload = { settings, updatedAt: new Date().toISOString() };
    io.emit('waiting-rate-settings:updated', payload);
    res.json({ success: true, ...payload });
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
    const [ratesDoc, longRangeDoc, displayDoc, vehicleCategoryDoc, waitingRateDoc, studentDiscountDoc] = await Promise.all([
      Settings.findOne({ key: 'per_km_rates' }).lean(),
      Settings.findOne({ key: LONG_RANGE_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: CUSTOMER_FARE_DISPLAY_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: VEHICLE_CATEGORY_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: WAITING_RATE_SETTINGS_KEY }).lean(),
      Settings.findOne({ key: STUDENT_DISCOUNT_SETTINGS_KEY }).lean()
    ]);
    res.json({
      perKmRates: normalizePerKmRates(ratesDoc?.value),
      longRangeSettings: normalizeLongRangeSettings(longRangeDoc?.value),
      displaySettings: normalizeCustomerFareDisplaySettings(displayDoc?.value),
      vehicleCategories: FARE_VEHICLE_CATEGORIES.map(category => ({
        category,
        active: normalizeVehicleCategorySettings(vehicleCategoryDoc?.value)[category].active
      })),
      waitingRateSettings: normalizeWaitingRateSettings(waitingRateDoc?.value),
      studentFeatureEnabled: normalizeStudentDiscountSettings(studentDiscountDoc?.value).enabled
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/customer-fare-display-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    res.json(await getCustomerFareDisplaySettings());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/customer-fare-display-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const settings = normalizeCustomerFareDisplaySettings(req.body?.displaySettings);
    await Settings.findOneAndUpdate(
      { key: CUSTOMER_FARE_DISPLAY_SETTINGS_KEY },
      { key: CUSTOMER_FARE_DISPLAY_SETTINGS_KEY, value: settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const payload = { settings, updatedAt: new Date().toISOString() };
    io.emit('customer-fare-display-settings:updated', payload);
    res.json({ success: true, ...payload });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/student-discount-settings', adminJwt, requirePerm('manageFareSettings'), async (_req, res) => {
  try { res.json(await getStudentDiscountSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/student-discount-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const raw = Number(req.body?.discountPercent);
    const dailyLimitInput = req.body?.maxDiscountedRidesPerDay;
    const startTimeInput = req.body?.startTime;
    const endTimeInput = req.body?.endTime;
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
      return res.status(422).json({ error: 'Student discount must be a percentage from 0 to 100' });
    }
    if (dailyLimitInput !== undefined
      && (!Number.isInteger(Number(dailyLimitInput)) || Number(dailyLimitInput) < 0 || Number(dailyLimitInput) > 1000)) {
      return res.status(422).json({ error: 'Daily discounted ride limit must be a whole number from 0 to 1000' });
    }
    const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    if ((startTimeInput !== undefined && !validTime(startTimeInput))
      || (endTimeInput !== undefined && !validTime(endTimeInput))) {
      return res.status(422).json({ error: 'Student discount times must use HH:MM format' });
    }
    const currentSettings = await getStudentDiscountSettings();
    const settings = normalizeStudentDiscountSettings({
      enabled: req.body?.enabled !== false,
      discountPercent: raw,
      maxDiscountedRidesPerDay: dailyLimitInput ?? currentSettings.maxDiscountedRidesPerDay,
      startTime: startTimeInput ?? currentSettings.startTime,
      endTime: endTimeInput ?? currentSettings.endTime
    });
    await Settings.findOneAndUpdate(
      { key: STUDENT_DISCOUNT_SETTINGS_KEY },
      { key: STUDENT_DISCOUNT_SETTINGS_KEY, value: settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    io.emit('student-discount-settings:updated', { settings });
    res.json({ success: true, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/student-fair-quota-settings', adminJwt, requirePerm('manageFareSettings'), async (_req, res) => {
  try { res.json(await getStudentFairQuotaSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/student-fair-quota-settings', adminJwt, requirePerm('manageFareSettings'), async (req, res) => {
  try {
    const rawQuota = Number(req.body?.dailyQuota);
    if (!Number.isInteger(rawQuota) || rawQuota < 0 || rawQuota > 100) {
      return res.status(422).json({ error: 'Daily Student ride quota must be a whole number from 0 to 100' });
    }
    const settings = normalizeStudentFairQuotaSettings({ dailyQuota: rawQuota });
    await Settings.findOneAndUpdate(
      { key: STUDENT_FAIR_QUOTA_SETTINGS_KEY },
      { key: STUDENT_FAIR_QUOTA_SETTINGS_KEY, value: settings },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    io.emit('student-fair-quota-settings:updated', { settings });
    res.json({ success: true, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/student-ride-logs', adminJwt, requirePerm('manageFareSettings'), async (_req, res) => {
  try {
    const logs = await StudentRideResponseLog.find({})
      .sort({ occurredAt: -1 })
      .limit(250)
      .lean();
    res.json(logs.map(log => ({
      ...log,
      _id: String(log._id),
      rideId: String(log.ride),
      driverId: String(log.driver)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/student-ride-quota-status', adminJwt, requirePerm('manageFareSettings'), async (_req, res) => {
  try {
    const [settings, drivers] = await Promise.all([
      getStudentFairQuotaSettings(),
      User.find({ role: 'driver', accountStatus: 'active' })
        .select('_id name phone isOnline studentRideLastAssignedAt')
        .sort({ name: 1 })
        .lean()
    ]);
    const completedCounts = await getStudentRideCompletedCounts(drivers.map(driver => driver._id));
    res.json({
      dailyQuota: settings.dailyQuota,
      drivers: drivers.map(driver => ({
        driverId: String(driver._id),
        name: driver.name || '',
        phone: driver.phone || '',
        isOnline: driver.isOnline === true,
        completedStudentRides: completedCounts.get(String(driver._id)) || 0,
        remaining: settings.dailyQuota > 0
          ? Math.max(0, settings.dailyQuota - (completedCounts.get(String(driver._id)) || 0))
          : null
      }))
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
    primeCachedAdminSetting(LONG_RANGE_SETTINGS_KEY, validated.settings);
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
    io.emit('payment-settings:updated', { updatedAt: new Date().toISOString() });
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

const ADMIN_REVENUE_PERIODS = new Set([7, 30, 90, 365]);
const ADMIN_REVENUE_FIELDS = [
  'dailyFeeCollections',
  'bonusFundedDailyFees',
  'longRangeCommissions',
  'bonusFundedLongRangeCommissions',
  'bonusCredits',
  'advanceDeposits',
  'unclassifiedFeeDeductions'
];

function normalizeAdminRevenueDays(value) {
  const days = Number.parseInt(value, 10);
  return ADMIN_REVENUE_PERIODS.has(days) ? days : 30;
}

function adminRevenueTotals(bucket = {}) {
  const totals = Object.fromEntries(ADMIN_REVENUE_FIELDS.map(field => [
    field,
    Number((Number(bucket[field]) || 0).toFixed(2))
  ]));
  const grossRevenue = totals.dailyFeeCollections + totals.longRangeCommissions;
  const bonusNonRevenueEarnings = totals.bonusFundedDailyFees + totals.bonusFundedLongRangeCommissions;
  return {
    ...totals,
    // Approved Driver recharges are advance deposits, not operating revenue.
    approvedWalletFunding: totals.advanceDeposits,
    grossRevenue: Number(grossRevenue.toFixed(2)),
    netRevenue: Number(grossRevenue.toFixed(2)),
    bonusNonRevenueEarnings: Number(bonusNonRevenueEarnings.toFixed(2))
  };
}

function mergeAdminRevenueBuckets(...buckets) {
  return adminRevenueTotals(Object.fromEntries(ADMIN_REVENUE_FIELDS.map(field => [
    field,
    buckets.reduce((sum, bucket) => sum + (Number(bucket?.[field]) || 0), 0)
  ])));
}

function adminWalletRevenueGroup() {
  const description = { $ifNull: ['$transactions.description', ''] };
  const amount = { $ifNull: ['$transactions.amount', 0] };
  const source = { $ifNull: ['$transactions.fundingSource', WALLET_FUNDING_SOURCES.UNKNOWN] };
  const hasTrackedSource = {
    $in: [source, [
      WALLET_FUNDING_SOURCES.REAL,
      WALLET_FUNDING_SOURCES.BONUS,
      WALLET_FUNDING_SOURCES.MIXED
    ]]
  };
  const realAmount = {
    $cond: [
      { $in: [source, [WALLET_FUNDING_SOURCES.REAL, WALLET_FUNDING_SOURCES.MIXED]] },
      { $ifNull: ['$transactions.realAmount', amount] },
      0
    ]
  };
  const bonusAmount = {
    $cond: [
      { $in: [source, [WALLET_FUNDING_SOURCES.BONUS, WALLET_FUNDING_SOURCES.MIXED]] },
      { $ifNull: ['$transactions.bonusAmount', amount] },
      0
    ]
  };
  const isDailyFee = {
    $and: [
      { $eq: ['$transactions.type', 'debit'] },
      { $regexMatch: { input: description, regex: '^Automatic daily fee for going online', options: 'i' } }
    ]
  };
  const isLongRangeCommission = {
    $and: [
      { $eq: ['$transactions.type', 'debit'] },
      { $eq: [description, 'Long Range commission'] },
      { $eq: ['$transactions.revenueCategory', 'manual-long-range'] }
    ]
  };
  const isLegacyLongRangeCommission = {
    $and: [
      { $eq: ['$transactions.type', 'debit'] },
      { $eq: [description, 'Long Range commission'] },
      { $ne: ['$transactions.revenueCategory', 'manual-long-range'] }
    ]
  };
  const isBonus = {
    $and: [
      { $eq: ['$transactions.type', 'credit'] },
      { $regexMatch: { input: description, regex: 'bonus|trial|promotional', options: 'i' } }
    ]
  };
  const bonusCreditAmount = {
    $cond: [
      { $eq: ['$transactions.type', 'credit'] },
      {
        $cond: [
          { $in: [source, [WALLET_FUNDING_SOURCES.BONUS, WALLET_FUNDING_SOURCES.MIXED]] },
          { $ifNull: ['$transactions.bonusAmount', amount] },
          { $cond: [isBonus, amount, 0] }
        ]
      },
      0
    ]
  };
  const isLegacyFee = {
    $or: [
      {
        $and: [
          isDailyFee,
          { $not: [hasTrackedSource] }
        ]
      },
      isLegacyLongRangeCommission
    ]
  };
  return {
    _id: null,
    dailyFeeCollections: { $sum: { $cond: [isDailyFee, realAmount, 0] } },
    bonusFundedDailyFees: { $sum: { $cond: [isDailyFee, bonusAmount, 0] } },
    longRangeCommissions: { $sum: { $cond: [isLongRangeCommission, realAmount, 0] } },
    bonusFundedLongRangeCommissions: { $sum: { $cond: [isLongRangeCommission, bonusAmount, 0] } },
    bonusCredits: { $sum: bonusCreditAmount },
    unclassifiedFeeDeductions: { $sum: { $cond: [isLegacyFee, amount, 0] } }
  };
}

function adminRevenueTrendGroup() {
  return {
    ...adminWalletRevenueGroup(),
    _id: { $dateToString: { format: '%Y-%m-%d', date: '$transactions.createdAt', timezone: 'UTC' } }
  };
}

function adminPaymentRevenueGroup() {
  return { _id: null, advanceDeposits: { $sum: '$amount' } };
}

function adminPaymentRevenueTrendGroup() {
  return {
    _id: { $dateToString: { format: '%Y-%m-%d', date: '$_revenueDate', timezone: 'UTC' } },
    advanceDeposits: { $sum: '$amount' }
  };
}

async function getAdminRevenueAnalytics(days) {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const since = new Date(todayStart);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const walletPeriodMatch = { 'transactions.createdAt': { $gte: since } };
    const paymentRevenueMatch = { status: 'approved' };

    const [walletFacets, paymentFacets, currentAdvanceDeposits] = await Promise.all([
      Wallet.aggregate([
        { $unwind: '$transactions' },
        {
          $facet: {
            allTime: [{ $group: adminWalletRevenueGroup() }],
            period: [
              { $match: walletPeriodMatch },
              { $group: adminWalletRevenueGroup() }
            ],
            trend: [
              { $match: walletPeriodMatch },
              { $group: adminRevenueTrendGroup() },
              { $sort: { _id: 1 } }
            ]
          }
        }
      ]),
      Payment.aggregate([
        { $match: paymentRevenueMatch },
        {
          $addFields: {
            _revenueDate: { $ifNull: ['$approvedAt', { $ifNull: ['$updatedAt', '$createdAt'] }] }
          }
        },
        {
          $facet: {
            allTime: [{ $group: adminPaymentRevenueGroup() }],
            period: [
              { $match: { _revenueDate: { $gte: since } } },
              { $group: adminPaymentRevenueGroup() }
            ],
            trend: [
              { $match: { _revenueDate: { $gte: since } } },
              { $group: adminPaymentRevenueTrendGroup() },
              { $sort: { _id: 1 } }
            ]
          }
        }
      ]),
      getCurrentDriverAdvanceDeposits()
    ]);

    const wallet = walletFacets[0] || {};
    const payments = paymentFacets[0] || {};
    const allTime = mergeAdminRevenueBuckets(wallet.allTime?.[0], payments.allTime?.[0]);
    const period = mergeAdminRevenueBuckets(wallet.period?.[0], payments.period?.[0]);
    const walletTrend = Object.fromEntries((wallet.trend || []).map(row => [row._id, row]));
    const paymentTrend = Object.fromEntries((payments.trend || []).map(row => [row._id, row]));
    const trend = [];

    for (let index = 0; index < days; index += 1) {
      const date = new Date(since);
      date.setUTCDate(date.getUTCDate() + index);
      const dateKey = date.toISOString().slice(0, 10);
      trend.push({
        date: dateKey,
        ...mergeAdminRevenueBuckets(walletTrend[dateKey], paymentTrend[dateKey])
      });
    }

    return {
      asOf: new Date().toISOString(),
      days,
      periodStart: since.toISOString(),
      periodEnd: new Date().toISOString(),
      allTime,
      period,
      currentAdvanceDeposits,
      trend
    };
}

// GET /api/admin/revenue — persisted platform revenue and funding analytics
app.get('/api/admin/revenue', adminJwt, requirePerm('viewOverview'), async (req, res) => {
  try {
    res.json(await getAdminRevenueAnalytics(normalizeAdminRevenueDays(req.query.days)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy compatibility endpoint. It now exposes the same platform-revenue
// trend as /api/admin/revenue instead of approved recharge payments, which
// were never operating income.
app.get('/api/admin/daily-income', adminJwt, requirePerm('viewOverview'), async (_req, res) => {
  try {
    const revenue = await getAdminRevenueAnalytics(30);
    res.json(revenue.trend.map(day => ({
      date: day.date,
      total: day.netRevenue
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  res.json({ status: 'ok', db: getDatabaseStatus(), ts: new Date().toISOString() });
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
      if (page === 'admin' || page === 'customer') {
        // These routes bypass express.static because pages are preloaded at
        // startup. Do not let a browser, service worker, or reverse proxy
        // retain an older shell after a deployment.
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    if (socket.user.isAdmin) {
      const security = await getAdminSecurity();
      if (Number(socket.user.adminSessionVersion || 0) !== security.sessionVersion) {
        return next(new Error('Admin session expired'));
      }
    }
    if (socket.user.role === 'customer' || socket.user.role === 'driver') {
      const clientSession = socket.handshake.auth?.sessionToken;
      if (typeof clientSession !== 'string' || !clientSession) {
        return next(new Error('Session expired'));
      }
      const user = await User.findById(socket.user.id).select('activeSessionToken').lean();
      if (!user || user.activeSessionToken !== clientSession) {
        return next(new Error('Session expired'));
      }
    }
    next();
  } catch (err) {
    next(new Error(err?.name === 'JsonWebTokenError' ? 'Invalid token' : 'Session validation unavailable'));
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
  // Status and heartbeat events can arrive together when a Driver comes
  // online or resumes after a reconnect. Serialize them so a heartbeat never
  // observes the previous offline state and incorrectly suspends the client.
  let driverAvailabilityQueue = Promise.resolve();
  const enqueueDriverAvailability = operation => {
    const next = driverAvailabilityQueue.catch(() => undefined).then(operation);
    driverAvailabilityQueue = next.catch(() => undefined);
    return next;
  };

  // ── Driver: restore room memberships from DB on every (re)connect ──────────
  // Socket.io rooms are process-memory only — they vanish on server restart.
  // We persist isOnline and active ride state to MongoDB so we can restore both
  // here without requiring the client to manually re-send status events first.
  if (role === 'driver') {
    void rehydrateDriverSocket(socket, id).then(({ activeRide }) => {
      if (activeRide) console.log('Driver rejoined an active ride room after reconnect');
    }).catch(() => {});
  }

  // A ride room carries location, contact, and verification details. Personal
  // user rooms deliver pending offers, so only the passenger or assigned driver
  // may join a ride room after the assignment is persisted.
  async function isRideParticipant(rideId) {
    if (!mongoose.isValidObjectId(rideId)) return false;
    const ride = await Ride.exists({
      _id: rideId,
      ...(role === 'customer' ? { passenger: id } : { driver: id })
    }).catch(() => null);
    return !!ride;
  }

  socket.on('ride:join', async (rideId) => {
    if (await isRideParticipant(rideId)) socket.join(`ride:${rideId}`);
  });
  socket.on('ride:leave', async (rideId) => {
    if (await isRideParticipant(rideId)) socket.leave(`ride:${rideId}`);
  });

  // The native/web Driver emergency hold must be authoritative even when the
  // UI clears itself before the network round trip finishes. The ack lets the
  // client decide whether a REST retry is needed.
  socket.on('ride:emergency-cancel', async ({ rideId } = {}, acknowledge) => {
    if (role !== 'driver') {
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Drivers only', retryable: false });
      return;
    }
    try {
      const ride = await cancelRideForDriverEmergency(rideId, id);
      if (typeof acknowledge === 'function') {
        acknowledge({ ok: true, rideId: String(ride._id), status: ride.status });
      }
    } catch (err) {
      if (typeof acknowledge === 'function') {
        acknowledge({
          ok: false,
          error: err.message,
          code: err.statusCode || 500,
          retryable: ![400, 403, 404, 409].includes(err.statusCode)
        });
      }
    }
  });

  // Driver sends location updates during a ride
  socket.on('driver:location', async ({ rideId, lat, lng }) => {
    if (role !== 'driver') return;
    if (!hasValidCoordinates({ lat, lng })) {
      socket.emit('location:rejected', { error: 'Invalid coordinates', code: 'INVALID_COORDINATES' });
      return;
    }
    if (rideId) {
      const activeRide = await Ride.findOne({
        _id: rideId, driver: id, status: { $in: ['accepted', 'arrived', 'in-progress'] }
      }).select('_id driver passenger pickupLocation status pickupReachedAt verificationPin driverLocation vehicleType distance durationMinutes fare fareQuote customerFareOffset agreedFareBeforeWaiting waitingSeconds waitingAccumulatedSeconds waitingStartedAt waitingMinutes waitingFare').lean().catch(() => null);
      if (!activeRide) return;
      const waitingRateSettings = await getWaitingRateSettings().catch(() => DEFAULT_WAITING_RATE_SETTINGS);
      const waitingState = observeRideWaiting(activeRide, { lat, lng }, waitingRateSettings, new Date());
      const category = normalizeFareVehicle(activeRide.vehicleType);
      const waitingConfig = normalizeWaitingRateSettings(waitingRateSettings)[category];
      const shouldRefreshWaitingFare = activeRide.status === 'in-progress'
        && (waitingConfig?.enabled && waitingConfig.ratePerMinute > 0
          || activeRide.fareQuote?.waitingEnabled && !waitingConfig?.enabled);
      let fareQuote = null;
      let rideForFare = null;
      if (shouldRefreshWaitingFare) {
        rideForFare = {
          ...activeRide,
          driverLocation: { lat, lng },
          waitingSeconds: waitingState.waitingSeconds
        };
        fareQuote = await refreshRideFareFromCurrentSettings(rideForFare, waitingRateSettings).catch(() => null);
        if (fareQuote?.error) fareQuote = null;
      }
      const waitingChanged = activeRide.waitingSeconds !== waitingState.waitingSeconds
        || String(activeRide.waitingStartedAt || '') !== String(waitingState.waitingStartedAt || '');
      const fareChanged = fareQuote && (
        Number(activeRide.fare) !== Number(rideForFare?.fare)
        || Number(activeRide.fareQuote?.waitingFare || 0) !== Number(fareQuote.waitingFare || 0)
        || activeRide.fareQuote?.waitingEnabled !== fareQuote.waitingEnabled
      );
      const waitingUpdate = {
        'driverLocation.lat': lat,
        'driverLocation.lng': lng,
        waitingSeconds: waitingState.waitingSeconds,
        waitingAccumulatedSeconds: waitingState.waitingAccumulatedSeconds,
        waitingStartedAt: waitingState.waitingStartedAt,
        ...(fareQuote && !fareQuote.error ? {
          fare: rideForFare.fare,
          fareQuote,
          waitingMinutes: fareQuote.waitingMinutes,
          waitingFare: fareQuote.waitingFare
        } : {})
      };
      await Ride.updateOne({ _id: rideId }, { $set: waitingUpdate }).catch(() => {});
      await releaseRidePinAtPickup(activeRide, { lat, lng }).catch(() => {});
      io.to(`ride:${rideId}`).emit('driver:location', { lat, lng });
      if (waitingChanged || fareChanged) {
        io.to(`ride:${rideId}`).emit('ride:fare-updated', {
          id: rideId,
          fare: fareQuote ? rideForFare.fare : activeRide.fare,
          fareQuote: fareQuote || activeRide.fareQuote,
          reason: 'waiting'
        });
      }
    }
    await User.updateOne({ _id: id }, {
      'currentLocation.lat': lat,
      'currentLocation.lng': lng,
      lastOnlineHeartbeat: new Date()
    }).catch(() => {});
    void syncRedisDriverPresence(id);
  });

  // Driver toggles online/offline
  socket.on('driver:status', ({ isOnline: requestedOnline } = {}) => enqueueDriverAvailability(async () => {
    if (role !== 'driver') return;
    const isOnline = requestedOnline === true;
    let feeResult = null;
    let driver = await User.findById(id)
      .select('accountStatus vehicleType paidUntilDate lastDailyFeePaidAt isFreeTrial isOnline onlineStartedAt onlineTimeDate onlineTimeTodaySeconds')
      .lean()
      .catch(() => null);
    if (isOnline) {
      if (driver?.accountStatus === 'pending') {
        await User.updateOne({ _id: id }, { isOnline: false, lastOnlineHeartbeat: null, onlineStartedAt: null }).catch(() => {});
        socket.emit('account:suspended', { reason: 'Your account is pending Admin approval. You will be notified once approved.' });
        return;
      }
      if (driver?.accountStatus === 'suspended' || driver?.accountStatus === 'blocked' || driver?.accountStatus === 'pending_deletion') {
        await User.updateOne({ _id: id }, { isOnline: false, lastOnlineHeartbeat: null, onlineStartedAt: null }).catch(() => {});
        socket.emit('account:suspended', { reason: 'Your account has been suspended. Please contact Admin.' });
        return;
      }
      if (!isVehicleCategoryActive(await getVehicleCategorySettings(), driver?.vehicleType)) {
        await User.updateOne({ _id: id }, { isOnline: false, lastOnlineHeartbeat: null, onlineStartedAt: null }).catch(() => {});
        socket.emit('account:suspended', { reason: 'This vehicle category is currently inactive. Contact Admin before going online.' });
        return;
      }
      feeResult = await chargeDailyFeeForOnlineDriver(id, driver);
      if (!feeResult.allowed) {
        await User.updateOne({ _id: id }, { isOnline: false, lastOnlineHeartbeat: null, onlineStartedAt: null }).catch(() => {});
        socket.emit('account:suspended', {
          reason: DAILY_FEE_UNPAID_MESSAGE
        });
        return;
      }
      // Cache vehicle type on socket for room management
      if (driver?.vehicleType) socket.vehicleType = normalizeFareVehicle(driver.vehicleType);
    }
    const onlineNow = new Date();
    const onlineTime = getOnlineTimeTransition(driver, isOnline, onlineNow);
    const onlineStartedAt = onlineTime.onlineStartedAt;
    await User.updateOne({ _id: id }, isOnline
      ? { isOnline: true, lastOnlineHeartbeat: onlineNow, ...onlineTime }
      : { isOnline: false, lastOnlineHeartbeat: null, ...onlineTime }
    ).catch(() => {});
    const vRoom = `drivers:${socket.vehicleType || 'Car Mini Non-AC'}`;
    if (isOnline) { socket.join('drivers-online'); socket.join(vRoom); }
    else          { socket.leave('drivers-online'); socket.leave(vRoom); }
    if (isOnline) await rehydrateDriverSocket(socket, id, { replayOffers: true }).catch(() => {});
    void syncRedisDriverPresence(id);
    socket.emit('driver:status:ack', {
      isOnline,
      vehicleType: socket.vehicleType || null,
      onlineStartedAt,
      onlineTimeDate: onlineTime.onlineTimeDate,
      onlineTimeTodaySeconds: onlineTime.onlineTimeTodaySeconds,
      nextFeeDeductionAt: feeResult?.paidUntilDate || driver?.paidUntilDate || null
    });
  }));

  // Native clients explicitly heartbeat while their foreground service is
  // active. This lets the server detect policy/account changes without treating
  // short radio reconnects as an offline transition.
  socket.on('driver:heartbeat', (client = {}) => enqueueDriverAvailability(async () => {
    if (role !== 'driver') return;
    const driver = await User.findById(id).select('accountStatus isOnline').lean().catch(() => null);
    if (!driver || driver.accountStatus !== 'active' || !driver.isOnline) {
      socket.emit('account:suspended', { reason: 'Driver availability is no longer active.' });
      return;
    }
    await User.updateOne({ _id: id }, { lastOnlineHeartbeat: new Date() }).catch(() => {});
    void syncRedisDriverPresence(id);
    socket.emit('driver:heartbeat:ack', {
      serverTime: new Date().toISOString(),
      clientSentAt: typeof client.clientSentAt === 'string' ? client.clientSentAt : null
    });
  }));

  // Share passenger location only with an active ride's authorized room.
  socket.on('location:share', async ({ lat, lng, rideId }) => {
    if (role !== 'customer' || !rideId || !hasValidCoordinates({ lat, lng })) return;
    const activeRide = await Ride.findOne({
      _id: rideId, passenger: id, status: { $in: ['accepted', 'arrived', 'in-progress'] }
    }).select('_id').lean().catch(() => null);
    if (activeRide) {
      const updatedAt = new Date();
      await Ride.updateOne(
        { _id: rideId, passenger: id, status: { $in: ['accepted', 'arrived', 'in-progress'] } },
        {
          $set: {
            'passengerLocation.lat': Number(lat),
            'passengerLocation.lng': Number(lng),
            passengerLocationUpdatedAt: updatedAt
          }
        }
      ).catch(() => {});
      io.to(`ride:${rideId}`).emit('passenger:location', { lat: Number(lat), lng: Number(lng) });
    }
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

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function connectMongoWithRetry(uri) {
  const connectionOptions = getMongoConnectionOptions();
  const retryOptions = getMongoRetryOptions();
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      await mongoose.connect(uri, connectionOptions);
      if (attempt > 1) console.log(`✓ MongoDB Atlas connected after ${attempt} attempt(s)`);
      return attempt;
    } catch (err) {
      dbConnected = false;
      const exhausted = retryOptions.maxAttempts > 0 && attempt >= retryOptions.maxAttempts;
      if (exhausted) throw err;

      // Reset a failed initial connection before trying the same URI again.
      // Mongoose's normal reconnect behavior remains active after a
      // successful connection and is handled by the connection event hooks.
      await mongoose.disconnect().catch(() => {});
      const delay = Math.min(
        retryOptions.maxDelayMS,
        retryOptions.initialDelayMS * (2 ** Math.min(attempt - 1, 8))
      );
      console.warn(
        `⚠ MongoDB connection attempt ${attempt} failed; retrying in ${delay}ms: ${err.message}`
      );
      await sleep(delay);
    }
  }
}

function installMongoConnectionHandlers() {
  if (mongoConnectionHandlersInstalled) return;
  mongoConnectionHandlersInstalled = true;

  mongoose.connection.on('disconnected', () => {
    dbConnected = false;
    console.warn('⚠  MongoDB disconnected — Mongoose will auto-reconnect');
  });
  mongoose.connection.on('reconnected', () => {
    dbConnected = true;
    console.log('✓ MongoDB reconnected');
    // Reconcile environment-managed Admin credentials after recovery, but
    // serialize this with the initial sync and any other reconnect event.
    void initializeAdminSecurity();
  });
  mongoose.connection.on('error', (mongoErr) => {
    console.error('MongoDB connection error:', mongoErr.message);
  });
}

async function ensureFinancialIndexes() {
  // Explicitly build the persisted safety constraints in environments where
  // Mongoose autoIndex is disabled. Existing duplicate TIDs must fail startup
  // rather than leave the service accepting unverifiable recharges.
  await Payment.createIndexes();
  await FinancialOperation.createIndexes();
}

async function connectDatabase() {
  const { uri: rawUri, source } = getConfiguredMongoUri();
  console.log(`MongoDB URI attached: ${Boolean(rawUri)}${source ? ` (source: ${source})` : ''}`);
  if (!rawUri) {
    const demoMode = process.env.DEMO_ACCOUNTS_ENABLED === 'true' && process.env.NODE_ENV !== 'production';
    if (!demoMode) {
      console.error(
        '✖ MongoDB is not configured. Set MONGO_URI (or MONGODB_URI/MONGO_URL) in the service environment; ' +
        'persistence is disabled until it is provided.'
      );
      return;
    }
    try {
      // Preview-only persistence: this database lives for the workflow process
      // and is never used when a configured production Mongo URI is available.
      // Financial activation and fee flows use Mongo transactions. A replica
      // set is required even for the in-memory preview database so preview
      // exercises the same atomic wallet behavior as production.
      const { MongoMemoryReplSet } = require('mongodb-memory-server');
      const demoMongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      await demoMongo.waitUntilRunning();
      await mongoose.connect(demoMongo.getUri(), getMongoConnectionOptions());
      dbConnected = true;
      await ensureFinancialIndexes();
      global._demoMongoServer = demoMongo;
      await removeCustomerEmailIndex();
      await migrateLegacyUserData();
      await initializeAdminSecurity();
      await seedDemoAccounts();
       void runAdvanceBookingDispatcher().catch(err => console.warn('[advance-booking] initial sweep failed:', err.message));
       void runAdvanceBookingBroadcastRecovery().catch(err => console.warn('[advance-booking] initial broadcast recovery failed:', err.message));
      console.log('✓ Preview demo database connected and demo accounts seeded');
      await initVapidKeys();
      await rebuildRedisDriverIndex();
    } catch (err) {
      console.warn('⚠  Demo database unavailable, running without persistence:', err.message);
    }
    return;
  }
  const uri = normalizeMongoUri(rawUri);
  installMongoConnectionHandlers();
  try {
    await connectMongoWithRetry(uri);
    dbConnected = true;
    console.log('✓ MongoDB Atlas connected');

    await ensureFinancialIndexes();
    await removeCustomerEmailIndex();
    await migrateLegacyUserData();
    await initializeAdminSecurity();
    void runAdvanceBookingDispatcher().catch(err => console.warn('[advance-booking] initial sweep failed:', err.message));
      void runAdvanceBookingBroadcastRecovery().catch(err => console.warn('[advance-booking] initial broadcast recovery failed:', err.message));

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
    console.error('⚠  MongoDB unavailable; persistence remains disabled until it is repaired:', err.message);
  }

  await initVapidKeys();
  await rebuildRedisDriverIndex();
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

// Development previews seed accounts automatically, so they also need a usable
// quote baseline. This is insert-only, runs only with DEMO_ACCOUNTS_ENABLED,
// and never replaces an Admin's stored production or preview pricing rules.
const PREVIEW_DEMO_FARE_SETTINGS = Object.freeze(
  Object.fromEntries(FARE_VEHICLE_CATEGORIES.map(category => [category, {
    baseFare: 100,
    perMinuteRate: 2,
    distanceSlabs: [{ minKm: 0, maxKm: null, rate: DEFAULT_PER_KM_RATES[category] }],
    peakRules: []
  }]))
);

// These accounts are intentionally limited to the preview/demo database. Store
// only the bcrypt hash in source; never persist the requested test password.
const TEST_ACCOUNT_PASSWORD_HASH = '$2a$12$CByloTMQfIwC393QDR.TH.bruF.52lOlDbr1yEmbuQDSA4q8ePKZe';
const TEST_ACCOUNTS = Object.freeze({
  customer: {
    name: 'Customer Test Account',
    phone: '+923000000011',
    email: 'customer@test.com',
    role: 'customer'
  },
  driver: {
    name: 'Driver Test Account',
    phone: '+923000000012',
    email: 'driver@test.com',
    role: 'driver'
  }
});

async function seedDemoAccounts() {
  if (process.env.DEMO_ACCOUNTS_ENABLED !== 'true' || process.env.NODE_ENV === 'production') return;
  const now = new Date();
  await Settings.findOneAndUpdate(
    { key: 'daily_fare_settings' },
    { $setOnInsert: { key: 'daily_fare_settings', value: PREVIEW_DEMO_FARE_SETTINGS } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Settings.findOneAndUpdate(
    { key: VEHICLE_CATEGORY_SETTINGS_KEY },
    { $setOnInsert: { key: VEHICLE_CATEGORY_SETTINGS_KEY, value: DEFAULT_VEHICLE_CATEGORY_SETTINGS } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const customerPassword = await bcrypt.hash(DEMO_ACCOUNTS.customer.password, 12);
  const driverPassword = await bcrypt.hash(DEMO_ACCOUNTS.driver.password, 12);
  const subAdminPassword = await bcrypt.hash('DemoOps-2026!', 12);

  const customerDeleted = await AccountDeletionTombstone.exists({ seedKey: 'demo:customer' });
  const driverDeleted = await AccountDeletionTombstone.exists({ seedKey: 'demo:driver' });
  const customer = customerDeleted ? null : await User.findOneAndUpdate(
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
  const driver = driverDeleted ? null : await User.findOneAndUpdate(
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
          vehicleType: 'Car Mini Non-AC',
          vehicleModel: 'Toyota Corolla',
          vehiclePlate: 'DEMO-2026',
          isOnline: false,
          lastDailyFeePaidAt: null,
          paidUntilDate: null,
          isFreeTrial: false
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

  if (driver) {
    await Wallet.findOneAndUpdate(
      { user: driver._id },
      {
        // Demo state must never advertise a paid pass without the matching
        // negative Daily Fee ledger entry. The first online activation will use
        // the same atomic debit path as every real Driver.
        $set: {
          balance: 5000,
          realCashWallet: 5000,
          realCashAvailable: 5000,
          bonusAvailable: 0,
          fee_paid_at: null,
          transactions: []
        }
      },
      { upsert: true, new: true }
    );
    await Payment.findOneAndUpdate(
      { trxId: 'DEMO-APPROVED-2026' },
      {
        $set: {
          driver: driver._id,
          amount: 500,
          vehicleCategory: 'Car Mini Non-AC',
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
  }
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
          viewAdvanceBookings: true,
          manageAdvanceBookingReminders: true,
          viewDriverPasses: true
        })
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await seedTestAccounts();
  return { customer, driver };
}

async function seedTestAccounts() {
  const now = new Date();
  const customer = await AccountDeletionTombstone.exists({ seedKey: 'test:customer' })
    ? null
    : await User.findOneAndUpdate(
        { email: TEST_ACCOUNTS.customer.email },
        {
          $set: {
            name: TEST_ACCOUNTS.customer.name,
            email: TEST_ACCOUNTS.customer.email,
            phone: TEST_ACCOUNTS.customer.phone,
            password: TEST_ACCOUNT_PASSWORD_HASH,
            role: 'customer',
            accountStatus: 'active',
            identityVerificationStatus: 'approved',
            identityVerifiedAt: now
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
  const driver = await AccountDeletionTombstone.exists({ seedKey: 'test:driver' })
    ? null
    : await User.findOneAndUpdate(
        { email: TEST_ACCOUNTS.driver.email },
        {
          $set: {
            name: TEST_ACCOUNTS.driver.name,
            email: TEST_ACCOUNTS.driver.email,
            phone: TEST_ACCOUNTS.driver.phone,
            password: TEST_ACCOUNT_PASSWORD_HASH,
            role: 'driver',
            accountStatus: 'active',
            vehicleType: 'Car Mini Non-AC',
            vehicleModel: 'Toyota Corolla',
            vehiclePlate: 'TEST-2026',
            isOnline: false,
            lastDailyFeePaidAt: now,
            paidUntilDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            isFreeTrial: true,
            trialStartDate: now
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
  if (driver) {
    await Wallet.findOneAndUpdate(
      { user: driver._id },
      { $setOnInsert: { balance: 0, transactions: [] } },
      { upsert: true, new: true }
    );
  }
  console.log('✓ Test customer and driver accounts seeded');
  return { customer, driver };
}

// Start DB connection in background — never blocks the HTTP server
if (require.main === module) {
  connectDatabase().catch(err => console.error('connectDatabase error:', err));
}

if (require.main === module) {
  const advanceBookingSweep = setInterval(() => {
    runAdvanceBookingDispatcher().catch(err =>
      console.warn(`[advance-booking] sweep failed: ${err.message}`)
    );
  }, 15_000);
  advanceBookingSweep.unref?.();
  const advanceBookingBroadcastRecovery = setInterval(() => {
    runAdvanceBookingBroadcastRecovery().catch(err =>
      console.warn(`[advance-booking] broadcast recovery sweep failed: ${err.message}`)
    );
  }, 30_000);
  advanceBookingBroadcastRecovery.unref?.();
  const advanceBookingReminderSweep = setInterval(() => {
    runAdvanceBookingReminderSweep().catch(err =>
      console.warn(`[advance-booking] reminder sweep failed: ${err.message}`)
    );
  }, 60_000);
  advanceBookingReminderSweep.unref?.();
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
    const drivers = await User.find({
      role: 'driver',
      accountStatus: 'active',
      isOnline: true
    })
      .select('_id vehicleType ridePreference name paidUntilDate lastDailyFeePaidAt isFreeTrial isOnline lastOnlineHeartbeat');
    const dailyFeeSettings = await getDailyFeeSettings();
    let charged = 0;
    let exempt = 0;
    let blocked = 0;
    for (const driver of drivers) {
      // Keep legacy test/demo records compatible while making an explicit
      // offline state immune to the scheduled rollover.
      if (driver.isOnline === false) continue;
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

if (require.main === module) {
  const studentRideLogSweep = setInterval(() => {
    recordExpiredStudentRideResponses().catch(err =>
      console.warn(`[student-ride-log] expiry sweep failed: ${err.message}`)
    );
  }, 10_000);
  studentRideLogSweep.unref?.();
}

module.exports = {
  app,
  server,
  io,
  FARE_VEHICLE_CATEGORIES,
  DEFAULT_PER_KM_RATES,
  DEFAULT_VEHICLE_CATEGORY_SETTINGS,
  DEFAULT_RIDE_BROADCAST_RADIUS_KM,
  DEFAULT_RIDE_BROADCAST_REQUEST_DURATION_SECONDS,
  normalizeFareSettings,
  normalizeVehicleCategorySettings,
  isVehicleCategoryActive,
  getVehicleCategorySettings,
  DEFAULT_WAITING_RATE_SETTINGS,
  normalizeWaitingRateSettings,
  validateWaitingRateSettings,
  calculateWaitingFare,
  observeRideWaiting,
  validateFareSettings,
  calculateFareFromSettings,
  normalizeCustomerFareDisplaySettings,
  getCustomerFareDisplaySettings,
  normalizeStudentDiscountSettings,
  normalizeStudentFairQuotaSettings,
  getStudentFairQuotaSettings,
  selectFairStudentRideDrivers,
  recordStudentRideResponse,
  getVerifiedStudentDiscountPercent,
  applyStudentDiscountToFareQuote,
  normalizeLongRangeSettings,
  validateLongRangeSettings,
  getLongRangeMinimumWalletBalance,
  calculateRideFare,
  customerRegistrationAccountStatus,
  normalizeTerms,
  normalizeFareVehicle,
  storedVehicleTypesForFareCategory,
  DRIVER_RIDE_PREFERENCES,
  normalizeRidePreference,
  isLongRangeOnlyDriver,
  canDriverReceiveRideForPreference,
  chargeDailyFeeForOnlineDriver,
  getWalletSourceBalances,
  walletAdvanceDepositTotal,
  getDriverTodayIncome,
  allocateWalletDebit,
  runDailyDeduction,
  normalizeRideBroadcastSettings,
  validateRideBroadcastSettings,
  normalizeCustomerLocationAliasText,
  normalizeCustomerLocationAlias,
  validateCustomerLocationAlias,
  normalizeCustomerLocationAliases,
  customerLocationAliasMatch,
  matchCustomerLocationAliases,
  isSafeDirectCustomerAlias,
  getAdminSecurity,
  saveAdminSecurity,
  syncAdminSecurity,
  rideOfferIsStillOpenQuery,
  haversineKm,
  coordinateBoundsQuery,
  findRideBroadcastDrivers,
  findLongRangeBroadcastDrivers,
  emitRideRequestToDrivers,
  emitRideOffers,
  parseAdvanceBookingDate,
  broadcastAdvanceBooking,
  advanceBookingDriverResponse,
  runAdvanceBookingDispatcher,
  runAdvanceBookingBroadcastRecovery,
  dispatchAdvanceBooking,
  sendAdvanceBookingReminder,
  runAdvanceBookingReminderSweep,
  sendExpoPush,
  getAvailableRidesForDriver,
  driverRidePayload,
  emitRideLifecycle,
  ADMIN_ACTIVE_RIDE_STATUSES,
  chargeLongRangeCommission,
  startLongRangeRideWithCommission,
  completeRideFinancialSettlement,
  approveDriverPayment,
  rejectDriverPayment,
  runFinancialTransaction,
  runIdempotentFinancialOperation,
  refreshPendingRideFares,
  SUB_ADMIN_PERMISSION_CATALOG,
  normalizeSubAdminPermissions,
  hasAdminPermission,
  emailOtpConfigured,
  sendEmailViaResend,
  setEmailSenderForTests,
  getMongoConnectionOptions,
  getMongoRetryOptions,
  getConfiguredMongoUri,
  getDatabaseStatus,
  connectDatabase,
  migrateLegacyUserData,
  seedDemoAccounts,
  seedTestAccounts,
  models: {
    User, LegacyUser, Customer, Driver, Admin, Ride, AdvanceBooking, Wallet, Payment, Settings,
    SOS, Ticket, PushSub, SubAdmin, StudentRideResponseLog, AccountDeletionTombstone,
    FinancialOperation
  }
};
