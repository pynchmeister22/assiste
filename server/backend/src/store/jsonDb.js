const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { DATA_DIR } = require('./paths');
const { USERNAME } = require('../config/staticAuth');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const RESUMES_FILE = path.join(DATA_DIR, 'resumes.json');
const CHATS_FILE = path.join(DATA_DIR, 'chatHistory.json');

/** Serialize all reads/writes to avoid torn JSON under concurrent requests */
let chain = Promise.resolve();
function locked(fn) {
  const next = chain.then(() => fn());
  chain = next.catch(() => {});
  return next;
}

function readFileSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(fallback));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[jsonDb] read error', file, e.message);
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function toPublicUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    id: u._id,
    name: u.name,
    email: u.email || undefined,
    isAdmin: !!u.isAdmin,
    isActive: u.isActive !== false,
    createdAt: u.createdAt
  };
}

function ensureMoonUser(users) {
  if (users.some(u => u.name === USERNAME)) return { users, changed: false };
  const now = new Date().toISOString();
  users.push({
    _id: randomUUID(),
    name: USERNAME,
    passwordHash: bcrypt.hashSync('123456', 12),
    email: null,
    openaiApiKey: null,
    isAdmin: true,
    isActive: true,
    createdAt: now,
    updatedAt: now
  });
  return { users, changed: true };
}

// ─── Users ───────────────────────────────────────────────────────────────────
async function getUsers() {
  return locked(() => {
    let users = readFileSafe(USERS_FILE, []);
    const { users: u2, changed } = ensureMoonUser(users);
    if (changed) writeFileAtomic(USERS_FILE, u2);
    return u2;
  });
}

async function findUserById(id) {
  const users = await getUsers();
  return users.find(u => u._id === id) || null;
}

async function findUserByName(name) {
  const users = await getUsers();
  return users.find(u => u.name === name) || null;
}

async function createUser({ name, password, email, isAdmin, openaiApiKey }) {
  return locked(() => {
    let users = readFileSafe(USERS_FILE, []);
    const { users: u2 } = ensureMoonUser(users);
    users = u2;
    if (users.some(u => u.name === name)) throw new Error('DUPLICATE');
    const now = new Date().toISOString();
    const u = {
      _id: randomUUID(),
      name,
      passwordHash: bcrypt.hashSync(password, 12),
      email: email || null,
      openaiApiKey: openaiApiKey || null,
      isAdmin: !!isAdmin,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    users.push(u);
    writeFileAtomic(USERS_FILE, users);
    return u;
  });
}

async function updateUserById(id, patch) {
  return locked(() => {
    let users = readFileSafe(USERS_FILE, []);
    const { users: u2 } = ensureMoonUser(users);
    users = u2;
    const i = users.findIndex(u => u._id === id);
    if (i < 0) return null;
    const { password, ...rest } = patch;
    const next = {
      ...users[i],
      ...rest,
      updatedAt: new Date().toISOString()
    };
    if (password) next.passwordHash = bcrypt.hashSync(password, 12);
    users[i] = next;
    writeFileAtomic(USERS_FILE, users);
    const out = { ...users[i] };
    return out;
  });
}

// ─── Resumes ─────────────────────────────────────────────────────────────────
async function getResumes() {
  return locked(() => readFileSafe(RESUMES_FILE, []));
}

async function saveResumes(list) {
  return locked(() => writeFileAtomic(RESUMES_FILE, list));
}

async function findResumesByUserId(userId) {
  const all = await getResumes();
  return all.filter(r => r.userId === userId).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function findResume(id, userId) {
  const all = await getResumes();
  const r = all.find(x => x._id === id && (!userId || x.userId === userId));
  return r || null;
}

async function createResume(payload) {
  return locked(() => {
    const all = readFileSafe(RESUMES_FILE, []);
    const now = new Date().toISOString();
    const r = {
      _id: randomUUID(),
      ...payload,
      createdAt: now,
      updatedAt: now
    };
    all.push(r);
    writeFileAtomic(RESUMES_FILE, all);
    return r;
  });
}

async function updateResumeById(id, userId, fields) {
  return locked(() => {
    const all = readFileSafe(RESUMES_FILE, []);
    const i = all.findIndex(x => x._id === id && x.userId === userId);
    if (i < 0) return null;
    all[i] = { ...all[i], ...fields, updatedAt: new Date().toISOString() };
    writeFileAtomic(RESUMES_FILE, all);
    return all[i];
  });
}

async function deleteResume(id, userId) {
  return locked(() => {
    let all = readFileSafe(RESUMES_FILE, []);
    const before = all.length;
    all = all.filter(x => !(x._id === id && x.userId === userId));
    if (all.length === before) return false;
    writeFileAtomic(RESUMES_FILE, all);
    return true;
  });
}

async function deleteResumeAdmin(id) {
  return locked(() => {
    let all = readFileSafe(RESUMES_FILE, []);
    const before = all.length;
    all = all.filter(x => x._id !== id);
    if (all.length === before) return false;
    writeFileAtomic(RESUMES_FILE, all);
    return true;
  });
}

// ─── Chat history ────────────────────────────────────────────────────────────
async function getChats() {
  return locked(() => readFileSafe(CHATS_FILE, []));
}

async function saveChats(list) {
  return locked(() => writeFileAtomic(CHATS_FILE, list));
}

async function upsertChat({ userId, interviewId, data }) {
  return locked(() => {
    const all = readFileSafe(CHATS_FILE, []);
    const idx = all.findIndex(c => c.userId === userId && c.interviewId === interviewId);
    const now = new Date().toISOString();
    if (idx >= 0) {
      all[idx] = {
        ...all[idx],
        ...data,
        userId,
        interviewId,
        updatedAt: now
      };
    } else {
      all.push({
        _id: randomUUID(),
        userId,
        interviewId,
        ...data,
        createdAt: now,
        updatedAt: now
      });
    }
    writeFileAtomic(CHATS_FILE, all);
    return all.find(c => c.userId === userId && c.interviewId === interviewId);
  });
}

async function findChatsByUser(userId) {
  const all = await getChats();
  return all.filter(c => c.userId === userId).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

async function findChatById(id, userId) {
  const all = await getChats();
  return all.find(c => c._id === id && (!userId || c.userId === userId)) || null;
}

async function findChatByIdAdmin(id) {
  const all = await getChats();
  return all.find(c => c._id === id) || null;
}

async function deleteChat(id, userId) {
  return locked(() => {
    let all = readFileSafe(CHATS_FILE, []);
    const before = all.length;
    all = all.filter(c => !(c._id === id && c.userId === userId));
    if (all.length === before) return false;
    writeFileAtomic(CHATS_FILE, all);
    return true;
  });
}

async function deleteChatAdmin(id) {
  return locked(() => {
    let all = readFileSafe(CHATS_FILE, []);
    const before = all.length;
    all = all.filter(c => c._id !== id);
    if (all.length === before) return false;
    writeFileAtomic(CHATS_FILE, all);
    return true;
  });
}

function isValidId(id) {
  return typeof id === 'string' && id.length >= 32;
}

async function resumeMini(resumeId) {
  if (!resumeId) return null;
  const all = await getResumes();
  const r = all.find(x => x._id === resumeId);
  if (!r) return null;
  return { _id: r._id, title: r.title, name: r.name };
}

async function userMini(userId) {
  const u = await findUserById(userId);
  if (!u) return null;
  return {
    _id: u._id,
    name: u.name,
    email: u.email,
    isActive: u.isActive !== false,
    isAdmin: !!u.isAdmin
  };
}

module.exports = {
  toPublicUser,
  getUsers,
  findUserById,
  findUserByName,
  createUser,
  updateUserById,
  getResumes,
  findResumesByUserId,
  findResume,
  createResume,
  updateResumeById,
  deleteResume,
  deleteResumeAdmin,
  getChats,
  upsertChat,
  findChatsByUser,
  findChatById,
  findChatByIdAdmin,
  deleteChat,
  deleteChatAdmin,
  isValidId,
  resumeMini,
  userMini
};
