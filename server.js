/**
 * TrueCosmic Ken Burns Render Server
 *
 * Single endpoint: POST /ken-burns
 * Body: { image_url, duration (s, default 10), output_filename, effect }
 * Effects: zoom-in | zoom-out | pan-left | pan-right | diagonal | zoom-drift
 *
 * Downloads the image, applies an FFmpeg zoompan filter, outputs 1920x1080 @ 25fps,
 * uploads to the Supabase `generated-clips` bucket and returns { clip_url }.
 *
 * Upload endpoints prefer caller-provided signed upload URLs so Railway does
 * not need Supabase credentials. Legacy direct uploads still work when env
 * vars are present.
 * Requires `ffmpeg` binary in the container or the bundled `ffmpeg-static` binary.
 */

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
let ffmpegStatic = null;
try {
  ffmpegStatic = require("ffmpeg-static");
} catch {
  ffmpegStatic = null;
}

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RENDER_SERVER_VERSION = "2026-07-15-portrait-shorts-duration-lock-v31";
const FFMPEG_BIN = resolveFfmpegBinary();
const FFPROBE_BIN = resolveFfprobeBinary();
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const CAPTIONS_HIGHLIGHT_BGR = process.env.CAPTIONS_HIGHLIGHT_BGR || "FF4FB4"; // #B44FFF (BBGGRR) — brand bright purple
const CAPTIONS_FONT_FILE = process.env.CAPTIONS_FONT_FILE || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const CAPTIONS_FONT_NAME = process.env.CAPTIONS_FONT_NAME || "DejaVu Sans";
const EMOJI_FONT_FILE = process.env.EMOJI_FONT_FILE || "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf";

function resolveFfmpegBinary() {
  const candidates = [
    process.env.FFMPEG_PATH,
    ffmpegStatic,
    "/usr/bin/ffmpeg",
    "/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }

  // Last resort for environments that install ffmpeg on PATH.
  return "ffmpeg";
}

function resolveFfprobeBinary() {
  const sibling = path.isAbsolute(FFMPEG_BIN) ? path.join(path.dirname(FFMPEG_BIN), "ffprobe") : null;
  const candidates = [
    process.env.FFPROBE_PATH,
    sibling,
    "/usr/bin/ffprobe",
    "/bin/ffprobe",
    "/usr/local/bin/ffprobe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }

  return "ffprobe";
}

// ==========================================================================
// Motion library — varied per-image Ken Burns motion.
// Rotated by scene index so no two adjacent stills share the same motion.
// Applies to both portrait (1080x1920) and landscape (1920x1080) renders.
// ==========================================================================
const MOTION_LIBRARY = [
  { name: "zoom-in",         filter: (d, s) => `zoompan=z='min(zoom+0.0015,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "zoom-out",        filter: (d, s) => `zoompan=z='if(lte(zoom,1.0),1.15,max(1.0,zoom-0.0015))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "pan-left",        filter: (d, s) => `zoompan=z=1.08:x='iw/zoom/2+((iw-iw/zoom)*on/${Math.round(d*25)})':y='ih/2-(ih/zoom/2)':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "pan-right",       filter: (d, s) => `zoompan=z=1.08:x='(iw-iw/zoom)*on/${Math.round(d*25)}':y='ih/2-(ih/zoom/2)':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "pan-up",          filter: (d, s) => `zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='ih/zoom/2+((ih-ih/zoom)*on/${Math.round(d*25)})':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "pan-down",        filter: (d, s) => `zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${Math.round(d*25)}':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "zoom-in-top",     filter: (d, s) => `zoompan=z='min(zoom+0.0015,1.15)':x='iw/2-(iw/zoom/2)':y=0:d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "zoom-in-bottom",  filter: (d, s) => `zoompan=z='min(zoom+0.0015,1.15)':x='iw/2-(iw/zoom/2)':y='ih-ih/zoom':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "diagonal-drift",  filter: (d, s) => `zoompan=z=1.08:x='(iw-iw/zoom)*on/${Math.round(d*25)}':y='(ih-ih/zoom)*on/${Math.round(d*25)}':d=${Math.round(d*25)}:s=${s}:fps=25` },
  { name: "breathe",         filter: (d, s) => `zoompan=z='1.0+0.008*sin(2*3.14159*on/${Math.round(d*25)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(d*25)}:s=${s}:fps=25` },
];
// Non-consecutive rotation order — no two adjacent scenes share a motion.
const MOTION_ROTATION = [0, 2, 1, 4, 3, 8, 5, 6, 9, 7, 0, 4, 2, 5, 1, 3, 8, 6, 9, 7];

function getMotionFilter(sceneIndex, durationSec, orientation) {
  const dims = orientation === "portrait" ? "1080x1920" : "1920x1080";
  const d = Math.max(1, Math.round(Number(durationSec) || 5));
  const idx = MOTION_ROTATION[Math.abs(Number(sceneIndex) || 0) % MOTION_ROTATION.length];
  return MOTION_LIBRARY[idx].filter(d, dims);
}

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing; direct storage uploads are disabled. Signed upload URL flows will still work.");
}

function assertStorageConfigured() {
  if (!supabase) {
    throw new Error("Storage upload is not configured on this render server. Pass upload_url/public_url for signed upload, or configure legacy storage env vars.");
  }
}

// Robust download: retries with backoff and a per-attempt timeout so
// transient 504s / slow Supabase Storage responses don't kill the render.
async function downloadWithRetry(url, { attempts = 4, timeoutMs = 45000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      lastErr = new Error(`Image download failed (${r.status})`);
      // Retry on 5xx and 408/429
      if (![408, 429, 500, 502, 503, 504].includes(r.status)) throw lastErr;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, i)));
  }
  throw lastErr || new Error("Image download failed");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({ ok: true, service: "truecosmic-ken-burns", version: RENDER_SERVER_VERSION, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN, storage_uploads: Boolean(supabase) }));
app.get("/health", async (_req, res) => {
  try {
    const version = await ffmpegVersion();
    res.json({ ok: true, service: "truecosmic-ken-burns", server_version: RENDER_SERVER_VERSION, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN, ffmpeg_version: version, storage_uploads: Boolean(supabase) });
  } catch (e) {
    res.status(503).json({ ok: false, service: "truecosmic-ken-burns", server_version: RENDER_SERVER_VERSION, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN, storage_uploads: Boolean(supabase), error: e.message });
  }
});

// ==========================================================================
// Async job registry for long-running /stitch-final renders.
// Allows the client/edge-function to fire-and-poll instead of holding a
// connection open for many minutes (which Railway's proxy will reset).
// ==========================================================================
const jobs = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function createJob() {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    id,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Job queued",
    clip_count: 0,
    clips_downloaded: 0,
    video_url: null,
    error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updated_at: Date.now() });
}

// Periodic cleanup so jobs don't pile up in memory forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.updated_at > JOB_TTL_MS) jobs.delete(id);
  }
}, 30 * 60 * 1000).unref?.();

app.get("/status/:job_id", (req, res) => {
  const job = jobs.get(req.params.job_id);
  if (!job) return res.status(404).json({ error: "job not found", job_id: req.params.job_id });
  res.json(job);
});

function ffmpegVersion() {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => reject(new Error(`Failed to start ffmpeg at ${FFMPEG_BIN}: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.split("\n")[0]);
      else reject(new Error(`ffmpeg -version exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * FFmpeg zoompan filters per effect.
 * d=125 = 5 seconds at 25fps. We override `d` based on requested duration.
 */
function buildZoompan(effect, durationSec, orientation = "landscape") {
  const dims = orientation === "portrait" ? "1080x1920" : "1920x1080";
  const motion = MOTION_LIBRARY.find((item) => item.name === effect);
  if (motion) return motion.filter(Math.max(1, Number(durationSec) || 5), dims);

  const d = Math.max(1, Math.round(durationSec * 25));
  switch (effect) {
    case "zoom-in":
      // Slower, gentler push-in. Caps at 1.15x so framing stays close to the original.
      return `zoompan=z='min(zoom+0.0006,1.15)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${dims}:fps=25`;
    case "zoom-out":
      // Start slightly zoomed-in (1.15x) and ease back to 1.0x for a calm reveal.
      return `zoompan=z='if(lte(zoom,1.0),1.15,max(1.0,zoom-0.0006))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${dims}:fps=25`;
    case "pan-left":
      // Gentle horizontal pan at a lighter 1.1x crop.
      return `zoompan=z='1.1':d=${d}:x='iw/3+(iw/6*(on/${d}))':y='ih/2-(ih/zoom/2)':s=${dims}:fps=25`;
    case "pan-right":
      return `zoompan=z='1.1':d=${d}:x='iw-(iw/3+(iw/6*(on/${d})))':y='ih/2-(ih/zoom/2)':s=${dims}:fps=25`;
    case "diagonal":
      return `zoompan=z='min(zoom+0.0005,1.12)':d=${d}:x='iw/8*(on/${d})':y='ih/8*(on/${d})':s=${dims}:fps=25`;
    case "zoom-drift":
      return `zoompan=z='min(zoom+0.0008,1.18)':d=${d}:x='iw/2-(iw/zoom/2)+(10*(on/${d}))':y='ih/2-(ih/zoom/2)':s=${dims}:fps=25`;
    case "auto":
      return getMotionFilter(0, durationSec, orientation);
    default:
      throw new Error(`Unknown effect: ${effect}`);
  }
}

function runFfmpeg(args, { timeoutMs = Number(process.env.FFMPEG_TIMEOUT_MS || 10 * 60 * 1000) } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s: ${stderr.slice(-1000)}`));
    }, timeoutMs);
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start ffmpeg at ${FFMPEG_BIN}: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const n = Number(stdout.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

async function extractFramePng(videoPath, framePath, atSec) {
  await runFfmpeg([
    "-y",
    "-ss", String(Math.max(0, atSec)),
    "-i", videoPath,
    "-frames:v", "1",
    "-f", "image2",
    framePath,
  ], { timeoutMs: 2 * 60 * 1000 });
}

function findCaptionProbeTimes(words) {
  const times = [];
  for (const word of words || []) {
    if (typeof word.start !== "number" || typeof word.end !== "number") continue;
    const mid = ((word.start + word.end) / 2) / 1000;
    if (Number.isFinite(mid) && mid >= 0) times.push(mid);
    if (times.length >= 8) break;
  }
  return times.length ? times : [1, 3, 5, 8, 12];
}

async function assertCaptionBurnVisible(originalPath, captionedPath, words, tmpDir) {
  const probeTimes = findCaptionProbeTimes(words);
  let largestDelta = 0;
  for (let i = 0; i < probeTimes.length; i++) {
    const t = probeTimes[i];
    const before = path.join(tmpDir, `caption-probe-before-${i}.png`);
    const after = path.join(tmpDir, `caption-probe-after-${i}.png`);
    await extractFramePng(originalPath, before, t);
    await extractFramePng(captionedPath, after, t);
    const beforeSize = fs.statSync(before).size;
    const afterSize = fs.statSync(after).size;
    const delta = Math.abs(afterSize - beforeSize);
    largestDelta = Math.max(largestDelta, delta);
    if (delta > 1200) return;
  }
  throw new Error(`ASS caption burn produced no visible frame changes (largest probe delta ${largestDelta} bytes)`);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeDurationList(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => {
      if (typeof value === "number" || typeof value === "string") return Number(value);
      if (value && typeof value === "object") {
        return Number(value.duration_seconds ?? value.duration ?? value.seconds ?? value.target_duration_seconds);
      }
      return NaN;
    })
    .map((n) => (Number.isFinite(n) && n > 0 ? n : null));
}

function isShortPortraitPayload(body, clipCount, targetAspect) {
  const explicitShort = body?.shorts_mode === true || body?.is_shorts === true || body?.force_short_form === true;
  const requestedTarget = Number(body?.target_duration_seconds ?? body?.target_duration ?? 0);
  return targetAspect === "9:16" && (explicitShort || requestedTarget <= 180 || clipCount >= 30);
}

function shortSceneDuration(body, fallback = 2.5) {
  const value = Number(body?.short_scene_duration ?? body?.scene_duration_seconds ?? body?.clip_duration_seconds);
  if (Number.isFinite(value) && value > 0) return Math.max(0.5, Math.min(10, value));
  return fallback;
}

function shortPortraitDurationCap(body, clipCount, fixedSceneDuration) {
  const base = Math.max(1, clipCount) * fixedSceneDuration;
  // Shorts are visual-beat timed: 2.5s per scene, with only a tiny allowance
  // for the final closing word. Never let a stale/full narration stretch the
  // whole render to 5–6 minutes.
  return base + 4.0;
}

function fitClipToCanvasFilter(W, H, isPortrait) {
  // Portrait shorts must fill the 9:16 phone frame. The old "decrease + pad"
  // route made landscape clips appear as small postcard boxes. For portrait
  // outputs we crop/fill instead; if a legacy landscape clip slips through,
  // this removes the black/postbox look rather than preserving it.
  const mode = isPortrait ? "increase" : "decrease";
  const tail = isPortrait
    ? `crop=${W}:${H}`
    : `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
  return `scale=${W}:${H}:force_original_aspect_ratio=${mode},${tail},setsar=1,fps=25,format=yuv420p`;
}

function normalizeCaptionItems(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index) => {
      if (typeof item === "string") return { text: item, scene_number: index + 1 };
      if (!item || typeof item !== "object") return null;
      const text = String(item.text || item.caption || item.scene_text || item.narration_text || item.script_text || "").trim();
      if (!text) return null;
      return { ...item, text };
    })
    .filter(Boolean);
}

function selectCaptionItemsFromBody(body) {
  const candidates = [
    ["captions", body?.captions],
    ["caption_items", body?.caption_items],
    ["captionItems", body?.captionItems],
    ["caption_rows", body?.caption_rows],
    ["captionRows", body?.captionRows],
    ["scene_captions", body?.scene_captions],
    ["sceneCaptions", body?.sceneCaptions],
    ["scenes", body?.scenes],
    ["scene_breakdowns", body?.scene_breakdowns],
    ["sceneBreakdowns", body?.sceneBreakdowns],
    ["breakdowns", body?.breakdowns],
  ];
  for (const [key, value] of candidates) {
    const items = normalizeCaptionItems(value);
    if (items.length > 0) return { key, items };
  }
  return { key: "none", items: [] };
}

function fitDurationsToTotal(durations, total) {
  const clean = durations.map((d) => (Number.isFinite(d) && d > 0 ? d : 0));
  const sum = clean.reduce((s, d) => s + d, 0);
  if (!Number.isFinite(total) || total <= 0 || sum <= 0) return clean;
  const scale = total / sum;
  return clean.map((d) => Math.max(0.04, d * scale));
}

function ffconcatLine(filePath) {
  return `file '${String(filePath).replace(/'/g, "'\\''")}'`;
}

function mediaExtFromUrl(url, fallback) {
  try {
    const clean = String(url).split("?")[0].split("#")[0];
    const match = clean.match(/\.([a-zA-Z0-9]{1,5})$/);
    return match ? match[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

async function downloadToFile(url, dest, label) {
  const buf = await downloadWithRetry(url, { attempts: 4, timeoutMs: 60000 });
  if (!buf.length) throw new Error(`${label} download returned an empty file`);
  fs.writeFileSync(dest, buf);
}

function flattenClipUrls(input) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === "object") {
      add(value.video_url || value.clip_url || value.url);
      add(value.parts || value.clip_urls || value.clips);
    }
  };
  add(input);
  return out;
}

function normalizeNarrationItems(body) {
  const items = [];
  const add = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      items.push({ url: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === "object") {
      const url = value.audio_url || value.narration_url || value.url;
      if (url) items.push({ ...value, url });
    }
  };
  add(body.narrations);
  add(body.narration_urls);
  add(body.narration_url);

  const seen = new Set();
  return items.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

app.post("/ken-burns", async (req, res) => {
  const { image_url, duration = 10, output_filename, effect, scene_index, orientation, music_url, music_volume = 0.15, return_binary = false } = req.body || {};
  if (!image_url || (!return_binary && !output_filename)) {
    return res.status(400).json({ error: "image_url and output_filename required unless return_binary=true" });
  }
  let binaryResponseInProgress = false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  const cleanUrl = image_url.split("?")[0];
  const lastSeg = cleanUrl.substring(cleanUrl.lastIndexOf("/") + 1);
  const extMatch = lastSeg.match(/\.([a-zA-Z0-9]{1,5})$/);
  const inExt = (extMatch ? extMatch[1] : "jpg").toLowerCase();
  const inPath = path.join(tmpDir, `in.${inExt}`);
  const outPath = path.join(tmpDir, `out.mp4`);
  const musicPath = path.join(tmpDir, `music.mp3`);

  try {
    const buf = await downloadWithRetry(image_url);
    fs.writeFileSync(inPath, buf);

    const dur = Math.max(1, Number(duration) || 10);
    // Prefer the varied motion library (rotated per scene_index). Only fall
    // back to the legacy fixed-effect map when the caller pins a specific
    // effect AND does not supply a scene_index for rotation.
    const useLibrary = (typeof scene_index === "number") || !effect || effect === "auto";
    const zoompan = useLibrary
      ? getMotionFilter(scene_index ?? 0, dur, orientation)
      : buildZoompan(effect, dur, orientation);

    let hasMusic = false;
    if (music_url) {
      try {
        const m = await fetch(music_url);
        if (m.ok) { fs.writeFileSync(musicPath, Buffer.from(await m.arrayBuffer())); hasMusic = true; }
      } catch (e) { console.warn("music fetch failed", e.message); }
    }

    const args = [
      "-y",
      "-loop", "1",
      "-framerate", "25",
      "-i", inPath,
    ];
    if (hasMusic) args.push("-i", musicPath);
    args.push(
      "-vf", `${zoompan},format=yuv420p`,
      "-t", String(dur),
      "-r", "25",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
    );
    if (hasMusic) {
      args.push(
        "-filter_complex", `[1:a]volume=${music_volume},aloop=loop=-1:size=2e9[a]`,
        "-map", "0:v", "-map", "[a]",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
      );
    }
    args.push(outPath);
    await runFfmpeg(args);

    if (return_binary) {
      binaryResponseInProgress = true;
      return res.sendFile(outPath, { headers: { "Content-Type": "video/mp4" } }, () => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      });
    }

    assertStorageConfigured();
    const outBuf = fs.readFileSync(outPath);
    const { error: upErr } = await supabase.storage
      .from("generated-clips")
      .upload(output_filename, outBuf, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`Storage upload: ${upErr.message}`);

    const { data: pub } = supabase.storage.from("generated-clips").getPublicUrl(output_filename);
    res.json({ ok: true, clip_url: pub.publicUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "render failed" });
  } finally {
    if (binaryResponseInProgress) return;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * POST /probe-media
 * Body: { url }
 * Returns { duration } (seconds) for the given remote media file.
 */
app.post("/probe-media", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const filePath = path.join(tmpDir, "in.mp4");
  try {
    const buf = await downloadWithRetry(url);
    fs.writeFileSync(filePath, buf);
    const duration = await ffprobeDuration(filePath);
    res.json({ ok: true, duration });
  } catch (e) {
    console.error("probe-media failed", e);
    res.status(500).json({ error: e.message || "probe failed" });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * POST /extract-clip
 * Body: { source_video_url, start_seconds, duration_seconds, output_filename, aspect_ratio="9:16", upload_url?, public_url? }
 * Cuts a sub-clip from a source video, center-crops to the requested aspect ratio
  * (default 9:16 -> 1080x1920), re-encodes, uploads via signed upload URL
  * when provided (legacy bucket upload fallback), and returns { clip_url, duration }.
 */
app.post("/extract-clip", async (req, res) => {
  const {
    source_video_url,
    start_seconds = 0,
    duration_seconds,
    output_filename,
    aspect_ratio = "9:16",
    upload_url,
    public_url,
    top_text,
    bottom_text,
    top_logo_url,
  } = req.body || {};
  if (!source_video_url || !output_filename || !duration_seconds) {
    return res.status(400).json({ error: "source_video_url, duration_seconds, output_filename required" });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
  const inPath = path.join(tmpDir, "in.mp4");
  const outPath = path.join(tmpDir, "out.mp4");
  const logoPath = path.join(tmpDir, "logo.png");
  try {
    const buf = await downloadWithRetry(source_video_url);
    fs.writeFileSync(inPath, buf);

    let hasLogo = false;
    if (top_logo_url && aspect_ratio === "9:16") {
      try {
        const lbuf = await downloadWithRetry(top_logo_url, { attempts: 2, timeoutMs: 20000 });
        if (lbuf?.length) { fs.writeFileSync(logoPath, lbuf); hasLogo = true; }
      } catch (e) {
        console.warn("top_logo_url download failed, falling back to text:", e.message);
      }
    }

    // Fit clips into the target canvas. Portrait source should fill the phone
    // frame; only true landscape source may letterbox.
    let vfChain;
    if (aspect_ratio === "9:16") {
      vfChain =
        "scale=1080:1920:force_original_aspect_ratio=decrease," +
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1";
    } else if (aspect_ratio === "1:1") {
      vfChain =
        "scale=1080:1080:force_original_aspect_ratio=decrease," +
        "pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1";
    } else {
      // 16:9
      vfChain =
        "scale=1920:1080:force_original_aspect_ratio=decrease," +
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1";
    }

    // Burn branded text into top/bottom bars for highlight reels only. The
    // normal final-video path does not use this endpoint.
    // Sanitize text for drawtext filter (FFmpeg escaping rules).
    const escapeDrawText = (s) =>
      String(s)
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\\\\\'")
        .replace(/%/g, "\\%");

    const escapeAssInlineText = (s) =>
      String(s || "")
        .replace(/\\/g, "\\\\")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/\r?\n/g, " ");

    const buildStaticAssOverlay = (overlays, { width = 1080, height = 1920 } = {}) => {
      const header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        `Style: Brand,${CAPTIONS_FONT_NAME},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,5,40,40,0,1`,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ];

      const events = overlays
        .filter((o) => o?.text)
        .map((o) => {
          const fontsize = Math.round(o.fontsize || 48);
          const x = Math.round(o.x || width / 2);
          const y = Math.round(o.y || height / 2);
          const outline = Math.round(o.outline || 3);
          const text = escapeAssInlineText(o.text);
          return `Dialogue: 1,0:00:00.00,9:59:59.99,Brand,,0,0,0,,{\\an5\\fs${fontsize}\\bord${outline}\\pos(${x},${y})}${text}`;
        });

      return `${header.concat(events).join("\n")}\n`;
    };

    // Auto-fit a line to a max pixel width by shrinking the font size and
    // truncating with an ellipsis as a last resort. DejaVu Sans Bold averages
    // roughly fontsize * 0.55 px per character.
    const fitTextToWidth = (text, startSize, minSize, maxPxWidth) => {
      const t = String(text || "").trim();
      if (!t) return { text: "", fontsize: startSize };
      for (let fs = startSize; fs >= minSize; fs -= 2) {
        const avg = fs * 0.55;
        const fits = t.length * avg <= maxPxWidth;
        if (fits) return { text: t, fontsize: fs };
      }
      // Truncate at minSize.
      const avg = minSize * 0.55;
      const maxChars = Math.max(1, Math.floor(maxPxWidth / avg) - 1);
      return { text: t.slice(0, maxChars - 1).trimEnd() + "…", fontsize: minSize };
    };
    const fontFile = CAPTIONS_FONT_FILE;
    const drawtextParts = [];
    const assOverlayParts = [];
    if (aspect_ratio === "9:16") {
      const TOP_BAR_H = 656;       // (1920 - 608) / 2, rounded
      const BOTTOM_BAR_Y = 1264;   // 1920 - 656
      const BOTTOM_BAR_H = 656;
      const SAFE_W = 1080 - 2 * 40; // 40px padding each side → 1000px usable

      // Top bar: always burn the per-clip hook. When a logo is present it sits
      // higher in the bar and the hook renders underneath it.
      if (top_text && String(top_text).trim()) {
        const { text, fontsize } = fitTextToWidth(top_text, 64, 36, SAFE_W);
        const yPos = hasLogo
          ? 80 + 180 + 40 // logo top (80) + logo height (180) + gap (40)
          : Math.round(TOP_BAR_H / 2 - fontsize / 2);
        assOverlayParts.push({ text, fontsize, x: 540, y: yPos + Math.round(fontsize / 2), outline: 3 });
      }
      if (bottom_text && String(bottom_text).trim()) {
        const { text, fontsize } = fitTextToWidth(bottom_text, 52, 32, SAFE_W);
        assOverlayParts.push({
          text,
          fontsize,
          x: 540,
          y: BOTTOM_BAR_Y + Math.round(BOTTOM_BAR_H / 2),
          outline: 3,
        });
      }
    }
    if (drawtextParts.length) {
      vfChain = `${vfChain},${drawtextParts.join(",")}`;
    }
    if (assOverlayParts.length) {
      const assOverlayPath = path.join(tmpDir, "brand-overlay.ass");
      fs.writeFileSync(assOverlayPath, buildStaticAssOverlay(assOverlayParts), "utf8");
      const escapedAssOverlayPath = assOverlayPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");
      vfChain = `${vfChain},ass='${escapedAssOverlayPath}'`;
    }

    const start = Math.max(0, Number(start_seconds) || 0);
    const dur = Math.max(1, Number(duration_seconds) || 30);

    // Keep -t with the source video input. When a logo overlay is added as a
    // second input, placing -t after the first -i makes FFmpeg apply it to the
    // logo input instead, so the exported "clip" becomes the full remaining
    // 5–6 minute video.
    const args = ["-y", "-ss", String(start), "-t", String(dur), "-i", inPath];
    if (hasLogo) {
      // Logo sits in the upper portion of the 656px top bar so the hook text
      // (drawn via vfChain above) has room to render directly underneath it.
      const LOGO_H = 180;
      const LOGO_Y = 80;
      args.push("-i", logoPath);
      const filterComplex =
        `[0:v]${vfChain}[bg];` +
        `[1:v]scale=-1:${LOGO_H}:flags=lanczos[lg];` +
        `[bg][lg]overlay=(W-w)/2:${LOGO_Y}:format=auto,format=yuv420p[outv]`;
      args.push(
        "-filter_complex", filterComplex,
        "-map", "[outv]",
        "-map", "0:a?",
      );
    } else {
      args.push("-vf", `${vfChain},format=yuv420p`);
    }
    args.push(
      "-t", String(dur),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    );
    await runFfmpeg(args);

    const actualDuration = await ffprobeDuration(outPath).catch(() => dur);

    const outBuf = fs.readFileSync(outPath);
    let clipUrl = public_url || null;
    if (upload_url) {
      const putRes = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
        body: outBuf,
      });
      if (!putRes.ok) {
        const txt = await putRes.text().catch(() => "");
        throw new Error(`Signed upload failed (${putRes.status}): ${txt.slice(0, 200)}`);
      }
    } else {
      assertStorageConfigured();
      const { error: upErr } = await supabase.storage
        .from("generated-clips")
        .upload(output_filename, outBuf, { contentType: "video/mp4", upsert: true });
      if (upErr) throw new Error(`Storage upload: ${upErr.message}`);
      const { data: pub } = supabase.storage.from("generated-clips").getPublicUrl(output_filename);
      clipUrl = pub.publicUrl;
    }
    res.json({ ok: true, clip_url: clipUrl, duration: actualDuration });
  } catch (e) {
    console.error("extract-clip failed", e);
    res.status(500).json({ error: e.message || "extract failed" });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * POST /mix-audio
 * Body: { video_url, narration_url, music_url, music_volume=0.15, output_filename }
 * Mixes the narration (primary) and music (background) into the final video and
 * uploads the result to the `final-videos` bucket.
 */
app.post("/mix-audio", async (req, res) => {
  const { video_url, narration_url, music_url, music_volume = 0.15, output_filename, sound_effects = [], return_binary = false } = req.body || {};
  if (!video_url || (!return_binary && !output_filename)) {
    return res.status(400).json({ error: "video_url and output_filename required unless return_binary=true" });
  }
  let binaryResponseInProgress = false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mix-"));
  const videoPath = path.join(tmpDir, "video.mp4");
  const narrPath = path.join(tmpDir, "narr.mp3");
  const musicPath = path.join(tmpDir, "music.mp3");
  const outPath = path.join(tmpDir, "out.mp4");

  try {
    const dl = async (url, dest) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Download ${url} -> ${r.status}`);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    };
    await dl(video_url, videoPath);
    let hasNarr = false, hasMusic = false;
    if (narration_url) { try { await dl(narration_url, narrPath); hasNarr = true; } catch (e) { console.warn("narr fetch", e.message); } }
    if (music_url) { try { await dl(music_url, musicPath); hasMusic = true; } catch (e) { console.warn("music fetch", e.message); } }

    // Download sound effects (optional)
    const sfxList = [];
    if (Array.isArray(sound_effects)) {
      for (let i = 0; i < sound_effects.length; i++) {
        const sfx = sound_effects[i] || {};
        if (!sfx.url && !sfx.sound_effect_url) continue;
        const url = sfx.url || sfx.sound_effect_url;
        const ts = Math.max(0, Number(sfx.timestamp_seconds) || 0);
        const vol = Math.max(0, Math.min(1, Number(sfx.volume) ?? 0.3));
        const dest = path.join(tmpDir, `sfx-${i}.mp3`);
        try {
          await dl(url, dest);
          sfxList.push({ path: dest, ts, vol });
        } catch (e) { console.warn("sfx fetch", url, e.message); }
      }
    }

    const args = ["-y", "-i", videoPath];
    if (hasNarr) args.push("-i", narrPath);
    if (hasMusic) args.push("-i", musicPath);
    for (const s of sfxList) args.push("-i", s.path);

    // Build audio mix graph dynamically.
    // Input indices: 0=video, then narration (if any), then music (if any), then sfx in order.
    let inputIdx = 1;
    const mixLabels = [];
    const filterParts = [];
    if (hasNarr) {
      filterParts.push(`[${inputIdx}:a]volume=1.0[narr]`);
      mixLabels.push("[narr]");
      inputIdx++;
    }
    if (hasMusic) {
      filterParts.push(`[${inputIdx}:a]volume=${music_volume},aloop=loop=-1:size=2e9[bg]`);
      mixLabels.push("[bg]");
      inputIdx++;
    }
    sfxList.forEach((s, i) => {
      const delayMs = Math.round(s.ts * 1000);
      filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${s.vol}[sfx${i}]`);
      mixLabels.push(`[sfx${i}]`);
      inputIdx++;
    });
    let filter = "";
    let mapAudio = null;
    if (mixLabels.length > 1) {
      filter = filterParts.join(";") + `;${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2:normalize=0[aout]`;
      mapAudio = "[aout]";
    } else if (mixLabels.length === 1) {
      // Rename the sole label to [aout]
      const sole = mixLabels[0];
      filter = filterParts.join(";").replace(sole, "[aout]");
      mapAudio = "[aout]";
    }

    args.push("-map", "0:v");
    if (mapAudio) {
      args.push("-filter_complex", filter, "-map", mapAudio);
    }
    args.push("-c:v", "copy");
    if (mapAudio) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    args.push("-movflags", "+faststart", outPath);
    await runFfmpeg(args);

    if (return_binary) {
      binaryResponseInProgress = true;
      return res.sendFile(outPath, { headers: { "Content-Type": "video/mp4" } }, () => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      });
    }

    assertStorageConfigured();
    const outBuf = fs.readFileSync(outPath);
    const { error: upErr } = await supabase.storage
      .from("final-videos")
      .upload(output_filename, outBuf, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`Storage upload: ${upErr.message}`);
    const { data: pub } = supabase.storage.from("final-videos").getPublicUrl(output_filename);
    res.json({ ok: true, video_url: pub.publicUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "mix failed" });
  } finally {
    if (binaryResponseInProgress) return;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

/**
 * POST /stitch-final
 * Body: {
 *   clip_urls: string[] | nested clips,  // ordered MP4 URLs; nested part arrays are flattened
 *   narrations?: string[] | { audio_url/url }[],
 *   sound_effects?: { audio_url/url/sound_effect_url, timestamp_seconds, volume }[],
 *   music_url?: string,                  // background soundtrack
 *   music_volume?: number,               // default 0.15
 *   clip_durations?: number[],            // optional per-clip target seconds
 *   clip_duration_weights?: number[],     // optional per-clip weights, scaled to narration length
 *   output_filename: string,             // path inside the `final-videos` bucket
 *   target_aspect?: "16:9"|"9:16"       // default 16:9
 * }
 * Concatenates every clip/part in order, then mixes narration (front), sound
 * effects (medium), and soundtrack (low) into the final MP4.
 */
/* ===========================================================
 * AssemblyAI karaoke caption helpers
 * =========================================================== */
function formatAssTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(t) {
  return String(t).replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, " ");
}

/**
 * Group AssemblyAI words into chunks of <= maxWords (≈ max 2 lines on screen).
 */
function chunkWords(words, maxWords = 7) {
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords));
  return chunks;
}

function chunkWordsByTime(words, { maxWords = 6, maxDurationSec = 2.8, maxChars = Infinity } = {}) {
  const chunks = [];
  let current = [];
  for (const word of words) {
    if (!word || typeof word.start !== "number" || typeof word.end !== "number") continue;
    const proposed = current.concat(word);
    const duration = (proposed[proposed.length - 1].end - proposed[0].start) / 1000;
    const charCount = proposed.map((w) => String(w.text || "")).join(" ").length;
    if (
      current.length > 0 &&
      (proposed.length > maxWords || duration > maxDurationSec || charCount > maxChars)
    ) {
      chunks.push(current);
      current = [word];
    } else {
      current = proposed;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function wordsFromTextTimed(text, startSec, endSec) {
  const tokens = String(text || "").match(/\S+/g) || [];
  const durationMs = Math.max(500, (endSec - startSec) * 1000);
  const slotMs = durationMs / Math.max(1, tokens.length);
  return tokens.map((token, index) => ({
    text: token,
    start: Math.round(startSec * 1000 + index * slotMs),
    end: Math.round(startSec * 1000 + (index + 1) * slotMs),
  }));
}

function buildCaptionWordsFromSceneText(captions, durations) {
  const out = [];
  let cursor = 0;
  for (let i = 0; i < durations.length; i++) {
    const caption = captions[i];
    const duration = Math.max(0.5, Number(durations[i]) || 0.5);
    if (caption?.text) out.push(...wordsFromTextTimed(caption.text, cursor, cursor + duration));
    cursor += duration;
  }
  return out;
}

/**
 * Build an ASS subtitle file with karaoke-style word-by-word highlighting.
 * Highlighted word = bright purple (#B44FFF), rest = white. Large bold centered.
 */
function buildKaraokeAss(words, { width, height, highlightBgr = CAPTIONS_HIGHLIGHT_BGR }) {
  // Portrait vs landscape captions have very different constraints.
  // Portrait 9:16 mobile videos need bigger type, tighter line-wrap, and a
  // higher bottom margin so captions clear the phone nav bar.
  const isPortrait = height > width;
  // Shorts request: bigger type + higher position so captions clear the
  // phone UI and are readable at arm's length.
  // Shorts: 76px type, ~25% from bottom (1920 * 0.25 = 480) so captions sit
  // mid-lower third and clear phone chrome comfortably.
  const fontSize = isPortrait ? 76 : Math.round(height * 0.07);
  const marginV = isPortrait ? 480 : Math.round(height * 0.12);
  // Outline + shadow scale with resolution so the dark stroke stays readable
  // over any background.
  const outline = isPortrait ? 4 : Math.max(3, Math.round(height * 0.004));
  const shadow = isPortrait ? 2 : Math.max(2, Math.round(height * 0.002));
  // Use DejaVu Sans — it's installed in the container via `fonts-dejavu-core`
  // and libass/fontconfig will resolve it reliably. "Arial Black" is NOT
  // present on Debian, which caused libass to silently fall back to an
  // empty glyph set on some builds (the symptom: ASS burn appeared to
  // succeed but no captions were visible).
  const fontName = process.env.CAPTIONS_FONT_NAME || "DejaVu Sans";
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // PrimaryColour = white, OutlineColour = black, BackColour = translucent black shadow.
    // BorderStyle=1 (outline + drop shadow), Alignment=2 (bottom-centre).
    `Style: Karaoke,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${outline},${shadow},2,80,80,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = [];
  // Portrait: aggressive wrap — cap at ~20 characters per chunk so no line
  // exceeds screen width. Landscape: existing 5-word / 2.5s chunks.
  const chunks = isPortrait
    ? chunkWordsByTime(words, { maxWords: 4, maxDurationSec: 2.0, maxChars: 20 })
    : chunkWordsByTime(words, { maxWords: 5, maxDurationSec: 2.5 });
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const chunkEnd = chunk[chunk.length - 1].end / 1000;
    for (let i = 0; i < chunk.length; i++) {
      const w = chunk[i];
      const wStart = w.start / 1000;
      const wEnd = i + 1 < chunk.length ? chunk[i + 1].start / 1000 : chunkEnd;
      if (!(wEnd > wStart)) continue;
      const text = chunk
        .map((cw, j) => {
          const t = escapeAssText(cw.text);
          if (j === i) {
            // Active word: brand bright purple (#B44FFF) + slightly larger.
            return `{\\c&H${highlightBgr}&\\fscx110\\fscy110}${t}{\\r}`;
          }
          return t;
        })
        .join(" ");
      events.push(
        `Dialogue: 0,${formatAssTime(wStart)},${formatAssTime(wEnd)},Karaoke,,0,0,0,,${text}`
      );
    }
  }

  return header.concat(events).join("\n") + "\n";
}

/**
 * Upload audio to AssemblyAI and request a transcript with word timestamps.
 * Returns the words array (each: { text, start, end }) or [] on failure.
 */
async function transcribeWithAssemblyAi(audioPath) {
  if (!ASSEMBLYAI_API_KEY) {
    console.warn("ASSEMBLYAI_API_KEY not set; skipping captions.");
    return [];
  }
  try {
    const audioBuf = fs.readFileSync(audioPath);
    const upRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/octet-stream" },
      body: audioBuf,
    });
    if (!upRes.ok) throw new Error(`AssemblyAI upload ${upRes.status}: ${(await upRes.text()).slice(0, 200)}`);
    const upJson = await upRes.json();
    const audio_url = upJson.upload_url;

    const trRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        audio_url,
        punctuate: true,
        format_text: true,
        speech_models: ["universal-2"],
      }),
    });
    if (!trRes.ok) throw new Error(`AssemblyAI submit ${trRes.status}: ${(await trRes.text()).slice(0, 200)}`);
    const trJson = await trRes.json();
    const transcriptId = trJson.id;

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: ASSEMBLYAI_API_KEY },
      });
      if (!pollRes.ok) continue;
      const pollJson = await pollRes.json();
      if (pollJson.status === "completed") {
        return Array.isArray(pollJson.words) ? pollJson.words : [];
      }
      if (pollJson.status === "error") {
        throw new Error(`AssemblyAI transcript error: ${pollJson.error}`);
      }
    }
    throw new Error("AssemblyAI transcript timed out");
  } catch (e) {
    console.warn("AssemblyAI captioning failed:", e.message);
    return [];
  }
}

/**
 * Burn karaoke ASS captions into a video file. Replaces destPath atomically.
 * Returns true on success, false on failure (caller keeps original file).
 */
async function burnCaptionsIntoVideo(srcPath, destPath, assPath, words = [], tmpDir = path.dirname(destPath)) {
  // Use the `ass=` filter (purpose-built for .ass files) rather than the
  // generic `subtitles=` filter — it avoids format auto-detection edge cases
  // that caused silent no-op burns on some libass builds.
  const escaped = assPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,");
  const args = [
    "-y",
    "-i", srcPath,
    "-vf", `ass=${escaped}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    destPath,
  ];
  await runFfmpeg(args);
  // Sanity-check: ffmpeg can exit 0 even if libass produced no glyphs. A
  // valid encode should be at least as large as the source, give or take.
  try {
    const srcSize = fs.statSync(srcPath).size;
    const dstSize = fs.statSync(destPath).size;
    if (dstSize < srcSize * 0.5) {
      throw new Error(`ASS burn output suspiciously small (${dstSize} vs src ${srcSize})`);
    }
  } catch (e) {
    if (/suspiciously small/.test(e.message)) throw e;
  }
  await assertCaptionBurnVisible(srcPath, destPath, words, tmpDir);
  return true;
}

function escapeDrawtextText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%")
    .replace(/[\r\n]+/g, " ");
}

function buildDrawtextCaptionFilter(words, { width, height }) {
  const fontSize = Math.round(height * 0.07);
  const borderW = Math.max(5, Math.round(height * 0.006));
  const y = Math.round(height * 0.72);
  return chunkWordsByTime(words, { maxWords: 6, maxDurationSec: 2.8 })
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const start = Math.max(0, chunk[0].start / 1000);
      const end = Math.max(start + 0.45, chunk[chunk.length - 1].end / 1000);
      const text = escapeDrawtextText(chunk.map((w) => w.text).join(" "));
      const fontFile = fs.existsSync(CAPTIONS_FONT_FILE) ? `fontfile='${CAPTIONS_FONT_FILE.replace(/'/g, "\\'")}'` : "font='Sans'";
      return `drawtext=${fontFile}:text='${text}':fontsize=${fontSize}:fontcolor=white:bordercolor=black:borderw=${borderW}:box=1:boxcolor=black@0.62:boxborderw=${Math.round(borderW * 3)}:x=max(${Math.round(width * 0.04)}\\,(w-text_w)/2):y=${y}:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`;
    })
    .join(",");
}

async function burnCaptionsIntoVideoWithDrawtext(srcPath, destPath, filterPath, words, dims) {
  const filter = buildDrawtextCaptionFilter(words, dims);
  if (!filter) throw new Error("No drawtext caption filter could be generated");
  fs.writeFileSync(filterPath, filter, "utf8");
  await runFfmpeg([
    "-y",
    "-i", srcPath,
    "-filter_script:v", filterPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    destPath,
  ]);
  return true;
}

app.post("/stitch-final", async (req, res) => {
  const body = req.body || {};
  const { output_filename, target_aspect = "16:9", return_binary = false, async: asyncMode = false } = body;
  const clipUrls = flattenClipUrls(body.clip_urls || body.clips);
  if (clipUrls.length === 0 || (!return_binary && !output_filename)) {
    return res.status(400).json({ error: "clip_urls (non-empty array) and output_filename required unless return_binary=true" });
  }

  // ===== Async mode: respond immediately with job_id and run in background =====
  if (asyncMode) {
    if (return_binary) {
      return res.status(400).json({ error: "async=true requires return_binary=false (server uploads to storage and exposes video_url via /status/:job_id)" });
    }
    // Async mode needs SOMEWHERE to put the result. Either a signed upload URL
    // from the caller (preferred — no creds on the render server) or a
    // service-role Supabase client configured via env vars (legacy fallback).
    if (!body.upload_url && !supabase) {
      return res.status(400).json({ error: "async mode requires either upload_url (signed upload URL) in the body or SUPABASE_URL+SUPABASE_SERVICE_ROLE_KEY env vars on the render server" });
    }
    const job = createJob();
    updateJob(job.id, { clip_count: clipUrls.length, message: `Queued ${clipUrls.length} clips for stitching` });
    res.status(202).json({ ok: true, async: true, job_id: job.id, status_url: `/status/${job.id}`, clip_count: clipUrls.length });
    // Fire-and-forget: errors are captured into the job record.
    setImmediate(() => {
      runStitchPipeline(body, clipUrls, target_aspect, output_filename, {
        onProgress: (patch) => updateJob(job.id, patch),
      })
        .then((result) => {
          updateJob(job.id, {
            status: "complete",
            stage: "complete",
            progress: 100,
            message: "Render complete",
            video_url: result.video_url,
            clip_count: result.clip_count,
            completed_at: Date.now(),
          });
        })
        .catch((e) => {
          console.error("async stitch-final failed", e);
          updateJob(job.id, {
            status: "failed",
            stage: "failed",
            error: e?.message || "stitch failed",
            message: e?.message || "stitch failed",
            completed_at: Date.now(),
          });
        });
    });
    return;
  }

  // ===== Synchronous mode (legacy / return_binary): run inline and respond =====
  try {
    const result = await runStitchPipeline(body, clipUrls, target_aspect, output_filename, { onProgress: () => {} });
    if (return_binary) {
      res.setHeader("X-Clip-Count", String(result.clip_count));
      res.setHeader("X-Narration-Count", String(result.narration_count));
      res.setHeader("X-Sfx-Count", String(result.sfx_count));
      res.setHeader("X-Has-Music", result.has_music ? "true" : "false");
      res.setHeader("X-Captions", result.captions);
      return res.sendFile(result.captioned_path, { headers: { "Content-Type": "video/mp4" } }, () => {
        try { fs.rmSync(result.tmp_dir, { recursive: true, force: true }); } catch {}
      });
    }
    try { fs.rmSync(result.tmp_dir, { recursive: true, force: true }); } catch {}
    return res.json({
      ok: true,
      video_url: result.video_url,
      clip_count: result.clip_count,
      narration_count: result.narration_count,
      sfx_count: result.sfx_count,
      has_music: result.has_music,
      captions: result.captions,
    });
  } catch (e) {
    console.error("stitch-final error", e);
    return res.status(500).json({ error: e.message || "stitch failed" });
  }
});

// ==========================================================================
// POST /burn-captions-only
// Step 2 of the two-step pipeline. Takes a finished stitched video, runs
// AssemblyAI transcription on its audio, and burns karaoke captions with a
// single dedicated ffmpeg call. Always runs as an async job — caller polls
// `/status/:job_id` and the result is PUT to the supplied signed upload URL.
//
// Body: {
//   video_url:    string  (required) public URL of the stitched mp4
//   upload_url:   string  (required) signed PUT URL for the captioned mp4
//   public_url:   string  (optional) final public URL to return in status
//   target_aspect: "16:9" | "9:16" (defaults to 16:9)
//   captions:     fallback caption items (used only if AssemblyAI yields nothing)
//   scenes, clip_duration_weights: same fallback shape as /stitch-final
// }
// ==========================================================================
app.post("/burn-captions-only", async (req, res) => {
  const body = req.body || {};
  const { video_url, upload_url, public_url, target_aspect = "16:9" } = body;
  if (!video_url || !upload_url) {
    return res.status(400).json({ error: "video_url and upload_url are required" });
  }

  const job = createJob();
  updateJob(job.id, { clip_count: 1, message: "Caption job queued" });
  res.status(202).json({ ok: true, async: true, job_id: job.id, status_url: `/status/${job.id}` });

  setImmediate(() => {
    runCaptionBurnPipeline(body, video_url, upload_url, public_url, target_aspect, {
      onProgress: (patch) => updateJob(job.id, patch),
    })
      .then((result) => {
        updateJob(job.id, {
          status: "complete",
          stage: "complete",
          progress: 100,
          message: "Captions burned",
          video_url: result.video_url,
          completed_at: Date.now(),
        });
      })
      .catch((e) => {
        console.error("burn-captions-only failed", e);
        updateJob(job.id, {
          status: "failed",
          stage: "failed",
          error: e?.message || "caption burn failed",
          message: e?.message || "caption burn failed",
          completed_at: Date.now(),
        });
      });
  });
});

async function runCaptionBurnPipeline(body, videoUrl, uploadUrl, publicUrl, target_aspect, { onProgress }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-captions-"));
  const isPortrait = target_aspect === "9:16";
  const W = isPortrait ? 1080 : 1920;
  const H = isPortrait ? 1920 : 1080;
  try {
    onProgress({ status: "running", stage: "downloading", progress: 5, message: "Downloading stitched video…" });
    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadToFile(videoUrl, srcPath, "stitched video");

    onProgress({ stage: "extracting-audio", progress: 20, message: "Extracting audio for transcription…" });
    const audioPath = path.join(tmpDir, "source-audio.m4a");
    let hasExtractedAudio = false;
    try {
      await runFfmpeg(["-y", "-i", srcPath, "-vn", "-c:a", "aac", "-b:a", "128k", audioPath]);
      hasExtractedAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
    } catch (e) {
      console.warn("No usable audio track for AssemblyAI; falling back to scene text captions:", e.message);
    }

    let words = [];
    let captionSource = "none";
    if (ASSEMBLYAI_API_KEY && hasExtractedAudio) {
      onProgress({ stage: "transcribing", progress: 35, message: "Transcribing with AssemblyAI…" });
      words = await transcribeWithAssemblyAi(audioPath);
      if (words.length > 0) captionSource = "assemblyai";
    } else {
      console.warn("ASSEMBLYAI_API_KEY not set on render server; will rely on fallback caption text only.");
    }

    if (words.length === 0) {
      const { items: captionItems } = selectCaptionItemsFromBody(body);
      if (captionItems.length > 0) {
        // Without per-clip durations we evenly distribute over the video duration.
        const totalDur = await ffprobeDuration(srcPath);
        const per = Math.max(1, totalDur / captionItems.length);
        const fallbackDurations = captionItems.map(() => per);
        words = buildCaptionWordsFromSceneText(captionItems, fallbackDurations);
        if (words.length > 0) captionSource = "scene-text-fallback";
      }
    }

    if (words.length === 0) {
      throw new Error("No caption words available (AssemblyAI returned nothing and no fallback caption text provided)");
    }

    onProgress({ stage: "burning-captions", progress: 70, message: `Burning ${words.length} visible captions (${captionSource})…` });
    const burnedPath = path.join(tmpDir, "captioned.mp4");
    // Branded karaoke captions must be produced by ASS/libass: active word
    // bright purple (#B44FFF), inactive words white, bold centered, dark outline.
    // Do not silently fall back to plain drawtext or upload an uncaptioned MP4.
    const assPath = path.join(tmpDir, "captions.ass");
    fs.writeFileSync(assPath, buildKaraokeAss(words, { width: W, height: H }), "utf8");
    await burnCaptionsIntoVideo(srcPath, burnedPath, assPath, words, tmpDir);
    captionSource = `${captionSource}+ass-karaoke`;

    // ===== Brand intro/outro =====
    // Permanent system rule: every final video is wrapped with the user's
    // brand intro (prepended) and outro (appended) when they have uploaded
    // them in Settings → Brand Assets. Each clip is normalized to the same
    // WxH / 25fps / yuv420p / stereo AAC profile, then concat-demuxed with
    // the captioned body so audio (intro music, outro music) stays intact.
    let finalPath = burnedPath;
    const introOutroUrls = [
      { kind: "intro", url: body.intro_url },
      { kind: "outro", url: body.outro_url },
    ].filter((x) => typeof x.url === "string" && x.url.length > 0);
    if (introOutroUrls.length > 0) {
      onProgress({ stage: "branding", progress: 85, message: "Adding brand intro/outro…" });
      async function normalizeBrandClip(url, label) {
        const dlPath = path.join(tmpDir, `${label}-src.mp4`);
        await downloadToFile(url, dlPath, `${label} video`);
        const normPath = path.join(tmpDir, `${label}-norm.mp4`);
        const vf =
          `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25,format=yuv420p`;
        await runFfmpeg([
          "-y",
          "-fflags", "+genpts+discardcorrupt",
          "-err_detect", "ignore_err",
          "-i", dlPath,
          "-vf", vf,
          "-af", "aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "20",
          "-r", "25",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "192k",
          "-ar", "44100",
          "-ac", "2",
          "-movflags", "+faststart",
          normPath,
        ]);
        return normPath;
      }
      // Body needs to share the same audio profile so concat demuxer is stable.
      const bodyNormPath = path.join(tmpDir, "body-norm.mp4");
      await runFfmpeg([
        "-y",
        "-i", burnedPath,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        bodyNormPath,
      ]);
      const parts = [];
      const introUrl = body.intro_url;
      const outroUrl = body.outro_url;
      if (introUrl) parts.push(await normalizeBrandClip(introUrl, "intro"));
      parts.push(bodyNormPath);
      if (outroUrl) parts.push(await normalizeBrandClip(outroUrl, "outro"));
      const brandConcatList = path.join(tmpDir, "brand.ffconcat");
      fs.writeFileSync(brandConcatList, parts.map(ffconcatLine).join("\n") + "\n", "utf8");
      const brandedPath = path.join(tmpDir, "branded.mp4");
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", brandConcatList,
        "-c", "copy",
        "-movflags", "+faststart",
        brandedPath,
      ]);
      finalPath = brandedPath;
      console.log(`Wrapped final video with brand assets: intro=${Boolean(introUrl)}, outro=${Boolean(outroUrl)}`);
    }

    onProgress({ stage: "uploading", progress: 92, message: "Uploading captioned video…" });
    const outBuf = fs.readFileSync(finalPath);
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
      body: outBuf,
    });
    if (!putRes.ok) {
      const txt = await putRes.text().catch(() => "");
      throw new Error(`Signed upload failed (${putRes.status}): ${txt.slice(0, 200)}`);
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { video_url: publicUrl || null, caption_source: captionSource, word_count: words.length };
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// ==========================================================================
// Pipeline: all the heavy lifting. Pulled out of the handler so it can be
// driven either synchronously (returning a result for HTTP response) or
// asynchronously (driven by a job, with progress callbacks).
// ==========================================================================
async function runStitchPipeline(body, clipUrls, target_aspect, output_filename, { onProgress }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));
  const outPath = path.join(tmpDir, "final.mp4");
  const isPortrait = target_aspect === "9:16";
  const W = isPortrait ? 1080 : 1920;
  const H = isPortrait ? 1920 : 1080;
  const isShortPortrait = isShortPortraitPayload(body, clipUrls.length, target_aspect);
  const fixedShortDuration = shortSceneDuration(body);

  try {
    // Download all video parts SEQUENTIALLY (one at a time). 40+ concurrent
    // downloads spike memory/network on Railway and crashed the container
    // before FFmpeg even started. Sequential keeps memory flat.
    onProgress({ status: "running", stage: "downloading", progress: 2, message: `Downloading ${clipUrls.length} clips sequentially…`, clip_count: clipUrls.length, clips_downloaded: 0 });
    const localPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const dest = path.join(tmpDir, `clip-${String(i).padStart(4, "0")}.mp4`);
      await downloadToFile(clipUrls[i], dest, `clip ${i + 1}`);
      localPaths.push(dest);
      const pct = 2 + Math.round((i + 1) / clipUrls.length * 28); // 2..30
      onProgress({ stage: "downloading", progress: pct, message: `Downloaded clip ${i + 1}/${clipUrls.length}`, clips_downloaded: i + 1 });
    }

    const durations = await Promise.all(localPaths.map((p) => ffprobeDuration(p)));
    const totalDuration = Math.max(1, durations.reduce((sum, d) => sum + (d || 0), 0) || localPaths.length * 5);

    const narrationItems = normalizeNarrationItems(body);
    onProgress({ stage: "downloading-audio", progress: 32, message: `Downloading ${narrationItems.length} narration tracks…` });
    const narrationPaths = [];
    const narrationDownloads = [];
    for (let i = 0; i < narrationItems.length; i++) {
      const ext = mediaExtFromUrl(narrationItems[i].url, "mp3");
      const dest = path.join(tmpDir, `narration-${String(i).padStart(3, "0")}.${ext}`);
      try {
        await downloadToFile(narrationItems[i].url, dest, `narration ${i + 1}`);
        narrationPaths.push(dest);
        narrationDownloads.push({ ...narrationItems[i], path: dest });
      } catch (e) {
        console.warn("narration fetch", narrationItems[i].url, e.message);
      }
    }

    const soundtrackUrl = body.music_url || body.soundtrack_url;
    // Clamp soundtrack to a safe ceiling so narration stays dominant
    // even if the project stored an overly loud music_volume.
    const musicVolume = clampNumber(body.music_volume, 0.12, 0, 0.15);
    let musicPath = null;
    if (soundtrackUrl) {
      const ext = mediaExtFromUrl(soundtrackUrl, "mp3");
      const dest = path.join(tmpDir, `soundtrack.${ext}`);
      try {
        await downloadToFile(soundtrackUrl, dest, "soundtrack");
        musicPath = dest;
      } catch (e) {
        console.warn("soundtrack fetch", soundtrackUrl, e.message);
      }
    }

    const sfxPaths = [];
    if (Array.isArray(body.sound_effects)) {
      for (let i = 0; i < body.sound_effects.length; i++) {
        const sfx = body.sound_effects[i] || {};
        const url = sfx.audio_url || sfx.url || sfx.sound_effect_url;
        if (!url) continue;
        const ext = mediaExtFromUrl(url, "mp3");
        const dest = path.join(tmpDir, `sfx-${String(i).padStart(3, "0")}.${ext}`);
        try {
          await downloadToFile(url, dest, `sound effect ${i + 1}`);
          sfxPaths.push({
            path: dest,
            timestamp: Math.max(0, Number(sfx.timestamp_seconds) || 0),
            // SFX should sit below narration: cap at 0.4 with a 0.35 default.
            volume: clampNumber(sfx.volume, 0.35, 0, 0.4),
          });
        } catch (e) {
          console.warn("sfx fetch", url, e.message);
        }
      }
    }

    let narrationTrackPath = null;
    if (narrationPaths.length > 1) {
      const narrationListPath = path.join(tmpDir, "narrations.ffconcat");
      narrationTrackPath = path.join(tmpDir, "narration-track.m4a");
      fs.writeFileSync(narrationListPath, narrationPaths.map(ffconcatLine).join("\n") + "\n", "utf8");
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", narrationListPath,
        "-vn",
        "-ac", "2",
        "-ar", "44100",
        "-c:a", "aac",
        "-b:a", "192k",
        narrationTrackPath,
      ]);
    } else if (narrationPaths.length === 1) {
      narrationTrackPath = narrationPaths[0];
    }

    const narrationDurations = await Promise.all(narrationPaths.map((p) => ffprobeDuration(p)));
    narrationDownloads.forEach((item, i) => { item.probed_duration = narrationDurations[i] || null; });
    const narrationDuration = narrationDurations.reduce((sum, d) => sum + (d || 0), 0);

    const requestedClipDurations = isShortPortrait
      ? localPaths.map(() => fixedShortDuration)
      : normalizeDurationList(body.clip_durations || body.scene_durations || body.durations);
    // Shorts use a fixed 2.5s per scene, but the LAST scene's narration is
    // often slightly longer than 2.5s — extend the final clip to fit the
    // whole last narration (plus a small tail) so the closing word isn't
    // clipped mid-syllable.
    if (isShortPortrait && narrationPaths.length === localPaths.length && narrationPaths.length > 0) {
      const lastIdx = requestedClipDurations.length - 1;
      const lastNarr = Number(narrationDurations[lastIdx]) || 0;
      // Extend the last clip by at most 3s to catch a trailing word — never
      // stretch to the full narration length (which could be a stale
      // full-script audio file and would balloon the video by minutes).
      const extension = Math.min(3, Math.max(0, lastNarr - fixedShortDuration)) + 0.6;
      requestedClipDurations[lastIdx] = fixedShortDuration + extension;
    }
    const shortDurationCap = isShortPortrait
      ? shortPortraitDurationCap(body, localPaths.length, fixedShortDuration)
      : Infinity;
    const requestedClipWeights = normalizeDurationList(body.clip_duration_weights || body.scene_duration_weights || body.duration_weights);

    // Per-scene image/narration sync: when we receive one narration per clip
    // (matching scene order), retime each clip to exactly its narration's
    // duration so images stay on screen as long as the voice over plays.
    const perSceneSync =
      !isShortPortrait &&
      narrationPaths.length === localPaths.length &&
      narrationPaths.length > 1 &&
      narrationDurations.every((d) => typeof d === "number" && d > 0);
    const explicitDurationSync =
      requestedClipDurations.length === localPaths.length &&
      requestedClipDurations.every((d) => typeof d === "number" && d > 0);
    const weightedDurationSync =
      !perSceneSync &&
      !explicitDurationSync &&
      requestedClipWeights.length === localPaths.length &&
      requestedClipWeights.every((d) => typeof d === "number" && d > 0) &&
      narrationDuration > 0;
    const stretchClipsToNarration =
      !perSceneSync &&
      !explicitDurationSync &&
      !weightedDurationSync &&
      narrationDuration > totalDuration + 0.5 &&
      localPaths.length > 1;
    const weightedDurations = weightedDurationSync ? fitDurationsToTotal(requestedClipWeights, narrationDuration) : [];
    const stretchedDurations = stretchClipsToNarration ? fitDurationsToTotal(durations, narrationDuration) : [];
    const clipTargetDurations = localPaths.map((_, i) => {
      if (perSceneSync) return narrationDurations[i];
      if (explicitDurationSync) return requestedClipDurations[i];
      if (weightedDurationSync) return weightedDurations[i] || durations[i] || 5;
      if (stretchClipsToNarration) return stretchedDurations[i] || durations[i] || 5;
      return durations[i] || 5;
    });
    if (isShortPortrait) {
      let runningTotal = clipTargetDurations.reduce((s, d) => s + (Number(d) || 0), 0);
      if (runningTotal > shortDurationCap) {
        const overflow = runningTotal - shortDurationCap;
        const lastIdx = clipTargetDurations.length - 1;
        clipTargetDurations[lastIdx] = Math.max(fixedShortDuration, (Number(clipTargetDurations[lastIdx]) || fixedShortDuration) - overflow);
        runningTotal = clipTargetDurations.reduce((s, d) => s + (Number(d) || 0), 0);
      }
      console.log("Shorts duration lock", {
        clip_count: localPaths.length,
        fixed_scene_duration: fixedShortDuration,
        cap_seconds: shortDurationCap,
        planned_seconds: runningTotal,
        narration_seconds: narrationDuration,
      });
    }
    const syncedTotalDuration = clipTargetDurations.reduce((s, d) => s + d, 0);
    const baseTotalDuration = syncedTotalDuration;

    const clipSceneNumbers = Array.isArray(body.clip_scene_numbers)
      ? body.clip_scene_numbers.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    const sceneNumberedNarrations = narrationDownloads.filter((n) => Number.isFinite(Number(n.scene_number)));
    if (clipSceneNumbers.length === localPaths.length && sceneNumberedNarrations.length > 0) {
      const byScene = new Map(sceneNumberedNarrations.map((n) => [Number(n.scene_number), n]));
      const offsetsByScene = new Map();
      const audioSegments = [];
      onProgress({ stage: "syncing-audio", progress: 35, message: "Aligning narration to scene timings…" });
      for (let i = 0; i < localPaths.length; i++) {
        const target = Math.max(0.5, Number(clipTargetDurations[i]) || 0.5);
        const segmentPath = path.join(tmpDir, `narration-segment-${String(i).padStart(4, "0")}.m4a`);
        const sceneNumber = clipSceneNumbers[i];
        const item = byScene.get(sceneNumber);
        const offset = offsetsByScene.get(sceneNumber) || 0;
        offsetsByScene.set(sceneNumber, offset + target);
        const itemDuration = Number(item?.probed_duration) || 0;
        if (item?.path && (!itemDuration || offset < itemDuration - 0.05)) {
          await runFfmpeg([
            "-y",
            "-i", item.path,
            "-filter_complex", `[0:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,atrim=start=${offset.toFixed(3)}:duration=${target.toFixed(3)},apad,atrim=duration=${target.toFixed(3)},asetpts=N/SR/TB[a]`,
            "-map", "[a]",
            "-c:a", "aac",
            "-b:a", "192k",
            segmentPath,
          ]);
        } else {
          await runFfmpeg([
            "-y",
            "-f", "lavfi",
            "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:d=${target.toFixed(3)}`,
            "-c:a", "aac",
            "-b:a", "192k",
            segmentPath,
          ]);
        }
        audioSegments.push(segmentPath);
      }
      const alignedListPath = path.join(tmpDir, "narrations-aligned.ffconcat");
      narrationTrackPath = path.join(tmpDir, "narration-track-aligned.m4a");
      fs.writeFileSync(alignedListPath, audioSegments.map(ffconcatLine).join("\n") + "\n", "utf8");
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", alignedListPath, "-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", narrationTrackPath]);
    }

    const sfxDurations = await Promise.all(sfxPaths.map((s) => ffprobeDuration(s.path)));
    const maxSfxEnd = sfxPaths.reduce((max, s, i) => Math.max(max, s.timestamp + (sfxDurations[i] || 0)), 0);
    const finalDuration = isShortPortrait
      ? Math.min(shortDurationCap, Math.max(1, baseTotalDuration, Math.min(maxSfxEnd, shortDurationCap)))
      : Math.max(1, baseTotalDuration, narrationDuration, maxSfxEnd);
    const videoPadDuration = Math.max(0, finalDuration - baseTotalDuration);
    const videoTrimRequired = isShortPortrait && baseTotalDuration > finalDuration + 0.05;

    // Keep FFmpeg stable for long projects: normalize each clip in its own
    // small process, concat the uniform MP4s with the demuxer, then run an
    // audio-only mix. A single huge filter_complex crashed Railway on 40+
    // scenes with "Resource temporarily unavailable" / exit 245.
    const n = localPaths.length;
    onProgress({ stage: "processing", progress: 38, message: `Normalizing ${n} clips…` });
    const normalizedPaths = [];
    for (let i = 0; i < n; i++) {
      const target = clipTargetDurations[i];
      const srcDur = durations[i] || target;
      const pad = Math.max(0, target - srcDur);
      const normalizedPath = path.join(tmpDir, `normalized-${String(i).padStart(4, "0")}.mp4`);
      const vf =
        `${fitClipToCanvasFilter(W, H, isPortrait)},` +
        `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},` +
        `trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS`;
      await runFfmpeg([
        "-y",
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "-i", localPaths[i],
        "-vf", vf,
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-r", "25",
        "-pix_fmt", "yuv420p",
        "-threads", "2",
        "-movflags", "+faststart",
        normalizedPath,
      ]);
      normalizedPaths.push(normalizedPath);
      const pct = 38 + Math.round((i + 1) / n * 30); // 38..68
      onProgress({ stage: "processing", progress: pct, message: `Normalized clip ${i + 1}/${n}` });
    }

    onProgress({ stage: "processing", progress: 70, message: "Concatenating clips…" });
    const concatListPath = path.join(tmpDir, "normalized.ffconcat");
    const concatVideoPath = path.join(tmpDir, "video-concat.mp4");
    fs.writeFileSync(concatListPath, normalizedPaths.map(ffconcatLine).join("\n") + "\n", "utf8");
    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-movflags", "+faststart",
      concatVideoPath,
    ]);

    let videoForMixPath = concatVideoPath;
    if (videoPadDuration > 0.05 || videoTrimRequired) {
      videoForMixPath = path.join(tmpDir, videoTrimRequired ? "video-duration-locked.mp4" : "video-padded.mp4");
      await runFfmpeg([
        "-y",
        "-i", concatVideoPath,
        "-vf", `tpad=stop_mode=clone:stop_duration=${videoPadDuration.toFixed(3)},trim=duration=${finalDuration.toFixed(3)},setpts=PTS-STARTPTS`,
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-r", "25",
        "-pix_fmt", "yuv420p",
        "-threads", "2",
        "-movflags", "+faststart",
        videoForMixPath,
      ]);
    }

    onProgress({ stage: "processing", progress: 76, message: "Mixing audio tracks…" });
    const mixInputs = ["-i", videoForMixPath];
    let inputIdx = 1;
    const audioLabels = [];
    const audioParts = [];
    if (narrationTrackPath) {
      mixInputs.push("-i", narrationTrackPath);
      audioParts.push(`[${inputIdx}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[narr]`);
      audioLabels.push("[narr]");
      inputIdx++;
    }
    if (musicPath) {
      mixInputs.push("-i", musicPath);
      audioParts.push(`[${inputIdx}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,aloop=loop=-1:size=2147483647,asetpts=N/SR/TB,volume=${musicVolume}[music]`);
      audioLabels.push("[music]");
      inputIdx++;
    }
    sfxPaths.forEach((s, i) => {
      mixInputs.push("-i", s.path);
      const delayMs = Math.round(s.timestamp * 1000);
      audioParts.push(`[${inputIdx}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,volume=${s.volume},adelay=${delayMs}:all=1[sfx${i}]`);
      audioLabels.push(`[sfx${i}]`);
      inputIdx++;
    });
    const hasAudio = audioLabels.length > 0;
    if (hasAudio) {
      audioParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${finalDuration.toFixed(3)}[base]`);
      audioParts.push(`[base]${audioLabels.join("")}amix=inputs=${audioLabels.length + 1}:duration=first:dropout_transition=0:normalize=0,atrim=duration=${finalDuration.toFixed(3)},asetpts=N/SR/TB[aout]`);
      await runFfmpeg([
        "-y",
        ...mixInputs,
        "-filter_complex", audioParts.join(";"),
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-max_muxing_queue_size", "1024",
        outPath,
      ]);
    } else {
      await runFfmpeg(["-y", "-i", videoForMixPath, "-c", "copy", "-movflags", "+faststart", outPath]);
    }

    // ===== Karaoke caption burn-in =====
    // Two-step pipeline: when the caller passes skip_captions=true, we ship
    // the stitched (uncaptioned) video as-is. A separate `/burn-captions-only`
    // job is responsible for transcription + caption burn. This isolates the
    // two complex failure modes (long ffmpeg stitch vs caption burn).
    let captionedPath = outPath;
    let captionSource = body.skip_captions ? "skipped-two-step-pipeline" : "none";
    if (body.skip_captions) {
      onProgress({ stage: "stitched", progress: 90, message: "Stitch complete (captions deferred to burn step)" });
    }
    try {
      if (body.skip_captions) throw new Error("__skip_captions__");
      onProgress({ stage: "burning-captions", progress: 84, message: "Burning captions…" });
      const { key: captionPayloadKey, items: captionItems } = selectCaptionItemsFromBody(body);
      console.log(`Caption payload key: ${captionPayloadKey}; normalized caption items: ${captionItems.length}.`);
      let words = [];
      if (ASSEMBLYAI_API_KEY && hasAudio) {
        const audioOnly = path.join(tmpDir, "final-audio.m4a");
        await runFfmpeg(["-y", "-i", outPath, "-vn", "-c:a", "aac", "-b:a", "128k", audioOnly]);
        words = await transcribeWithAssemblyAi(audioOnly);
        if (words.length > 0) captionSource = "assemblyai";
      }

      if (words.length === 0 && captionItems.length > 0) {
        words = buildCaptionWordsFromSceneText(captionItems, clipTargetDurations);
        if (words.length > 0) captionSource = "scene-text";
      }

      if (words.length === 0) {
        captionSource = "unburned-no-caption-words";
      }

      if (words.length > 0) {
        const ass = buildKaraokeAss(words, { width: W, height: H });
        const assPath = path.join(tmpDir, "captions.ass");
        fs.writeFileSync(assPath, ass, "utf8");
        const burnedPath = path.join(tmpDir, "final-captioned.mp4");
        await burnCaptionsIntoVideo(outPath, burnedPath, assPath, words, tmpDir);
        captionSource = `${captionSource}+ass-karaoke`;
        captionedPath = burnedPath;
        console.log(`Burned ${words.length} karaoke captions into final video via ${captionSource}.`);
      } else {
        throw new Error("No caption words were available from AssemblyAI or scene text");
      }
    } catch (e) {
      if (e && e.message === "__skip_captions__") {
        captionedPath = outPath;
      } else {
        throw new Error(`Caption burn-in failed; refusing to ship uncaptioned video: ${e.message}`);
      }
    }

    const captionsTag = captionedPath !== outPath ? `burned:${captionSource}` : captionSource;
    const meta = {
      clip_count: n,
      narration_count: narrationPaths.length,
      sfx_count: sfxPaths.length,
      has_music: Boolean(musicPath),
      captions: captionsTag,
      tmp_dir: tmpDir,
      captioned_path: captionedPath,
      video_url: null,
    };

    // Upload path priority:
    //  1. Signed upload URL passed in body.upload_url (preferred — no creds on render server)
    //  2. Supabase service-role client configured via env vars (legacy fallback)
    //  3. Neither — caller (sync return_binary path) keeps the file to stream back
    const uploadUrl = body.upload_url;
    const publicUrl = body.public_url;
    if (uploadUrl) {
      onProgress({ stage: "uploading", progress: 92, message: "Uploading final video…" });
      const outBuf = fs.readFileSync(captionedPath);
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
        body: outBuf,
      });
      if (!putRes.ok) {
        const txt = await putRes.text().catch(() => "");
        throw new Error(`Signed upload failed (${putRes.status}): ${txt.slice(0, 200)}`);
      }
      meta.video_url = publicUrl || null;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      meta.tmp_dir = null;
      meta.captioned_path = null;
    } else if (output_filename && supabase) {
      onProgress({ stage: "uploading", progress: 92, message: "Uploading final video…" });
      const outBuf = fs.readFileSync(captionedPath);
      const { error: upErr } = await supabase.storage
        .from("final-videos")
        .upload(output_filename, outBuf, { contentType: "video/mp4", upsert: true });
      if (upErr) throw new Error(`Storage upload: ${upErr.message}`);
      const { data: pub } = supabase.storage.from("final-videos").getPublicUrl(output_filename);
      meta.video_url = pub.publicUrl;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      meta.tmp_dir = null;
      meta.captioned_path = null;
    }

    return meta;
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

app.listen(PORT, () => console.log(`Ken Burns render server listening on :${PORT}; ffmpeg=${FFMPEG_BIN}`));