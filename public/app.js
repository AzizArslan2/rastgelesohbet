const socket = io();

const el = {
  ageConsent: document.getElementById("ageConsent"),
  privacyConsent: document.getElementById("privacyConsent"),
  startBtn: document.getElementById("startBtn"),
  homeView: document.getElementById("homeView"),
  searchView: document.getElementById("searchView"),
  chatView: document.getElementById("chatView"),
  onlineCount: document.getElementById("onlineCount"),
  searchCount: document.getElementById("searchCount"),
  cancelBtn: document.getElementById("cancelBtn"),
  partnerAlias: document.getElementById("partnerAlias"),
  messages: document.getElementById("messages"),
  chatIntro: document.getElementById("chatIntro"),
  typingIndicator: document.getElementById("typingIndicator"),
  chatNotice: document.getElementById("chatNotice"),
  noticeText: document.getElementById("noticeText"),
  newMatchBtn: document.getElementById("newMatchBtn"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  sendBtn: document.getElementById("sendBtn"),
  skipBtn: document.getElementById("skipBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  reportBtn: document.getElementById("reportBtn"),
  copyBtn: document.getElementById("copyBtn"),
  autoNext: document.getElementById("autoNext"),
  sessionTimer: document.getElementById("sessionTimer"),
  reportDialog: document.getElementById("reportDialog"),
  reportForm: document.getElementById("reportForm"),
  reportCancelBtn: document.getElementById("reportCancelBtn"),
  toast: document.getElementById("toast"),
};

const state = {
  view: "home",
  connected: false,
  searching: false,
  typingSent: false,
  typingTimer: null,
  partnerTypingTimer: null,
  sessionTimer: null,
  sessionStartedAt: null,
  autoNextTimer: null,
  config: {
    consentVersion: "2026-01",
    chatRetentionDays: 30,
  },
};

let toastTimer = null;

function showView(name) {
  state.view = name;
  el.homeView.hidden = name !== "home";
  el.searchView.hidden = name !== "search";
  el.chatView.hidden = name !== "chat";
}

function updateStartState() {
  el.startBtn.disabled =
    !el.ageConsent.checked || !el.privacyConsent.checked || !socket.connected;
}

function setComposerEnabled(enabled) {
  el.messageInput.disabled = !enabled;
  el.sendBtn.disabled = !enabled;
}

function stopTyping() {
  clearTimeout(state.typingTimer);
  state.typingTimer = null;
  if (state.typingSent && socket.connected) {
    socket.emit("typing", false);
  }
  state.typingSent = false;
}

function hidePartnerTyping() {
  clearTimeout(state.partnerTypingTimer);
  state.partnerTypingTimer = null;
  el.typingIndicator.hidden = true;
}

function clearAutoNext() {
  clearTimeout(state.autoNextTimer);
  state.autoNextTimer = null;
}

function stopSessionTimer() {
  clearInterval(state.sessionTimer);
  state.sessionTimer = null;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${two(hours)}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}

function updateSessionTimer() {
  if (!state.sessionStartedAt) {
    el.sessionTimer.textContent = "00:00";
    return;
  }
  el.sessionTimer.textContent = formatDuration(Date.now() - state.sessionStartedAt);
}

function startSessionTimer() {
  stopSessionTimer();
  state.sessionStartedAt = Date.now();
  updateSessionTimer();
  state.sessionTimer = window.setInterval(updateSessionTimer, 1000);
}

function updateRetentionText() {
  const days = Number(state.config.chatRetentionDays) || 30;
  document.querySelectorAll("[data-chat-retention]").forEach((node) => {
    node.textContent = String(days);
  });
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("config");
    }
    const config = await response.json();
    state.config = {
      ...state.config,
      ...config,
    };
  } catch {
    showToast("KVKK ayarları yüklenemedi; varsayılan bilgiler kullanılıyor.");
  }
  updateRetentionText();
}

function sendConsent() {
  socket.emit("consent", {
    version: state.config.consentVersion,
    accepted: true,
  });
}

function resetChat() {
  state.connected = false;
  state.searching = false;
  state.typingSent = false;
  clearTimeout(state.typingTimer);
  state.typingTimer = null;
  clearAutoNext();
  hidePartnerTyping();
  stopSessionTimer();
  state.sessionStartedAt = null;
  el.sessionTimer.textContent = "00:00";

  el.messages.querySelectorAll(".message-row").forEach((row) => row.remove());
  el.chatIntro.hidden = false;
  el.chatNotice.hidden = true;
  el.partnerAlias.textContent = "Anonim";
  el.messageInput.value = "";
  el.messageInput.disabled = true;
  el.sendBtn.disabled = true;
}

function enterChat(partnerAlias) {
  resetChat();
  state.connected = true;
  state.searching = false;
  el.partnerAlias.textContent = partnerAlias || "Anonim";
  el.chatNotice.hidden = true;
  setComposerEnabled(true);
  showView("chat");
  el.messages.scrollTop = 0;
  startSessionTimer();

  if (window.matchMedia("(pointer: fine)").matches) {
    window.setTimeout(() => el.messageInput.focus(), 80);
  }
}

function beginSearch() {
  if (!el.ageConsent.checked || !el.privacyConsent.checked) {
    showToast("Devam etmek için yaş ve KVKK onaylarını işaretle.");
    return;
  }
  if (!socket.connected) {
    showToast("Bağlantı kuruluyor, birazdan tekrar dene.");
    return;
  }

  sendConsent();
  resetChat();
  showView("search");
  socket.emit("find");
}

function nextMatch() {
  if (!el.privacyConsent.checked) {
    showToast("Yeni eşleşme için KVKK onayı gerekli.");
    return;
  }
  if (!socket.connected) {
    showToast("Bağlantı kuruluyor, birazdan tekrar dene.");
    return;
  }

  sendConsent();
  resetChat();
  showView("search");
  socket.emit("skip");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add("show");
  toastTimer = window.setTimeout(() => {
    el.toast.classList.remove("show");
  }, 3400);
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scrollToLatest() {
  window.requestAnimationFrame(() => {
    el.messages.scrollTop = el.messages.scrollHeight;
  });
}

function appendMessage(text, who, timestamp) {
  el.chatIntro.hidden = true;

  const row = document.createElement("div");
  row.className = `message-row ${who}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const body = document.createElement("p");
  body.textContent = text;

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(timestamp || Date.now());

  bubble.append(body, time);
  row.append(bubble);
  el.messages.append(row);
  scrollToLatest();
}

function fallbackCopy(text) {
  const helper = document.createElement("textarea");
  helper.className = "clipboard-helper";
  helper.value = text;
  helper.setAttribute("readonly", "");
  document.body.append(helper);
  helper.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  helper.remove();
  showToast(copied ? "Sohbet panoya kopyalandı." : "Kopyalama desteklenmiyor.");
}

async function copyTranscript() {
  const rows = Array.from(el.messages.querySelectorAll(".message-row"));
  if (rows.length === 0) {
    showToast("Kopyalanacak mesaj yok.");
    return;
  }

  const partnerName = el.partnerAlias.textContent || "Yabancı";
  const lines = rows.map((row) => {
    const text = row.querySelector(".bubble p")?.textContent || "";
    const time = row.querySelector(".msg-time")?.textContent || "";
    const who = row.classList.contains("self") ? "Sen" : partnerName;
    return `${time} ${who}: ${text}`;
  });

  const transcript = [
    "Rastgele anonim sohbet dökümü",
    `Tarih: ${new Date().toLocaleString("tr-TR")}`,
    "",
    ...lines,
    "",
    "Bu döküm yalnızca cihazında oluşturuldu.",
  ].join("\n");

  try {
    if (!navigator.clipboard || !window.isSecureContext) {
      throw new Error("clipboard");
    }
    await navigator.clipboard.writeText(transcript);
    showToast("Sohbet panoya kopyalandı.");
  } catch {
    fallbackCopy(transcript);
  }
}

function leaveMessage(reason) {
  if (reason === "disconnected") {
    return "Yabancının bağlantısı koptu.";
  }
  if (reason === "skip") {
    return "Yabancı sonraki kişiye geçti.";
  }
  if (reason === "left") {
    return "Yabancı sohbetten ayrıldı.";
  }
  if (typeof reason === "string" && reason.startsWith("reported")) {
    return "Sohbet güvenlik nedeniyle sonlandırıldı.";
  }
  return "Yabancı sohbetten ayrıldı.";
}

el.ageConsent.addEventListener("change", updateStartState);
el.privacyConsent.addEventListener("change", updateStartState);

document.querySelectorAll(".consent a").forEach((link) => {
  link.addEventListener("click", (event) => event.stopPropagation());
});

el.startBtn.addEventListener("click", beginSearch);

el.cancelBtn.addEventListener("click", () => {
  socket.emit("cancel");
  resetChat();
  showView("home");
});

el.skipBtn.addEventListener("click", nextMatch);
el.newMatchBtn.addEventListener("click", nextMatch);
el.copyBtn.addEventListener("click", copyTranscript);

el.autoNext.addEventListener("change", () => {
  if (!el.autoNext.checked) {
    clearAutoNext();
  }
  showToast(
    el.autoNext.checked
      ? "Otomatik yeni eşleşme açıldı."
      : "Otomatik yeni eşleşme kapatıldı."
  );
});

el.leaveBtn.addEventListener("click", () => {
  socket.emit("leave");
  resetChat();
  showView("home");
  showToast("Sohbet sonlandırıldı.");
});

el.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.connected) {
    return;
  }

  const text = el.messageInput.value.trim();
  if (!text) {
    return;
  }

  appendMessage(text, "self", Date.now());
  socket.emit("message", { text });
  el.messageInput.value = "";
  stopTyping();
  el.messageInput.focus();
});

el.messageInput.addEventListener("input", () => {
  if (!state.connected) {
    return;
  }

  if (!state.typingSent) {
    socket.emit("typing", true);
    state.typingSent = true;
  }

  clearTimeout(state.typingTimer);
  state.typingTimer = window.setTimeout(stopTyping, 1200);
});

el.reportBtn.addEventListener("click", () => {
  if (!state.connected) {
    showToast("Bildirilecek aktif bir eşleşme yok.");
    return;
  }
  el.reportDialog.showModal();
});

el.reportCancelBtn.addEventListener("click", () => {
  el.reportDialog.close();
});

el.reportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(el.reportForm);
  const reason = formData.get("reportReason") || "other";
  socket.emit("report", { reason });
  el.reportDialog.close();
});

el.reportDialog.addEventListener("click", (event) => {
  if (event.target === el.reportDialog) {
    el.reportDialog.close();
  }
});

socket.on("connect", () => {
  updateStartState();
});

socket.on("disconnect", () => {
  resetChat();
  showView("home");
  updateStartState();
  showToast("Bağlantı koptu. Yeniden bağlanılıyor...");
});

socket.on("connect_error", () => {
  updateStartState();
  showToast("Sunucuya bağlanılamadı.");
});

socket.on("ready", (payload) => {
  if (payload?.consentVersion) {
    state.config.consentVersion = payload.consentVersion;
  }
  updateStartState();
});

socket.on("consent-accepted", () => {
  updateStartState();
});

socket.on("consent-required", () => {
  el.privacyConsent.checked = false;
  resetChat();
  showView("home");
  updateStartState();
  showToast("Devam etmek için KVKK onayını yeniden ver.");
});

socket.on("stats", (payload) => {
  const online = Number(payload?.online) || 0;
  el.onlineCount.textContent = String(online);
  el.searchCount.textContent = String(online);
});

socket.on("searching", () => {
  state.connected = false;
  state.searching = true;
  setComposerEnabled(false);
  hidePartnerTyping();
  clearAutoNext();
  showView("search");
});

socket.on("matched", (payload) => {
  enterChat(payload?.partnerAlias);
  showToast("Eşleştiniz. Sohbet başlasın.");
});

socket.on("message", (payload) => {
  if (!state.connected || !payload || typeof payload.text !== "string") {
    return;
  }
  hidePartnerTyping();
  appendMessage(payload.text, "stranger", payload.at);
});

socket.on("partner-left", (payload) => {
  state.connected = false;
  state.searching = false;
  setComposerEnabled(false);
  hidePartnerTyping();
  stopSessionTimer();
  stopTyping();
  el.noticeText.textContent = leaveMessage(payload?.reason);
  el.chatNotice.hidden = false;

  if (el.autoNext.checked && socket.connected) {
    el.noticeText.textContent = "Yabancı ayrıldı. Yeni eşleşme aranıyor...";
    clearAutoNext();
    state.autoNextTimer = window.setTimeout(() => {
      if (
        el.autoNext.checked &&
        socket.connected &&
        !state.connected &&
        state.view === "chat"
      ) {
        nextMatch();
      }
    }, 1300);
  }
});

socket.on("typing", (isTyping) => {
  if (!state.connected) {
    return;
  }

  if (isTyping) {
    el.typingIndicator.hidden = false;
    clearTimeout(state.partnerTypingTimer);
    state.partnerTypingTimer = window.setTimeout(hidePartnerTyping, 4000);
  } else {
    hidePartnerTyping();
  }
});

socket.on("rate-limited", () => {
  showToast("Çok hızlı yazıyorsun. Kısa bir mola ver.");
});

socket.on("reported", () => {
  resetChat();
  showView("home");
  showToast("Bildirim kaydedildi ve sohbet sonlandırıldı.");
});

socket.on("idle", () => {
  state.searching = false;
  if (state.view === "search") {
    showView("home");
  }
});

updateStartState();
loadConfig();
