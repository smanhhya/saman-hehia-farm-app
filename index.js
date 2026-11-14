
const express = require("express");
const cors = require("cors");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  delay
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

let sock;
let isConnected = false;

const PHONE_NUMBER = "201280531968"; 

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log("========================================");
        console.log("🔑 كود ربط الواتساب الخاص بك هو: ", code);
        console.log("========================================");
      } catch (err) {
        console.log("❌ خطأ في طلب كود الربط:", err);
      }
    }, 15000);
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("⚠️ الاتصال فصل، جاري إعادة المحاولة...", shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      isConnected = true;
      console.log("✅ تم ربط الواتساب بنجاح والسيرفر جاهز للعمل!");
    }
  });
}

connectToWhatsApp();

app.get("/", (req, res) => {
  res.status(200).send(isConnected ? "Server is running & WhatsApp Connected!" : "Server is running (Waiting for WhatsApp)...");
});

app.post("/send-bulk-smart", async (req, res) => {
  const { bulkData } = req.body;

  if (!bulkData || !Array.isArray(bulkData)) {
    return res.status(400).send("البيانات ناقصة!");
  }

  if (!isConnected) {
    return res.status(503).send("الواتساب غير متصل بالسيرفر حالياً!");
  }

  res.send("جاري الإرسال المخصص...");
  console.log(`📥 استلام طلب إرسال لـ ${bulkData.length} عميل...`);

  for (let i = 0; i < bulkData.length; i++) {
    let { phone, message } = bulkData[i];
    let cleanPhone = phone.toString().replace(/\D/g, "");
    if (cleanPhone.startsWith("0")) cleanPhone = "2" + cleanPhone;
    let jid = cleanPhone + "@s.whatsapp.net";

    try {
      await sock.sendMessage(jid, { text: message });
      console.log(`✅ تم الإرسال إلى: ${cleanPhone}`);
    } catch (error) {
      console.log(`❌ فشل الإرسال إلى: ${cleanPhone}`, error);
    }

    let randomDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
    await delay(randomDelay);
  }
  console.log("🎉 تم الانتهاء من إرسال الدفعة بالكامل!");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});
