// Deixa cada midia num formato que o story do Meta aceita, convertendo com o
// ffmpeg quando precisa. Chamado pelo server.js logo depois de cada upload.
//
// O que o Meta aceita sem travar (visto na pratica):
//   - imagem: JPG ou PNG          (.webp, .heic, .gif... nem entram no composer)
//   - video:  H.264 ("avc1"), ate 30 s, leve
//             (mp4v fica eterno em "Processando midia"; >30 s deixa o botao
//              Programar cinza com "O video e muito longo")

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const IMAGENS_OK = new Set([".jpg", ".jpeg", ".png"]);
const VIDEOS_OK = new Set([".mp4", ".mov"]);
const MAX_SEGUNDOS = 30;
const MAX_MB = 100;

// ---------- leitura do cabecalho do MP4/MOV (codec e duracao) ----------

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function lerCaixas(fd, pos, end, out) {
  const h = Buffer.alloc(16);
  while (pos < end) {
    fs.readSync(fd, h, 0, 16, pos);
    let size = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    let hdr = 8;
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); hdr = 16; }
    if (size === 0) size = end - pos;
    if (size < 8) break;
    if (CONTAINERS.has(type)) lerCaixas(fd, pos + hdr, pos + size, out);
    else if (type === "mvhd") {
      const b = Buffer.alloc(32);
      fs.readSync(fd, b, 0, 32, pos + hdr);
      out.duracao = b[0] === 1
        ? Number(b.readBigUInt64BE(24)) / b.readUInt32BE(20)
        : b.readUInt32BE(16) / b.readUInt32BE(12);
    } else if (type === "stsd") {
      const b = Buffer.alloc(16);
      fs.readSync(fd, b, 0, 16, pos + hdr);
      const fmt = b.toString("latin1", 12, 16);
      // Fica so com a primeira trilha de VIDEO: ignora audio e as trilhas de
      // metadados/legenda que o iPhone e outros gravam junto (mebx, tmcd...).
      const naoVideo = ["mp4a", "Opus", "ac-3", "ec-3", "lpcm", "sowt", "twos", "mebx", "tmcd", "text", "tx3g", "wvtt", "c608", "rtp ", "fdsc"];
      if (!out.codec && !naoVideo.includes(fmt)) out.codec = fmt;
    }
    pos += size;
  }
}

export function inspecionarVideo(arquivo) {
  const out = {};
  const fd = fs.openSync(arquivo, "r");
  try {
    lerCaixas(fd, 0, fs.fstatSync(fd).size, out);
  } catch {
    // arquivo fora do padrao MP4/MOV: trata como "precisa converter"
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

// ---------- decisao ----------

// Retorna null se o arquivo ja serve, ou o motivo pra converter.
function motivoParaConverter(arquivo) {
  const ext = path.extname(arquivo).toLowerCase();
  const mb = fs.statSync(arquivo).size / 1024 / 1024;

  if (IMAGENS_OK.has(ext)) return null;
  if (!VIDEOS_OK.has(ext)) {
    return ehVideoPelaExtensao(ext)
      ? `vídeo ${ext} (o Meta só aceita .mp4/.mov)`
      : `imagem ${ext} em vez de JPG/PNG`;
  }

  const { codec, duracao } = inspecionarVideo(arquivo);
  const motivos = [];
  if (codec !== "avc1") motivos.push(descreverCodificador(codec));
  if (duracao && duracao > MAX_SEGUNDOS) motivos.push(`${Math.round(duracao)} s, máximo ${MAX_SEGUNDOS} s (cortado)`);
  if (mb > MAX_MB) motivos.push(`${Math.round(mb)} MB, pesado demais`);
  return motivos.length ? motivos.join("; ") : null;
}

// Texto legivel do codificador de video pra observacao no dashboard.
const NOMES_CODIFICADOR = {
  hvc1: "H.265/HEVC",
  hev1: "H.265/HEVC",
  mp4v: "MPEG-4 Parte 2 (mp4v)",
  av01: "AV1",
  vp09: "VP9",
  apcn: "Apple ProRes",
  apch: "Apple ProRes",
  apcs: "Apple ProRes",
  apco: "Apple ProRes",
  ap4h: "Apple ProRes"
};
export function descreverCodificador(codec) {
  if (!codec) return "codificador desconhecido em vez de H.264";
  return `codificador ${NOMES_CODIFICADOR[codec] || codec} em vez de H.264`;
}

const EXT_VIDEO = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".3gp", ".flv", ".mpg", ".mpeg", ".ts"]);
const ehVideoPelaExtensao = (ext) => EXT_VIDEO.has(ext);

// ---------- conversao ----------

function rodarFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split("\n").pop()));
      else resolve();
    });
  });
}

// Converte (se precisar) e devolve { arquivo, convertido, motivo }.
// O original e apagado quando a conversao da certo; o novo arquivo fica na
// mesma pasta com o mesmo nome base (.jpg pra imagem, .mp4 pra video).
export async function prepararParaMeta(arquivo, ffmpeg) {
  const motivo = motivoParaConverter(arquivo);
  if (!motivo) return { arquivo, convertido: false };

  const ext = path.extname(arquivo).toLowerCase();
  const base = arquivo.slice(0, -ext.length || undefined);
  const video = ehVideoPelaExtensao(ext);
  const destinoFinal = base + (video ? ".mp4" : ".jpg");
  const temp = base + ".convertendo" + (video ? ".mp4" : ".jpg");

  const args = video
    ? [
        "-i", arquivo, "-t", "29.5",
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30",
        "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-maxrate", "3500k", "-bufsize", "7000k",
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100",
        "-movflags", "+faststart", temp
      ]
    : ["-i", arquivo, "-frames:v", "1", "-q:v", "2", temp];

  try {
    await rodarFfmpeg(ffmpeg, args);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw new Error(`nao consegui converter ${path.basename(arquivo)} (${motivo}): ${err.message}`);
  }
  // Mesmo nome (ex.: .mp4 -> .mp4): o rename substitui o original direto.
  if (path.resolve(arquivo) !== path.resolve(destinoFinal)) fs.rmSync(arquivo, { force: true });
  fs.renameSync(temp, destinoFinal);
  return { arquivo: destinoFinal, convertido: true, motivo };
}
