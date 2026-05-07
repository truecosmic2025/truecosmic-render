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
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Requires `ffmpeg` binary in the container (Railway nixpacks: add `ffmpeg`).
 */

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({ ok: true, service: "truecosmic-ken-burns" }));

/**
 * FFmpeg zoompan filters per effect.
 * d=125 = 5 seconds at 25fps. We override `d` based on requested duration.
 */
function buildZoompan(effect, durationSec) {
  const d = Math.max(1, Math.round(durationSec * 25));
  switch (effect) {
    case "zoom-in":
      return `zoompan=z='min(zoom+0.0015,1.5)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "zoom-out":
      return `zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "pan-left":
      return `zoompan=z='1.2':d=${d}:x='iw/4+(iw/4*(on/${d}))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "pan-right":
      return `zoompan=z='1.2':d=${d}:x='iw-(iw/4+(iw/4*(on/${d})))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "diagonal":
      return `zoompan=z='min(zoom+0.001,1.3)':d=${d}:x='iw/4*(on/${d})':y='ih/4*(on/${d})':s=1920x1080:fps=25`;
    case "zoom-drift":
      return `zoompan=z='min(zoom+0.002,1.6)':d=${d}:x='iw/2-(iw/zoom/2)+(20*(on/${d}))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    default:
      throw new Error(`Unknown effect: ${effect}`);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

app.post("/ken-burns", async (req, res) => {
  const { image_url, duration = 10, output_filename, effect } = req.body || {};
  if (!image_url || !output_filename || !effect) {
    return res.status(400).json({ error: "image_url, output_filename, effect required" });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  const cleanUrl = image_url.split("?")[0];
  const lastSeg = cleanUrl.substring(cleanUrl.lastIndexOf("/") + 1);
  const extMatch = lastSeg.match(/\.([a-zA-Z0-9]{1,5})$/);
  const inExt = (extMatch ? extMatch[1] : "jpg").toLowerCase();
  const inPath = path.join(tmpDir, `in.${inExt}`);
  const outPath = path.join(tmpDir, `out.mp4`);

  try {
    const dl = await fetch(image_url);
    if (!dl.ok) throw new Error(`Image download failed (${dl.status})`);
    const buf = Buffer.from(await dl.arrayBuffer());
    fs.writeFileSync(inPath, buf);

    const dur = Math.max(1, parseInt(duration, 10) || 10);
    const zoompan = buildZoompan(effect, dur);

    await runFfmpeg([
      "-y",
      "-loop", "1",
      "-framerate", "25",
      "-i", inPath,
      "-vf", `${zoompan},format=yuv420p`,
      "-t", String(dur),
      "-r", "25",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
      outPath,
    ]);

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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => console.log(`Ken Burns render server listening on :${PORT}`));
