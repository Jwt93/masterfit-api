/**
 * Read-only diagnostic script: finds groups of client documents that are
 * really the same person but ended up as separate documents because their
 * saved phone numbers differ only by whitespace/formatting (the bug fixed
 * in this round's server.js update).
 *
 * Makes NO changes to the database - it only reads and prints. Deciding
 * what to do with any duplicates it finds (merge, delete the stale one,
 * leave alone) is a judgment call left to you, since some pairs may be two
 * genuinely different people who happen to share a phone (e.g. a family
 * member's number reused).
 *
 * Usage:
 *   MONGODB_URI="<your Atlas connection string>" node find_duplicate_phones.js
 *   (optionally: DB_NAME="masterfit" if it's not the default)
 */
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'masterfit';

if (!MONGODB_URI) {
  console.error('Set MONGODB_URI to your Atlas connection string before running this script.');
  process.exit(1);
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

(async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const clients = await db.collection('clients').find({}).toArray();

  const groups = new Map();
  for (const doc of clients) {
    const rawPhone = doc.formData?.clientBasics?.phone;
    const normalized = normalizePhone(rawPhone);
    if (!normalized) continue;
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push(doc);
  }

  const duplicateGroups = [...groups.entries()].filter(([, docs]) => docs.length > 1);

  console.log(`Scanned ${clients.length} client documents.`);
  console.log(`Found ${duplicateGroups.length} phone number(s) with more than one document.\n`);

  for (const [normalizedPhone, docs] of duplicateGroups) {
    console.log('='.repeat(70));
    console.log(`Normalized phone: "${normalizedPhone}"  (${docs.length} documents)`);
    docs
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
      .forEach((doc, i) => {
        const rawPhone = doc.formData?.clientBasics?.phone;
        console.log(`  [${i}] _id=${doc._id}`);
        console.log(`      name=${doc.formData?.clientBasics?.name || '(none)'}`);
        console.log(`      rawPhoneStored=${JSON.stringify(rawPhone)}  (compare for stray whitespace/formatting)`);
        console.log(`      branch=${doc.branch}  visitCount=${doc.visitCount}`);
        console.log(`      createdAt=${doc.createdAt}  updatedAt=${doc.updatedAt}`);
      });
    console.log('');
  }

  if (duplicateGroups.length === 0) {
    console.log('No duplicate/ghost records found.');
  } else {
    console.log('Nothing was modified or deleted. Review the documents above and decide');
    console.log('per-group whether to merge/delete manually in Atlas, or ask me to write');
    console.log('a merge script for a specific case once you\'ve confirmed which one to keep.');
  }

  await client.close();
})().catch(err => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
