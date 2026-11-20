const el = {
  refreshBtn: document.getElementById("refreshBtn"),
  statChats: document.getElementById("statChats"),
  statToday: document.getElementById("statToday"),
  statMessages: document.getElementById("statMessages"),
  statReports: document.getElementById("statReports"),
  statConsents: document.getElementById("statConsents"),
  statSize: document.getElementById("statSize"),
  retentionNote: document.getElementById("retentionNote"),
  reportCount: document.getElementById("reportCount"),
  reportsBody: document.getElementById("reportsBody"),
  detailPanel: document.getElementById("detailPanel"),
  detailTitle: document.getElementById("detailTitle"),
  detailMeta: document.getElementById("detailMeta"),
  detailMessages: document.getElementById("detailMessages"),
  closeDetailBtn: document.getElementById("closeDetailBtn"),
  resolveBtn: document.getElementById("resolveBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  adminStatus: document.getElementById("adminStatus"),
};

const state = {
  reports: [],
  selectedReport: null,
  selectedChat: null,
};

let statusTimer = null;

function showStatus(message, isError = false) {
  window.clearTimeout(statusTimer);
  el.adminStatus.textContent = message;
  el.adminStatus.classList.toggle("error", isError);
  el.adminStatus.classList.add("show");
  statusTimer = window.setTimeout(() => {
    el.adminStatus.classList.remove("show");
  }, 3600);
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = {};
  if (method !== "GET") {
    headers["X-Requested-With"] = "fetch";
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const error = new Error(payload?.error || "İstek başarısız oldu");
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "—";
  }
  return new Date(timestamp).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function reasonLabel(reason) {
  const labels = {
    harassment: "Taciz veya tehdit",
    sexual: "Cinsel içerik",
    spam: "Spam veya reklam",
    other: "Diğer",
  };
  return labels[reason] || reason || "Diğer";
}

function endReasonLabel(reason) {
  const labels = {
    skip: "Sonraki kişiye geçildi",
    left: "Sohbetten ayrıldı",
    disconnected: "Bağlantı koptu",
    reported: "Bildirim üzerine sonlandırıldı",
  };
  return labels[reason] || reason || "—";
}

async function loadOverview() {
  const data = await api("/api/admin/overview");
  el.statChats.textContent = String(data.totalChats ?? 0);
  el.statToday.textContent = String(data.todayChats ?? 0);
  el.statMessages.textContent = String(data.totalMessages ?? 0);
  el.statReports.textContent = String(data.openReports ?? 0);
  el.statConsents.textContent = String(data.totalConsents ?? 0);
  el.statSize.textContent = formatBytes(data.databaseBytes);
  el.retentionNote.textContent =
    `Saklama: sohbet ${data.retention?.chatDays ?? "—"} gün · ` +
    `rapor ${data.retention?.reportDays ?? "—"} gün · ` +
    `rıza ${data.retention?.consentDays ?? "—"} gün. ` +
    `Aktif bağlantı: ${data.online ?? 0}, arama kuyruğu: ${data.waiting ?? 0}.`;
}

function renderReports() {
  el.reportsBody.replaceChildren();
  el.reportCount.textContent = `${state.reports.length} kayıt`;

  if (state.reports.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "admin-empty";
    cell.textContent = "Henüz rapor yok.";
    row.append(cell);
    el.reportsBody.append(row);
    return;
  }

  for (const report of state.reports) {
    const row = document.createElement("tr");
    row.dataset.reportId = String(report.id);
    if (state.selectedReport?.id === report.id) {
      row.classList.add("is-active");
    }

    const date = document.createElement("td");
    date.textContent = formatDate(report.created_at);

    const reason = document.createElement("td");
    reason.textContent = reasonLabel(report.reason);

    const messageCount = document.createElement("td");
    messageCount.textContent = String(report.message_count ?? 0);

    const status = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = "admin-badge-soft";
    if (report.resolved_at) {
      statusBadge.classList.add("resolved");
      statusBadge.textContent = "Çözüldü";
    } else {
      statusBadge.textContent = "Açık";
    }
    status.append(statusBadge);

    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-link-btn";
    button.textContent = "İncele";
    button.addEventListener("click", () => {
      selectReport(report);
    });
    action.append(button);

    row.append(date, reason, messageCount, status, action);
    el.reportsBody.append(row);
  }
}

async function loadReports() {
  const data = await api("/api/admin/reports");
  state.reports = Array.isArray(data.reports) ? data.reports : [];
  renderReports();
}

function markActiveReport(reportId) {
  el.reportsBody.querySelectorAll("tr").forEach((row) => {
    row.classList.toggle("is-active", Number(row.dataset.reportId) === reportId);
  });
}

function appendMessage(message, reporterSide) {
  const bubble = document.createElement("div");
  bubble.className = "admin-message";
  if (message.sender === reporterSide) {
    bubble.classList.add("self");
  }

  const meta = document.createElement("div");
  meta.className = "admin-message-meta";

  const who = document.createElement("span");
  who.textContent = message.sender === reporterSide ? "Bildiren" : "Karşı taraf";

  const time = document.createElement("span");
  time.textContent = formatDate(message.created_at);

  const body = document.createElement("p");
  body.textContent = message.body;

  meta.append(who, time);
  bubble.append(meta, body);
  el.detailMessages.append(bubble);
}

function renderChat(detail, report) {
  const chat = detail.chat;
  el.detailMeta.textContent =
    `${formatDate(chat.started_at)} · ${chat.message_count} mesaj · ` +
    `${endReasonLabel(chat.end_reason)} · Sohbet ${chat.id.slice(0, 8)}…`;

  el.detailMessages.replaceChildren();
  if (!detail.messages.length) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent = "Bu sohbette kayıtlı mesaj yok.";
    el.detailMessages.append(empty);
    return;
  }

  for (const message of detail.messages) {
    appendMessage(message, report.reporter_side);
  }
}

async function selectReport(report) {
  state.selectedReport = report;
  state.selectedChat = null;
  markActiveReport(report.id);

  el.detailPanel.hidden = false;
  el.detailTitle.textContent = `Rapor #${report.id}`;
  el.detailMeta.textContent =
    `${formatDate(report.created_at)} · ${reasonLabel(report.reason)} · ` +
    `${report.resolved_at ? "Çözüldü" : "Açık"}`;
  el.detailMessages.replaceChildren();
  el.resolveBtn.disabled = Boolean(report.resolved_at);
  el.deleteBtn.disabled = false;

  const loading = document.createElement("p");
  loading.className = "admin-empty";
  loading.textContent = "Sohbet yükleniyor...";
  el.detailMessages.append(loading);

  try {
    const detail = await api(`/api/admin/chats/${encodeURIComponent(report.chat_id)}`);
    if (state.selectedReport?.id !== report.id) {
      return;
    }
    state.selectedChat = detail;
    renderChat(detail, report);
  } catch (error) {
    if (state.selectedReport?.id !== report.id) {
      return;
    }
    el.detailMessages.replaceChildren();
    const message = document.createElement("p");
    message.className = "admin-empty";
    message.textContent =
      error.status === 404
        ? "Sohbet kaydı bulunamadı. Saklama süresi dolmuş veya kayıt silinmiş olabilir."
        : "Sohbet kaydı yüklenemedi.";
    el.detailMessages.append(message);
    el.deleteBtn.disabled = true;
  }
}

async function resolveSelectedReport() {
  const report = state.selectedReport;
  if (!report || report.resolved_at) {
    return;
  }

  el.resolveBtn.disabled = true;
  try {
    await api(`/api/admin/reports/${report.id}/resolve`, { method: "POST" });
    showStatus("Rapor çözüldü olarak işaretlendi.");
    await loadReports();
    await loadOverview();
    const updated = state.reports.find((item) => item.id === report.id);
    if (updated) {
      await selectReport(updated);
    }
  } catch (error) {
    showStatus(error.message || "Rapor güncellenemedi.", true);
    el.resolveBtn.disabled = false;
  }
}

async function deleteSelectedChat() {
  const report = state.selectedReport;
  if (!report || !state.selectedChat) {
    return;
  }

  const approved = window.confirm(
    "Bu sohbetin mesaj kayıtları kalıcı olarak silinecek. Emin misin?"
  );
  if (!approved) {
    return;
  }

  el.deleteBtn.disabled = true;
  try {
    await api(`/api/admin/chats/${encodeURIComponent(report.chat_id)}/delete`, {
      method: "POST",
    });
    showStatus("Sohbet kaydı silindi.");
    closeDetail();
    await loadReports();
    await loadOverview();
  } catch (error) {
    showStatus(error.message || "Sohbet silinemedi.", true);
    el.deleteBtn.disabled = false;
  }
}

function closeDetail() {
  state.selectedReport = null;
  state.selectedChat = null;
  el.detailPanel.hidden = true;
  el.detailMessages.replaceChildren();
  el.reportsBody.querySelectorAll("tr").forEach((row) => {
    row.classList.remove("is-active");
  });
}

async function refreshAll(showSuccess = false) {
  el.refreshBtn.disabled = true;
  try {
    await Promise.all([loadOverview(), loadReports()]);
    if (showSuccess) {
      showStatus("Veriler yenilendi.");
    }
  } catch (error) {
    showStatus(
      error.status === 401
        ? "Oturum doğrulanamadı. Sayfayı yenileyip tekrar giriş yap."
        : error.message || "Veriler alınamadı.",
      true
    );
  } finally {
    el.refreshBtn.disabled = false;
  }
}

el.refreshBtn.addEventListener("click", () => refreshAll(true));
el.closeDetailBtn.addEventListener("click", closeDetail);
el.resolveBtn.addEventListener("click", resolveSelectedReport);
el.deleteBtn.addEventListener("click", deleteSelectedChat);

refreshAll();
setInterval(() => {
  loadOverview().catch(() => {});
}, 60000);
