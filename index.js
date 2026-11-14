
const express = require("express");
const cors = require("cors");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = require("@whiskeysockets/baileys");

// درع حماية لمنع توقف السيرفر بسبب أي خطأ تشفير في الخلفية (مثل Bad MAC)
process.on("uncaughtException", (err) => {
  console.log("⚠️ تم تجاهل خطأ غير مؤثر في الخلفية:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.log("⚠️ تم تجاهل وعد غير معالج:", err?.message || err);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

let sock;
let isConnected = false;
let pairingCodeRequested = false;

const PHONE_NUMBER = "201280531968";

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false, // منع مزامنة الرسائل القديمة لمنع خطأ Bad MAC
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // طلب كود الربط فور جاهزية خط الاتصال (لمرة واحدة فقط)
    if ((connection === "connecting" || qr) && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      setTimeout(async () => {
        try {
          let code = await sock.requestPairingCode(PHONE_NUMBER);
          code = code?.match(/.{1,4}/g)?.join("-") || code;
          console.log("========================================");
          console.log("🔑 كود ربط الواتساب الخاص بك هو: ", code);
          console.log("========================================");
        } catch (err) {
          pairingCodeRequested = false;
          console.log("❌ خطأ في طلب كود الربط:", err.message);
        }
      }, 5000);
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ الاتصال فصل (كود: ${statusCode})، جاري إعادة الاتصال...`, shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 4000);
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

// مسار فحص حالة السيرفر من لوحة التحكم
app.get("/", (req, res) => {
  res.status(200).send(
    isConnected
      ? "Server is running & WhatsApp Connected!"
      : "Server is running (Waiting for WhatsApp)..."
  );
});

// مسار الإرسال المخصص الذكي (لمنصة whatsapp.html والـ CRM)
app.post("/send-bulk-smart", async (req, res) => {
  const { bulkData } = req.body;

  if (!bulkData || !Array.isArray(bulkData)) {
    return res.status(400).json({ error: "البيانات ناقصة!" });
  }

  if (!isConnected) {
    return res.status(503).json({ error: "الواتساب غير متصل بالسيرفر حالياً!" });
  }

  res.status(200).json({ status: "started", count: bulkData.length });
  console.log(`📥 استلام طلب إرسال مخصص لـ ${bulkData.length} عميل...`);

  for (let i = 0; i < bulkData.length; i++) {
    let { phone, message } = bulkData[i];
    if (!phone || !message) continue;

    let cleanPhone = phone.toString().replace(/\D/g, "");
    if (cleanPhone.startsWith("0020")) cleanPhone = cleanPhone.substring(2);
    else if (cleanPhone.startsWith("0")) cleanPhone = "2" + cleanPhone;
    else if (cleanPhone.length === 10 && cleanPhone.startsWith("1")) cleanPhone = "20" + cleanPhone;

    let jid = cleanPhone + "@s.whatsapp.net";

    try {
      await sock.sendMessage(jid, { text: message });
      console.log(`✅ [${i + 1}/${bulkData.length}] تم الإرسال إلى: ${cleanPhone}`);
    } catch (error) {
      console.log(`❌ [${i + 1}/${bulkData.length}] فشل الإرسال إلى: ${cleanPhone}`, error.message);
    }

    // فاصل زمني آمن بين كل رسالة وأخرى (من 6 إلى 10 ثوانٍ)
    if (i < bulkData.length - 1) {
      let randomDelay = Math.floor(Math.random() * (10000 - 6000 + 1)) + 6000;
      await delay(randomDelay);
    }
  }
  console.log("🎉 تم الانتهاء من إرسال الدفعة بالكامل!");
});

// مسار إضافي لدعم الكود القديم (/send-bulk) احتياطياً
app.post("/send-bulk", async (req, res) => {
  const { numbers, message } = req.body;
  if (!numbers || !Array.isArray(numbers) || !message) {
    return res.status(400).send("البيانات ناقصة!");
  }
  if (!isConnected) {
    return res.status(503).send("الواتساب غير متصل!");
  }
  res.status(200).send("جاري الإرسال...");

  for (let i = 0; i < numbers.length; i++) {
    let cleanPhone = numbers[i].toString().replace(/\D/g, "");
    if (cleanPhone.startsWith("0")) cleanPhone = "2" + cleanPhone;
    let jid = cleanPhone + "@s.whatsapp.net";
    try {
      await sock.sendMessage(jid, { text: message });
      console.log(`✅ تم الإرسال إلى: ${cleanPhone}`);
    } catch (e) {
      console.log(`❌ فشل الإرسال إلى: ${cleanPhone}`);
    }
    if (i < numbers.length - 1) await delay(7000);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});
