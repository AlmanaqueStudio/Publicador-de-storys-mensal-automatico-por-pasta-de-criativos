// API local que liga o botao "Publicar storys" do dashboard ao bot.
// Sobe em http://localhost:4599 e aceita chamadas de http://localhost:8000.
//
//   npm run server
//
// Endpoints:
//   GET  /health              -> { ok, running }
//   POST /upload?name=arq.mp4 -> corpo = bytes do arquivo; salva em ./media
//   POST /publicar            -> JSON { meta, schedule, targets, items, mode }
//   GET  /status              -> progresso da execucao atual

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, PROGRESS, setRunConfig, runBatch } from "./publish-stories.js";
import { saveAgenda } from "./agenda.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4599;
const MEDIA_DIR = path.resolve(__dirname, CONFIG.mediaDir);
const AGENDA_FILE = path.join(__dirname, "agenda.json");

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toLocaleTimeString(), "-", ...a);
const safeName = (n) => path.basename(String(n || "")).replace(/[^\w.\- ]+/g, "_");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (limitBytes && size > limitBytes) {
        failed = true;
        // Nao usa req.destroy() aqui: derrubar o socket antes do fim do
        // corpo impede o res.end() de sair e o navegador ve "Failed to
        // fetch" em vez do erro. Em vez disso, so paramos de guardar bytes
        // e deixamos o corpo escoar ate "end" para responder normalmente.
        reject(new Error(`arquivo maior que o limite desta API local (${(limitBytes / 1024 / 1024).toFixed(0)} MB)`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function buildAgendaFromItems(items) {
  return {
    createdAt: new Date().toISOString(),
    source: "dashboard",
    targets: CONFIG.targets,
    items: items.map((it) => {
      const fileName = safeName(it.fileName);
      return {
        date: it.date,
        time: it.time || "12:00",
        file: path.join(MEDIA_DIR, fileName),
        fileName,
        status: "pendente"
      };
    })
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, running: PROGRESS.running });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return sendJson(res, 200, PROGRESS);
    }

    if (req.method === "GET" && url.pathname === "/agenda") {
      if (!fs.existsSync(AGENDA_FILE)) return sendJson(res, 200, { items: [] });
      const agenda = JSON.parse(fs.readFileSync(AGENDA_FILE, "utf8"));
      return sendJson(res, 200, agenda);
    }

    if (req.method === "POST" && url.pathname === "/upload") {
      const name = safeName(url.searchParams.get("name"));
      if (!name) return sendJson(res, 400, { error: "faltou ?name=" });
      const buf = await readBody(req, 500 * 1024 * 1024); // 500 MB por arquivo (video de story)
      fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
      log("upload:", name, `(${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return sendJson(res, 200, { saved: name, size: buf.length });
    }

    if (req.method === "POST" && url.pathname === "/publicar") {
      if (PROGRESS.running) return sendJson(res, 409, { error: "ja tem uma publicacao rodando" });

      const raw = await readBody(req, 2 * 1024 * 1024);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      const { meta = {}, schedule = {}, targets = {}, items = [], mode = "today", scheduleMode = false, days = 7 } = body;

      if (!meta.url) return sendJson(res, 400, { error: "faltou o link do Meta (destino)" });
      if (!Array.isArray(items) || items.length === 0) {
        return sendJson(res, 400, { error: "agenda vazia" });
      }

      // Monta as URLs do Meta a partir do link colado no dashboard.
      const u = new URL(meta.url);
      const bid = meta.businessId || u.searchParams.get("business_id") || "";
      const aid = meta.assetId || u.searchParams.get("asset_id") || "";
      const qs = `business_id=${bid}&asset_id=${aid}`;
      setRunConfig({
        calendarUrl: `https://business.facebook.com/latest/content_calendar?${qs}&calendar_type=MONTH`,
        homeUrl: `https://business.facebook.com/latest/home?${qs}`,
        schedule,
        targets: { facebook: targets.facebook !== false, instagram: targets.instagram !== false }
      });

      // Verifica se todas as midias ja foram enviadas.
      const faltando = items
        .map((it) => safeName(it.fileName))
        .filter((n) => !fs.existsSync(path.join(MEDIA_DIR, n)));
      if (faltando.length) {
        return sendJson(res, 400, { error: "midias nao enviadas: " + [...new Set(faltando)].join(", ") });
      }

      const agenda = buildAgendaFromItems(items);
      saveAgenda(agenda, AGENDA_FILE);

      const all = mode === "all";
      const week = mode === "week";
      const label = all ? "agenda inteira" : week ? `proximos ${days} dias` : "hoje";
      log(`iniciando ${scheduleMode ? "agendamento" : "publicacao"} (${label}): ${agenda.items.length} itens`);

      // Dispara em segundo plano; o dashboard acompanha por /status.
      runBatch({ all, week, scheduleMode: !!scheduleMode, days: Number(days) || 7 }).catch((err) => {
        PROGRESS.lastError = String(err.message || err);
        PROGRESS.running = false;
        log("ERRO na execucao:", PROGRESS.lastError);
      });

      return sendJson(res, 200, { started: true, total: agenda.items.length, mode });
    }

    sendJson(res, 404, { error: "rota nao encontrada" });
  } catch (err) {
    log("erro:", err.message || err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  log(`story-bot API em http://localhost:${PORT}`);
  log(`midias em ${MEDIA_DIR}`);
  log('deixe esta janela aberta e use o botao "Publicar storys" no dashboard.');
});
