const express = require("express");
const cors = require("cors");
const { Readable } = require("stream");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ---------- Configuração (variáveis de ambiente no Render) ----------
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_KEY = process.env.GEMINI_KEY; // chave do Google AI Studio
const PROXY_KEY = process.env.PROXY_KEY || ""; // senha para proteger o seu proxy
const MODELS = (
  process.env.MODELS ||
  "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const COOLDOWN_MS = Number(process.env.COOLDOWN_SECONDS || 60) * 1000;

// Erros que fazem o proxy passar para o próximo modelo
const RETRY_STATUS = [404, 408, 429, 500, 502, 503, 504];

const cooldown = {}; // modelo -> timestamp até quando fica "de molho"
const lastErrors = {}; // modelo -> último erro (para diagnóstico)

// ---------- Utilidades ----------
function auth(req, res, next) {
  if (!PROXY_KEY) return next();
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token !== PROXY_KEY) {
    return res
      .status(401)
      .json({ error: { message: "Chave do proxy inválida" } });
  }
  next();
}

// Remove mensagens vazias e junta mensagens seguidas do mesmo papel
function sanitizeMessages(msgs) {
  const out = [];
  for (const m of msgs || []) {
    const content = m.content;
    if (typeof content === "string" && !content.trim()) continue;
    if (content == null) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === "string" &&
      typeof content === "string"
    ) {
      last.content += "\n\n" + content;
    } else {
      out.push({ ...m });
    }
  }
  if (!out.length) out.push({ role: "user", content: "..." });
  return out;
}

// ---------- Rota principal ----------
async function handleChat(req, res) {
  if (!GEMINI_KEY) {
    return res
      .status(500)
      .json({ error: { message: "GEMINI_KEY não configurada no Render" } });
  }

  const base = { ...req.body };
  delete base.logit_bias;
  delete base.user;
  base.messages = sanitizeMessages(base.messages);
  const wantsStream = !!base.stream;

  // Modelos fora de cooldown primeiro; se todos estiverem, tenta todos mesmo assim
  const now = Date.now();
  const available = MODELS.filter((m) => (cooldown[m] || 0) <= now);
  const order = available.length ? available : MODELS;

  for (const model of order) {
    try {
      const r = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GEMINI_KEY}`,
        },
        body: JSON.stringify({ ...base, model }),
      });

      if (r.ok) {
        res.setHeader("X-Used-Model", model);

        if (wantsStream) {
          res.status(200);
          res.setHeader(
            "Content-Type",
            r.headers.get("content-type") || "text/event-stream"
          );
          res.setHeader("Cache-Control", "no-cache");
          const stream = Readable.fromWeb(r.body);
          stream.on("error", () => res.end());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }

        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content;
        if (!text || !String(text).trim()) {
          lastErrors[model] = "resposta vazia (possível filtro de segurança)";
          console.log(`[${model}] resposta vazia, tentando o próximo`);
          continue;
        }
        return res.json(data);
      }

      const errText = await r.text();
      lastErrors[model] = `${r.status}: ${errText.slice(0, 300)}`;
      console.log(`[${model}] ${lastErrors[model]}`);

      if (r.status === 429) cooldown[model] = Date.now() + COOLDOWN_MS;
      if (RETRY_STATUS.includes(r.status)) continue;

      // Outros erros (ex.: 400) não adianta repetir: devolve ao Janitor
      return res.status(r.status).type("application/json").send(errText);
    } catch (e) {
      lastErrors[model] = "erro de rede: " + e.message;
      console.log(`[${model}] ${lastErrors[model]}`);
    }
  }

  res.status(503).json({
    error: { message: "Todos os modelos falharam", details: lastErrors },
  });
}

app.post(["/v1/chat/completions", "/chat/completions"], auth, handleChat);

// Alguns clientes consultam a lista de modelos
app.get(["/v1/models", "/models"], auth, (req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", owned_by: "google" })),
  });
});

// Diagnóstico (abra no navegador): mostra a fila, cooldowns e últimos erros
app.get("/", (req, res) => {
  const now = Date.now();
  res.json({
    status: "ok",
    gemini_key_configurada: !!GEMINI_KEY,
    proxy_protegido: !!PROXY_KEY,
    modelos: MODELS.map((m) => ({
      modelo: m,
      em_cooldown_segundos: Math.max(0, Math.ceil(((cooldown[m] || 0) - now) / 1000)),
      ultimo_erro: lastErrors[m] || null,
    })),
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy Gemini rodando na porta ${port}`));
