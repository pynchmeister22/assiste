/**
 * Ensures data directory and default user (moon) exist.
 * Run: node src/scripts/seed.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('../store/jsonDb');

async function seed() {
  await db.getUsers();
  console.log('[SEED] users.json ready (includes moon if new)');
  console.log('[SEED] Done');
}

seed().catch(err => { console.error(err); process.exit(1); });
