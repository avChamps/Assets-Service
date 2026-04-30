const fs = require("fs");
const path = require("path");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const P = require("pino");

const AUTH_DIR = path.resolve("baileys_auth");
let sock;
let isStarting = false;
let reconnectTimer = null;

function getWhatsAppGroupJid() {
  return String(process.env.WHATSAPP_GROUP_JID || "").trim();
}

async function logAvailableGroups(currentSock) {
  try {
    const groups = await currentSock.groupFetchAllParticipating();
    const entries = Object.values(groups || {});

    if (!entries.length) {
      console.log("[WA] No groups found for this account.");
      return;
    }

 } catch (err) {
    console.error("[WA] Failed to fetch groups:", err?.message || err);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function clearAuthDir() {
  try {
    await fs.promises.rm(AUTH_DIR, { recursive: true, force: true });
    console.log("[WA] Cleared auth directory for fresh login.");
  } catch (err) {
    console.error("[WA] Failed to clear auth directory:", err?.message || err);
  }
}

function shouldForceFreshLogin(statusCode) {
  return statusCode === DisconnectReason.loggedOut || statusCode === 405;
}

function scheduleReconnect({ forceFreshLogin = false, delayMs = 3000 } = {}) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(async () => {
    if (forceFreshLogin) {
      await clearAuthDir();
    }
    await startWhatsApp();
  }, delayMs);
}

async function startWhatsApp() {
  if (isStarting) return sock;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      ({ version } = await fetchLatestWaWebVersion());
    } catch (_) {
      // Continue with Baileys default version if version fetch fails.
    }

    sock = makeWASocket({
      auth: state,
      logger: P({ level: "silent" }),
      version,
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[WA] Scan this QR:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        clearReconnectTimer();
        console.log("[WA] WhatsApp connected.");
        logAvailableGroups(sock);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const forceFreshLogin = shouldForceFreshLogin(statusCode);
        console.log(`[WA] Connection closed: ${statusCode}`);

        if (forceFreshLogin) {
          console.log("[WA] Session invalid/expired. Regenerating QR.");
        }

        scheduleReconnect({
          forceFreshLogin,
          delayMs: forceFreshLogin ? 1000 : 3000,
        });
      }
    });

    return sock;
  } catch (err) {
    console.error("[WA] Failed to start socket:", err?.message || err);
    scheduleReconnect({ forceFreshLogin: false, delayMs: 5000 });
    return sock;
  } finally {
    isStarting = false;
  }
}

// start once
startWhatsApp();

async function sendMessageToGroup(text) {
  const groupJid = getWhatsAppGroupJid();

  if (!groupJid) {
    throw new Error("WHATSAPP_GROUP_JID is not configured");
  }

  if (!text || !String(text).trim()) {
    throw new Error("Message text is required");
  }

  let currentSock = sock;

  if (!currentSock) {
    currentSock = await startWhatsApp();
  }

  if (!currentSock) {
    throw new Error("WhatsApp socket is not ready");
  }

  return currentSock.sendMessage(groupJid, { text: String(text).trim() });
}

module.exports = {
  getSock: () => sock,
  startWhatsApp,
  sendMessageToGroup,
};
