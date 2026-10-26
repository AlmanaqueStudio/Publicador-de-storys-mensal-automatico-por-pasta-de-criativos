// story-bot — publica storys no Facebook + Instagram pelo Meta Business Suite.
//
// Simula uma pessoa: movimenta o mouse, espera intervalos aleatorios, faz um
// story de cada vez e SO passa para o proximo depois de detectar a confirmacao
// de envio. Nao usa Claude nem fica preso a nenhuma sessao externa: e um
// processo Node que voce roda quando quiser (ou deixa agendado com --daemon).
//
// Modos:
//   node publish-stories.js --setup      abre o Chrome para voce logar na conta certa (uma vez)
//   node publish-stories.js --plan       gera agenda.json a partir da pasta de midias
//   node publish-stories.js --run        publica os itens de HOJE, um a um
//   node publish-stories.js --run --all  publica a agenda inteira agora (teste/atraso)
//   node publish-stories.js --daemon     agenda diario no horario do config e publica sozinho
//
// AVISO: automatizar o Meta e contra os Termos de Uso deles. E a sua conta e o
// seu conteudo, mas existe risco de bloqueio temporario. Use com moderacao.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import cron from "node-cron";
import { buildAgenda, loadAgenda, saveAgenda } from "./agenda.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const SEL = JSON.parse(fs.readFileSync(path.join(__dirname, "selectors.json"), "utf8"));
const ARGS = new Set(process.argv.slice(2));

export { CONFIG, SEL };

// Ajusta o CONFIG em memoria (usado pelo server.js para aplicar o destino do
// Meta e a agenda vindos do dashboard, sem reescrever o config.json).
export function setRunConfig(partial = {}) {
  for (const [k, v] of Object.entries(partial)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      CONFIG[k] = { ...(CONFIG[k] || {}), ...v };
    } else if (v !== undefined) {
      CONFIG[k] = v;
    }
  }
  return CONFIG;
}

// Estado da execucao atual, lido pelo server.js para mostrar progresso no dashboard.
export const PROGRESS = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  current: null,
  items: [],
  lastError: null,
  scheduleMode: false,
  cancelRequested: false
};

// Pagina/contexto da execucao em andamento, usados por requestCancel() para
// interromper na hora qualquer espera do Playwright (locator.click etc.) em
// vez de deixar o item atual estourar o timeout normal (ate 30s).
let currentSession = null;

// Pedido de cancelamento vindo do dashboard (botao "Cancelar tudo"). Nao mata
// o processo: so avisa o loop do runBatch pra parar assim que puder e fecha a
// aba que o bot esta usando agora, sem tentar de novo nem seguir pro proximo.
export function requestCancel() {
  if (!PROGRESS.running || PROGRESS.cancelRequested) return false;
  PROGRESS.cancelRequested = true;
  log("cancelamento pedido — parando apos a etapa atual…");
  if (currentSession) {
    const { page, ctx, cdp } = currentSession;
    // Modo CDP: so fecha a aba do bot, nunca o navegador/contexto do usuario.
    (cdp ? page.close() : ctx.close()).catch(() => {});
  }
  return true;
}

const log = (...a) => console.log(new Date().toLocaleTimeString(), "-", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// Evita duas verificacoes ao mesmo tempo (duas abririam o mesmo chrome-profile
// em paralelo e uma delas falharia por lock de perfil).
let contaCheckEmAndamento = false;

// Usado pelo dashboard (painel/dashboard.html, via server.js) para mostrar
// qual conta/pagina esta logada no perfil isolado do bot. Abre uma janela
// headless curta no mesmo chrome-profile do "npm run setup", entra na
// pagina inicial do Business Suite (homeUrl, por padrao CONFIG.homeUrl —
// mas o dashboard pode passar outra, pra conferir qualquer pagina salva,
// nao so a fixa do config.json) e le o primeiro heading (nome da pagina,
// ex.: "Debroi Eventos") + a foto dela (primeira imagem de
// scontent.*.fbcdn.net — a foto de perfil — perto desse heading, ignorando
// icones de rede static.xx.fbcdn.net e a foto de capa, bem maior).
export async function getLoggedInAccount(homeUrl) {
  if (CONFIG.cdp && CONFIG.cdp.enabled) {
    return { checked: false, reason: "modo cdp ativo — essa verificacao so funciona com o perfil isolado padrao" };
  }
  if (PROGRESS.running) {
    return { checked: false, reason: "bot publicando agora — tente de novo quando terminar" };
  }
  if (contaCheckEmAndamento) {
    return { checked: false, reason: "ja verificando — aguarde" };
  }

  const userDataDir = path.resolve(__dirname, CONFIG.profileDir);
  if (!fs.existsSync(userDataDir)) {
    return { checked: true, loggedIn: false, reason: 'nenhum login feito ainda — rode "npm run setup"' };
  }

  contaCheckEmAndamento = true;
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, { headless: true, channel: "chrome" });
    const page = await ctx.newPage();
    await page.goto(homeUrl || CONFIG.homeUrl, { waitUntil: "domcontentloaded", timeout: 25000 });

    const heading = page.locator('[role="heading"]').first();
    const achou = await heading.waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
    if (!achou || /login|checkpoint/i.test(page.url())) {
      return { checked: true, loggedIn: false, reason: 'sessao expirada ou nao logada — rode "npm run setup" de novo' };
    }

    const nome = ((await heading.textContent().catch(() => "")) || "").trim() || null;
    const foto = await page.evaluate(() => {
      const h = document.querySelector('[role="heading"]');
      let node = h;
      for (let up = 0; node && up < 6; up++) {
        const img = [...node.querySelectorAll("img")].find((im) => {
          try {
            return new URL(im.src).host.startsWith("scontent") && im.naturalWidth >= 32 && im.naturalWidth <= 150;
          } catch { return false; }
        });
        if (img) return img.src;
        node = node.parentElement;
      }
      return null;
    }).catch(() => null);

    return { checked: true, loggedIn: true, nome, foto };
  } catch (err) {
    const raw = String(err.message || err);
    const reason = /has been closed|already in use|SingletonLock/i.test(raw)
      ? 'nao consegui abrir o perfil agora — provavelmente outro Chrome do bot (ex.: "npm run setup") ainda esta aberto nele. Feche-o e tente de novo.'
      : raw.split("\n")[0];
    return { checked: true, loggedIn: null, reason };
  } finally {
    contaCheckEmAndamento = false;
    if (ctx) await ctx.close().catch(() => {});
  }
}

// Como o sleep() entre storys (config: betweenStoriesDelayMs, 15-45s) e o mais
// longo do fluxo, esperar em pedacos pequenos deixa o cancelamento reagir em
// no maximo 500ms em vez de so no proximo item.
async function sleepCancelable(ms) {
  const passo = 500;
  for (let restante = ms; restante > 0 && !PROGRESS.cancelRequested; restante -= passo) {
    await sleep(Math.min(passo, restante));
  }
}

function humanPause() {
  return sleep(rand(CONFIG.humanize.minActionDelayMs, CONFIG.humanize.maxActionDelayMs));
}

// ---------- humanizacao de mouse/clique/digitacao ----------

async function humanMoveTo(page, box) {
  if (!box) return;
  const target = {
    x: box.x + box.width / 2 + rand(-6, 6),
    y: box.y + box.height / 2 + rand(-4, 4)
  };
  const steps = CONFIG.humanize.mouseSteps;
  await page.mouse.move(target.x, target.y, { steps });
}

async function humanClick(page, locator, { timeout } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox().catch(() => null);
  await humanMoveTo(page, box);
  await humanPause();
  await locator.click({ delay: rand(40, 120), ...(timeout ? { timeout } : {}) });
}

// Procura o primeiro locator visivel a partir de uma lista de textos.
async function firstVisibleByText(page, texts, role = null) {
  for (const t of texts) {
    const loc = role
      ? page.getByRole(role, { name: new RegExp(escapeRe(t), "i") })
      : page.getByText(new RegExp(escapeRe(t), "i"), { exact: false });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickByText(page, texts, { role = "button", required = true, what = "", direct = false } = {}) {
  let loc = await firstVisibleByText(page, texts, role);
  if (!loc && role !== "menuitem") loc = await firstVisibleByText(page, texts, "menuitem");
  if (!loc) loc = await firstVisibleByText(page, texts, null);
  if (!loc) {
    if (required) throw new Error(`Nao achei o elemento: ${what || texts[0]} (ajuste selectors.json)`);
    return false;
  }
  if (direct) {
    // Clique direto, sem mover o mouse em varios passos ate o elemento.
    // Usado em menus/overlays que fecham se o cursor "passar por fora"
    // deles no meio do caminho de um movimento humanizado mais longo.
    await loc.click({ delay: rand(30, 80) });
  } else {
    await humanClick(page, loc);
  }
  return true;
}

// O botao final (Publicar/Compartilhar/Programar) tem o MESMO texto exato de
// um alternador la em cima ("Compartilhar agora" contem "Compartilhar"; no
// modo agendar, a propria aba ja ativa se chama so "Programar", igual ao
// botao de confirmar). Clicar por texto solto (contains, case-insensitive)
// acaba clicando nesse alternador em vez de enviar de verdade — foi
// exatamente o que travou o agendamento: a tela voltava pro modo padrao sem
// nada ter sido enviado. Por isso aqui exigimos o texto EXATO do botao (nao
// so "contem") e, quando ainda sobra mais de um (ex.: os dois "Programar"),
// pegamos o que estiver mais embaixo na tela — o alternador fica no topo da
// secao "Programar", o botao de confirmar fica no rodape do composer.
async function footerActionButton(page, exactTexts) {
  let best = null;
  for (const text of exactTexts) {
    const loc = page.getByRole("button", { name: new RegExp(`^\\s*${escapeRe(text)}\\s*$`, "i") });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box) continue;
      if (!best || box.y > best.box.y) best = { el, box };
    }
  }
  return best ? best.el : null;
}

// Checa se o composer ("Criar story"/"Criar post") ainda esta na tela.
// Tentamos antes checar por texto EXATO de botao (Programar/Compartilhar),
// mas o proprio Planner (fora do composer) tem seus PROPRIOS botoes
// "Programar" soltos nos cartoes de sugestao de horario — isso fazia a
// checagem achar "ainda aberto" pra sempre, mesmo com o composer ja fechado
// havia muito tempo, e o agendamento saindo certo. O titulo "Criar story" so
// existe dentro do composer, entao e um sinal sem ambiguidade nenhuma.
// So "Criar story": o Planner (pra onde o Meta volta depois de programar) tem
// um botao azul "Criar post" no canto — aceitar "post" aqui fazia o composer
// parecer aberto pra sempre e todo item caia no timeout de 2 min.
async function isComposerOpen(page) {
  const heading = page.getByText(/^Criar st[oó]ry$/i);
  const n = await heading.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    if (await heading.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

// Timeout bem maior que o padrao (30s) do Playwright: o botao final so fica
// habilitado depois que o Meta termina de processar a midia (gerar preview,
// validar destino/data) — video grande ou o servidor deles mais lento podem
// levar bem mais que 30s nisso, e o botao existe na tela o tempo todo, so
// com aria-disabled=true ate acabar. Sem isso o item cai em "erro" mesmo
// quando so precisava esperar mais um pouco.
const FINAL_ACTION_TIMEOUT_MS = 120000;

// O Meta recusa video de story com mais de 30s: mostra "Encurte o video" /
// "O video e muito longo" e deixa o botao final desabilitado pra sempre. Sem
// esta checagem o bot ficava 2 min esperando o botao e caia num "Timeout"
// que nao dizia o motivo real.
async function assertMediaAccepted(page, mediaPath) {
  const body = (await page.locator("body").innerText().catch(() => "")) || "";
  if (/v[ií]deo [eé] muito longo|Encurte o v[ií]deo|video is too long|Trim your video/i.test(body)) {
    await debugShot(page, "video_longo");
    throw new Error(
      `O Meta recusou ${path.basename(mediaPath)}: video muito longo. Story do Facebook aceita no maximo 30 segundos — ` +
      `corte o video e tente de novo.`
    );
  }
}

// Botoes visiveis cujo nome e EXATAMENTE o texto (ignora maiusculas), com a
// posicao na tela de cada um.
async function visibleExactButtons(page, text) {
  const loc = page.getByRole("button", { name: new RegExp(`^\\s*${escapeRe(text)}\\s*$`, "i") });
  const n = await loc.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box) out.push({ el, box });
  }
  return out;
}

// Passo 3: a aba "Programar" da secao Programar (a de cima, ao lado de
// "Compartilhar agora") — nunca o botao azul do rodape.
async function clickProgramarTab(page) {
  const btns = await visibleExactButtons(page, "Programar");
  if (!btns.length) throw new Error('Nao achei a aba "Programar" na secao Programar do composer.');
  btns.sort((a, b) => a.box.y - b.box.y);
  await humanClick(page, btns[0].el);
}

// Passo 5: o botao "Programar" do rodape, na mesma linha e a direita do
// "Cancelar". Espera ate FINAL_ACTION_TIMEOUT_MS ele habilitar.
async function clickFooterProgramar(page) {
  const cancel = (await visibleExactButtons(page, "Cancelar")).sort((a, b) => b.box.y - a.box.y)[0];
  const btns = await visibleExactButtons(page, "Programar");
  let target = null;
  if (cancel) {
    const cy = cancel.box.y + cancel.box.height / 2;
    target = btns.find(({ box }) => Math.abs(box.y + box.height / 2 - cy) < 30 && box.x > cancel.box.x) || null;
  }
  if (!target) {
    // Sem "Cancelar" na tela: usa o "Programar" mais embaixo (o do rodape).
    target = btns.sort((a, b) => b.box.y - a.box.y)[0] || null;
  }
  if (!target) throw new Error('Nao achei o botao "Programar" no rodape (ao lado de "Cancelar").');
  log(`aguardando o botao "Programar" do rodape habilitar (ate ${FINAL_ACTION_TIMEOUT_MS / 1000}s)…`);
  await humanClick(page, target.el, { timeout: FINAL_ACTION_TIMEOUT_MS });
}

async function clickFinalAction(page, { exactTexts, fallbackTexts, what }) {
  const btn = await footerActionButton(page, exactTexts);
  if (btn) {
    log(`aguardando o botao "${what}" habilitar (ate ${FINAL_ACTION_TIMEOUT_MS / 1000}s — o Meta pode demorar pra terminar de processar a midia)…`);
    await humanClick(page, btn, { timeout: FINAL_ACTION_TIMEOUT_MS });
    return;
  }
  log(`aviso: nao achei o botao final pelo texto exato (${exactTexts.join("/")}) — usando busca por texto solto como fallback para ${what}.`);
  await clickByText(page, fallbackTexts, { what });
}

// Espera o indicador "Carregando mídia" (barra de progresso do upload)
// desaparecer da tela — sinal real de que o preview terminou de processar,
// em vez de confiar num tempo fixo. Se nunca sumir dentro do prazo, retorna
// false (quem chamou decide o que fazer — normalmente abortar esse item).
async function waitForMediaReady(page, timeoutMs) {
  const loadingRe = new RegExp(SEL.mediaLoadingText.map(escapeRe).join("|"), "i");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = (await page.textContent("body").catch(() => "")) || "";
    if (!loadingRe.test(body)) return true;
    await sleep(1000);
  }
  return false;
}

async function debugShot(page, name) {
  if (!CONFIG.debug) return;
  const dir = path.join(__dirname, "debug");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  log("debug:", path.relative(__dirname, file));
}

// ---------- navegador ----------

// Modo CDP: conecta no Chrome que voce ja tem aberto (aberto com
// --remote-debugging-port) e abre uma NOVA ABA nele, reaproveitando o login
// do Facebook que ja esta na sua sessao. Nao fecha nada do seu navegador.
async function launchCdp() {
  const url = CONFIG.cdp.url || "http://localhost:9222";
  let browser;
  try {
    browser = await chromium.connectOverCDP(url);
  } catch (err) {
    throw new Error(
      `Nao consegui conectar no Chrome em ${url}. Feche todas as janelas do Chrome e abra de novo com ` +
      `--remote-debugging-port=9222 (veja o README). Detalhe: ${err.message || err}`
    );
  }
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  return { ctx, page, browser, cdp: true };
}

async function launch() {
  if (CONFIG.cdp && CONFIG.cdp.enabled) return launchCdp();

  const userDataDir = path.resolve(__dirname, CONFIG.profileDir);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble"
    ]
  });

  // Depois de varias aberturas/fechamentos seguidas, o Chrome pode restaurar
  // abas antigas (about:blank ou de sessao anterior) junto com o perfil.
  // Se a automacao pegar uma dessas em vez da aba que aparece na tela, o
  // script "trava" numa aba escondida enquanto voce ve outra parada em
  // about:blank. Pra evitar isso: cria uma aba nova e limpa primeiro, so
  // depois fecha as antigas — fechar todas ANTES de abrir a nova deixa o
  // Chrome achar que nao tem mais janela nenhuma (ele fecha o processo
  // inteiro quando a ultima aba morre), derrubando a chamada seguinte.
  const oldPages = ctx.pages();
  const page = await ctx.newPage();
  for (const p of oldPages) {
    await p.close().catch(() => {});
  }
  return { ctx, page, cdp: false };
}

// Espera o conteudo de verdade aparecer na tela, em vez de um tempo fixo.
// O Business Suite e um SPA pesado — as vezes carrega em 2s, as vezes leva
// bem mais, e um sleep fixo faz o resto do script agir numa pagina ainda
// em branco (foi exatamente o que causou o "nao achei o quadradinho do
// dia": o print de debug saiu vazio, cinza, nada renderizado ainda).
async function waitForContent(page, { timeout = 15000, minChars = 300 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = (await page.locator("body").innerText().catch(() => "")) || "";
    if (text.trim().length >= minChars) return true;
    await sleep(500);
  }
  return false;
}

async function ensureLoggedIn(page) {
  await page.goto(CONFIG.homeUrl, { waitUntil: "domcontentloaded" });
  if (!(await waitForContent(page))) log("aviso: pagina inicial do Meta demorou a carregar — seguindo mesmo assim.");
  await sleep(1500);

  // So considera "tela de login" pelo CAMINHO da url (nao qualquer substring
  // solta, que da falso positivo com paths tipo /login_router ou hashes) e
  // por um campo de senha VISIVEL na tela. "textContent" pega texto de
  // elementos escondidos no DOM (menu de trocar conta, configuracoes, etc.)
  // e isso gerava falso positivo mesmo logado — por isso trocamos para
  // "innerText", que respeita o que esta realmente visivel.
  const urlPath = new URL(page.url()).pathname;
  const looksLikeLoginUrl = /^\/login(\.php)?\/?$/i.test(urlPath) || /checkpoint/i.test(urlPath);
  const hasVisiblePasswordField = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);

  if (looksLikeLoginUrl || hasVisiblePasswordField) {
    await debugShot(page, "nao_logado");
    throw new Error("Nao esta logado nessa conta. Rode: npm run setup  e faca o login manualmente.");
  }

  const body = (await page.locator("body").innerText().catch(() => "")) || "";
  if (/conteúdo não está disponível|content isn't available|isn't available right now/i.test(body)) {
    await debugShot(page, "sem_acesso_business_id");
    throw new Error(
      "Logado, mas esta conta nao tem acesso ao business_id/asset_id do config.json. " +
      "Confirme que logou na conta dona dessa pagina (ex.: Debroi Eventos) e que os IDs no config estao certos."
    );
  }
}

// ---------- fluxo de 1 story ----------

// Passos compartilhados: abre a Pagina Inicial do Meta, clica direto em
// "Criar story" e envia a midia. Termina logo apos marcar os destinos
// (Facebook/Instagram) — quem chama decide se publica agora (publishOne) ou
// agenda para depois (scheduleOne).
//
// (Versao simplificada a pedido do usuario: sem calendario mensal, sem
// procurar quadradinho de dia, sem filtro de tipo de conteudo — so abre a
// Pagina Inicial e clica em "Criar story" direto.)
async function openComposerAndUpload(page, mediaPath, dateStr) {
  if (!fs.existsSync(mediaPath)) throw new Error("Arquivo nao encontrado: " + mediaPath);
  log("abrindo a Pagina Inicial do Meta…");

  await page.goto(CONFIG.homeUrl, { waitUntil: "domcontentloaded" });
  if (!(await waitForContent(page))) log("aviso: pagina demorou a carregar conteudo — seguindo mesmo assim.");
  await sleep(1000);
  await debugShot(page, "1_home");

  log('clicando em "Criar story"…');
  await clickByText(page, SEL.createStoryButton, { what: "botao Criar story" });
  await sleep(2500);
  await debugShot(page, "2_composer");

  // Clicar em "Adicionar foto/video" abre o dialogo nativo de arquivo do
  // Windows (fora do controle do navegador) — por isso NAO da pra so
  // procurar um <input type=file> depois do clique, ele fica esperando pra
  // sempre (foi exatamente o que travou: 30s de timeout). A forma certa e
  // escutar o evento "filechooser" ANTES de clicar e responder direto com o
  // arquivo sorteado pro item, sem nunca abrir uma janela de verdade.
  log("enviando arquivo:", path.basename(mediaPath));
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15000 }),
      clickByText(page, SEL.addPhotoVideoButton, { what: "adicionar foto/video" })
    ]);
    await fileChooser.setFiles(mediaPath);
  } catch {
    // Fallback: alguns layouts tem um <input type=file> estatico no DOM em
    // vez de abrir dialogo nativo — tenta usar setInputFiles direto nele.
    log("aviso: nao veio dialogo nativo de arquivo — tentando input[type=file] direto no DOM.");
    const fileInput = page.locator(SEL.composerFileInput).first();
    await fileInput.waitFor({ state: "attached", timeout: 15000 });
    await fileInput.setInputFiles(mediaPath);
  }

  // Espera de verdade o upload/preview terminar de processar, em vez de um
  // tempo fixo torcendo pra ter sido suficiente — foi exatamente isso que
  // mascarava um arquivo com problema real: ele ficava preso em "Carregando
  // mídia" pra sempre e o erro so aparecia bem mais na frente, no botao
  // final "Programar" travado, sem dizer o motivo verdadeiro.
  await sleep(1500); // da tempo do indicador de carregamento aparecer antes de checar
  const carregou = await waitForMediaReady(page, CONFIG.mediaReadyTimeoutMs || 90000);
  await debugShot(page, "3_uploaded");
  if (!carregou) {
    throw new Error(
      `A mídia não terminou de carregar no Meta depois de ${Math.round((CONFIG.mediaReadyTimeoutMs || 90000) / 1000)}s ` +
      `(${path.basename(mediaPath)}) — o arquivo pode ter um problema (codec/formato); reexporte e tente de novo.`
    );
  }
  await sleep(rand(1000, 2500)); // acomoda a tela depois que o preview aparece

  // Garante Facebook + Instagram marcados, se o composer tiver esses toggles.
  await ensurePlacement(page, SEL.facebookPlacementToggle, CONFIG.targets.facebook, "Facebook");
  await ensurePlacement(page, SEL.instagramPlacementToggle, CONFIG.targets.instagram, "Instagram");
  await debugShot(page, "4_placements");
}

async function publishOne(page, mediaPath, dateStr) {
  await openComposerAndUpload(page, mediaPath, dateStr);
  await assertMediaAccepted(page, mediaPath);

  await humanPause();
  log("clicando em publicar…");
  await clickFinalAction(page, { exactTexts: ["Compartilhar", "Publicar", "Share", "Publish"], fallbackTexts: SEL.publishButton, what: "botao Publicar" });

  // Espera a confirmacao de envio antes de liberar o proximo.
  await waitForConfirmation(page, { okTexts: SEL.confirmationText, dateStr }).catch(markAfterSubmit);
  log("story confirmado ✓");
}

// Agenda o story direto no calendario do Meta, em vez de publicar na hora.
// Confirmado no print de debug: a secao "Programar" do composer e um
// alternador simples "Compartilhar agora" / "Programar" (nao um menu
// escondido) — clicar em "Programar" deve revelar os campos de data/hora.
// Se o layout mudar, rode com "debug": true e ajuste scheduleOptionButton /
// scheduleDateInput / scheduleTimeInput / scheduleConfirmButton em
// selectors.json conforme os prints em ./debug.
async function scheduleOne(page, mediaPath, dateStr, timeStr) {
  await openComposerAndUpload(page, mediaPath, dateStr);

  await humanPause();
  // Passo 3: aba "Programar".
  log('clicando na aba "Programar"…');
  await clickProgramarTab(page);
  await sleep(800);
  await debugShot(page, "5_schedule_open");

  // Passo 4: data e horario do Facebook e do Instagram.
  log(`preenchendo data/horario (Facebook e Instagram): ${dateStr} ${timeStr}`);
  await fillScheduleDateTime(page, dateStr, timeStr);
  await debugShot(page, "6_schedule_filled");

  await assertMediaAccepted(page, mediaPath);

  // Passo 5: "Programar" do rodape, ao lado de "Cancelar".
  await humanPause();
  log(`confirmando agendamento para ${dateStr} ${timeStr}…`);
  await clickFooterProgramar(page);

  await waitForConfirmation(page, { okTexts: SEL.scheduledConfirmationText, dateStr }).catch(markAfterSubmit);
  log("story agendado ✓");
}

const MESES_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
];

// O campo de data do Meta e um textbox de verdade que abre um mini-calendario
// popup ao ganhar foco (confirmado em diag: digitar texto direto no campo o
// preenche visualmente, mas o dia MARCADO no calendario continua sendo o de
// hoje — ou seja, o texto digitado nao necessariamente vira a data usada de
// verdade). Por isso escolhemos o dia clicando na casinha certa do
// calendario, do jeito que uma pessoa faria, em vez de so digitar a string.
async function pickCalendarDay(page, targetDate) {
  const day = targetDate.getDate();
  const monthName = MESES_PT[targetDate.getMonth()];
  const year = targetDate.getFullYear();

  // Confere/navega ate o mes certo usando o cabecalho "<mes> de <ano>" e as
  // setas ao lado. Se nao achar o cabecalho, segue em frente mesmo assim —
  // a maioria dos agendamentos cai no mes ja exibido por padrao (o atual).
  for (let tries = 0; tries < 13; tries++) {
    const header = page.getByText(new RegExp(`${monthName} de ${year}`, "i"));
    if (await header.count().catch(() => 0)) break;
    const next = page.getByRole("button", { name: />|próximo|next/i }).first();
    if (!(await next.count().catch(() => 0))) {
      log("aviso: nao achei o cabecalho do calendario nem seta de navegacao — tentando clicar no dia mesmo assim.");
      break;
    }
    await next.click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
  }

  // O mesmo numero aparece nos campos de hora/minuto (ex.: dia 12 com horario
  // 12:00, ou dia 17 com a hora atual 17h): eles sao <label aria-hidden> por
  // cima de um spinbutton e bloqueiam o clique. Pula esses e fica so com a
  // casinha do mini-calendario.
  const cell = page.getByText(new RegExp(`^${day}$`), { exact: true });
  const n = await cell.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = cell.nth(i);
    const ehCampoDeHora = await el
      .evaluate((node) => {
        const label = node.closest("label[for]");
        const alvo = label && document.getElementById(label.getAttribute("for"));
        return Boolean(alvo && alvo.getAttribute("role") === "spinbutton") || Boolean(node.closest("[role='spinbutton']"));
      })
      .catch(() => false);
    if (ehCampoDeHora) continue;
    if (await el.isVisible().catch(() => false)) {
      await humanClick(page, el);
      return true;
    }
  }
  return false;
}

async function fillTimeSpinbuttons(page, hourSpin, minuteSpin, hh, mm) {
  await humanClick(page, hourSpin);
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(String(hh).padStart(2, "0"), { delay: rand(50, 100) });
  await sleep(200);
  await humanClick(page, minuteSpin);
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(String(mm).padStart(2, "0"), { delay: rand(50, 100) });
  await sleep(200);
}

// "Clica fora": clica no titulo "Criar story" do composer (texto parado, nao
// e botao nem campo) pra fechar o mini-calendario e o Meta aceitar o valor
// digitado. Sem o titulo na tela, clica num canto vazio no topo da pagina.
async function clickOutside(page) {
  const heading = page.getByText(/^Criar st[oó]ry$/i).first();
  if (await heading.isVisible().catch(() => false)) {
    await humanClick(page, heading);
  } else {
    const vp = page.viewportSize() || { width: 1440, height: 900 };
    await page.mouse.click(Math.round(vp.width * 0.6), 20);
  }
  await sleep(600);
}

async function fillScheduleDateTime(page, dateStr, timeStr) {
  const targetDate = new Date(dateStr + "T00:00:00");
  const [hh, mm] = timeStr.split(":").map(Number);

  // Campos visiveis, na ordem da tela: [0] = Facebook, [1] = Instagram.
  const dateBoxes = [];
  const allText = page.getByRole("textbox");
  for (let i = 0, n = await allText.count().catch(() => 0); i < n; i++) {
    if (await allText.nth(i).isVisible().catch(() => false)) dateBoxes.push(allText.nth(i));
  }
  const spinList = [];
  const allSpins = page.getByRole("spinbutton");
  for (let i = 0, n = await allSpins.count().catch(() => 0); i < n; i++) {
    if (await allSpins.nth(i).isVisible().catch(() => false)) spinList.push(allSpins.nth(i));
  }
  if (dateBoxes.length === 0) {
    log("aviso: nao achei nenhum campo de data (textbox) — o agendamento provavelmente vai usar a data padrao (hoje).");
  }
  if (spinList.length === 0) {
    log("aviso: nao achei nenhum campo de horario (spinbutton) — o agendamento provavelmente vai usar o horario padrao (agora).");
  }

  // Uma plataforma de cada vez: data -> horario -> clica fora. So depois
  // passa pra proxima (Facebook primeiro, Instagram depois).
  const labels = ["Facebook", "Instagram"];
  const platforms = Math.max(dateBoxes.length, Math.floor(spinList.length / 2));
  for (let i = 0; i < platforms; i++) {
    const label = labels[i] || `plataforma ${i + 1}`;
    log(`${label}: data ${dateStr}, horario ${timeStr}`);

    if (dateBoxes[i]) {
      await humanClick(page, dateBoxes[i]);
      await sleep(500);
      const picked = await pickCalendarDay(page, targetDate);
      if (!picked) {
        log(`aviso: nao achei o dia ${targetDate.getDate()} no calendario do ${label} — ele pode ter ficado com a data padrao.`);
        await page.keyboard.press("Escape").catch(() => {});
      }
      await sleep(300);
    }

    if (spinList[2 * i] && spinList[2 * i + 1]) {
      await fillTimeSpinbuttons(page, spinList[2 * i], spinList[2 * i + 1], hh, mm);
    }

    await clickOutside(page);
  }
}

async function ensurePlacement(page, texts, wanted, label) {
  if (wanted === undefined) return;
  const loc = await firstVisibleByText(page, texts, null);
  if (!loc) return; // composer sem selecao de destino: ignora
  // procura um checkbox/switch proximo
  const control = loc.locator("xpath=ancestor-or-self::*[self::label or self::div][1]//*[@role='checkbox' or @role='switch' or self::input]").first();
  const has = await control.count().catch(() => 0);
  if (!has) return;
  const checked =
    (await control.getAttribute("aria-checked").catch(() => null)) === "true" ||
    (await control.isChecked?.().catch(() => false));
  if (Boolean(checked) !== Boolean(wanted)) {
    log(`${wanted ? "marcando" : "desmarcando"} destino ${label}`);
    await humanClick(page, control);
    await sleep(600);
  }
}

// Ultima checagem antes de desistir: pergunta pro proprio calendario do Meta
// (visao Mes) se ja existe algo agendado no dia certo, em vez de confiar so
// no toast/composer. Confirmado varias vezes na pratica: o agendamento quase
// sempre sai certo, so demora mais que o timeout pra aparecer — sem isso, o
// item ficava marcado "erro" injustamente.
async function verificarAgendadoNoCalendario(page, dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  const day = String(target.getDate());
  try {
    const base = CONFIG.calendarUrl.split("?")[0];
    const qs = new URLSearchParams(CONFIG.calendarUrl.split("?")[1] || "");
    qs.set("calendar_type", "MONTH");
    await page.goto(`${base}?${qs.toString()}`, { waitUntil: "domcontentloaded" });
    if (!(await waitForContent(page))) return false;
    await sleep(1500);

    const dayHeaders = page.getByText(new RegExp(`^${day}$`), { exact: true });
    const n = await dayHeaders.count().catch(() => 0);
    const times = page.getByText(/^\d{1,2}:\d{2}$/);
    const timeCount = await times.count().catch(() => 0);

    for (let i = 0; i < n; i++) {
      const header = dayHeaders.nth(i);
      if (!(await header.isVisible().catch(() => false))) continue;
      const headerBox = await header.boundingBox().catch(() => null);
      if (!headerBox) continue;
      for (let j = 0; j < timeCount; j++) {
        const timeBox = await times.nth(j).boundingBox().catch(() => null);
        if (!timeBox) continue;
        const mesmaColuna = Math.abs((timeBox.x + timeBox.width / 2) - (headerBox.x + headerBox.width / 2)) < 90;
        if (mesmaColuna && timeBox.y > headerBox.y) return true;
      }
    }
  } catch (err) {
    log("aviso: falha ao verificar o calendario:", err.message || err);
  }
  return false;
}

// Erro que acontece DEPOIS do clique final (Programar/Compartilhar): o story
// provavelmente ja foi enviado, so nao conseguimos confirmar. Tentar de novo
// do zero agendaria o mesmo story duas vezes (foi o que encheu o Planner de
// repetidos), entao o loop principal NAO repete esse item.
function markAfterSubmit(err) {
  err.afterSubmit = true;
  throw err;
}

async function waitForConfirmation(page, { okTexts = SEL.confirmationText, dateStr } = {}) {
  const deadline = Date.now() + CONFIG.confirmTimeoutMs;
  const okRe = new RegExp(okTexts.map(escapeRe).join("|"), "i");
  const errRe = new RegExp(SEL.errorText.map(escapeRe).join("|"), "i");

  while (Date.now() < deadline) {
    const body = (await page.textContent("body").catch(() => "")) || "";
    if (errRe.test(body)) {
      await debugShot(page, "erro");
      throw new Error("O Meta mostrou erro ao publicar/agendar. Abortando para nao repetir errado.");
    }
    if (okRe.test(body)) {
      await debugShot(page, "6_confirmado");
      return;
    }
    // Sinal alternativo: o composer fechou sozinho depois do clique final.
    // O Meta pode mandar pra qualquer tela (Pagina Inicial, calendario,
    // Planner...), entao nao depende da URL — so do "Criar story" ter sumido.
    if (!(await isComposerOpen(page))) {
      await debugShot(page, "6_composer_fechou");
      return;
    }
    await sleep(2000);
  }
  await debugShot(page, "timeout");

  if (dateStr) {
    log("nao confirmei pelo toast — conferindo direto no calendario antes de desistir…");
    if (await verificarAgendadoNoCalendario(page, dateStr)) {
      log("achei no calendario: confirmado do jeito difícil ✓");
      await debugShot(page, "6_confirmado_via_calendario");
      return;
    }
  }

  throw new Error(
    "Nao detectei a confirmacao de envio dentro do tempo limite (nem no toast, nem no calendario). " +
    "Verifique manualmente se o story foi publicado."
  );
}

// ---------- orquestracao ----------

function todaysItems(agenda) {
  const today = new Date().toISOString().slice(0, 10);
  return agenda.items.filter((it) => it.status === "pendente" && it.date === today);
}

function pendingItems(agenda) {
  return agenda.items.filter((it) => it.status === "pendente");
}

// Itens pendentes dentro de uma janela de N dias a partir de hoje (inclusive).
// Usado pelo modo --schedule para agendar "uma semana de uma vez" direto no
// calendario do Meta, em vez de publicar um a um na hora.
function windowItems(agenda, days = 7) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days - 1);
  return agenda.items.filter((it) => {
    if (it.status !== "pendente") return false;
    const d = new Date(it.date + "T00:00:00");
    return d >= start && d <= end;
  });
}

async function executarItem(page, it, scheduleMode) {
  if (scheduleMode) {
    await scheduleOne(page, it.file, it.date, it.time);
    return "agendado";
  }
  await publishOne(page, it.file, it.date);
  return "publicado";
}

export async function runBatch({ all = false, week = false, scheduleMode = false, days = 7 } = {}) {
  const agendaFile = path.join(__dirname, "agenda.json");
  if (!fs.existsSync(agendaFile)) {
    throw new Error("agenda.json nao existe. Rode primeiro: npm run plan");
  }
  const agenda = loadAgenda(agendaFile);
  const queue = all ? pendingItems(agenda) : week ? windowItems(agenda, days) : todaysItems(agenda);
  const label = all ? "(agenda inteira)" : week ? `(proximos ${days} dias)` : "de hoje";

  if (queue.length === 0) {
    log(week || all ? "nada pendente nessa janela." : "nenhum story pendente para hoje.");
    return;
  }
  log(`fila: ${queue.length} story(s) ${label}${scheduleMode ? " — modo AGENDAR no Meta" : " — modo publicar AGORA"}`);

  if (PROGRESS.running) throw new Error("Ja existe uma publicacao em andamento.");
  Object.assign(PROGRESS, {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: queue.length,
    done: 0,
    current: null,
    lastError: null,
    scheduleMode,
    cancelRequested: false,
    items: queue.map((it) => ({ date: it.date, time: it.time, fileName: it.fileName, status: it.status }))
  });

  let { ctx, page, cdp } = await launch();
  currentSession = { ctx, page, cdp };
  try {
    await ensureLoggedIn(page);
    for (let i = 0; i < queue.length; i++) {
      if (PROGRESS.cancelRequested) break;
      const it = queue[i];
      log(`[${i + 1}/${queue.length}] ${it.date} ${it.time} -> ${it.fileName}`);
      PROGRESS.current = it.fileName;
      PROGRESS.items[i].status = scheduleMode ? "agendando" : "publicando";
      try {
        it.status = await executarItem(page, it, scheduleMode);
      } catch (err) {
        if (PROGRESS.cancelRequested) break; // fechado de proposito pelo cancelamento — nao tenta de novo
        log("ERRO neste story:", err.message || err);
        if (err.afterSubmit) {
          // Ja clicou no botao final: repetir poderia duplicar o story.
          it.status = "verificar";
          it.error = "Botao final clicado, mas sem confirmacao — confira no Planner do Meta. " + String(err.message || err);
          PROGRESS.items[i].status = "verificar";
          PROGRESS.lastError = it.error;
          saveAgenda(agenda, agendaFile);
          log("o botao final ja tinha sido clicado — NAO vou repetir (evita story duplicado). Marcado como 'verificar'.");
          if (i < queue.length - 1) {
            const [a, b] = CONFIG.betweenStoriesDelayMs;
            await sleepCancelable(rand(a, b));
          }
          continue;
        }
        log("fechando o navegador e tentando esse dia de novo do zero, uma vez, antes de desistir…");
        if (cdp) await page.close().catch(() => {});
        else await ctx.close().catch(() => {});
        ({ ctx, page, cdp } = await launch());
        currentSession = { ctx, page, cdp };
        try {
          await ensureLoggedIn(page);
          it.status = await executarItem(page, it, scheduleMode);
          log("recuperado na segunda tentativa ✓");
        } catch (err2) {
          if (PROGRESS.cancelRequested) break; // idem, na segunda tentativa
          it.status = "erro";
          it.error = String(err2.message || err2);
          PROGRESS.items[i].status = "erro";
          PROGRESS.lastError = it.error;
          saveAgenda(agenda, agendaFile);
          log("ERRO de novo na segunda tentativa:", it.error);
          log("marcando como erro e seguindo pro proximo dia da fila (nada mais e repetido pra esse).");
          if (i < queue.length - 1) {
            const [a, b] = CONFIG.betweenStoriesDelayMs;
            await sleepCancelable(rand(a, b));
          }
          continue;
        }
      }
      it.publishedAt = new Date().toISOString();
      PROGRESS.items[i].status = it.status;
      PROGRESS.done++;
      saveAgenda(agenda, agendaFile);

      if (i < queue.length - 1) {
        const [a, b] = CONFIG.betweenStoriesDelayMs;
        const wait = rand(a, b);
        log(`aguardando ${Math.round(wait / 1000)}s antes do proximo…`);
        await sleepCancelable(wait);
      }
    }

    if (PROGRESS.cancelRequested) {
      // Marca so o que ainda nao foi concluido; o que ja publicou/agendou ou
      // ja deu erro antes do cancelamento fica como estava.
      for (let i = 0; i < queue.length; i++) {
        if (!["publicado", "agendado", "erro"].includes(queue[i].status)) {
          queue[i].status = "cancelado";
          PROGRESS.items[i].status = "cancelado";
        }
      }
      saveAgenda(agenda, agendaFile);
      log(`cancelado pelo usuario — ${PROGRESS.done}/${queue.length} ja tinham sido concluidos.`);
    }
  } finally {
    if (cdp) {
      // Modo CDP: so fecha a aba que o bot abriu. Nunca fecha o contexto
      // nem a janela — e o seu navegador de verdade, com suas outras abas.
      await page.close().catch(() => {});
    } else {
      await ctx.close().catch(() => {});
    }
    currentSession = null;
    PROGRESS.running = false;
    PROGRESS.current = null;
    PROGRESS.finishedAt = new Date().toISOString();
  }
}

// Evita duas janelas de setup ao mesmo tempo (ex.: dois cliques em "Conectar
// Facebook" no painel) — a segunda abriria o mesmo chrome-profile em paralelo
// e falharia por lock de perfil.
let setupEmAndamento = false;

export function isSetupEmAndamento() {
  return setupEmAndamento;
}

export async function doSetup() {
  if (setupEmAndamento) {
    log("setup ja esta aberto — aguarde fechar a janela atual.");
    return;
  }
  if (CONFIG.cdp && CONFIG.cdp.enabled) {
    log("modo CDP ativo: nao precisa de setup. O bot usa o login que ja esta no seu Chrome.");
    log("so confira que o Chrome esta aberto com --remote-debugging-port (veja o README) e rode: npm run run");
    return;
  }
  setupEmAndamento = true;
  log("abrindo o Chrome. Faca login na conta do Facebook/Meta que administra a pagina alvo.");
  log("quando terminar de logar e ver o Meta Business Suite, feche a janela.");
  try {
    const { ctx, page } = await launch();
    try {
      await page.goto("https://business.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      log("AVISO: nao consegui abrir business.facebook.com automaticamente:", err.message || err);
      log("a aba abriu em about:blank — cole esse link manualmente na barra de endereco e faca o login la mesmo.");
    }
    await new Promise((resolve) => ctx.on("close", resolve));
    log("perfil salvo em", CONFIG.profileDir, "- proximos comandos ja entram logados.");
  } finally {
    setupEmAndamento = false;
  }
}

export function doPlan() {
  const agenda = buildAgenda(CONFIG);
  saveAgenda(agenda, path.join(__dirname, "agenda.json"));
  log(`agenda.json gerada: ${agenda.items.length} storys, ${agenda.mediaCount} midias.`);
  const byFile = {};
  agenda.items.forEach((i) => (byFile[i.fileName] = (byFile[i.fileName] || 0) + 1));
  log("uso por arquivo:", byFile);
  console.log("\n" + agenda.items.map((i) => `  ${i.date} ${i.time}  ${i.fileName}`).join("\n") + "\n");
}

function doDaemon() {
  const [hh, mm] = (CONFIG.schedule.time || "12:00").split(":").map(Number);
  const expr = `${mm} ${hh} * * *`;
  log(`daemon ativo. Vai publicar os storys de cada dia as ${CONFIG.schedule.time} (cron: "${expr}").`);
  log("deixe esta janela aberta. Ctrl+C para parar.");
  cron.schedule(expr, async () => {
    log("disparo diario…");
    try {
      await runBatch({ all: false });
    } catch (err) {
      log("ERRO no disparo:", err.message || err);
    }
  });
}

// ---------- entrada (so quando rodado direto pela linha de comando) ----------

const runAsCli = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function argValue(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : def;
}

if (runAsCli) {
  (async () => {
    try {
      if (ARGS.has("--setup")) return await doSetup();
      if (ARGS.has("--plan")) return doPlan();
      if (ARGS.has("--daemon")) return doDaemon();
      if (ARGS.has("--run")) {
        return await runBatch({
          all: ARGS.has("--all"),
          week: ARGS.has("--schedule") && !ARGS.has("--all"),
          scheduleMode: ARGS.has("--schedule"),
          days: Number(argValue("days", 7)) || 7
        });
      }
      console.log(`Uso:
  npm run setup        login manual (uma vez)
  npm run plan          gera agenda.json a partir de ${CONFIG.mediaDir}
  npm run run           publica os storys de hoje, um a um, AGORA
  npm run run:all       publica a agenda inteira, um a um, AGORA (rajada — use com cuidado)
  npm run schedule      AGENDA (nao publica na hora) os proximos 7 dias direto no calendario do Meta
  npm run schedule:all  AGENDA a agenda inteira de uma vez direto no calendario do Meta
                         (use --days N para mudar a janela, ex.: node publish-stories.js --run --schedule --days 14)
  npm run daemon        publica sozinho todo dia no horario do config
  npm run server        sobe a API local para o botao "Publicar storys" do dashboard`);
    } catch (err) {
      console.error("\nFALHOU:", err.message || err, "\n");
      process.exit(1);
    }
  })();
}
