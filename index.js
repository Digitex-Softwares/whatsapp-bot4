import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR   = path.join(__dirname, "auth_info_baileys");
const QR_PORT    = 9093;
const SITE       = "https://xdigitex.space";
const FOLLOWERS  = "https://digitexsmartsolutions.com";
const OWNER_JID  = "254792361581@s.whatsapp.net";
const START_TIME = Date.now();

// ── Suppress noisy session logs ───────────────────────────────────────────────
const logger = pino({ level: "silent" });
process.env.DEBUG = "";
const origLog = console.log.bind(console);
const NOISE = ["SessionEntry","_chains","chainKey","Buffer","registrationId",
  "pendingPreKey","Closing session","Decrypted","Closing open session",
  "Failed to decrypt","MessageCounter","baseKeyType","Session error"];
console.log = (...a) => {
  if (NOISE.some(k => String(a[0]||"").includes(k))) return;
  origLog(...a);
};

// ── State ─────────────────────────────────────────────────────────────────────
let sock, currentQR = null, isLinked = false;
let botMode          = "public";
let antiDeleteEnabled = true;
let presenceMode     = "none";       // "none"|"available"|"composing"|"recording"
let autoViewOnce     = true;
let autoStatusDL     = true;

// Status rate limiting
const statusRateMap = new Map();
const STATUS_RATE       = 300_000;  // 5 min per contact
const STATUS_GLOBAL_GAP = 5_000;   // 5 sec between any two forwards
let   statusLastSent    = 0;

// msgCache: id → { jid, sender, pushName, text, type, mediaBuf }
const msgCache = new Map();

// ── QR / Phone pairing web server ─────────────────────────────────────────────
const AUTH_PAGE = (qrImg) => `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="28">
  <title>XDIGITEX BOT</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d1117;color:#fff;font-family:-apple-system,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:30px 16px}
    h1{color:#25D366;font-size:1.8rem;margin-bottom:6px}
    p.sub{color:#888;margin-bottom:24px;font-size:.9rem}
    .tabs{display:flex;gap:0;margin-bottom:24px;border-bottom:1px solid #333;width:100%;max-width:420px}
    .tab-btn{flex:1;background:none;border:none;color:#888;padding:13px;font-size:1rem;cursor:pointer;border-bottom:3px solid transparent;transition:.2s}
    .tab-btn.active{color:#25D366;border-bottom-color:#25D366}
    .panel{display:none;width:100%;max-width:420px;text-align:center}
    .panel.active{display:block}
    img{border:6px solid #1a2332;border-radius:16px;max-width:280px}
    input{width:100%;padding:14px;font-size:1.1rem;background:#161b22;color:#fff;border:2px solid #333;border-radius:10px;text-align:center;letter-spacing:2px;margin-bottom:14px;outline:none}
    input:focus{border-color:#25D366}
    .btn{width:100%;padding:14px;background:#25D366;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;transition:.2s}
    .btn:hover{background:#1ebe5a}
    .btn:disabled{background:#333;cursor:not-allowed}
    .btn.copy{background:#1a2332;border:2px solid #25D366;color:#25D366;margin-top:10px}
    .btn.copy:hover{background:#25D366;color:#fff}
    .code-box{background:#161b22;border:2px solid #25D366;border-radius:14px;padding:22px 16px 14px;margin:18px 0 0;font-size:2.6rem;letter-spacing:12px;color:#25D366;font-weight:700;font-family:monospace;user-select:all;cursor:text}
    .steps{background:#161b22;border-radius:12px;padding:16px;margin:18px 0;text-align:left}
    .steps p{color:#aaa;font-size:.85rem;margin-bottom:8px;line-height:1.5}
    .steps b{color:#fff}
    .err{color:#f85149;margin-top:12px;font-size:.9rem}
    .hint{color:#555;font-size:.78rem;margin-top:6px}
    a{color:#25D366;text-decoration:none}
    .tag{display:inline-block;background:#1a2332;color:#25D366;border-radius:6px;padding:2px 8px;font-family:monospace;font-size:.85rem}
  </style>
</head>
<body>
  <h1>⚡ XDIGITEX BOT</h1>
  <p class="sub">Link your WhatsApp account</p>

  <div class="tabs">
    <button class="tab-btn active" onclick="show('qr',this)">📷 Scan QR</button>
    <button class="tab-btn" onclick="show('phone',this)">📱 Phone Code</button>
  </div>

  <!-- QR panel -->
  <div id="qr" class="panel active">
    <div class="steps">
      <p>1. Open WhatsApp on your phone</p>
      <p>2. Tap <b>⋮ Menu</b> → <b>Linked Devices</b> → <b>Link a Device</b></p>
      <p>3. Point camera at the QR code below</p>
    </div>
    ${qrImg ? `<img src="${qrImg}" alt="QR"/>` : `<p style="color:#f85149;padding:20px">⏳ QR loading — page auto-refreshes</p>`}
    <p class="hint" style="margin-top:12px">QR refreshes every 25s</p>
  </div>

  <!-- Phone code panel -->
  <div id="phone" class="panel">
    <div class="steps">
      <p>Enter the phone number of the WhatsApp account to link:</p>
    </div>
    <input type="tel" id="pnum" placeholder="254712345678" inputmode="numeric"/>
    <button class="btn" id="pairBtn" onclick="getCode()">Get Pairing Code</button>
    <div id="result"></div>
  </div>

  <p style="margin-top:32px;color:#555;font-size:.8rem">
    <a href="${SITE}">${SITE}</a>
  </p>

  <script>
    function show(id, btn) {
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      btn.classList.add('active');
    }

    function copyCode(code) {
      const plain = code.replace(/-/g,'');
      navigator.clipboard.writeText(plain).then(() => {
        const cb = document.getElementById('copyBtn');
        if (cb) { cb.textContent = '✅ Copied!'; setTimeout(()=>{ cb.textContent='📋 Copy Code'; }, 2500); }
      }).catch(() => {
        // Fallback: select the code box text
        const el = document.getElementById('codeDisplay');
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }

    async function getCode() {
      const phone = document.getElementById('pnum').value.replace(/\\D/g,'');
      if (phone.length < 7) {
        document.getElementById('result').innerHTML='<p class="err">Enter a valid phone number with country code</p>';
        return;
      }
      const btn = document.getElementById('pairBtn');
      btn.disabled = true; btn.textContent = '⏳ Requesting…';
      document.getElementById('result').innerHTML = '';
      try {
        const r = await fetch('/pair', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({phone})
        });
        const d = await r.json();
        if (d.code) {
          document.getElementById('result').innerHTML =
            '<p style="color:#aaa;margin:14px 0 6px;font-size:.85rem">Your pairing code:</p>' +
            '<div class="code-box" id="codeDisplay">' + d.code + '</div>' +
            '<button class="btn copy" id="copyBtn" onclick="copyCode(\\'' + d.code.replace(/'/g,"\\\\'") + '\\')">📋 Copy Code</button>' +
            '<div class="steps" style="margin-top:16px">' +
              '<p style="color:#25D366;font-weight:bold">✅ Request sent to WhatsApp! Now:</p>' +
              '<p>1. <b>Check your phone</b> — a WhatsApp notification should appear</p>' +
              '<p>2. Tap it and <b>confirm</b> the link (you will see the same code above on screen)</p>' +
              '<p>3. If no notification, go to: <b>WhatsApp → Settings → Linked Devices</b> — a pending request will be at the top</p>' +
              '<p style="color:#f85149">⚠️ Do NOT go to "Link a Device" — the notification/pending request will appear automatically</p>' +
            '</div>' +
            '<p class="hint">⏳ Code expires in ~60 seconds — this page will reload when linked</p>';
        } else {
          document.getElementById('result').innerHTML = '<p class="err">❌ ' + (d.error||'Request failed — make sure bot is not already linked') + '</p>';
        }
      } catch(e) {
        document.getElementById('result').innerHTML = '<p class="err">❌ ' + e.message + '</p>';
      }
      btn.disabled = false; btn.textContent = 'Get 8-Digit Code';
    }
  </script>
</body></html>`;

const LINKED_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>XDIGITEX BOT</title>
<style>body{background:#0d1117;color:#fff;font-family:sans-serif;text-align:center;padding:60px 20px}
h1{color:#25D366;font-size:2rem}p{color:#aaa;margin-top:10px}a{color:#25D366}</style>
</head><body>
<h1>✅ XDIGITEX BOT LIVE</h1>
<p>Your bot is connected and running.</p>
<p><a href="${SITE}">${SITE}</a></p>
</body></html>`;

const qrServer = http.createServer(async (req, res) => {
  // ── Pairing code API ────────────────────────────────────────────────────────
  if (req.url === "/pair" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      try {
        const { phone } = JSON.parse(body);
        const digits = String(phone).replace(/\D/g, "");
        if (!digits || digits.length < 7) {
          return res.end(JSON.stringify({ error: "Invalid phone number" }));
        }
        if (isLinked) {
          return res.end(JSON.stringify({ error: "Bot is already linked to a WhatsApp account" }));
        }
        if (!sock) {
          return res.end(JSON.stringify({ error: "Bot not ready — refresh and try again" }));
        }
        const code = await sock.requestPairingCode(digits);
        origLog(`📱 Pairing code for +${digits}: ${code}`);
        res.end(JSON.stringify({ code }));
      } catch(e) {
        origLog(`❌ Pairing code error: ${e.message}`);
        const msg = e.message?.toLowerCase().includes("connection")
          ? "Bot is reconnecting — wait a few seconds and try again"
          : e.message;
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  if (isLinked) return res.end(LINKED_PAGE);

  let qrImg = null;
  if (currentQR) {
    try { qrImg = await QRCode.toDataURL(currentQR, { errorCorrectionLevel:"L", margin:2, width:280 }); }
    catch {}
  }
  res.end(AUTH_PAGE(qrImg));
});
qrServer.listen(QR_PORT, () => origLog(`🌐 QR server on port ${QR_PORT}`));

// ── Helpers ───────────────────────────────────────────────────────────────────
const send = async (jid, text, opts = {}) => {
  try { await sock.sendMessage(jid, { text }, opts); }
  catch(e) { origLog("send err:", e.message); }
};

const sendToOwner = async (content) => {
  try { await sock.sendMessage(OWNER_JID, content); }
  catch(e) { origLog("sendToOwner err:", e.message); }
};

const notifyOwner = (senderJid, action) => {
  if (jidNormalizedUser(senderJid) === OWNER_JID) return;
  const ts = new Date().toLocaleString("en-GB",{timeZone:"Africa/Nairobi",hour12:true});
  sendToOwner({ text:`📊 *XDIGITEX ACTIVITY*\n\n👤 +${senderJid.split("@")[0]}\n📌 ${action}\n🕐 ${ts} EAT` });
};

const runtime = () => {
  const s = Math.floor((Date.now()-START_TIME)/1000);
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
};

const nowEAT = () => new Date().toLocaleString("en-GB",{timeZone:"Africa/Nairobi",hour12:true});

const displayName = (pushName, sender) => {
  const num = sender?.split("@")[0] || "?";
  return pushName ? `*${pushName}* (+${num})` : `+${num}`;
};

// ── Presence ──────────────────────────────────────────────────────────────────
const updatePresence = async (jid) => {
  if (presenceMode === "none" || !jid) return;
  try { await sock.sendPresenceUpdate(presenceMode, jid); } catch {}
};

// ── Auto-view status ──────────────────────────────────────────────────────────
const viewStatus = async (msg) => {
  const id = msg?.key?.id;
  if (!id) return;
  const participant = msg.key?.participant || msg.key?.remoteJid;
  const key = { remoteJid: "status@broadcast", id, participant };
  try { await sock.readMessages([key]); } catch {}
  try { if (participant) await sock.sendReceipt("status@broadcast", participant, [id], "read"); } catch {}
  try {
    await sock.chatModify({
      markRead: true,
      lastMessages: [{ key, messageTimestamp: msg.messageTimestamp || Math.floor(Date.now()/1000) }]
    }, "status@broadcast");
  } catch {}
};

// ── Status download & forward ─────────────────────────────────────────────────
const forwardStatus = async (msg) => {
  if (!autoStatusDL) return;
  const age = Math.floor(Date.now()/1000) - (msg.messageTimestamp || 0);
  if (age > 300) return;
  const sender = msg.key?.participant || msg.key?.remoteJid || "";
  const now = Date.now();
  if (now - (statusRateMap.get(sender)||0) < STATUS_RATE) return;
  if (now - statusLastSent < STATUS_GLOBAL_GAP) return;
  statusRateMap.set(sender, now);
  statusLastSent = now;

  const name = msg.pushName || sender.split("@")[0];
  const num  = sender.split("@")[0];
  const type = getContentType(msg.message);
  const hdr  = `📸 *STATUS UPDATE*\n👤 ${name ? `*${name}*` : ""} (+${num})\n🕐 ${nowEAT()}`;

  try {
    if (["imageMessage","videoMessage","audioMessage","stickerMessage"].includes(type)) {
      const buf = await downloadMediaMessage(msg, "buffer", {}, {
        logger: pino({ level:"silent" }),
        reuploadRequest: sock.updateMediaMessage,
      });
      if (type === "imageMessage")    await sendToOwner({ image: buf, caption: hdr });
      else if (type === "videoMessage")   await sendToOwner({ video: buf, caption: hdr });
      else if (type === "audioMessage")   await sendToOwner({ audio: buf, mimetype:"audio/mp4" });
      else if (type === "stickerMessage") { await sendToOwner({ sticker: buf }); await sendToOwner({ text: hdr }); }
    } else {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "(status)";
      await sendToOwner({ text: `${hdr}\n\n💬 ${text}` });
    }
    origLog(`📸 Status from +${num} (${name})`);
  } catch(e) { origLog("status fwd err:", e.message); }
};

// ── Group helpers ─────────────────────────────────────────────────────────────
const getParticipants = async (jid) => {
  try { return (await sock.groupMetadata(jid)).participants.map(p => p.id); }
  catch { return []; }
};

const getAllGroups = async () => {
  try {
    return Object.values(await sock.groupFetchAllParticipating())
      .sort((a,b) => a.subject.localeCompare(b.subject));
  } catch { return []; }
};

// ── Anti-delete ───────────────────────────────────────────────────────────────
const relayDeleted = async (msgId, jid) => {
  if (!antiDeleteEnabled) return;
  const cached = msgCache.get(msgId);
  if (!cached) { origLog(`🗑️ anti-delete: no cache for ${msgId}`); return; }

  const { sender, pushName, text, type, mediaBuf } = cached;
  const who = displayName(pushName, sender);

  let loc = "💬 DM";
  if (jid?.endsWith("@g.us")) {
    try { const m = await sock.groupMetadata(jid); loc = `👥 Group: *${m.subject}*`; }
    catch { loc = `👥 Group`; }
  }

  const hdr = `🗑️ *DELETED MESSAGE*\n👤 ${who}\n📍 ${loc}\n🕐 ${nowEAT()}\n${"─".repeat(22)}`;

  try {
    if (text) {
      await sendToOwner({ text: `${hdr}\n📝 ${text}` });
    } else if (mediaBuf) {
      if      (type === "imageMessage")                  await sendToOwner({ image: mediaBuf, caption: `${hdr}\n🖼️ Image` });
      else if (type === "videoMessage")                  await sendToOwner({ video: mediaBuf, caption: `${hdr}\n🎥 Video` });
      else if (type === "audioMessage" || type === "pttMessage") {
        await sendToOwner({ audio: mediaBuf, mimetype:"audio/ogg; codecs=opus", ptt:true });
        await sendToOwner({ text: hdr });
      }
      else if (type === "stickerMessage")                { await sendToOwner({ sticker: mediaBuf }); await sendToOwner({ text: hdr }); }
      else                                               await sendToOwner({ text: `${hdr}\n📦 ${type}` });
    } else {
      await sendToOwner({ text: `${hdr}\n📦 ${type||"Media"} (not cached in time)` });
    }
    origLog(`🗑️ relayed deleted msg from ${who}`);
  } catch(e) { origLog("anti-delete relay err:", e.message); }
};

// Pre-cache media on arrival for anti-delete
const cacheMedia = async (msg) => {
  const type = getContentType(msg.message);
  const MEDIA = ["imageMessage","videoMessage","audioMessage","pttMessage","stickerMessage","documentMessage"];
  if (!MEDIA.includes(type)) return null;
  try {
    return await downloadMediaMessage(msg, "buffer", {}, {
      logger: pino({ level:"silent" }),
      reuploadRequest: sock.updateMediaMessage,
    });
  } catch { return null; }
};

// ── Auto view-once → owner DM ─────────────────────────────────────────────────
const handleAutoViewOnce = async (msg) => {
  if (!autoViewOnce) return;

  // Strip ephemeral wrapper first (common in disappearing-message groups)
  const raw = msg.message?.ephemeralMessage?.message || msg.message;
  if (!raw) return;

  // Find view-once wrapper (all known formats)
  const wrapped = raw?.viewOnceMessage
                || raw?.viewOnceMessageV2
                || raw?.viewOnceMessageV2Extension;
  if (!wrapped?.message) return;

  const inner    = wrapped.message;
  const innerType = getContentType(inner);
  if (!["imageMessage","videoMessage","audioMessage"].includes(innerType)) return;

  const jid    = msg.key?.remoteJid;
  const sender = msg.key?.participant || jid;
  const name   = msg.pushName || sender?.split("@")[0];
  const num    = sender?.split("@")[0];

  let loc = "💬 DM";
  if (jid?.endsWith("@g.us")) {
    try { const m = await sock.groupMetadata(jid); loc = `👥 *${m.subject}*`; }
    catch { loc = `👥 Group`; }
  }

  origLog(`👁️  View-once from ${name} (+${num}) [${innerType}] in ${loc}`);
  const caption = `👁️ *VIEW-ONCE AUTO-REVEAL*\n👤 *${name}* (+${num})\n📍 ${loc}\n🕐 ${nowEAT()}`;

  try {
    // Use original msg — Baileys internally unwraps viewOnce for download
    const buf = await downloadMediaMessage(msg, "buffer", {}, {
      logger: pino({ level:"silent" }),
      reuploadRequest: sock.updateMediaMessage,
    });
    if (!buf || buf.length < 100) {
      origLog(`👁️  View-once: empty buffer (media may not be available on linked device)`);
      await sendToOwner({ text: `${caption}\n\n⚠️ Media could not be downloaded (WhatsApp view-once restriction)` });
      return;
    }

    if      (innerType === "imageMessage") await sendToOwner({ image: buf, caption });
    else if (innerType === "videoMessage") await sendToOwner({ video: buf, caption });
    else if (innerType === "audioMessage") {
      await sendToOwner({ audio: buf, mimetype:"audio/ogg; codecs=opus", ptt:true });
      await sendToOwner({ text: caption });
    }
    origLog(`✅ View-once forwarded to owner from ${name} (+${num})`);
  } catch(e) {
    origLog(`❌ view-once download err: ${e.message}`);
    await sendToOwner({ text: `${caption}\n\n⚠️ Failed: ${e.message}` });
  }
};

// ── Menus ─────────────────────────────────────────────────────────────────────
const MENU = () =>
`┏▣ ◈ *XDIGITEX BOT v6* ◈
┃ *ᴘʀᴇғɪx*    : [ . ]
┃ *ᴍᴏᴅᴇ*      : ${botMode === "public" ? "🌍 Public" : "🔒 Private"}
┃ *ᴘʀᴇsᴇɴᴄᴇ* : ${presenceMode === "none" ? "Off" : presenceMode}
┃ *ᴜᴘᴛɪᴍᴇ*    : ${runtime()}
┗▣

┏▣ ◈ *GROUP TOOLS* ◈
│➽ .hidetag {msg}  - tag all silently
│➽ .tagall {msg}   - tag all members
│➽ .everyone {msg} - tag all members
│➽ .totalmembers   - member count
┗▣

┏▣ ◈ *OWNER ONLY* ◈
│➽ .list              - all groups
│➽ .hidetag {#} {msg} - remote silent tag
│➽ .antidelete on/off
│➽ .mode public/private
│➽ .presence [online/typing/recording/off]
│➽ .autovv on/off    - auto view-once DM
│➽ .autostatus on/off - status download
┗▣

┏▣ ◈ *TOOLS* ◈
│➽ .vv      - reveal view-once in chat
│➽ .ping    - response speed
│➽ .runtime - bot uptime
┗▣

🚀 *Deploy your bot → ${SITE}*`;

const BOT_PROMO = () =>
`┏▣ ◈ *XDIGITEX BOT* ◈
┗▣
🚀 *Deploy your WhatsApp bot!*
Visit *${SITE}*
👥 Cheap followers → _${FOLLOWERS}_`;

// ── Main connect ──────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, auth: state, logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 20_000,
    browser: ["Chrome (Linux)", "Chrome", "120.0.0"],
    getMessage: async (key) => msgCache.get(key.id)?.fullMsg?.message,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; isLinked = false; origLog("📱 New QR generated"); }
    if (connection === "open") {
      currentQR = null; isLinked = true;
      origLog(`✅ XDIGITEX BOT v6 LIVE | mode=${botMode} | presence=${presenceMode}`);
      sock.sendPresenceUpdate("available").catch(()=>{});
    }
    if (connection === "close") {
      isLinked = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      origLog(`🔄 Reconnecting... code=${code}`);
      if (code === DisconnectReason.loggedOut) {
        // Delete credential FILES but keep the folder (parent dir may be root-owned)
        origLog("🗑️  Logged out — clearing session, restarting fresh");
        try {
          for (const f of fs.readdirSync(AUTH_DIR)) {
            fs.rmSync(path.join(AUTH_DIR, f), { force: true, recursive: true });
          }
        } catch {}
        setTimeout(connectToWhatsApp, 2000);
      } else {
        setTimeout(connectToWhatsApp, 3500);
      }
    }
  });

  // ── Incoming messages ───────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid) continue;

      // ── Status: auto-view + forward ───────────────────────────────────────
      if (jid === "status@broadcast") {
        viewStatus(msg).catch(()=>{});
        if (msg.message) forwardStatus(msg).catch(()=>{});
        continue;
      }

      // ── Deletion stub in upsert (Baileys 6.x alternate deletion signal) ──
      if (msg.messageStubType === 1 && msg.key?.id) {
        relayDeleted(msg.key.id, jid).catch(()=>{});
        continue;
      }

      const sender   = msg.key?.participant || jid;
      const pushName = msg.pushName || "";

      // ── Presence ──────────────────────────────────────────────────────────
      if (!msg.key?.fromMe && msg.message) updatePresence(jid).catch(()=>{});

      // ── Auto view-once ────────────────────────────────────────────────────
      if (!msg.key?.fromMe && msg.message) handleAutoViewOnce(msg).catch(()=>{});

      // ── Cache for anti-delete ─────────────────────────────────────────────
      if (msg.key?.id && msg.message && !msg.key.fromMe) {
        const msgType = getContentType(msg.message);
        msgCache.set(msg.key.id, {
          jid, sender, pushName,
          text: msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption || null,
          type: msgType,
          fullMsg: msg,
          mediaBuf: null,
        });
        const MEDIA = ["imageMessage","videoMessage","audioMessage","pttMessage","stickerMessage"];
        if (MEDIA.includes(msgType)) {
          cacheMedia(msg).then(buf => {
            if (buf && msgCache.has(msg.key.id)) {
              msgCache.get(msg.key.id).mediaBuf = buf;
              origLog(`📦 cached ${msgType} from ${displayName(pushName, sender)}`);
            }
          });
        }
        if (msgCache.size > 3000) msgCache.delete(msgCache.keys().next().value);
      }

      if (!msg.message) continue;

      // Allow fromMe only if it's a "." command (owner commanding their linked bot)
      const rawText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || "";
      const isFromMeCmd = msg.key?.fromMe && rawText.trim().startsWith(".");
      if (msg.key?.fromMe && !isFromMeCmd) continue;

      const isGroup = jid.endsWith("@g.us");
      const isOwner = isFromMeCmd
        || jidNormalizedUser(sender) === OWNER_JID
        || jidNormalizedUser(jid)    === OWNER_JID;

      const text = rawText ||
        msg.message?.ephemeralMessage?.message?.conversation ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text || "";

      if (!text.trim().startsWith(".")) continue;

      const parts = text.trim().split(/\s+/);
      const cmd   = parts[0].toLowerCase();
      const args  = text.trim().slice(cmd.length).trim();

      origLog(`⚙️  [${cmd}] from ${displayName(pushName, sender)} | owner=${isOwner}`);

      // ── Private mode guard ────────────────────────────────────────────────
      const publicCmds = [".ping",".runtime",".menu",".vv"];
      if (botMode === "private" && !isOwner && !publicCmds.includes(cmd)) {
        await send(jid, `🔒 *Bot is in private mode*\n\n🚀 Deploy yours → ${SITE}`, { quoted: msg });
        continue;
      }

      // ── .menu ─────────────────────────────────────────────────────────────
      if (cmd === ".menu") {
        await sock.sendMessage(jid, { text: MENU() }, { quoted: msg });
        notifyOwner(sender, "viewed menu");
        continue;
      }

      // ── .ping ─────────────────────────────────────────────────────────────
      if (cmd === ".ping") {
        const t = Date.now();
        await sock.sendMessage(jid, { text:
          `┏▣ ◈ *PING* ◈\n┃ 🏓 Pong! ${Date.now()-t}ms\n┃ ⏳ ${runtime()}\n┃ 🌍 ${botMode}\n┗▣`
        }, { quoted: msg });
        continue;
      }

      // ── .runtime ──────────────────────────────────────────────────────────
      if (cmd === ".runtime") {
        await sock.sendMessage(jid, { text:
          `┏▣ ◈ *RUNTIME* ◈\n┃ ⏳ ${runtime()}\n┃ 🗑️ Anti-delete: ${antiDeleteEnabled?"✅":"🔕"}\n┃ 👁️ Presence: ${presenceMode}\n┃ 📸 Status DL: ${autoStatusDL?"✅":"🔕"}\n┃ 👁️ Auto VV: ${autoViewOnce?"✅":"🔕"}\n┗▣`
        }, { quoted: msg });
        continue;
      }

      // ── .totalmembers ─────────────────────────────────────────────────────
      if (cmd === ".totalmembers") {
        if (!isGroup) { await send(jid, "⚠️ Use inside a group.", { quoted: msg }); continue; }
        const members = await getParticipants(jid);
        await send(jid, `👥 *${members.length}* members`, { quoted: msg });
        continue;
      }

      // ── .mode ─────────────────────────────────────────────────────────────
      if (cmd === ".mode") {
        if (!isOwner) { await send(jid, "⚠️ Owner only.", { quoted: msg }); continue; }
        const m = args.toLowerCase();
        if (m === "public")  { botMode = "public";  await send(jid, "🌍 *Mode: PUBLIC*", { quoted: msg }); continue; }
        if (m === "private") { botMode = "private"; await send(jid, "🔒 *Mode: PRIVATE*", { quoted: msg }); continue; }
        await send(jid, `Mode: *${botMode}*\nUsage: *.mode public/private*`, { quoted: msg });
        continue;
      }

      // ── .presence ─────────────────────────────────────────────────────────
      if (cmd === ".presence") {
        if (!isOwner) { await send(jid, "⚠️ Owner only.", { quoted: msg }); continue; }
        const p = args.toLowerCase().trim();
        if (p === "online")    { presenceMode = "available";  await send(jid, "🟢 *Presence: ALWAYS ONLINE*", { quoted: msg }); continue; }
        if (p === "typing")    { presenceMode = "composing";  await send(jid, "⌨️ *Presence: TYPING*", { quoted: msg }); continue; }
        if (p === "recording") { presenceMode = "recording";  await send(jid, "🎙️ *Presence: RECORDING*", { quoted: msg }); continue; }
        if (p === "off")       { presenceMode = "none";       await send(jid, "⚪ *Presence: OFF*", { quoted: msg }); continue; }
        await send(jid, `Presence: *${presenceMode||"off"}*\nUsage: *.presence online/typing/recording/off*`, { quoted: msg });
        continue;
      }

      // ── .antidelete ───────────────────────────────────────────────────────
      if (cmd === ".antidelete") {
        if (!isOwner) { await send(jid, "⚠️ Owner only.", { quoted: msg }); continue; }
        const t = args.toLowerCase();
        if (t === "on")  { antiDeleteEnabled = true;  await send(jid, "✅ *Anti-delete ON*", { quoted: msg }); continue; }
        if (t === "off") { antiDeleteEnabled = false; await send(jid, "🔕 *Anti-delete OFF*", { quoted: msg }); continue; }
        await send(jid, `Anti-delete: *${antiDeleteEnabled?"✅ ON":"🔕 OFF"}*`, { quoted: msg });
        continue;
      }

      // ── .autovv ───────────────────────────────────────────────────────────
      if (cmd === ".autovv") {
        if (!isOwner) { await send(jid, "⚠️ Owner only.", { quoted: msg }); continue; }
        const t = args.toLowerCase();
        if (t === "on")  { autoViewOnce = true;  await send(jid, "✅ *Auto View-Once: ON*", { quoted: msg }); continue; }
        if (t === "off") { autoViewOnce = false; await send(jid, "🔕 *Auto View-Once: OFF*", { quoted: msg }); continue; }
        await send(jid, `Auto VV: *${autoViewOnce?"✅ ON":"🔕 OFF"}*`, { quoted: msg });
        continue;
      }

      // ── .autostatus ───────────────────────────────────────────────────────
      if (cmd === ".autostatus") {
        if (!isOwner) { await send(jid, "⚠️ Owner only.", { quoted: msg }); continue; }
        const t = args.toLowerCase();
        if (t === "on")  { autoStatusDL = true;  await send(jid, "✅ *Status Download: ON*", { quoted: msg }); continue; }
        if (t === "off") { autoStatusDL = false; await send(jid, "🔕 *Status Download: OFF*", { quoted: msg }); continue; }
        await send(jid, `Status DL: *${autoStatusDL?"✅ ON":"🔕 OFF"}*`, { quoted: msg });
        continue;
      }

      // ── .list ─────────────────────────────────────────────────────────────
      if (cmd === ".list") {
        if (!isOwner) { await send(jid, "⚠️ Owner only.", { quoted: msg }); continue; }
        const groups = await getAllGroups();
        if (!groups.length) { await send(jid, "⚠️ Not in any groups.", { quoted: msg }); continue; }
        let out = `┏▣ ◈ *YOUR GROUPS* (${groups.length}) ◈\n`;
        groups.forEach((g,i) => out += `┃ [${i+1}] ${g.subject} _(${g.participants?.length||0})_\n`);
        out += `┗▣\n\n_.hidetag {#} {message}_`;
        await send(jid, out, { quoted: msg });
        continue;
      }

      // ── .hidetag ─────────────────────────────────────────────────────────
      if (cmd === ".hidetag") {
        if (!isGroup) {
          if (!isOwner) { await send(jid, "⚠️ Owner only from DM.", { quoted: msg }); continue; }
          const first = args.split(" ")[0];
          const code  = parseInt(first);
          if (!first || isNaN(code) || code < 1) {
            await send(jid, "⚠️ Usage: *.hidetag {#} {message}*\nGet codes with *.list*", { quoted: msg }); continue;
          }
          const message = args.slice(first.length).trim() || "\u200e";
          const groups  = await getAllGroups();
          const target  = groups[code-1];
          if (!target) { await send(jid, `⚠️ Group [${code}] not found.`, { quoted: msg }); continue; }
          let members;
          try { const f = await sock.groupMetadata(target.id); members = f.participants.map(p => p.id); }
          catch { members = target.participants?.map(p=>p.id)||[]; }
          if (!members.length) { await send(jid, `⚠️ Could not load members.`, { quoted: msg }); continue; }
          try {
            await sock.sendMessage(target.id, { text: message, mentions: members });
            await send(jid, `✅ Tagged *${members.length}* in *${target.subject}*`, { quoted: msg });
          } catch(e) {
            await send(jid, /not-authorized|forbidden|403/i.test(e.message||"")
              ? `🔒 *${target.subject}* is admin-only.` : `❌ ${e.message}`, { quoted: msg });
          }
          continue;
        }
        const members = await getParticipants(jid);
        if (!members.length) { await send(jid, "⚠️ Could not fetch members.", { quoted: msg }); continue; }
        await sock.sendMessage(jid, { text: args||"\u200e", mentions: members }, { quoted: msg });
        notifyOwner(sender, `.hidetag (${members.length})`);
        continue;
      }

      // ── .tagall / .everyone ───────────────────────────────────────────────
      if (cmd === ".tagall" || cmd === ".everyone") {
        if (!isGroup) { await send(jid, "⚠️ Use inside a group.", { quoted: msg }); continue; }
        const members = await getParticipants(jid);
        if (!members.length) { await send(jid, "⚠️ Could not fetch members.", { quoted: msg }); continue; }
        const tagText = (args||"📢 *Attention everyone!*") + "\n\n" + members.map(m=>`@${m.split("@")[0]}`).join(" ");
        await sock.sendMessage(jid, { text: tagText, mentions: members }, { quoted: msg });
        notifyOwner(sender, `${cmd} (${members.length})`);
        continue;
      }

      // ── .vv — reveal view-once in chat ────────────────────────────────────
      if (cmd === ".vv") {
        const ctx =
          msg.message?.extendedTextMessage?.contextInfo ||
          msg.message?.imageMessage?.contextInfo ||
          msg.message?.videoMessage?.contextInfo ||
          msg.message?.audioMessage?.contextInfo;

        if (!ctx?.stanzaId) {
          await send(jid, "↩️ *Reply* to a view-once message first, then type *.vv*", { quoted: msg }); continue;
        }
        const quoted = ctx.quotedMessage;
        if (!quoted) {
          await send(jid, "↩️ *Reply* to a view-once message first, then type *.vv*", { quoted: msg }); continue;
        }

        let mediaMsg = null;
        const inner = quoted?.viewOnceMessage?.message || quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessageV2Extension?.message;
        if (inner) {
          if      (inner.imageMessage) mediaMsg = { imageMessage: inner.imageMessage };
          else if (inner.videoMessage) mediaMsg = { videoMessage: inner.videoMessage };
          else if (inner.audioMessage) mediaMsg = { audioMessage: inner.audioMessage };
        }
        if (!mediaMsg) {
          if      (quoted?.imageMessage?.viewOnce) mediaMsg = { imageMessage: quoted.imageMessage };
          else if (quoted?.videoMessage?.viewOnce) mediaMsg = { videoMessage: quoted.videoMessage };
          else if (quoted?.audioMessage?.viewOnce) mediaMsg = { audioMessage: quoted.audioMessage };
        }
        if (!mediaMsg) { await send(jid, "⚠️ Not a view-once. Reply directly to the view-once media.", { quoted: msg }); continue; }

        try {
          const fakeMsg = {
            key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant||undefined, fromMe: false },
            message: mediaMsg,
          };
          const buffer = await downloadMediaMessage(fakeMsg, "buffer", {}, {
            logger: pino({ level:"silent" }), reuploadRequest: sock.updateMediaMessage,
          });
          const FOOTER = `\n\n🚀 _${SITE}_`;
          if      (mediaMsg.imageMessage) await sock.sendMessage(jid, { image: buffer, caption:`👁 *View-once revealed*${FOOTER}` }, { quoted: msg });
          else if (mediaMsg.videoMessage) await sock.sendMessage(jid, { video: buffer, caption:`👁 *View-once revealed*${FOOTER}` }, { quoted: msg });
          else if (mediaMsg.audioMessage) {
            await sock.sendMessage(jid, { audio: buffer, mimetype:"audio/ogg; codecs=opus", ptt:true }, { quoted: msg });
            await send(jid, `👁 *View-once revealed*${FOOTER}`);
          }
          notifyOwner(sender, "used .vv");
        } catch(e) { await send(jid, `❌ Failed: ${e.message}`, { quoted: msg }); }
        continue;
      }

      // ── Unknown command → promo ───────────────────────────────────────────
      notifyOwner(sender, `used: ${cmd}`);
      await send(jid, BOT_PROMO(), { quoted: msg });
    }
  });

  // ── Anti-delete: messages.update ───────────────────────────────────────────
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      if (update.key?.remoteJid === "status@broadcast") {
        viewStatus({ key: update.key, messageTimestamp: update.update?.messageTimestamp }).catch(()=>{});
        continue;
      }
      // Deletion: message set to null OR messageStubType 1 (REVOKE)
      const isDelete =
        (update.update && "message" in update.update && update.update.message === null) ||
        update.update?.messageStubType === 1;
      if (isDelete && update.key?.id) {
        relayDeleted(update.key.id, update.key.remoteJid).catch(e => origLog("anti-delete err:", e.message));
      }
    }
  });
}

connectToWhatsApp().catch(e => origLog("Fatal:", e.message));
