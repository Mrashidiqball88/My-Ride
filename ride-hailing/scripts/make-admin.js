/**
 * Provision the dedicated Super Admin record.
 * Usage: node ride-hailing/scripts/make-admin.js [email]
 *
 * If ADMIN_PASSWORD or ADMIN_RECOVERY_KEY is present in the environment, only
 * their bcrypt hashes are written. Existing hashes are preserved when the
 * corresponding secret is omitted.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const email = String(process.argv[2] || process.env.ADMIN_EMAIL || 'admin@myride.com').trim().toLowerCase();

function normalizeMongoUri(uri) {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return uri;
  const authorityStart    = schemeEnd + 3;
  const userInfoSeparator = uri.lastIndexOf('@');
  if (userInfoSeparator < authorityStart) return uri;
  const userInfo          = uri.slice(authorityStart, userInfoSeparator);
  const passwordSeparator = userInfo.indexOf(':');
  if (passwordSeparator === -1) return uri;
  const username = userInfo.slice(0, passwordSeparator);
  const password = userInfo.slice(passwordSeparator + 1);
  const norm = (s) =>
    s.replace(/%[0-9a-f]{2}|./giu, (ch) =>
      ch.startsWith('%') ? ch.toUpperCase() : encodeURIComponent(ch)
    );
  return `${uri.slice(0, authorityStart)}${norm(username)}:${norm(password)}${uri.slice(userInfoSeparator)}`;
}

const adminSchema = new mongoose.Schema({
  _id: { type: String, default: 'super-admin' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, default: '' },
  recoveryKeyHash: { type: String, default: '' },
  sessionVersion: { type: Number, default: 0 }
}, { timestamps: true, collection: 'admins' });
const Admin = mongoose.model('Admin', adminSchema);

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(normalizeMongoUri(uri));
  const update = { $set: { email } };
  if (process.env.ADMIN_PASSWORD) {
    update.$set.passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  }
  if (process.env.ADMIN_RECOVERY_KEY) {
    update.$set.recoveryKeyHash = await bcrypt.hash(process.env.ADMIN_RECOVERY_KEY, 12);
  }
  await Admin.findOneAndUpdate(
    { _id: 'super-admin' },
    { ...update, $setOnInsert: { _id: 'super-admin', sessionVersion: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log('Dedicated Super Admin record provisioned.');
  await mongoose.disconnect();
})();
