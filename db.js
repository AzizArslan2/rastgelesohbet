const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "rastgele.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS consents (
    id TEXT PRIMARY KEY,
    session_ref TEXT NOT NULL,
    version TEXT NOT NULL,
    accepted_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    consent_a TEXT,
    consent_b TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    message_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('a', 'b')),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    reporter_side TEXT NOT NULL CHECK (reporter_side IN ('a', 'b')),
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT,
    admin_user TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chats_started_at ON chats(started_at);
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_reports_resolved_at ON reports(resolved_at);
  CREATE INDEX IF NOT EXISTS idx_consents_accepted_at ON consents(accepted_at);
`);

const statements = {
  insertConsent: db.prepare(
    "INSERT INTO consents (id, session_ref, version, accepted_at) VALUES (?, ?, ?, ?)"
  ),
  insertChat: db.prepare(
    "INSERT INTO chats (id, consent_a, consent_b, started_at) VALUES (?, ?, ?, ?)"
  ),
  endChat: db.prepare(
    "UPDATE chats SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL"
  ),
  insertMessage: db.prepare(
    "INSERT INTO messages (chat_id, sender, body, created_at) VALUES (?, ?, ?, ?)"
  ),
  incrementMessageCount: db.prepare(
    "UPDATE chats SET message_count = message_count + 1 WHERE id = ?"
  ),
  insertReport: db.prepare(
    "INSERT INTO reports (chat_id, reporter_side, reason, created_at) VALUES (?, ?, ?, ?)"
  ),
  resolveReport: db.prepare(
    "UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL"
  ),
  getChat: db.prepare("SELECT * FROM chats WHERE id = ?"),
  getMessages: db.prepare(
    "SELECT id, sender, body, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC"
  ),
  getReport: db.prepare("SELECT * FROM reports WHERE id = ?"),
  deleteChat: db.prepare("DELETE FROM chats WHERE id = ?"),
  deleteChatMessages: db.prepare("DELETE FROM messages WHERE chat_id = ?"),
  listReports: db.prepare(`
    SELECT
      r.id,
      r.chat_id,
      r.reporter_side,
      r.reason,
      r.created_at,
      r.resolved_at,
      r.resolved_by,
      c.started_at,
      c.ended_at,
      c.end_reason,
      c.message_count
    FROM reports r
    LEFT JOIN chats c ON c.id = r.chat_id
    ORDER BY r.created_at DESC
    LIMIT ?
  `),
  insertAudit: db.prepare(
    "INSERT INTO admin_audit (action, target, admin_user, created_at) VALUES (?, ?, ?, ?)"
  ),
  countChats: db.prepare("SELECT COUNT(*) AS total FROM chats"),
  countChatsSince: db.prepare("SELECT COUNT(*) AS total FROM chats WHERE started_at >= ?"),
  countMessages: db.prepare("SELECT COUNT(*) AS total FROM messages"),
  countReports: db.prepare("SELECT COUNT(*) AS total FROM reports"),
  countOpenReports: db.prepare(
    "SELECT COUNT(*) AS total FROM reports WHERE resolved_at IS NULL"
  ),
  countConsents: db.prepare("SELECT COUNT(*) AS total FROM consents"),
  purgeChats: db.prepare("DELETE FROM chats WHERE started_at < ?"),
  purgeReports: db.prepare("DELETE FROM reports WHERE created_at < ?"),
  purgeConsents: db.prepare("DELETE FROM consents WHERE accepted_at < ?"),
  purgeAudit: db.prepare("DELETE FROM admin_audit WHERE created_at < ?"),
};

function scalar(statement, ...args) {
  const row = statement.get(...args);
  return Number(row?.total) || 0;
}

function recordConsent({ sessionRef, version }) {
  const id = randomUUID();
  const acceptedAt = Date.now();
  statements.insertConsent.run(id, String(sessionRef).slice(0, 80), String(version).slice(0, 40), acceptedAt);
  return { id, version, acceptedAt };
}

function createChat({ consentA, consentB }) {
  const id = randomUUID();
  statements.insertChat.run(id, consentA || null, consentB || null, Date.now());
  return id;
}

function endChat(chatId, reason) {
  if (!chatId) {
    return;
  }
  statements.endChat.run(Date.now(), String(reason || "left").slice(0, 80), chatId);
}

function addMessage(chatId, sender, body) {
  if (!chatId || (sender !== "a" && sender !== "b")) {
    return;
  }
  const text = String(body).slice(0, 1000);
  statements.insertMessage.run(chatId, sender, text, Date.now());
  statements.incrementMessageCount.run(chatId);
}

function addReport({ chatId, reporterSide, reason }) {
  if (!chatId) {
    return null;
  }
  const result = statements.insertReport.run(
    chatId,
    reporterSide === "b" ? "b" : "a",
    String(reason || "other").slice(0, 100),
    Date.now()
  );
  return Number(result.lastInsertRowid);
}

function resolveReport(id, adminUser) {
  const result = statements.resolveReport.run(Date.now(), String(adminUser).slice(0, 80), id);
  return result.changes > 0;
}

function getReport(id) {
  return statements.getReport.get(id) || null;
}

function getChatDetail(chatId) {
  const chat = statements.getChat.get(chatId);
  if (!chat) {
    return null;
  }
  return {
    chat,
    messages: statements.getMessages.all(chatId),
  };
}

function deleteChat(chatId) {
  statements.deleteChatMessages.run(chatId);
  const result = statements.deleteChat.run(chatId);
  return result.changes > 0;
}

function listReports(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return statements.listReports.all(safeLimit);
}

function addAudit(action, target, adminUser) {
  statements.insertAudit.run(
    String(action).slice(0, 80),
    target ? String(target).slice(0, 120) : null,
    String(adminUser || "admin").slice(0, 80),
    Date.now()
  );
}

function databaseBytes() {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(`${DB_PATH}${suffix}`).size;
    } catch {
      continue;
    }
  }
  return total;
}

function getOverview() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  return {
    totalChats: scalar(statements.countChats),
    todayChats: scalar(statements.countChatsSince, startOfToday.getTime()),
    totalMessages: scalar(statements.countMessages),
    totalReports: scalar(statements.countReports),
    openReports: scalar(statements.countOpenReports),
    totalConsents: scalar(statements.countConsents),
    databaseBytes: databaseBytes(),
  };
}

function purgeExpired({ chatDays, reportDays, consentDays, auditDays }) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const result = {
    chats: statements.purgeChats.run(now - chatDays * day).changes,
    reports: statements.purgeReports.run(now - reportDays * day).changes,
    consents: statements.purgeConsents.run(now - consentDays * day).changes,
    audit: statements.purgeAudit.run(now - auditDays * day).changes,
  };
  return result;
}

function close() {
  db.close();
}

module.exports = {
  DB_PATH,
  DATA_DIR,
  recordConsent,
  createChat,
  endChat,
  addMessage,
  addReport,
  resolveReport,
  getReport,
  getChatDetail,
  deleteChat,
  listReports,
  addAudit,
  getOverview,
  purgeExpired,
  close,
};
