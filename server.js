// FCS Site QA – cloud server (Ample). One shared site password; data in Postgres, files in a private bucket.
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const yauzl = require("yauzl");

const PORT = process.env.PORT || 8080;
const PASSWORD = process.env.SITE_PASSWORD || "";
const ADMIN = process.env.ADMIN_TOKEN || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const BUCKET = process.env.S3_BUCKET;
const QUOTA = Number(process.env.STORAGE_QUOTA_BYTES || 900 * 1024 * 1024);
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "auto", forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_KEY || "", secretAccessKey: process.env.S3_SECRET || "" },
});
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=disable/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false }, max: 5 });

const APP_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, "public", "login.html"), "utf8");
const IMPORT_HTML = fs.readFileSync(path.join(__dirname, "public", "import.html"));
const LOGO = fs.existsSync(path.join(__dirname, "public", "logo.png")) ? fs.readFileSync(path.join(__dirname, "public", "logo.png")) : null;

async function migrate() {
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS doc_seq;
    CREATE TABLE IF NOT EXISTS docs (col text NOT NULL, id text NOT NULL, data jsonb, deleted boolean NOT NULL DEFAULT false,
      seq bigint NOT NULL DEFAULT nextval('doc_seq'), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (col, id));
    CREATE INDEX IF NOT EXISTS docs_seq ON docs (seq);
    CREATE TABLE IF NOT EXISTS files (aid text PRIMARY KEY, size bigint NOT NULL, type text, created_at timestamptz NOT NULL DEFAULT now());`);
}

// ---- auth ----
const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
function makeCookie() { const exp = Date.now() + 30 * 864e5; const v = "ok." + exp; return v + "." + sign(v); }
function authed(req) {
  const c = (req.headers.cookie || "").split(/;\s*/).find(x => x.startsWith("fcsqa="));
  if (!c) return false;
  const v = decodeURIComponent(c.slice(6)); const i = v.lastIndexOf(".");
  if (i < 0) return false;
  const body = v.slice(0, i), mac = v.slice(i + 1), exp = Number(body.split(".")[1]);
  const a = Buffer.from(mac), b = Buffer.from(sign(body));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && exp > Date.now();
}
const isAdmin = req => ADMIN && req.headers["x-admin-token"] === ADMIN;
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ---- helpers ----
function send(res, code, body, type = "application/json", extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ "Content-Type": type, "Content-Length": buf.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, extra));
  res.end(buf);
}
function readBody(req, limit) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > limit) { bad(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else parts.push(d); });
    req.on("end", () => ok(Buffer.concat(parts))); req.on("error", bad);
  });
}
const COLS = new Set(["itrs", "mivs", "ncrs", "defects", "packs", "settings"]);
const okId = s => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s);
async function usedBytes() { const r = await pool.query("SELECT coalesce(sum(size),0)::bigint AS b, count(*)::int AS n FROM files"); return { bytes: Number(r.rows[0].b), files: r.rows[0].n }; }

async function putFile(aid, buf, type) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: "files/" + aid, Body: buf, ContentType: type || "application/octet-stream" }));
  await pool.query("INSERT INTO files (aid,size,type) VALUES ($1,$2,$3) ON CONFLICT (aid) DO UPDATE SET size=$2, type=$3", [aid, buf.length, type]);
}
const typeOf = n => /\.pdf$/i.test(n) ? "application/pdf" : /\.png$/i.test(n) ? "image/png" : /\.jpe?g$/i.test(n) ? "image/jpeg" : /\.webp$/i.test(n) ? "image/webp" : /\.csv$/i.test(n) ? "text/csv" : "application/octet-stream";

// Unpack a zip already in the bucket (key) into files/<aid>; entry names are "<aid>.<ext>". Deletes the zip afterwards.
async function unpack(key) {
  const tmp = path.join(os.tmpdir(), "u" + Date.now() + ".zip");
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await new Promise((ok, bad) => { const w = fs.createWriteStream(tmp); obj.Body.pipe(w); w.on("finish", ok); w.on("error", bad); obj.Body.on("error", bad); });
  let n = 0, bytes = 0, skipped = [];
  await new Promise((ok, bad) => {
    yauzl.open(tmp, { lazyEntries: true }, (err, zip) => {
      if (err) return bad(err);
      zip.readEntry();
      zip.on("entry", e => {
        const m = path.basename(e.fileName).match(/^([0-9a-f]{32})(\.[a-z0-9]+)?$/i);
        if (!m || /\/$/.test(e.fileName)) { if (!/\/$/.test(e.fileName)) skipped.push(e.fileName); zip.readEntry(); return; }
        zip.openReadStream(e, (er, rs) => {
          if (er) return bad(er);
          const parts = []; rs.on("data", d => parts.push(d));
          rs.on("end", async () => { try { const b = Buffer.concat(parts); await putFile(m[1].toLowerCase(), b, typeOf(e.fileName)); n++; bytes += b.length; zip.readEntry(); } catch (x) { bad(x); } });
          rs.on("error", bad);
        });
      });
      zip.on("end", ok); zip.on("error", bad);
    });
  });
  fs.unlinkSync(tmp);
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return { files: n, bytes, skipped };
}

// ---- routes ----
async function handle(req, res) {
  const u = new URL(req.url, "http://x"); const p = u.pathname;

  if (p === "/healthz") return send(res, 200, { ok: true });
  if (p === "/logo.png" && LOGO) return send(res, 200, LOGO, "image/png", { "Cache-Control": "public, max-age=86400" });

  // admin (token) — used once to import data from the claude.ai app
  if (p.startsWith("/admin/")) {
    if (!isAdmin(req)) return send(res, 403, { error: "forbidden" });
    if (p === "/admin/import" && req.method === "POST") {
      const docs = JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString("utf8"));
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const d of docs) {
          if (!COLS.has(d.col) || !okId(d.id)) continue;
          await c.query("INSERT INTO docs (col,id,data,deleted,seq,updated_at) VALUES ($1,$2,$3,false,nextval('doc_seq'),now()) ON CONFLICT (col,id) DO UPDATE SET data=$3, deleted=false, seq=nextval('doc_seq'), updated_at=now()", [d.col, d.id, d.data]);
        }
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
      return send(res, 200, { imported: docs.length });
    }
    if (p === "/admin/unpack" && req.method === "POST") {
      const { key } = JSON.parse((await readBody(req, 4096)).toString("utf8"));
      if (!/^incoming\/[A-Za-z0-9_.-]+\.zip$/.test(key || "")) return send(res, 400, { error: "bad key" });
      return send(res, 200, await unpack(key));
    }
    if (p === "/admin/stats") {
      const r = await pool.query("SELECT col, count(*)::int AS n FROM docs WHERE NOT deleted GROUP BY col ORDER BY col");
      return send(res, 200, { docs: r.rows, files: await usedBytes() });
    }
    if (p === "/admin/files") { const r = await pool.query("SELECT aid,size FROM files ORDER BY aid"); return send(res, 200, r.rows); }
    return send(res, 404, { error: "not found" });
  }

  // login
  if (p === "/login") {
    if (req.method === "POST") {
      const f = new URLSearchParams((await readBody(req, 4096)).toString("utf8"));
      await new Promise(r => setTimeout(r, 400));
      if (PASSWORD && safeEq(f.get("password") || "", PASSWORD))
        return send(res, 303, "", "text/plain", { Location: "/", "Set-Cookie": `fcsqa=${encodeURIComponent(makeCookie())}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax` });
      return send(res, 401, LOGIN_HTML.replace("<!--ERR-->", '<p class="err" role="alert">That password isn’t right. Check it and try again.</p>'), "text/html; charset=utf-8");
    }
    return send(res, 200, LOGIN_HTML, "text/html; charset=utf-8");
  }
  if (p === "/logout") return send(res, 303, "", "text/plain", { Location: "/login", "Set-Cookie": "fcsqa=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });

  if (!authed(req)) {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) return send(res, 401, { error: "login" });
    return send(res, 303, "", "text/plain", { Location: "/login" });
  }

  if (p === "/" || p === "/index.html") return send(res, 200, APP_HTML, "text/html; charset=utf-8");
  if (p === "/import") return send(res, 200, IMPORT_HTML, "text/html; charset=utf-8");

  // one-off import of records and files exported from the claude.ai app
  if (p === "/api/import/have") { const r = await pool.query("SELECT aid FROM files"); const d = await pool.query("SELECT col, count(*)::int AS n FROM docs WHERE NOT deleted GROUP BY col"); return send(res, 200, { files: r.rows.map(x => x.aid), docs: d.rows, usage: await usedBytes(), quota: QUOTA }); }
  if (p === "/api/import/docs" && req.method === "POST") {
    const docs = JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString("utf8"));
    if (!Array.isArray(docs)) return send(res, 400, { error: "expected a list" });
    const c = await pool.connect(); let n = 0;
    try {
      await c.query("BEGIN");
      for (const d of docs) {
        if (!d || !COLS.has(d.col) || !okId(String(d.id)) || typeof d.data !== "object") continue;
        await c.query("INSERT INTO docs (col,id,data,deleted,seq,updated_at) VALUES ($1,$2,$3,false,nextval('doc_seq'),now()) ON CONFLICT (col,id) DO UPDATE SET data=$3, deleted=false, seq=nextval('doc_seq'), updated_at=now()", [d.col, String(d.id), d.data]); n++;
      }
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    return send(res, 200, { imported: n });
  }
  let im = p.match(/^\/api\/import\/file\/([0-9a-f]{32})$/);
  if (im && req.method === "PUT") {
    const type = typeOf(String(u.searchParams.get("name") || "")) || "application/octet-stream";
    const buf = await readBody(req, 25 * 1024 * 1024);
    const used = await usedBytes();
    const had = await pool.query("SELECT size FROM files WHERE aid=$1", [im[1]]);
    if (used.bytes - (had.rows[0] ? Number(had.rows[0].size) : 0) + buf.length > QUOTA) return send(res, 507, { error: "storage_full", message: "Cloud storage is full." });
    await putFile(im[1], buf, type);
    return send(res, 200, { ok: true, size: buf.length });
  }

  // data
  if (p === "/api/all") {
    const r = await pool.query("SELECT col,id,data FROM docs WHERE NOT deleted");
    const s = await pool.query("SELECT coalesce(max(seq),0)::bigint AS s FROM docs");
    const f = await pool.query("SELECT aid FROM files");
    return send(res, 200, { seq: Number(s.rows[0].s), docs: r.rows, files: f.rows.map(x => x.aid) });
  }
  if (p === "/api/changes") {
    const since = Number(u.searchParams.get("since") || 0);
    const r = await pool.query("SELECT col,id,data,deleted,seq FROM docs WHERE seq > $1 ORDER BY seq", [since]);
    const s = r.rows.length ? Number(r.rows[r.rows.length - 1].seq) : since;
    return send(res, 200, { seq: s, changes: r.rows.map(x => ({ col: x.col, id: x.id, data: x.deleted ? null : x.data, deleted: x.deleted })) });
  }
  let m = p.match(/^\/api\/doc\/([a-z]+)\/([^/]+)$/);
  if (m) {
    const col = m[1], id = decodeURIComponent(m[2]);
    if (!COLS.has(col) || !okId(id)) return send(res, 400, { error: "bad path" });
    if (req.method === "PUT") {
      const data = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString("utf8"));
      await pool.query("INSERT INTO docs (col,id,data,deleted,seq,updated_at) VALUES ($1,$2,$3,false,nextval('doc_seq'),now()) ON CONFLICT (col,id) DO UPDATE SET data=$3, deleted=false, seq=nextval('doc_seq'), updated_at=now()", [col, id, data]);
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      await pool.query("UPDATE docs SET deleted=true, data=null, seq=nextval('doc_seq'), updated_at=now() WHERE col=$1 AND id=$2", [col, id]);
      return send(res, 200, { ok: true });
    }
  }

  // files
  if (p === "/api/assets" && req.method === "POST") {
    const type = String(u.searchParams.get("type") || "application/octet-stream").slice(0, 100);
    const buf = await readBody(req, 20 * 1024 * 1024);
    const used = await usedBytes();
    if (used.bytes + buf.length > QUOTA) return send(res, 507, { error: "storage_full", message: "Cloud storage is full." });
    const aid = crypto.randomBytes(16).toString("hex");
    await putFile(aid, buf, type);
    return send(res, 200, { id: aid, contentType: type, size: buf.length });
  }
  if (p === "/api/assets" && req.method === "GET") {
    const used = await usedBytes();
    return send(res, 200, { usage: { files: used.files, bytes: used.bytes, max_files: 5000, max_bytes: QUOTA }, assets: [] });
  }
  m = p.match(/^\/api\/assets\/([0-9a-f]{32})$/);
  if (m && req.method === "DELETE") {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "files/" + m[1] })).catch(() => {});
    await pool.query("DELETE FROM files WHERE aid=$1", [m[1]]);
    return send(res, 200, { ok: true });
  }
  m = p.match(/^\/_blob\/([0-9a-f]{32})$/);
  if (m) {
    const r = await pool.query("SELECT size,type FROM files WHERE aid=$1", [m[1]]);
    if (!r.rows.length) return send(res, 404, { error: "not in cloud" });
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "files/" + m[1] }));
    res.writeHead(200, { "Content-Type": r.rows[0].type || "application/octet-stream", "Content-Length": r.rows[0].size, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    obj.Body.pipe(res); return;
  }
  return send(res, 404, { error: "not found" });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(req.method, req.url, e); if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? "too large" : "server error" }); else res.end(); });
}).listen(PORT, async () => {
  try { await migrate(); console.log("FCS Site QA cloud listening on", PORT); } catch (e) { console.error("migrate failed", e); }
});
