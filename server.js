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
 * Required env for upload endpoints: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * `/stitch-final` can run without Supabase credentials when called with
 * `{ return_binary: true }`; the caller uploads the returned MP4 itself.
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
const RENDER_SERVER_VERSION = "2026-05-14-subtle-ken-burns";
const FFMPEG_BIN = resolveFfmpegBinary();
const FFPROBE_BIN = resolveFfprobeBinary();

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

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing; upload endpoints are disabled, but /stitch-final binary mode will still work.");
}

function assertStorageConfigured() {
  if (!supabase) {
    throw new Error("Storage upload is not configured on this render server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or use /stitch-final with return_binary=true.");
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
function buildZoompan(effect, durationSec) {
  const d = Math.max(1, Math.round(durationSec * 25));
  switch (effect) {
    case "zoom-in":
      // Slower, gentler push-in. Caps at 1.15x so framing stays close to the original.
      return `zoompan=z='min(zoom+0.0006,1.15)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "zoom-out":
      // Start slightly zoomed-in (1.15x) and ease back to 1.0x for a calm reveal.
      return `zoompan=z='if(lte(zoom,1.0),1.15,max(1.0,zoom-0.0006))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "pan-left":
      // Gentle horizontal pan at a lighter 1.1x crop.
      return `zoompan=z='1.1':d=${d}:x='iw/3+(iw/6*(on/${d}))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "pan-right":
      return `zoompan=z='1.1':d=${d}:x='iw-(iw/3+(iw/6*(on/${d})))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "diagonal":
      return `zoompan=z='min(zoom+0.0005,1.12)':d=${d}:x='iw/8*(on/${d})':y='ih/8*(on/${d})':s=1920x1080:fps=25`;
    case "zoom-drift":
      return `zoompan=z='min(zoom+0.0008,1.18)':d=${d}:x='iw/2-(iw/zoom/2)+(10*(on/${d}))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    default:
      throw new Error(`Unknown effect: ${effect}`);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      reject(new Error(`Failed to start ffmpeg at ${FFMPEG_BIN}: ${err.message}`));
    });
    proc.on("close", (code) => {
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

function fitDurationsToTotal(durations, total) {
  const clean = durations.map((d) => (Number.isFinite(d) && d > 0 ? d : 0));
  const sum = clean.reduce((s, d) => s + d, 0);
  if (!Number.isFinite(total) || total <= 0 || sum <= 0) return clean;
  const scale = total / sum;
  return clean.map((d) => Math.max(0.04, d * scale));
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
  const { image_url, duration = 10, output_filename, effect, music_url, music_volume = 0.15, return_binary = false } = req.body || {};
  if (!image_url || !effect || (!return_binary && !output_filename)) {
    return res.status(400).json({ error: "image_url, effect, and output_filename required unless return_binary=true" });
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

    const dur = Math.max(1, parseInt(duration, 10) || 10);
    const zoompan = buildZoompan(effect, dur);

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
app.post("/stitch-final", async (req, res) => {
  const body = req.body || {};
  const { output_filename, target_aspect = "16:9", return_binary = false } = body;
  const clipUrls = flattenClipUrls(body.clip_urls || body.clips);
  if (clipUrls.length === 0 || (!return_binary && !output_filename)) {
    return res.status(400).json({ error: "clip_urls (non-empty array) and output_filename required unless return_binary=true" });
  }
  let binaryResponseInProgress = false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-"));
  const outPath = path.join(tmpDir, "final.mp4");
  const isPortrait = target_aspect === "9:16";
  const W = isPortrait ? 1080 : 1920;
  const H = isPortrait ? 1920 : 1080;

  try {
    // Download all video parts in parallel (with retry). Nested arrays/objects
    // were flattened above, so long scripts split into part 1/2/3 are stitched
    // into one final video in the exact incoming order.
    const localPaths = await Promise.all(clipUrls.map(async (url, i) => {
      const dest = path.join(tmpDir, `clip-${String(i).padStart(4, "0")}.mp4`);
      await downloadToFile(url, dest, `clip ${i + 1}`);
      return dest;
    }));

    const durations = await Promise.all(localPaths.map((p) => ffprobeDuration(p)));
    const totalDuration = Math.max(1, durations.reduce((sum, d) => sum + (d || 0), 0) || localPaths.length * 5);

    const narrationItems = normalizeNarrationItems(body);
    const narrationPaths = [];
    for (let i = 0; i < narrationItems.length; i++) {
      const ext = mediaExtFromUrl(narrationItems[i].url, "mp3");
      const dest = path.join(tmpDir, `narration-${String(i).padStart(3, "0")}.${ext}`);
      try {
        await downloadToFile(narrationItems[i].url, dest, `narration ${i + 1}`);
        narrationPaths.push(dest);
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

    const narrationDurations = await Promise.all(narrationPaths.map((p) => ffprobeDuration(p)));
    const narrationDuration = narrationDurations.reduce((sum, d) => sum + (d || 0), 0);

    const requestedClipDurations = normalizeDurationList(body.clip_durations || body.scene_durations || body.durations);
    const requestedClipWeights = normalizeDurationList(body.clip_duration_weights || body.scene_duration_weights || body.duration_weights);

    // Per-scene image/narration sync: when we receive one narration per clip
    // (matching scene order), retime each clip to exactly its narration's
    // duration so images stay on screen as long as the voice over plays.
    const perSceneSync =
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
    const syncedTotalDuration = clipTargetDurations.reduce((s, d) => s + d, 0);
    const baseTotalDuration = perSceneSync ? syncedTotalDuration : totalDuration;

    const sfxDurations = await Promise.all(sfxPaths.map((s) => ffprobeDuration(s.path)));
    const maxSfxEnd = sfxPaths.reduce((max, s, i) => Math.max(max, s.timestamp + (sfxDurations[i] || 0)), 0);
    const finalDuration = Math.max(1, baseTotalDuration, narrationDuration, maxSfxEnd);
    const videoPadDuration = Math.max(0, finalDuration - baseTotalDuration);

    // Build a filter_complex that scales/pads every input to a uniform size,
    // forces 25fps, then concatenates. This is safer than -f concat demuxer
    // because the source clips come from different providers (Kling, Veo,
    // Ken Burns) with different resolutions/codecs/audio tracks.
    const inputs = [];
    for (const p of localPaths) {
      inputs.push(
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "-i", p,
      );
    }
    const narrationInputStart = localPaths.length;
    for (const p of narrationPaths) inputs.push("-i", p);
    const musicInputIndex = musicPath ? localPaths.length + narrationPaths.length : null;
    if (musicPath) inputs.push("-i", musicPath);
    const sfxInputStart = localPaths.length + narrationPaths.length + (musicPath ? 1 : 0);
    for (const s of sfxPaths) inputs.push("-i", s.path);

    const n = localPaths.length;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const target = clipTargetDurations[i];
      const srcDur = durations[i] || target;
      const pad = Math.max(0, target - srcDur);
      // Scale + pad to the target frame, then extend (clone last frame) or
      // trim to the narration-matched duration so each image holds for as
      // long as its narration line plays.
      parts.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25,format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},` +
        `trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`
      );
    }
    const concatLabels = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
    parts.push(`${concatLabels}concat=n=${n}:v=1:a=0[vcat]`);
    parts.push(`[vcat]tpad=stop_mode=clone:stop_duration=${videoPadDuration},trim=duration=${finalDuration},setpts=PTS-STARTPTS[outv]`);
    const audioLabels = [];
    if (narrationPaths.length > 1) {
      const narrLabels = [];
      for (let i = 0; i < narrationPaths.length; i++) {
        const inputIdx = narrationInputStart + i;
        parts.push(`[${inputIdx}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[nprep${i}]`);
        narrLabels.push(`[nprep${i}]`);
      }
      parts.push(`${narrLabels.join("")}concat=n=${narrationPaths.length}:v=0:a=1,volume=1.0[narr]`);
      audioLabels.push("[narr]");
    } else if (narrationPaths.length === 1) {
      parts.push(`[${narrationInputStart}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[narr]`);
      audioLabels.push("[narr]");
    }
    if (musicInputIndex !== null) {
      parts.push(`[${musicInputIndex}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,aloop=loop=-1:size=2147483647,asetpts=N/SR/TB,volume=${musicVolume}[music]`);
      audioLabels.push("[music]");
    }
    sfxPaths.forEach((s, i) => {
      const inputIdx = sfxInputStart + i;
      const delayMs = Math.round(s.timestamp * 1000);
      parts.push(`[${inputIdx}:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo,volume=${s.volume},adelay=${delayMs}:all=1[sfx${i}]`);
      audioLabels.push(`[sfx${i}]`);
    });
    const hasAudio = audioLabels.length > 0;
    if (hasAudio) {
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${finalDuration}[base]`);
      parts.push(`[base]${audioLabels.join("")}amix=inputs=${audioLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
    }
    const filter = parts.join(";");

    const args = [
      "-y",
      ...inputs,
      "-filter_complex", filter,
      "-map", "[outv]",
      ...(hasAudio ? ["-map", "[aout]"] : []),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-r", "25",
      "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-movflags", "+faststart",
      "-max_muxing_queue_size", "1024",
      outPath,
    ];
    await runFfmpeg(args);

    if (return_binary) {
      binaryResponseInProgress = true;
      res.setHeader("X-Clip-Count", String(n));
      res.setHeader("X-Narration-Count", String(narrationPaths.length));
      res.setHeader("X-Sfx-Count", String(sfxPaths.length));
      res.setHeader("X-Has-Music", musicPath ? "true" : "false");
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
    res.json({ ok: true, video_url: pub.publicUrl, clip_count: n, narration_count: narrationPaths.length, sfx_count: sfxPaths.length, has_music: Boolean(musicPath) });
  } catch (e) {
    console.error("stitch-final error", e);
    res.status(500).json({ error: e.message || "stitch failed" });
  } finally {
    if (binaryResponseInProgress) return;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => console.log(`render server on ${PORT} (ffmpeg=${FFMPEG_BIN}, ffprobe=${FFPROBE_BIN}, version=${RENDER_SERVER_VERSION})`));
