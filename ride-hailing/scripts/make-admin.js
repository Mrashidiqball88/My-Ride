/**
 * Promote a user to admin by email.
 * Usage: node ride-hailing/scripts/make-admin.js <email>
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node make-admin.js <email>');
  process.exit(1);
}

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

const userSchema = new mongoose.Schema({
  name: String, email: String, password: String,
  role: String, isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(normalizeMongoUri(uri));
  const result = await User.updateOne({ email: email.toLowerCase() }, { $set: { isAdmin: true } });
  if (result.matchedCount === 0) {
    console.error('No matching user found.');
  } else {
    console.log('User promotion completed.');
  }
  await mongoose.disconnect();
})();
