import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import multer from "multer";
import OpenAI from "openai";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project folder (so it works even if you run from another directory)
dotenv.config({ path: join(__dirname, ".env") });

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage() });

// Credentials (from .env or environment)
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;

// Keep as fallback + for manual sending endpoints
const DEFAULT_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

const required = [
  ["WA_VERIFY_TOKEN", VERIFY_TOKEN],
  ["WA_ACCESS_TOKEN", ACCESS_TOKEN],
  ["WA_PHONE_NUMBER_ID", DEFAULT_PHONE_NUMBER_ID],
  ["OPENAI_API_KEY", OPENAI_API_KEY],
  ["MINIMAX_API_KEY", MINIMAX_API_KEY],
];
const missing = required.filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error("Fehlende Umgebungsvariablen:", missing.join(", "));
  console.error("Setze sie in Railway unter Variables oder in einer lokalen .env-Datei.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const DONATION_LINK = process.env.DONATION_LINK || "";
const DONATION_TEXT = DONATION_LINK
  ? `💛 Wenn dir der Song gefallen hat, kannst du das Projekt hier unterstützen:\n${DONATION_LINK}\n\nAls Dank können Unterstützer Extra-Versionen (HQ / Instrumental) anfragen.`
  : `💛 Wenn dir der Song gefallen hat, kannst du das Projekt unterstützen (Spendenlink nicht gesetzt).`;

// Storage
let botEnabled = true;
const conversations = {};
const sseClients = new Set();
const generatingFor = new Set();

// Database
const dbPath = join(__dirname, "data.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    song_credits INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    from_side TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    read_flag INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
`);

function loadFromDb() {
  const userRows = db.prepare("SELECT phone, name, song_credits FROM users").all();
  for (const row of userRows) {
    conversations[row.phone] = {
      name: row.name,
      messages: [],
      state: { songCredits: row.song_credits },
    };
  }
  const msgRows = db
    .prepare("SELECT phone, from_side, content, timestamp, read_flag FROM messages ORDER BY id")
    .all();
  for (const row of msgRows) {
    const conv = conversations[row.phone];
    if (conv) {
      conv.messages.push({
        from: row.from_side,
        text: row.content,
        timestamp: row.timestamp,
        read: !!row.read_flag,
      });
    }
  }
}

loadFromDb();

function getConv(phone, name) {
  if (!conversations[phone]) {
    conversations[phone] = { name: name || phone, messages: [], state: { songCredits: 1 } };
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO users (phone, name, song_credits, created_at, updated_at) VALUES (?, ?, 1, ?, ?)"
    ).run(phone, name || phone, now, now);
  }
  if (!conversations[phone].state) conversations[phone].state = { songCredits: 1 };
  if (conversations[phone].state.songCredits === undefined) {
    const row = db.prepare("SELECT song_credits FROM users WHERE phone = ?").get(phone);
    conversations[phone].state.songCredits = row ? row.song_credits : 1;
  }
  return conversations[phone];
}

function saveMessage(phone, fromSide, content, timestamp, read = false) {
  getConv(phone);
  db.prepare("INSERT INTO messages (phone, from_side, content, timestamp, read_flag) VALUES (?, ?, ?, ?, ?)")
    .run(phone, fromSide, content, timestamp, read ? 1 : 0);
}

function useSongCredit(phone) {
  const conv = getConv(phone);
  const newCredits = Math.max(0, (conv.state.songCredits ?? 1) - 1);
  conv.state.songCredits = newCredits;
  db.prepare("UPDATE users SET song_credits = ?, updated_at = ? WHERE phone = ?")
    .run(newCredits, Date.now(), phone);
}

function addSongCredits(phone, count) {
  const conv = getConv(phone);
  const newCredits = Math.max(0, (conv.state.songCredits ?? 0) + count);
  conv.state.songCredits = newCredits;
  db.prepare("UPDATE users SET song_credits = ?, updated_at = ? WHERE phone = ?")
    .run(newCredits, Date.now(), phone);
  return newCredits;
}

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// --- WhatsApp API functions ---
// IMPORTANT: use the phoneNumberId that matches the inbound message (test vs real)
function resolvePhoneNumberId(phoneNumberId) {
  return phoneNumberId || DEFAULT_PHONE_NUMBER_ID;
}

async function sendMessage(phoneNumberId, to, text) {
  const pid = resolvePhoneNumberId(phoneNumberId);

  const response = await fetch(`https://graph.facebook.com/v22.0/${pid}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await response.json();
  console.log("Reply sent:", data);

  // Only store/broadcast if it really sent
  if (!data?.error) {
    const convTo = getConv(to);
    const msg = { from: "me", text, timestamp: Date.now() };
    convTo.messages.push(msg);
    saveMessage(to, "me", text, msg.timestamp, false);
    broadcast("message", { phone: to, message: msg });
  } else {
    console.error("WhatsApp sendMessage failed:", data.error);
  }

  return data;
}

async function uploadMedia(phoneNumberId, buffer, mimeType) {
  const pid = resolvePhoneNumberId(phoneNumberId);

  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), "audio.mp3");
  formData.append("type", mimeType);
  formData.append("messaging_product", "whatsapp");

  const response = await fetch(`https://graph.facebook.com/v22.0/${pid}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: formData,
  });

  const data = await response.json();
  if (data?.error) console.error("WhatsApp uploadMedia failed:", data.error);
  return data;
}

async function sendAudioMessage(phoneNumberId, to, mediaId) {
  const pid = resolvePhoneNumberId(phoneNumberId);

  const response = await fetch(`https://graph.facebook.com/v22.0/${pid}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: { id: mediaId },
    }),
  });

  const data = await response.json();
  console.log("Audio reply sent:", data);

  if (!data?.error) {
    const convTo = getConv(to);
    const msg = { from: "me", text: "🎵 [Audio]", timestamp: Date.now(), type: "audio" };
    convTo.messages.push(msg);
    saveMessage(to, "me", "🎵 [Audio]", msg.timestamp, false);
    broadcast("message", { phone: to, message: msg });
  } else {
    console.error("WhatsApp sendAudioMessage failed:", data.error);
  }

  return data;
}

// MiniMax Music Generation
async function generateMusicWithMiniMax(style, lyrics) {
  console.log("Generating music...", { style, lyrics: lyrics.substring(0, 50) });

  const response = await fetch("https://api.minimax.io/v1/music_generation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: "music-2.5",
      prompt: style,
      lyrics,
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
      output_format: "url",
    }),
  });

  const data = await response.json();
  const audioUrl = data.data?.audio;

  if (audioUrl?.startsWith("http")) {
    const audioResponse = await fetch(audioUrl);
    const buffer = await audioResponse.arrayBuffer();
    return { buffer: Buffer.from(buffer) };
  }

  return { error: data.base_resp?.status_msg || "Musik konnte nicht erzeugt werden" };
}

// === ONE AI FUNCTION TO RULE THEM ALL ===
const SYSTEM_PROMPT = `Du bist ein freundlicher WhatsApp-KI-Musik-Assistent, der persönliche Songs erstellt.

NUR DIESE AUFGABE:
- Du sprichst NUR über die Erstellung von persönlichen Songs. Keine anderen Themen.
- Wenn der Nutzer vom Thema abweicht (andere Fragen, Smalltalk, Wetter, andere Bitten): freundlich ablehnen und zurück zum Song lenken.
- Sage z.B.: "Ich bin nur hier, um dir bei deinem persönlichen Song zu helfen. Worum soll dein Song gehen?" oder "Dafür bin ich nicht zuständig – ich helfe dir gern bei deinem Song. Womit sollen wir anfangen?"
- Beantworte keine Fragen zu anderen Themen. Bleibe immer beim Song.

WICHTIGE REGELN:
1. Halte Antworten KURZ (max. 2–3 Sätze) es sei denn es geht um Lyrics
2. Rufe generate_song nur EINMAL pro Song-Anfrage auf – nie mehrfach
3. Wenn der Nutzer bestätigt, dass er generieren will, rufe generate_song sofort auf – frage nicht nochmal

GESPRÄCHSABLAUF:
1. Begrüße den Nutzer, frage worum es in dem Song gehen soll
2. Sobald du ein Thema hast, schreibe KURZE Lyrics (nur 1 Vers + 1 Refrain, nutze [verse] und [chorus] Tags)
3. Zeige die Lyrics und frage ob sie gefallen
4. Wenn ja, frage nach dem Musikstil (Pop, Rock, Rap, etc.)
5. Sobald der Stil bestätigt ist, rufe generate_song EINMAL auf
6. Nach dem Song: kurz um Spendenlink-Unterstützung bitten.

NIEMALS:
- Über andere Themen als den Song sprechen
- Mehrere Songs generieren
- Zu viele Fragen stellen
- Lange Antworten schreiben
- generate_song mehr als einmal pro Anfrage aufrufen

Nach dem Song den Nutzer freundlich um eine Spende bitten (nicht drängen).`;

const tools = [
  {
    type: "function",
    function: {
      name: "generate_song",
      description:
        "Erzeuge eine echte Song-/Musik-Audiodatei und sende sie an den Nutzer. Nutze das, wenn der Nutzer bestätigt hat, dass er einen Song erstellen will und du sowohl Lyrics als auch Stil hast.",
      parameters: {
        type: "object",
        properties: {
          lyrics: {
            type: "string",
            description: "Die Song-Lyrics mit [verse] und [chorus] Tags",
          },
          style: {
            type: "string",
            description:
              "Musikstil-Beschreibung z.B. 'beschwingter Pop, eingängige Melodie' oder 'emotionaler Ballad, Klavier'",
          },
        },
        required: ["lyrics", "style"],
      },
    },
  },
];

async function chat(phone, phoneNumberId) {
  const conv = getConv(phone);

  // Build conversation history
  const history = conv.messages.slice(-15).map((msg) => ({
    role: msg.from === "me" ? "assistant" : "user",
    content: msg.text,
  }));

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [{ role: "developer", content: SYSTEM_PROMPT }, ...history],
      tools,
    });

    const message = response.choices[0]?.message;

    // Check if AI wants to call a tool
    if (message?.tool_calls?.length > 0) {
      const toolCall = message.tool_calls[0]; // Only process FIRST tool call

      if (toolCall.function.name === "generate_song") {
        const credits = conv.state.songCredits ?? 0;
        if (credits <= 0) {
          await sendMessage(
            phoneNumberId,
            phone,
            `✅ Dein Song-Guthaben ist aufgebraucht.\n\n${DONATION_TEXT}\n\nWenn du weitere Songs möchtest, kannst du das Projekt unterstützen oder uns schreiben.`
          );
          return;
        }

        // Prevent duplicate generations
        if (generatingFor.has(phone)) {
          console.log("Already generating for", phone);
          return;
        }

        generatingFor.add(phone);
        const args = JSON.parse(toolCall.function.arguments);

        await sendMessage(phoneNumberId, phone, "🎵 Dein Song wird jetzt erstellt...");
        await sendMessage(
          phoneNumberId,
          phone,
          "✅ Alles läuft – die Erstellung kann einen Moment dauern. Ich melde mich, sobald dein Song fertig ist!"
        );

        // Generate the music
        const result = await generateMusicWithMiniMax(args.style, args.lyrics);
        generatingFor.delete(phone);

        if (result.error) {
          const errorResponse = await openai.chat.completions.create({
            model: "gpt-5.2",
            messages: [
              { role: "developer", content: "Die Song-Erstellung ist fehlgeschlagen. Entschuldige dich kurz." },
              { role: "user", content: `Fehler: ${result.error}` },
            ],
          });
          const errorMsg = errorResponse.choices[0]?.message?.content;
          if (errorMsg) await sendMessage(phoneNumberId, phone, errorMsg);
        } else {
          // Upload and send the audio
          const uploadResult = await uploadMedia(phoneNumberId, result.buffer, "audio/mpeg");
          if (uploadResult.id) {
            await sendAudioMessage(phoneNumberId, phone, uploadResult.id);
            useSongCredit(phone);
            await sendMessage(phoneNumberId, phone, `🎉 Hier ist dein Song!\n\n${DONATION_TEXT}`);
          } else {
            await sendMessage(phoneNumberId, phone, "❌ Upload fehlgeschlagen. Bitte versuch es später nochmal.");
          }
        }
      }
    } else if (message?.content) {
      // Regular text response
      await sendMessage(phoneNumberId, phone, message.content);
    }
  } catch (err) {
    console.error("Chat error:", err?.message || err);
  }
}

// === API ENDPOINTS ===

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/conversations", (req, res) => {
  const list = Object.entries(conversations).map(([phone, data]) => ({
    phone,
    name: data.name,
    lastMessage: data.messages[data.messages.length - 1],
    unread: data.messages.filter((m) => m.from !== "me" && !m.read).length,
  }));
  res.json(list);
});

app.get("/api/conversations/:phone", (req, res) => {
  const phone = req.params.phone;
  if (!conversations[phone]) return res.json({ phone, name: phone, messages: [], state: { songCredits: 0 } });
  conversations[phone].messages.forEach((m) => (m.read = true));
  res.json({ phone, ...conversations[phone] });
});

// List users with song credits (for dashboard)
app.get("/api/users", (req, res) => {
  const list = db.prepare("SELECT phone, name, song_credits FROM users ORDER BY updated_at DESC").all();
  res.json(list.map((row) => ({ phone: row.phone, name: row.name, songCredits: row.song_credits })));
});

// Add song credits for a user (from dashboard)
app.post("/api/users/:phone/songs", (req, res) => {
  const phone = req.params.phone;
  const add = Math.max(0, parseInt(req.body?.add ?? req.body?.songs ?? "1", 10) || 1);
  try {
    const newCredits = addSongCredits(phone, add);
    res.json({ phone, songCredits: newCredits, added: add });
  } catch (e) {
    res.status(400).json({ error: "Nutzer nicht gefunden" });
  }
});

app.get("/api/bot", (req, res) => res.json({ enabled: botEnabled }));
app.post("/api/bot", (req, res) => {
  if (typeof req.body.enabled === "boolean") botEnabled = req.body.enabled;
  res.json({ enabled: botEnabled });
});

// Manual send (uses DEFAULT_PHONE_NUMBER_ID)
app.post("/api/send", async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: "'to' oder 'text' fehlt" });
  res.json(await sendMessage(DEFAULT_PHONE_NUMBER_ID, to, text));
});

app.post("/api/send-audio", upload.single("audio"), async (req, res) => {
  const { to } = req.body;
  const file = req.file;
  if (!to || !file) return res.status(400).json({ error: "'to' oder Audiodatei fehlt" });

  try {
    const uploadResult = await uploadMedia(DEFAULT_PHONE_NUMBER_ID, file.buffer, file.mimetype);
    if (uploadResult.error) return res.status(400).json(uploadResult);
    res.json(await sendAudioMessage(DEFAULT_PHONE_NUMBER_ID, to, uploadResult.id));
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/generate-music", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "'to' fehlt" });

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      {
        role: "developer",
        content:
          'Erzeuge zufällige Song-Lyrics mit [verse]- und [chorus]-Tags sowie eine Stil-Beschreibung. Antworte in JSON: {"lyrics": "...", "style": "..."}',
      },
      { role: "user", content: "Erstelle einen zufälligen lustigen Song" },
    ],
  });

  try {
    const content = response.choices[0]?.message?.content || "";
    const match = content.match(/\{[\s\S]*\}/);
    const { lyrics, style } = JSON.parse(match?.[0] || "{}");

    const startMsg = await openai.chat.completions.create({
      model: "gpt-5.2",
      messages: [
        { role: "developer", content: "Tell user you're generating a random song for them. Be brief and fun." },
        { role: "user", content: "Starting generation" },
      ],
    });

    if (startMsg.choices[0]?.message?.content) {
      await sendMessage(DEFAULT_PHONE_NUMBER_ID, to, startMsg.choices[0].message.content);
    }

    const result = await generateMusicWithMiniMax(style, lyrics);
    if (result.error) return res.status(400).json({ error: result.error });

    const uploadResult = await uploadMedia(DEFAULT_PHONE_NUMBER_ID, result.buffer, "audio/mpeg");
    if (uploadResult.error) return res.status(400).json(uploadResult);

    await sendAudioMessage(DEFAULT_PHONE_NUMBER_ID, to, uploadResult.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Generate music error:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// === WHATSAPP WEBHOOK ===

app.get("/wa", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/wa", async (req, res) => {
  console.log("Webhook:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);

  const value = req.body.entry?.[0]?.changes?.[0]?.value;

  // This is the KEY FIX:
  // Use the phone_number_id that the inbound message was sent TO (test vs real)
  const inboundPhoneNumberId = value?.metadata?.phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  const inboundDisplayNumber = value?.metadata?.display_phone_number;
  if (inboundDisplayNumber) {
    console.log("Inbound to number:", inboundDisplayNumber, "phone_number_id:", inboundPhoneNumberId);
  }

  const messages = value?.messages;

  if (messages?.length > 0) {
    for (const msg of messages) {
      const from = msg.from;
      const text = msg.text?.body || "[media]";
      const contactName = value.contacts?.[0]?.profile?.name || from;

      const convFrom = getConv(from, contactName);
      convFrom.name = contactName;
      db.prepare("UPDATE users SET name = ?, updated_at = ? WHERE phone = ?").run(contactName, Date.now(), from);

      const ts = parseInt(msg.timestamp, 10) * 1000;
      const newMsg = { from, text, timestamp: ts, read: false };
      convFrom.messages.push(newMsg);
      saveMessage(from, from, text, ts, false);

      console.log(`Message from ${contactName}: ${text}`);
      broadcast("message", { phone: from, message: newMsg });
      broadcast("conversation_update", { phone: from, name: contactName });

      // Let AI handle everything
      if (botEnabled && msg.text?.body) {
        await chat(from, inboundPhoneNumberId);
      }
    }
  }

  // Status updates
  const statuses = value?.statuses;
  if (statuses?.length > 0) {
    for (const status of statuses) {
      broadcast("status", { messageId: status.id, status: status.status, recipient: status.recipient_id });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
