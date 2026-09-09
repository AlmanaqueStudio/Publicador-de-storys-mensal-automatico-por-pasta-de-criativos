// Planejador da agenda de storys.
// Mesmo criterio do dashboard: embaralha as midias num "baralho", distribui
// uma por slot e, ao reembaralhar, evita repetir a ultima da sequencia ->
// aleatorio e sem repetir muito o mesmo video.

import fs from "node:fs";
import path from "node:path";

export function listMedia(dir, exts) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(abs, f));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Sorteia N indices sem repetir muito.
export function drawSequence(count, howMany) {
  const seq = [];
  let deck = [];
  let last = -1;
  for (let n = 0; n < howMany; n++) {
    if (deck.length === 0) {
      deck = shuffle([...Array(count).keys()]);
      if (count > 1 && deck[0] === last) deck.push(deck.shift());
    }
    const idx = deck.shift();
    last = idx;
    seq.push(idx);
  }
  return seq;
}

function resolveDate(token, fallbackEndOfMonth) {
  if (token === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (token === "endOfMonth") {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }
  const d = new Date(token + "T00:00:00");
  if (isNaN(d)) {
    return fallbackEndOfMonth
      ? new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
      : (() => { const x = new Date(); x.setHours(0,0,0,0); return x; })();
  }
  return d;
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

// Gera a agenda completa a partir do config + midias da pasta.
export function buildAgenda(config) {
  const media = listMedia(config.mediaDir, config.mediaExtensions);
  if (media.length === 0) {
    throw new Error(`Nenhuma midia em ${path.resolve(config.mediaDir)} (extensoes: ${config.mediaExtensions.join(", ")})`);
  }

  const start = resolveDate(config.schedule.startDate, false);
  const end = resolveDate(config.schedule.endDate, true);
  if (end < start) throw new Error("endDate anterior a startDate no config.json");

  const perDay = Math.max(1, Math.min(20, config.schedule.perDay || 1));
  const time = config.schedule.time || "12:00";

  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }

  const seq = drawSequence(media.length, days.length * perDay);

  const items = [];
  let k = 0;
  for (const day of days) {
    for (let p = 0; p < perDay; p++) {
      const idx = seq[k++];
      items.push({
        date: isoDay(day),
        time,
        file: media[idx],
        fileName: path.basename(media[idx]),
        status: "pendente"
      });
    }
  }

  return {
    createdAt: new Date().toISOString(),
    mediaCount: media.length,
    targets: config.targets,
    items
  };
}

export function loadAgenda(file = "./agenda.json") {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

export function saveAgenda(agenda, file = "./agenda.json") {
  fs.writeFileSync(path.resolve(file), JSON.stringify(agenda, null, 2));
}
