import io, os, re, tempfile, urllib.request
from flask import Flask, request, send_file, jsonify, abort
import pdfgen, cover

app = Flask(__name__)
TOKEN = os.environ.get("API_TOKEN", "")

def check():
    if TOKEN and request.headers.get("X-Token") != TOKEN and request.args.get("token") != TOKEN:
        abort(401)

def fetch_drive(file_id):
    url = f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")

def pretty(name):
    name = re.sub(r"\.(txt|mp3|pdf)$", "", name or "", flags=re.I)
    name = re.sub(r"[-_]+", " ", name).strip()
    return name

@app.get("/")
def health():
    return jsonify(ok=True, service="neville-pdf-service")

@app.route("/pdf", methods=["GET", "POST"])
def pdf():
    check()
    d = request.get_json(silent=True) or request.values
    title = pretty(d.get("title", "Untitled"))
    raw = d.get("text") or fetch_drive(d["fileId"])
    if len(raw.strip()) < 200:
        abort(422)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        out = f.name
    pdfgen.build_from_text(raw, title, out)
    data = open(out, "rb").read(); os.unlink(out)
    return send_file(io.BytesIO(data), mimetype="application/pdf", download_name=f"{title}.pdf")

@app.route("/cover", methods=["GET", "POST"])
def cover_png():
    check()
    d = request.get_json(silent=True) or request.values
    title = pretty(d.get("title", "Untitled"))
    sub = d.get("subtitle") or cover.DEFAULT_SUB
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        out = f.name
    cover.generate(title, sub, out)
    data = open(out, "rb").read(); os.unlink(out)
    return send_file(io.BytesIO(data), mimetype="image/png", download_name=f"{title}.png")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
