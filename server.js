import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import multer from "multer";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  console.error("Missing required environment variables:", missing.join(", "));
  console.error("Set them in Railway: Variables tab, or in a local .env file.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

  if (!conversations[to]) conversations[to] = { name: to, messages: [] };
  const msg = { from: "me", text, timestamp: Date.now() };
  conversations[to].messages.push(msg);
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

  if (!conversations[to]) conversations[to] = { name: to, messages: [] };
  const msg = { from: "me", text: "🎵 [Audio]", timestamp: Date.now(), type: "audio" };
  conversations[to].messages.push(msg);
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

  return { error: data.base_resp?.status_msg || "Failed to generate music" };
}

// === ONE AI FUNCTION TO RULE THEM ALL ===
const SYSTEM_PROMPT = `You are a friendly WhatsApp AI music assistant that creates custom songs.

IMPORTANT RULES:
1. Keep responses SHORT (2-3 sentences max)
2. Only call generate_song ONCE per song request - never call it multiple times
3. When user confirms they want to generate, call generate_song immediately - don't ask again

CONVERSATION FLOW:
1. Greet user, ask what they want their song to be about
2. Once you have a topic, write SHORT lyrics (1 verse + 1 chorus only, use [verse] and [chorus] tags)
3. Show lyrics and ask if they like it
4. If yes, ask for music style (pop, rock, rap, etc)
5. Once you have style confirmation, call generate_song ONCE

NEVER:
- Generate multiple songs
- Ask too many questions
- Write long responses
- Call generate_song more than once per request

When generating lyrics, keep them SHORT - just 1 verse and 1 chorus.`;

const tools = [
  {
    type: "function",
    function: {
      name: "generate_song",
      description: "Generate an actual song/music audio file and send it to the user. Use this when user has confirmed they want to create a song and you have both lyrics and style.",
      parameters: {
        type: "object",
        properties: {
          lyrics: {
            type: "string",
            description: "The song lyrics with [verse] and [chorus] tags",
          },
          style: {
            type: "string",
            description: "Music style description like 'upbeat pop, catchy melody' or 'emotional ballad, piano'",
          },
        },
        required: ["lyrics", "style"],
      },
    },
  },
];

async function chat(phone) {
  const conv = conversations[phone];
  if (!conv) return;

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
        // Prevent duplicate generations
        if (generatingFor.has(phone)) {
          console.log("Already generating for", phone);
          return;
        }

        generatingFor.add(phone);
        const args = JSON.parse(toolCall.function.arguments);

        // Clear "generating" message
        await sendMessage(phone, "🎵 Generating your song now... This takes about 1-2 minutes. Please wait!");

        // Generate the music
        const result = await generateMusicWithMiniMax(args.style, args.lyrics);
        generatingFor.delete(phone);

        if (result.error) {
          const errorResponse = await openai.chat.completions.create({
            model: "gpt-5.2",
            messages: [
              { role: "developer", content: "Song generation failed. Apologize briefly." },
              { role: "user", content: `Error: ${result.error}` },
            ],
          });
          const errorMsg = errorResponse.choices[0]?.message?.content;
          if (errorMsg) await sendMessage(phone, errorMsg);
        } else {
          // Upload and send the audio
          const uploadResult = await uploadMedia(result.buffer, "audio/mpeg");
          if (uploadResult.id) {
            await sendAudioMessage(phone, uploadResult.id);
            await sendMessage(phone, "🎉 Here's your song! Enjoy!");
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
  if (!to || !text) return res.status(400).json({ error: "Missing 'to' or 'text'" });
  res.json(await sendMessage(to, text));
});

app.post("/api/send-audio", upload.single("audio"), async (req, res) => {
  const { to } = req.body;
  const file = req.file;
  if (!to || !file) return res.status(400).json({ error: "Missing 'to' or audio file" });

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
  if (!to) return res.status(400).json({ error: "Missing 'to'" });

  // Let AI generate everything
  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "developer", content: "Generate random song lyrics with [verse] and [chorus] tags, and a style description. Reply in JSON: {\"lyrics\": \"...\", \"style\": \"...\"}" },
      { role: "user", content: "Create a random fun song" },
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

      if (!conversations[from]) conversations[from] = { name: contactName, messages: [] };
      conversations[from].name = contactName;

      const newMsg = { from, text, timestamp: parseInt(msg.timestamp) * 1000, read: false };
      conversations[from].messages.push(newMsg);

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