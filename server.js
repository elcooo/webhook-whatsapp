import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import multer from "multer";
import OpenAI from "openai";

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
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

const required = [
  ["WA_VERIFY_TOKEN", VERIFY_TOKEN],
  ["WA_ACCESS_TOKEN", ACCESS_TOKEN],
  ["WA_PHONE_NUMBER_ID", PHONE_NUMBER_ID],
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

function getConv(phone) {
  if (!conversations[phone]) conversations[phone] = { name: phone, messages: [] };
  if (!conversations[phone].state) {
    conversations[phone].state = {
      songGenerated: false,
    };
  }
  return conversations[phone];
}

// Storage
let botEnabled = true;
const conversations = {};
const sseClients = new Set();
const generatingFor = new Set(); // Track users currently generating to prevent duplicates

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// WhatsApp API functions
async function sendMessage(to, text) {
  const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
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

  const convTo = getConv(to);
  const msg = { from: "me", text, timestamp: Date.now() };
  convTo.messages.push(msg);
  broadcast("message", { phone: to, message: msg });

  return data;
}

async function uploadMedia(buffer, mimeType) {
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), "audio.mp3");
  formData.append("type", mimeType);
  formData.append("messaging_product", "whatsapp");

  const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: formData,
  });

  return response.json();
}

async function sendAudioMessage(to, mediaId) {
  const response = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
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

  const convTo = getConv(to);
  const msg = { from: "me", text: "🎵 [Audio]", timestamp: Date.now(), type: "audio" };
  convTo.messages.push(msg);
  broadcast("message", { phone: to, message: msg });

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

WICHTIGE REGELN:
1. Halte Antworten KURZ (max. 2–3 Sätze)
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
- Mehrere Songs generieren
- Zu viele Fragen stellen
- Lange Antworten schreiben
- generate_song mehr als einmal pro Anfrage aufrufen

Lyrics immer KURZ halten – nur 1 Vers und 1 Refrain.

Nach dem Song den Nutzer freundlich um eine Spende bitten (nicht drängen).`;

const tools = [
  {
    type: "function",
    function: {
      name: "generate_song",
      description: "Erzeuge eine echte Song-/Musik-Audiodatei und sende sie an den Nutzer. Nutze das, wenn der Nutzer bestätigt hat, dass er einen Song erstellen will und du sowohl Lyrics als auch Stil hast.",
      parameters: {
        type: "object",
        properties: {
          lyrics: {
            type: "string",
            description: "Die Song-Lyrics mit [verse] und [chorus] Tags",
          },
          style: {
            type: "string",
            description: "Musikstil-Beschreibung z.B. 'beschwingter Pop, eingängige Melodie' oder 'emotionaler Ballad, Klavier'",
          },
        },
        required: ["lyrics", "style"],
      },
    },
  },
];

async function chat(phone) {
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
        // HARD BLOCK: only one song per user
        if (conv.state.songGenerated) {
          await sendMessage(
            phone,
            `✅ Deinen kostenlosen Song habe ich schon erstellt.\n\n${DONATION_TEXT}\n\nWenn du einen weiteren Song möchtest, antworte: „neuer Song“.`
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

        await sendMessage(phone, "🎵 Dein Song wird jetzt erstellt...");

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
          if (errorMsg) await sendMessage(phone, errorMsg);
        } else {
          // Upload and send the audio
          const uploadResult = await uploadMedia(result.buffer, "audio/mpeg");
          if (uploadResult.id) {
            await sendAudioMessage(phone, uploadResult.id);
            conv.state.songGenerated = true;
            await sendMessage(phone, `🎉 Hier ist dein Song!\n\n${DONATION_TEXT}`);
          }
        }
      }
    } else if (message?.content) {
      // Regular text response
      await sendMessage(phone, message.content);
    }
  } catch (err) {
    console.error("Chat error:", err.message);
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
  if (!conversations[phone]) return res.json({ phone, name: phone, messages: [] });
  conversations[phone].messages.forEach((m) => (m.read = true));
  res.json({ phone, ...conversations[phone] });
});

app.get("/api/bot", (req, res) => res.json({ enabled: botEnabled }));
app.post("/api/bot", (req, res) => {
  if (typeof req.body.enabled === "boolean") botEnabled = req.body.enabled;
  res.json({ enabled: botEnabled });
});

app.post("/api/send", async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: "'to' oder 'text' fehlt" });
  res.json(await sendMessage(to, text));
});

app.post("/api/send-audio", upload.single("audio"), async (req, res) => {
  const { to } = req.body;
  const file = req.file;
  if (!to || !file) return res.status(400).json({ error: "'to' oder Audiodatei fehlt" });

  try {
    const uploadResult = await uploadMedia(file.buffer, file.mimetype);
    if (uploadResult.error) return res.status(400).json(uploadResult);
    res.json(await sendAudioMessage(to, uploadResult.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/generate-music", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "'to' fehlt" });

  // Let AI generate everything
  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "developer", content: "Erzeuge zufällige Song-Lyrics mit [verse]- und [chorus]-Tags sowie eine Stil-Beschreibung. Antworte in JSON: {\"lyrics\": \"...\", \"style\": \"...\"}" },
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
      await sendMessage(to, startMsg.choices[0].message.content);
    }

    const result = await generateMusicWithMiniMax(style, lyrics);
    if (result.error) return res.status(400).json({ error: result.error });

    const uploadResult = await uploadMedia(result.buffer, "audio/mpeg");
    if (uploadResult.error) return res.status(400).json(uploadResult);

    await sendAudioMessage(to, uploadResult.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Generate music error:", err);
    res.status(500).json({ error: err.message });
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
  const messages = value?.messages;

  if (messages?.length > 0) {
    for (const msg of messages) {
      const from = msg.from;
      const text = msg.text?.body || "[media]";
      const contactName = value.contacts?.[0]?.profile?.name || from;

      const convFrom = getConv(from);
      convFrom.name = contactName;

      const newMsg = { from, text, timestamp: parseInt(msg.timestamp) * 1000, read: false };
      convFrom.messages.push(newMsg);

      console.log(`Message from ${contactName}: ${text}`);
      broadcast("message", { phone: from, message: newMsg });
      broadcast("conversation_update", { phone: from, name: contactName });

      // Let AI handle everything
      if (botEnabled && msg.text?.body) {
        await chat(from);
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