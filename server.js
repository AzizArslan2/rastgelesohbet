require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const http = require("http");
const { randomUUID, createHash, timingSafeEqual } = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingTimeout: 25000,
});

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

const PORT = envInt("PORT", 3000, 1, 65535);
const CONSENT_VERSION = (process.env.CONSENT_VERSION || "2026-01").slice(0, 40);
const CHAT_RETENTION_DAYS = envInt("CHAT_RETENTION_DAYS", 30, 1, 3650);
const REPORT_RETENTION_DAYS = envInt("REPORT_RETENTION_DAYS", 180, 1, 3650);
const CONSENT_RETENTION_DAYS = envInt("CONSENT_RETENTION_DAYS", 365, 1, 3650);
const AUDIT_RETENTION_DAYS = envInt("AUDIT_RETENTION_DAYS", 365, 1, 3650);
const CONTROLLER_NAME = (process.env.CONTROLLER_NAME || "Rastgele Anonim Sohbet").slice(0, 160);
const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || "kvkk@example.com").slice(0, 160);
const ADMIN_USER = (process.env.ADMIN_USER || "admin").slice(0, 80);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PRIVACY_UPDATED_AT = (
  process.env.PRIVACY_UPDATED_AT ||
  new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })
).slice(0, 80);

const waiting = new Set();

const adjectives = [
  "Mavi", "Gizli", "Hızlı", "Sessiz", "Cesur", "Meraklı", "Parlak", "Sakin",
  "Uzak", "Tatlı", "Kuzey", "Gümüş", "Turuncu", "Yeşil", "Sarı", "Mor",
];
const nouns = [
  "Kedi", "Baykuş", "Tilki", "Yunus", "Kartal", "Panda", "Kurt", "Şahin",
  "Serçe", "Vaşak", "Deniz", "Bulut", "Yıldız", "Rüzgar", "Çınar", "Kaya",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function makeAlias() {
  return `${pick(adjectives)} ${pick(nouns)} ${Math.floor(10 + Math.random() * 90)}`;
}

function onlineCount() {
  return io.of("/").sockets.size;
}

function broadcastStats() {
  io.emit("stats", { online: onlineCount(), waiting: waiting.size });
}

function allowMessage(socket) {
  const now = Date.now();
  const recent = (socket.data.messageTimes || []).filter((time) => now - time < 5000);
  if (recent.length >= 8) {
    socket.data.messageTimes = recent;
    return false;
  }
  recent.push(now);
  socket.data.messageTimes = recent;
  return true;
}

function findMatch(socket) {
  if (!socket.connected || socket.data.partnerId) {
    return;
  }

  if (!socket.data.consentId) {
    socket.emit("consent-required", { version: CONSENT_VERSION });
    return;
  }

  waiting.delete(socket.id);
  let partner = null;
  const candidates = Array.from(waiting);

  while (candidates.length > 0) {
    const index = Math.floor(Math.random() * candidates.length);
    const candidateId = candidates.splice(index, 1)[0];
    const candidate = io.sockets.sockets.get(candidateId);
    if (!candidate || !candidate.connected || candidate.data.partnerId || !candidate.data.consentId) {
      waiting.delete(candidateId);
      continue;
    }
    partner = candidate;
    break;
  }

  if (!partner) {
    waiting.add(socket.id);
    socket.emit("searching");
    broadcastStats();
    return;
  }

  waiting.delete(socket.id);
  waiting.delete(partner.id);

  let chatId = null;
  try {
    chatId = db.createChat({
      consentA: socket.data.consentId,
      consentB: partner.data.consentId,
    });
  } catch (error) {
    console.error("Sohbet kaydı oluşturulamadı:", error.message);
  }

  const roomId = chatId || randomUUID();
  socket.join(roomId);
  partner.join(roomId);

  socket.data.partnerId = partner.id;
  partner.data.partnerId = socket.id;
  socket.data.roomId = roomId;
  partner.data.roomId = roomId;
  socket.data.chatId = chatId;
  partner.data.chatId = chatId;
  socket.data.side = "a";
  partner.data.side = "b";

  socket.emit("matched", {
    selfAlias: socket.data.alias,
    partnerAlias: partner.data.alias,
  });
  partner.emit("matched", {
    selfAlias: partner.data.alias,
    partnerAlias: socket.data.alias,
  });

  broadcastStats();
}

function endMatch(socket, { notify = true, reason = "left" } = {}) {
  const partnerId = socket.data.partnerId;
  const roomId = socket.data.roomId;
  const chatId = socket.data.chatId;

  waiting.delete(socket.id);
  socket.data.partnerId = null;
  socket.data.roomId = null;
  socket.data.chatId = null;
  socket.data.side = null;
  if (roomId) {
    socket.leave(roomId);
  }

  if (chatId) {
    try {
      db.endChat(chatId, reason);
    } catch (error) {
      console.error("Sohbet kaydı kapatılamadı:", error.message);
    }
  }

  if (!partnerId) {
    return;
  }

  const partner = io.sockets.sockets.get(partnerId);
  if (!partner) {
    return;
  }

  waiting.delete(partner.id);
  partner.data.partnerId = null;
  partner.data.roomId = null;
  partner.data.chatId = null;
  partner.data.side = null;
  if (roomId) {
    partner.leave(roomId);
  }

  if (notify && partner.connected) {
    partner.emit("partner-left", { reason });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeEqual(left, right) {
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(404).send("Bulunamadı");
  }

  if (req.method !== "GET" && req.get("x-requested-with") !== "fetch") {
    return res.status(403).json({ error: "Geçersiz istek" });
  }

  const authorization = req.get("authorization") || "";
  if (!authorization.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Rastgele Admin", charset="UTF-8"');
    return res.status(401).send("Yetkisiz");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    decoded = "";
  }

  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="Rastgele Admin", charset="UTF-8"');
    return res.status(401).send("Yetkisiz");
  }

  req.adminUser = username;
  res.set("Cache-Control", "no-store");
  next();
}

function purgeExpiredData() {
  try {
    const result = db.purgeExpired({
      chatDays: CHAT_RETENTION_DAYS,
      reportDays: REPORT_RETENTION_DAYS,
      consentDays: CONSENT_RETENTION_DAYS,
      auditDays: AUDIT_RETENTION_DAYS,
    });
    const changed = result.chats + result.reports + result.consents + result.audit;
    if (changed > 0) {
      console.log("Süresi dolan kayıtlar silindi:", result);
    }
  } catch (error) {
    console.error("Veri temizliği başarısız:", error.message);
  }
}

const privacyTemplate = fs.readFileSync(path.join(__dirname, "templates", "kvkk.html"), "utf8");
const adminPage = path.join(__dirname, "templates", "admin.html");

function renderPrivacyPage() {
  const values = {
    CONTROLLER_NAME: escapeHtml(CONTROLLER_NAME),
    CONTACT_EMAIL: escapeHtml(CONTACT_EMAIL),
    CONSENT_VERSION: escapeHtml(CONSENT_VERSION),
    CHAT_RETENTION_DAYS: String(CHAT_RETENTION_DAYS),
    REPORT_RETENTION_DAYS: String(REPORT_RETENTION_DAYS),
    CONSENT_RETENTION_DAYS: String(CONSENT_RETENTION_DAYS),
    AUDIT_RETENTION_DAYS: String(AUDIT_RETENTION_DAYS),
    UPDATED_AT: escapeHtml(PRIVACY_UPDATED_AT),
  };

  return privacyTemplate.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    return Object.hasOwn(values, key) ? values[key] : match;
  });
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, online: onlineCount(), waiting: waiting.size });
});

app.get("/api/config", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    consentVersion: CONSENT_VERSION,
    chatRetentionDays: CHAT_RETENTION_DAYS,
    reportRetentionDays: REPORT_RETENTION_DAYS,
    controllerName: CONTROLLER_NAME,
    contactEmail: CONTACT_EMAIL,
  });
});

app.get("/kvkk", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(renderPrivacyPage());
});

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(adminPage);
});

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  try {
    res.json({
      online: onlineCount(),
      waiting: waiting.size,
      ...db.getOverview(),
      retention: {
        chatDays: CHAT_RETENTION_DAYS,
        reportDays: REPORT_RETENTION_DAYS,
        consentDays: CONSENT_RETENTION_DAYS,
      },
    });
  } catch (error) {
    console.error("Admin özeti alınamadı:", error.message);
    res.status(500).json({ error: "Veriler alınamadı" });
  }
});

app.get("/api/admin/reports", requireAdmin, (req, res) => {
  try {
    res.json({ reports: db.listReports(150) });
  } catch (error) {
    console.error("Raporlar alınamadı:", error.message);
    res.status(500).json({ error: "Raporlar alınamadı" });
  }
});

app.get("/api/admin/chats/:id", requireAdmin, (req, res) => {
  const chatId = String(req.params.id || "").slice(0, 80);
  try {
    const detail = db.getChatDetail(chatId);
    if (!detail) {
      return res.status(404).json({ error: "Sohbet bulunamadı" });
    }
    db.addAudit("view_chat", chatId, req.adminUser);
    res.json(detail);
  } catch (error) {
    console.error("Sohbet detayı alınamadı:", error.message);
    res.status(500).json({ error: "Sohbet detayı alınamadı" });
  }
});

app.post("/api/admin/reports/:id/resolve", requireAdmin, (req, res) => {
  const reportId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(reportId) || reportId < 1) {
    return res.status(400).json({ error: "Geçersiz rapor" });
  }
  try {
    const report = db.getReport(reportId);
    if (!report) {
      return res.status(404).json({ error: "Rapor bulunamadı" });
    }
    const changed = db.resolveReport(reportId, req.adminUser);
    db.addAudit("resolve_report", String(reportId), req.adminUser);
    res.json({ ok: true, changed });
  } catch (error) {
    console.error("Rapor çözülemedi:", error.message);
    res.status(500).json({ error: "Rapor güncellenemedi" });
  }
});

app.post("/api/admin/chats/:id/delete", requireAdmin, (req, res) => {
  const chatId = String(req.params.id || "").slice(0, 80);
  try {
    const deleted = db.deleteChat(chatId);
    if (!deleted) {
      return res.status(404).json({ error: "Sohbet bulunamadı" });
    }
    db.addAudit("delete_chat", chatId, req.adminUser);
    res.json({ ok: true });
  } catch (error) {
    console.error("Sohbet silinemedi:", error.message);
    res.status(500).json({ error: "Sohbet silinemedi" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.data.alias = makeAlias();
  socket.data.sessionRef = randomUUID();
  socket.data.consentId = null;
  socket.data.partnerId = null;
  socket.data.roomId = null;
  socket.data.chatId = null;
  socket.data.side = null;
  socket.data.messageTimes = [];

  socket.emit("ready", { alias: socket.data.alias, consentVersion: CONSENT_VERSION });
  broadcastStats();

  socket.on("consent", (payload) => {
    const accepted = payload?.accepted === true;
    const version = typeof payload?.version === "string" ? payload.version.slice(0, 40) : "";

    if (!accepted || version !== CONSENT_VERSION) {
      socket.data.consentId = null;
      socket.emit("consent-required", { version: CONSENT_VERSION });
      return;
    }

    if (!socket.data.consentId) {
      try {
        const consent = db.recordConsent({
          sessionRef: socket.data.sessionRef,
          version,
        });
        socket.data.consentId = consent.id;
      } catch (error) {
        console.error("Rıza kaydı oluşturulamadı:", error.message);
        socket.emit("consent-required", { version: CONSENT_VERSION });
        return;
      }
    }

    socket.emit("consent-accepted", { version });
  });

  socket.on("find", () => {
    if (socket.data.partnerId) {
      return;
    }
    findMatch(socket);
  });

  socket.on("cancel", () => {
    waiting.delete(socket.id);
    if (!socket.data.partnerId) {
      socket.emit("idle");
    }
    broadcastStats();
  });

  socket.on("skip", () => {
    if (!socket.data.partnerId) {
      findMatch(socket);
      return;
    }
    endMatch(socket, { notify: true, reason: "skip" });
    socket.emit("searching");
    findMatch(socket);
  });

  socket.on("leave", () => {
    endMatch(socket, { notify: true, reason: "left" });
    socket.emit("idle");
    broadcastStats();
  });

  socket.on("message", (payload) => {
    if (!socket.data.partnerId) {
      return;
    }

    const text = typeof payload?.text === "string" ? payload.text.trim().slice(0, 1000) : "";
    if (!text) {
      return;
    }

    if (!allowMessage(socket)) {
      socket.emit("rate-limited");
      return;
    }

    const partner = io.sockets.sockets.get(socket.data.partnerId);
    if (!partner || !partner.connected) {
      return;
    }

    if (socket.data.chatId && socket.data.side) {
      try {
        db.addMessage(socket.data.chatId, socket.data.side, text);
      } catch (error) {
        console.error("Mesaj kaydedilemedi:", error.message);
      }
    }

    partner.emit("message", { text, at: Date.now() });
  });

  socket.on("typing", (isTyping) => {
    const partnerId = socket.data.partnerId;
    if (!partnerId) {
      return;
    }
    const partner = io.sockets.sockets.get(partnerId);
    if (partner && partner.connected) {
      partner.emit("typing", Boolean(isTyping));
    }
  });

  socket.on("report", (payload) => {
    if (!socket.data.partnerId) {
      return;
    }
    const reason = typeof payload?.reason === "string" ? payload.reason.slice(0, 100) : "other";

    if (socket.data.chatId && socket.data.side) {
      try {
        db.addReport({
          chatId: socket.data.chatId,
          reporterSide: socket.data.side,
          reason,
        });
      } catch (error) {
        console.error("Rapor kaydedilemedi:", error.message);
      }
    }

    endMatch(socket, { notify: true, reason: "reported" });
    socket.emit("reported");
    broadcastStats();
  });

  socket.on("disconnect", () => {
    waiting.delete(socket.id);
    endMatch(socket, { notify: true, reason: "disconnected" });
    broadcastStats();
  });
});

purgeExpiredData();
const purgeTimer = setInterval(purgeExpiredData, 6 * 60 * 60 * 1000);
purgeTimer.unref();

server.listen(PORT, () => {
  console.log(`Rastgele sohbet http://localhost:${PORT} adresinde çalışıyor`);
  console.log(
    `Veri saklama: sohbet ${CHAT_RETENTION_DAYS} gün, rapor ${REPORT_RETENTION_DAYS} gün, rıza ${CONSENT_RETENTION_DAYS} gün`
  );
  if (!ADMIN_PASSWORD) {
    console.log("Admin paneli kapalı. Açmak için ADMIN_PASSWORD ortam değişkenini ayarla.");
  } else if (ADMIN_PASSWORD.length < 12) {
    console.warn("Uyarı: ADMIN_PASSWORD çok kısa. En az 12 karakter kullan.");
  }
  console.log(`KVKK aydınlatma metni: http://localhost:${PORT}/kvkk`);
});

function shutdown() {
  clearInterval(purgeTimer);
  io.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
