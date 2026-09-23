// store.js — persistence layer.
//
// If MONGODB_URI is set, every quiz/user/session/participant is kept in a
// real MongoDB database (e.g. a free MongoDB Atlas cluster), so data
// survives a restart or redeploy — this matters on Render's free tier,
// whose local disk is wiped every time the service restarts.
//
// If MONGODB_URI is NOT set, we fall back to a local JSON file. That's fine
// for trying the app out on your own laptop, but it will NOT survive a
// Render free-tier restart. See README.md for a 5-minute Atlas setup.

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'symposium_quiz';

let mode = 'file'; // 'mongo' | 'file'
let cols = {};
let fileSaveTimer = null;

function freshDB() {
  return { users: {}, sessions: {}, quizzes: {}, participants: {} };
}

function loadLocalFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...freshDB(), ...parsed };
  } catch {
    return freshDB();
  }
}

function saveLocalFileDebounced(db) {
  clearTimeout(fileSaveTimer);
  fileSaveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }, 200);
}

function stripId(doc) {
  const { _id, ...rest } = doc;
  return rest;
}

async function init(db) {
  if (!MONGODB_URI) {
    console.warn(
      '\n⚠  MONGODB_URI is not set — using a local JSON file for storage.\n' +
        "   This is fine for testing on your own machine, but on Render's free\n" +
        '   tier the filesystem is wiped on every restart/redeploy, so quizzes\n' +
        '   and results WILL be lost. Set MONGODB_URI before the real event —\n' +
        '   see the "Persistent database" section in README.md.\n'
    );
    Object.assign(db, loadLocalFile());
    return;
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const database = client.db(MONGODB_DB);
  cols = {
    users: database.collection('users'),
    sessions: database.collection('sessions'),
    quizzes: database.collection('quizzes'),
    participants: database.collection('participants'),
  };
  // Helpful indexes — safe to call every startup, no-ops if already there.
  // (Session expiry is a plain millisecond timestamp checked in requireStaff,
  // not a Mongo TTL index, so it works the same whether expired sessions are
  // still physically present or not.)
  await Promise.all([
    cols.users.createIndex({ email: 1 }, { unique: true }),
    cols.participants.createIndex({ quizId: 1 }),
  ]).catch((e) => console.warn('Index setup warning:', e.message));

  const [users, sessions, quizzes, participants] = await Promise.all([
    cols.users.find().toArray(),
    cols.sessions.find().toArray(),
    cols.quizzes.find().toArray(),
    cols.participants.find().toArray(),
  ]);
  const keyBy = (arr) => Object.fromEntries(arr.map((d) => [d._id, stripId(d)]));
  Object.assign(db, {
    users: keyBy(users),
    sessions: keyBy(sessions),
    quizzes: keyBy(quizzes),
    participants: keyBy(participants),
  });
  mode = 'mongo';
  console.log(`Connected to MongoDB (${MONGODB_DB}) — data persists across restarts.`);
}

async function upsert(collection, id, doc) {
  if (mode !== 'mongo') return;
  try {
    await cols[collection].replaceOne({ _id: id }, { _id: id, ...doc }, { upsert: true });
  } catch (e) {
    console.error(`Mongo save (${collection}) failed:`, e.message);
  }
}

async function remove(collection, id) {
  if (mode !== 'mongo') return;
  try {
    await cols[collection].deleteOne({ _id: id });
  } catch (e) {
    console.error(`Mongo delete (${collection}) failed:`, e.message);
  }
}

async function removeMany(collection, ids) {
  if (mode !== 'mongo' || ids.length === 0) return;
  try {
    await cols[collection].deleteMany({ _id: { $in: ids } });
  } catch (e) {
    console.error(`Mongo bulk delete (${collection}) failed:`, e.message);
  }
}

module.exports = {
  init,
  upsert,
  remove,
  removeMany,
  saveLocalFileDebounced,
  isMongo: () => mode === 'mongo',
};
