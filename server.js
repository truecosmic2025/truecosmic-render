const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (_req, res) => res.json({ ok: true, service: "truecosmic-ken-burns" }));

function buildZoompan(effect, durationSec) {
  const d = Math.max(1, Math.round(durationSec * 25));
  switch (effect) {
    case "zoom-in": return `zoompan=z='min(zoom+0.0015,1.5)':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "zoom-out": return `zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))':d=${d}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "pan-left": return `zoompan=z='1.2':d=${d}:x='iw/4+(iw/4*(on/${d}))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "pan-right": return `zoompan=z='1.2':d=${d}:x='iw-(iw/4+(iw/4*(on/${d})))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    case "diagonal": return `zoompan=z='min(zoom+0.001,1.3)':d=${d}:x='iw/4*(on/${d})':y='ih/4*(on/${d})':s=1920x1080:fps=25`;
    case "zoom-drift": return `zoompan=z='min(zoom+0.002,1.6)':d=${d}:x='iw/2-(iw/zoom/2)+(20*(on/${d}))':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25`;
    default: throw new Error(`Unknown effect: ${effect}`);
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
  const inPath = path.join(tmpDir, "in.jpg");
  const outPath = path.join(tmpDir, "out.mp4");
  try {
    const dl = await fetch(image_url);
    if (!dl.ok) throw new Error(`Image download failed (${dl.status})`);
    const buf = Buffer.from(await dl.arrayBuffer());
    fs.writeFileSync(inPath, buf);
    const dur = Math.max(1, parseInt(duration, 10) || 10);
    const zoompan = buildZoompan(effect, dur);
    await runFfmpeg(["-y","-loop","1","-framerate","25","-i",inPath,"-vf",`${zoompan},format=yuv420p`,"-t",String(dur),"-r","25","-c:v","libx264","-preset","veryfast","-crf","20","-movflags","+faststart",outPath]);
    const outBuf = fs.readFileSync(outPath);
    const base64 = outBuf.toString("base64");
    res.json({ ok: true, video_base64: base64, output_filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "render failed" });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => console.log(`Ken Burns render server listening on :${PORT}`));
