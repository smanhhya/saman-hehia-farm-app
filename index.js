const express = require("express");
const cors = require("cors");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require("@whiskeysockets/baileys");

process.on("uncaughtException", (err) => {
  console.log("⚠️ تجاهل خطأ خلفي:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.log("⚠️ تجاهل وعد غير معالج:", err?.message || err);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const SESSION_DIR = path.join(__dirname, "auth_info_baileys");
const PHONE_NUMBER = "201280531968";
const logger = pino({ level: "silent" });

let sock = null;
let isConnected = false;
let pairingCodeRequested = false;
let isSendingQueueRunning = false;
const sendQueue = [];

// خزنة الرسائل لمنع تعليق الرسائل على "في انتظار هذه الرسالة"
const messageStore = new Map();

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    getMessage: async (key) => {
      if (key?.id && messageStore.has(key.id)) {
        return messageStore.get(key.id);
      }
      return { conversation: "سمان ههيا" };
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      if (m.key?.id && m.message) {
        messageStore.set(m.key.id, m.message);
        if (messageStore.size > 500) {
          const firstKey = messageStore.keys().next().value;
          messageStore.delete(firstKey);
        }
      }
    }
  });

  // طلب كود الربط مرة واحدة فقط إذا لم يكن مسجلاً
  if (!sock.authState.creds.registered && !pairingCodeRequested) {
    pairingCodeRequested = true;
    setTimeout(async () => {
      try {
        if (!sock || sock.authState.creds.registered) return;
        let code = await sock.requestPairingCode(PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log("========================================");
        console.log("🔑 كود ربط الواتساب الخاص بك هو: ", code);
        console.log("========================================");
      } catch (err) {
        pairingCodeRequested = false;
        console.log("❌ خطأ في طلب كود الربط:", err.message);
      }
    }, 8000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ الاتصال فصل (كود: ${statusCode})`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        // مسح الجلسة فقط إذا كانت منتهية الصلاحية (401)
        console.log("🧹 مسح الجلسة القديمة المنتهية (401) وتوليد كود جديد...");
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch (e) {}
        pairingCodeRequested = false;
        setTimeout(() => connectToWhatsApp(), 2000);
      } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        // كود 515 يحدث لحظة إدخال الكود في الموبايل لإتمام الربط: إعادة اتصال فورية بدون مسح الملفات
        console.log("🔄 جاري إتمام ربط الموبايل (Restart 515)...");
        setTimeout(() => connectToWhatsApp(), 500);
      } else {
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    } else if (connection === "open") {
      isConnected = true;
      pairingCodeRequested = true;
      console.log("========================================");
      console.log("✅ تم ربط الواتساب بنجاح والسيرفر جاهز للعمل 24/7!");
      console.log("========================================");
    }
  });
}

connectToWhatsApp();

// دالة إرسال موحدة تفحص الرقم وتنشط التشفير قبل الإرسال
async function sendSafeWhatsAppMessage(rawPhone, textMessage) {
  let cleanPhone = rawPhone.toString().replace(/\D/g, "");
  if (cleanPhone.startsWith("0020")) cleanPhone = cleanPhone.substring(2);
  else if (cleanPhone.startsWith("0")) cleanPhone = "2" + cleanPhone;
  else if (cleanPhone.length === 10 && cleanPhone.startsWith("1")) cleanPhone = "20" + cleanPhone;

  let targetJid = cleanPhone + "@s.whatsapp.net";

  try {
    const [result] = await sock.onWhatsApp(cleanPhone);
    if (result && result.exists && result.jid) {
      targetJid = result.jid;
    }
  } catch (e) {}

  try {
    await sock.presenceSubscribe(targetJid);
    await sock.sendPresenceUpdate("composing", targetJid);
    await delay(1500);
    await sock.sendPresenceUpdate("paused", targetJid);
  } catch (e) {}

  const sentMsg = await sock.sendMessage(targetJid, { text: textMessage });
  if (sentMsg?.key?.id && sentMsg.message) {
    messageStore.set(sentMsg.key.id, sentMsg.message);
  }
  return cleanPhone;
}

async function processSendQueue() {
  if (isSendingQueueRunning) return;
  isSendingQueueRunning = true;

  while (sendQueue.length > 0) {
    const item = sendQueue.shift();
    if (!isConnected) {
      await delay(5000);
      sendQueue.unshift(item);
      continue;
    }

    try {
      const sentTo = await sendSafeWhatsAppMessage(item.phone, item.message);
      console.log(`✅ تم الإرسال بنجاح إلى: ${sentTo} (متبقي: ${sendQueue.length})`);
    } catch (err) {
      console.log(`❌ فشل الإرسال إلى ${item.phone}:`, err.message);
    }

    if (sendQueue.length > 0) {
      const waitMs = Math.floor(Math.random() * (8000 - 5000 + 1)) + 5000;
      await delay(waitMs);
    }
  }

  isSendingQueueRunning = false;
  console.log("🎉 اكتمل إرسال جميع الرسائل في الطابور!");
}

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    connected: isConnected,
    queueLength: sendQueue.length,
    message: isConnected ? "Server is running & WhatsApp Connected!" : "Waiting for WhatsApp pairing..."
  });
});

app.post("/send-bulk-smart", (req, res) => {
  const { bulkData } = req.body;
  if (!bulkData || !Array.isArray(bulkData)) {
    return res.status(400).json({ error: "البيانات ناقصة!" });
  }
  if (!isConnected) {
    return res.status(503).json({ error: "الواتساب غير متصل بالسيرفر حالياً!" });
  }

  bulkData.forEach((item) => {
    if (item.phone && item.message) {
      sendQueue.push({ phone: item.phone, message: item.message });
    }
  });

  res.status(200).json({ status: "queued", added: bulkData.length, totalInQueue: sendQueue.length });
  processSendQueue();
});

app.post("/send-bulk", (req, res) => {
  const { numbers, message } = req.body;
  if (!numbers || !Array.isArray(numbers) || !message) {
    return res.status(400).send("البيانات ناقصة!");
  }
  if (!isConnected) {
    return res.status(503).send("الواتساب غير متصل!");
  }

  numbers.forEach((num) => sendQueue.push({ phone: num, message }));
  res.status(200).send("تمت الإضافة لطابور الإرسال");
  processSendQueue();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});
