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
//   POST /cancelar            -> pede pra parar a execucao atual (nao repete nem publica o restante)
//   POST /agenda/limpar       -> cancela (se estiver rodando) e apaga a agenda salva, pra montar outra do zero
//   GET  /conta                -> qual conta do Facebook esta logada no perfil do bot

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, PROGRESS, setRunConfig, runBatch, requestCancel, getLoggedInAccount, doSetup, isSetupEmAndamento } from "./publish-stories.js";
import { saveAgenda } from "./agenda.js";
import { prepararParaMeta } from "./media-convert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4599;
const MEDIA_DIR = path.resolve(__dirname, CONFIG.mediaDir);
const PROFILE_DIR = path.resolve(__dirname, CONFIG.profileDir);
const AGENDA_FILE = path.join(__dirname, "agenda.json");
const FFMPEG = CONFIG.ffmpegPath || "ffmpeg";

// Nome enviado pelo dashboard -> nome do arquivo convertido em ./media
// (ex.: "foto.webp" -> "foto.jpg"). A agenda do dashboard usa o nome
// original, entao o /publicar traduz por aqui. Guarda tambem o tamanho do
// original pra nao converter de novo o mesmo arquivo a cada envio.
const CONVERSOES_FILE = path.join(__dirname, "conversoes.json");
const lerConversoes = () => {
  try { return JSON.parse(fs.readFileSync(CONVERSOES_FILE, "utf8")); } catch { return {}; }
};
const salvarConversoes = (c) => fs.writeFileSync(CONVERSOES_FILE, JSON.stringify(c, null, 2));
const nomeNoBot = (nome) => {
  const n = safeName(nome);
  return lerConversoes()[n]?.para || n;
};

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toLocaleTimeString(), "-", ...a);
const safeName = (n) => path.basename(String(n || "")).replace(/[^\w.\- ]+/g, "_");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Data de hoje no fuso local (nao UTC) no formato YYYY-MM-DD, pra comparar
// com o campo "date" (string) que vem do dashboard.
function hojeLocalISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

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

function streamUploadToFile(req, dest, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const out = fs.createWriteStream(dest);

    const fail = (err) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      req.destroy();
      out.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };

    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (limitBytes && size > limitBytes) {
        fail(new Error(`arquivo maior que o limite desta API local (${(limitBytes / 1024 / 1024).toFixed(0)} MB)`));
      }
    });
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (!failed) resolve(size);
    });

    req.pipe(out);
  });
}

function buildAgendaFromItems(items) {
  return {
    createdAt: new Date().toISOString(),
    source: "dashboard",
    targets: CONFIG.targets,
    items: items.map((it) => {
      const fileName = nomeNoBot(it.fileName);
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

    if (req.method === "GET" && url.pathname === "/conta") {
      // Sem business_id/asset_id, confere a pagina fixa do config.json.
      // Com eles (dashboard verificando uma pagina salva), confere essa.
      const businessId = url.searchParams.get("business_id");
      const assetId = url.searchParams.get("asset_id");
      const homeUrl = businessId && assetId
        ? `https://business.facebook.com/latest/home?business_id=${businessId}&asset_id=${assetId}`
        : undefined;
      const info = await getLoggedInAccount(homeUrl);
      return sendJson(res, 200, info);
    }

    if (req.method === "POST" && url.pathname === "/conectar") {
      if (isSetupEmAndamento()) return sendJson(res, 409, { error: "ja tem uma janela de login aberta" });
      log("abrindo janela de login do Facebook pedida pelo painel");
      doSetup().catch((err) => log("erro no setup:", err.message || err));
      return sendJson(res, 200, { started: true });
    }

    if (req.method === "POST" && url.pathname === "/desconectar") {
      if (PROGRESS.running) return sendJson(res, 409, { error: "nao da pra desconectar com uma publicacao rodando" });
      if (isSetupEmAndamento()) return sendJson(res, 409, { error: "feche a janela de login antes de desconectar" });
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      log("conta desconectada pelo painel (perfil do Chrome apagado)");
      return sendJson(res, 200, { disconnected: true });
    }

    if (req.method === "GET" && url.pathname === "/agenda") {
      if (!fs.existsSync(AGENDA_FILE)) return sendJson(res, 200, { items: [] });
      const agenda = JSON.parse(fs.readFileSync(AGENDA_FILE, "utf8"));
      return sendJson(res, 200, agenda);
    }

    if (req.method === "POST" && url.pathname === "/upload") {
      const name = safeName(url.searchParams.get("name"));
      if (!name) return sendJson(res, 400, { error: "faltou ?name=" });
      // Mesmo arquivo (nome + tamanho) ja convertido antes: nao converte de novo.
      const conv = lerConversoes();
      const tamanho = Number(req.headers["content-length"] || 0);
      const anterior = conv[name];
      if (anterior && tamanho && anterior.tamanho === tamanho && fs.existsSync(path.join(MEDIA_DIR, anterior.para))) {
        req.resume(); // descarta o corpo
        await new Promise((r) => req.on("end", r));
        log("upload:", name, `-> ja convertido antes (${anterior.para})`);
        return sendJson(res, 200, { saved: anterior.para, convertido: true, motivo: anterior.motivo });
      }

      const dest = path.join(MEDIA_DIR, name);
      const size = await streamUploadToFile(req, dest, 4 * 1024 * 1024 * 1024); // 4 GB por arquivo (video de story)
      log("upload:", name, `(${(size / 1024 / 1024).toFixed(1)} MB)`);

      // Converte pro formato que o Meta aceita (jpg/png ou H.264 ate 30 s).
      const r = await prepararParaMeta(dest, FFMPEG);
      const saved = path.basename(r.arquivo);
      if (r.convertido) {
        conv[name] = { para: saved, tamanho: size, motivo: r.motivo };
        log(`  convertido (${r.motivo}) -> ${saved} (${(fs.statSync(r.arquivo).size / 1024 / 1024).toFixed(1)} MB)`);
      } else {
        delete conv[name];
      }
      salvarConversoes(conv);
      return sendJson(res, 200, { saved, size, convertido: r.convertido, motivo: r.motivo || null });
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
        .map((it) => nomeNoBot(it.fileName))
        .filter((n) => !fs.existsSync(path.join(MEDIA_DIR, n)));
      if (faltando.length) {
        return sendJson(res, 400, { error: "midias nao enviadas: " + [...new Set(faltando)].join(", ") });
      }

      // O calendario do Meta nao deixa marcar dia que ja passou (fica
      // desabilitado) — sem essa checagem aqui, um pedido com data velha
      // (ex.: aba do dashboard esquecida aberta com uma previa antiga) so
      // falha la na frente, depois de 30s de tentativa por item.
      const hojeISO = hojeLocalISO();
      const passadas = [...new Set(items.filter((it) => it.date < hojeISO).map((it) => it.date))];
      if (passadas.length) {
        return sendJson(res, 400, {
          error: `agenda tem data(s) no passado: ${passadas.join(", ")} — hoje e ${hojeISO}. Gere a agenda de novo com datas a partir de hoje.`
        });
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

    if (req.method === "POST" && url.pathname === "/cancelar") {
      if (!PROGRESS.running) return sendJson(res, 409, { error: "nao tem nenhuma publicacao rodando" });
      requestCancel();
      log("cancelamento pedido pelo dashboard");
      return sendJson(res, 200, { cancelling: true });
    }

    if (req.method === "POST" && url.pathname === "/agenda/limpar") {
      let cancelou = false;
      if (PROGRESS.running) {
        cancelou = requestCancel();
        const prazo = Date.now() + 10000;
        while (PROGRESS.running && Date.now() < prazo) await sleep(300);
        if (PROGRESS.running) {
          return sendJson(res, 409, { error: "nao consegui parar a publicacao em andamento a tempo — tente de novo em alguns segundos" });
        }
      }
      saveAgenda({ createdAt: new Date().toISOString(), source: "dashboard", targets: CONFIG.targets, items: [] }, AGENDA_FILE);
      Object.assign(PROGRESS, {
        running: false, startedAt: null, finishedAt: null, total: 0, done: 0,
        current: null, items: [], lastError: null, scheduleMode: false, cancelRequested: false
      });
      log(`agenda removida pelo dashboard${cancelou ? " (publicacao em andamento foi cancelada antes)" : ""}`);
      return sendJson(res, 200, { cleared: true, cancelledFirst: cancelou });
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
