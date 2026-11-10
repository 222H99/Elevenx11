/*
 * 字卡网站 · 网易云登录/播放 同源后端
 * 运行：node server.js   （默认 http://127.0.0.1:8787，环境变量 PORT 可改）
 * 前端：index.html 里的音乐页只请求同源 /api/netease/*
 * 约束：网易云 Cookie 只存活在服务端会话里，绝不返回给前端、不写日志、不落前端存储
 */
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(ROOT, "data");
const SESSION_FILE = path.join(DATA_DIR, "sessions.json");
const SID_COOKIE = "wns_sid";
const QR_TTL = 300 * 1000; // 二维码有效期 5 分钟
const MAX_BODY = 8 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/* ---------------- 会话持久化 ---------------- */
let sessions = {};
try {
  if (fs.existsSync(SESSION_FILE)) sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) || {};
} catch (e) {
  sessions = {};
}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SESSION_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
      fs.renameSync(tmp, SESSION_FILE);
      try { fs.chmodSync(SESSION_FILE, 0o600); } catch (_) {}
    } catch (e) { /* 静默：不把内部细节吐给前端 */ }
  }, 60);
}

function newSid() {
  return crypto.randomBytes(24).toString("hex");
}

function getSid(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(SID_COOKIE + "=([a-f0-9]{32,})"));
  return m ? m[1] : null;
}

function ensureSession(req, res) {
  let sid = getSid(req);
  if (sid && sessions[sid]) return sessions[sid];
  sid = newSid();
  sessions[sid] = {
    id: sid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nmtid: "",
    cookie: "",          // 只存服务端，永不外发
    profile: null,       // {userId,nickname,avatarUrl}
    qr: null,            // {unikey,qrUrl,createdAt}
  };
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https");
  res.setHeader("Set-Cookie",
    SID_COOKIE + "=" + sid + "; Path=/api/netease/; HttpOnly; SameSite=Strict" + (secure ? "; Secure" : ""));
  persist();
  return sessions[sid];
}

function touch(s) { s.updatedAt = Date.now(); persist(); }

/* ---------------- 网易云请求 ---------------- */
const NM_ORIGIN = "https://music.163.com";

function nmHeaders(s, extra) {
  const h = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Referer": "https://music.163.com/",
    "Origin": "https://music.163.com",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Cookie": ["os=ios", "appver=9.1.0", s.nmtid ? "NMTID=" + s.nmtid : "", s.cookie].filter(Boolean).join("; "),
  };
  return Object.assign(h, extra || {});
}

function absorbCookies(s, res) {
  let list = [];
  try { if (typeof res.headers.getSetCookie === "function") list = res.headers.getSetCookie(); } catch (_) {}
  if (!list.length) {
    const one = res.headers.get("set-cookie");
    if (one) list = [one];
  }
  const jar = {};
  String(s.cookie || "").split(";").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  list.forEach((c) => {
    const first = String(c).split(";")[0];
    const i = first.indexOf("=");
    if (i <= 0) return;
    const k = first.slice(0, i).trim(), v = first.slice(i + 1).trim();
    if (k === "NMTID") { s.nmtid = v; return; }
    if (!v) return;
    jar[k] = v;
  });
  s.cookie = Object.keys(jar).map((k) => k + "=" + jar[k]).join("; ");
}

async function nmFetch(s, method, p, body) {
  const url = NM_ORIGIN + p;
  const opts = { method, headers: nmHeaders(s, body ? { "Content-Type": "application/x-www-form-urlencoded" } : null), redirect: "manual" };
  if (body) opts.body = body;
  const r = await fetch(url, opts);
  absorbCookies(s, r);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  /* 兼容：部分登录响应把 Cookie 塞在响应体里 */
  const m = text.match(/MUSIC_U=([A-Za-z0-9%_\-=]+)/);
  if (m) {
    const jar = String(s.cookie || "");
    if (!/MUSIC_U=/.test(jar)) s.cookie = (jar ? jar + "; " : "") + "MUSIC_U=" + m[1];
  }
  return { status: r.status, json, text };
}

function loggedIn(s) { return /MUSIC_U=/.test(s.cookie || ""); }

async function fetchProfile(s) {
  const r = await nmFetch(s, "GET", "/api/nuser/account/get?timestamp=" + Date.now());
  const d = r.json || {};
  if (d.code && d.code !== 200) return null;
  if (!d.profile) return null;
  s.profile = {
    userId: d.profile.userId,
    nickname: d.profile.nickname || "",
    avatarUrl: d.profile.avatarUrl || "",
  };
  return s.profile;
}

/* ---------------- 工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": res.__acao || "*",
    "Access-Control-Allow-Headers": "Content-Type, x-wns-client",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
  res.writeHead(code, h);
  res.end(body);
}

function sameOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return true; // 同源 JSON POST 通常不带 Origin 时也放行，但必须带自定义头
  try {
    const u = new URL(origin);
    const host = req.headers.host || "";
    if (u.host === host) return true;
    if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
        /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return true;
  } catch (_) {}
  return false;
}

async function readBody(req) {
  return new Promise((resolve) => {
    let size = 0, chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (_) { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

function isDigits(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= (max || 20) && /^\d+$/.test(v);
}

const ALLOW_HOST = [/(^|\.)music\.126\.net$/, /(^|\.)music\.163\.com$/, /(^|\.)m701\.music\.126\.net$/];
function safeMediaUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return "";
    if (x.username || x.password) return "";
    if (!ALLOW_HOST.some((re) => re.test(x.hostname))) return "";
    return x.toString();
  } catch (_) { return ""; }
}

/* ---------------- API 路由 ---------------- */
async function api(req, res, pathname) {
  if (req.method !== "POST") return json(res, 405, { code: 405, msg: "POST only" });
  /* 允许页面和接口不同源（比如页面托管在 CDN、后端在 Railway）：
     只要带 x-wns-client 自定义头即视为来自自家前端；同源请求照旧放行。 */
  if (req.headers["x-wns-client"] !== "1") return json(res, 403, { code: 403, msg: "forbidden" });
  const s = ensureSession(req, res);
  touch(s);

  if (pathname === "/api/netease/session") {
    if (loggedIn(s) && !s.profile) { try { await fetchProfile(s); } catch (_) {} }
    return json(res, 200, {
      code: 200,
      loggedIn: loggedIn(s),
      profile: s.profile || null,
      qrActive: !!(s.qr && Date.now() - s.qr.createdAt < QR_TTL),
    });
  }

  if (pathname === "/api/netease/qr/new") {
    if (loggedIn(s)) return json(res, 200, { code: 200, alreadyLoggedIn: true, profile: s.profile || null });
    if (s.qr && Date.now() - s.qr.createdAt < QR_TTL) {
      /* 刷新页面/重新进入不取消旧码 */
      return json(res, 200, { code: 200, unikey: s.qr.unikey, qrUrl: s.qr.qrUrl, reused: true });
    }
    const r = await nmFetch(s, "GET", "/api/login/qrcode/unikey?type=1&timestamp=" + Date.now());
    const key = r.json && r.json.unikey;
    if (!key) return json(res, 502, { code: 502, msg: "二维码获取失败" });
    s.qr = { unikey: key, qrUrl: "https://music.163.com/login?codekey=" + encodeURIComponent(key), createdAt: Date.now() };
    return json(res, 200, { code: 200, unikey: key, qrUrl: s.qr.qrUrl, reused: false });
  }

  if (pathname === "/api/netease/qr/check") {
    if (!s.qr) return json(res, 200, { code: 800, msg: "二维码已取消" });
    if (Date.now() - s.qr.createdAt > QR_TTL) {
      const dead = s.qr.unikey; s.qr = null;
      return json(res, 200, { code: 800, msg: "二维码已过期", unikey: dead });
    }
    const r = await nmFetch(s, "GET",
      "/api/login/qrcode/client/login?key=" + encodeURIComponent(s.qr.unikey) + "&type=1&timestamp=" + Date.now());
    const code = (r.json && r.json.code) || 800;
    if (code === 803) {
      /* 授权成功：先确保 Cookie 已安全保存，再查资料；资料失败也不回滚授权 */
      const saved = loggedIn(s);
      let profile = null, profileError = false;
      try { profile = await fetchProfile(s); } catch (_) { profileError = true; }
      if (!profile && !profileError) profileError = true;
      s.qr = null;
      return json(res, 200, {
        code: 803,
        loggedIn: saved,
        profile,
        profileError: !!profileError,
        msg: profileError ? "授权已保存，账号资料稍后重试" : "登录成功",
      });
    }
    if (code === 800) s.qr = null;
    const msg = code === 801 ? "等待扫码" : code === 802 ? "已扫码，请在手机上确认" : "二维码已过期";
    return json(res, 200, { code, msg, profile: null });
  }

  if (pathname === "/api/netease/qr/cancel") {
    s.qr = null;
    return json(res, 200, { code: 200, msg: "已取消" });
  }

  if (pathname === "/api/netease/logout") {
    s.qr = null; s.cookie = ""; s.profile = null;
    return json(res, 200, { code: 200, msg: "已退出登录" });
  }

  if (pathname === "/api/netease/playlists") {
    if (!loggedIn(s)) return json(res, 403, { code: 403, msg: "未登录" });
    const prof = s.profile && s.profile.userId;
    if (!prof) { try { await fetchProfile(s); } catch (_) {} }
    const uid = s.profile && s.profile.userId;
    if (!uid) return json(res, 502, { code: 502, msg: "账号信息不可用" });
    const r = await nmFetch(s, "GET", "/api/user/playlist?uid=" + uid + "&limit=1000&offset=0&timestamp=" + Date.now());
    const d = r.json || {};
    if (d.code && d.code !== 200) return json(res, 502, { code: 502, msg: "歌单获取失败" });
    const list = (d.playlist || []).map((p) => ({
      id: String(p.id), name: p.name || "", cover: p.coverImgUrl || "", trackCount: p.trackCount || 0, creator: (p.creator && p.creator.nickname) || "",
    }));
    return json(res, 200, { code: 200, playlists: list });
  }

  if (pathname === "/api/netease/playlist/tracks") {
    const body = await readBody(req);
    if (!body || !isDigits(String(body.id), 20)) return json(res, 400, { code: 400, msg: "歌单 ID 无效" });
    if (!loggedIn(s)) return json(res, 403, { code: 403, msg: "未登录" });
    const r = await nmFetch(s, "GET", "/api/playlist/detail?id=" + body.id + "&timestamp=" + Date.now());
    const d = r.json || {};
    if (d.code && d.code !== 200) return json(res, 502, { code: 502, msg: "歌单读取失败" });
    const pl = d.playlist || {};
    const tracks = (pl.tracks || []).map((t) => ({
      id: String(t.id),
      name: t.name || "",
      artist: (t.ar || t.artists || []).map((a) => a.name).filter(Boolean).join(" / "),
      album: (t.al || t.album || {}).name || "",
      duration: t.dt || t.duration || 0,
      fee: typeof t.fee === "number" ? t.fee : 0,
    }));
    return json(res, 200, { code: 200, name: pl.name || "", tracks });
  }

  if (pathname === "/api/netease/search") {
    const body = await readBody(req);
    const q = String((body && body.q) || "").trim().slice(0, 60);
    if (!q) return json(res, 400, { code: 400, msg: "关键词为空" });
    const limit = Math.min(30, Math.max(1, Number(body && body.limit) || 20));
    const r = await nmFetch(s, "GET", "/api/cloudsearch/pc?s=" + encodeURIComponent(q) + "&type=1&limit=" + limit + "&offset=0&timestamp=" + Date.now());
    const d = r.json || {};
    if (d.code && d.code !== 200) return json(res, 502, { code: 502, msg: "搜索接口异常" });
    const songs = ((d.result && (d.result.songs || d.result.songCount && d.result.songs)) || []).map((t) => ({
      id: String(t.id),
      name: t.name || "",
      artist: (t.ar || t.artists || []).map((a) => a.name).filter(Boolean).join(" / "),
      album: (t.al || t.album || {}).name || "",
      cover: (t.al || {}).picUrl || (t.album && t.album.picUrl) || "",
    }));
    return json(res, 200, { code: 200, songs });
  }

  if (pathname === "/api/netease/search") {
    const body = await readBody(req);
    const kw = String((body && (body.keywords || body.q)) || "").trim();
    if (!kw) return json(res, 400, { code: 400, msg: "搜索关键词不能为空" });
    if (!loggedIn(s)) return json(res, 403, { code: 403, msg: "未登录" });
    const limit = Math.min(30, Math.max(1, Number((body && body.limit) || 20)));
    const r = await nmFetch(s, "GET",
      "/api/search/get/web?csrf_token=&s=" + encodeURIComponent(kw) + "&type=1&offset=0&limit=" + limit + "&timestamp=" + Date.now());
    const d = r.json || {};
    if (d.code && d.code !== 200) return json(res, 502, { code: 502, msg: "搜索接口异常" });
    const raw = (d.result && (d.result.songs || d.result.song)) || [];
    const songs = raw.map((t) => ({
      id: String(t.id),
      name: t.name || "",
      artist: (t.ar || t.artists || []).map((a) => a.name).filter(Boolean).join(" / "),
      album: (t.al || t.album || {}).name || "",
      cover: (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || (t.album && t.album.artist && t.album.artist.img1v1Url) || "",
      duration: t.dt || t.duration || 0,
      fee: typeof t.fee === "number" ? t.fee : 0,
    })).filter((t) => t.id && t.name);
    return json(res, 200, { code: 200, keywords: kw, songs });
  }

  if (pathname === "/api/netease/song/url") {
    const body = await readBody(req);
    if (!body || !isDigits(String(body.id), 20)) return json(res, 400, { code: 400, msg: "歌曲 ID 无效" });
    if (!loggedIn(s)) return json(res, 403, { code: 403, msg: "未登录" });
    let last = null;
    for (const br of [320000, 192000, 128000]) {
      const r = await nmFetch(s, "GET",
        "/api/song/enhance/player/url?ids=[" + body.id + "]&br=" + br + "&timestamp=" + Date.now());
      const d = r.json || {};
      if (d.code && d.code !== 200) { last = { status: 502, msg: "网易云播放接口异常" }; continue; }
      const one = (d.data || [])[0] || {};
      const url = safeMediaUrl(one.url || "");
      if (!url) {
        last = { trial: !!one.freeTrialInfo, status: 200 };
        if (one.freeTrialInfo) {
          return json(res, 200, { code: 200, trial: true, url: "", br, fee: one.fee || 0, freeTrialInfo: one.freeTrialInfo, msg: "当前账号只有试听权限" });
        }
        continue;
      }
      return json(res, 200, { code: 200, url, br, fee: one.fee || 0, trial: false });
    }
    if (last && last.trial) return json(res, 200, { code: 200, trial: true, url: "", msg: "当前账号只有试听权限" });
    return json(res, 403, { code: 403, msg: "当前账号没有这首歌曲的播放权限" });
  }

  return json(res, 404, { code: 404, msg: "not found" });
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  if (path.basename(file).startsWith(".") || file.startsWith(DATA_DIR)) { res.writeHead(404); return res.end("not found"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

/* ---------------- 手机登录页（二维码 + 本机唤起） ---------------- */
function loginPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>登录网易云 · ECHO SETTLE</title>
<style>
body{margin:0;background:#f6f7f9;font-family:-apple-system,"PingFang SC",sans-serif;color:#1c1c1e;display:flex;min-height:100vh;flex-direction:column;align-items:center;padding:32px 18px;box-sizing:border-box;}
h1{font-size:19px;margin:0 0 6px;}
p.sub{font-size:13px;color:#8e8e93;margin:0 0 22px;text-align:center;line-height:1.6;}
.card{background:#fff;border-radius:18px;padding:22px;box-shadow:0 6px 24px rgba(0,0,0,.06);width:100%;max-width:340px;text-align:center;}
img.qr{width:220px;height:220px;border-radius:12px;background:#fff;}
a.big{display:block;margin-top:16px;background:#3478f6;color:#fff;text-decoration:none;padding:13px;border-radius:12px;font-size:15px;font-weight:600;}
.tip{font-size:12px;color:#8e8e93;margin-top:12px;line-height:1.6;}
.status{margin-top:14px;font-size:13px;color:#3478f6;min-height:18px;}
button.ghost{margin-top:14px;border:1px solid rgba(0,0,0,.12);background:#fff;color:#1c1c1e;padding:10px 16px;border-radius:12px;font-size:13px;}
</style></head><body>
<h1>网易云登录</h1>
<p class="sub">用同一台手机：点下面蓝色按钮，会直接唤起网易云 App 授权<br>有另一台设备：用网易云 App 扫上面的二维码</p>
<div class="card">
  <img class="qr" id="qr" alt="二维码">
  <a class="big" id="openapp" href="#">在本机网易云 App 打开</a>
  <div class="status" id="st">正在获取二维码…</div>
  <div class="tip">登录成功后这个页面会变成绿色“已登录”，直接回 App 用就行。</div>
  <button class="ghost" id="again">换一个二维码</button>
</div>
<script>
var QR="https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=";
var key="",timer=null;
function ui(t,ok){var e=document.getElementById("st");e.textContent=t;e.style.color=ok?"#2e9f5c":"#3478f6";}
function poll(){
  if(!key)return;
  fetch("/api/netease/qr/check",{method:"POST",headers:{"Content-Type":"application/json","x-wns-client":"1"},body:JSON.stringify({unikey:key})})
   .then(function(r){return r.json();})
   .then(function(d){
     if(d.code===803||d.loggedIn){ui("已登录，回 App 听歌吧",true);clearInterval(timer);return;}
     if(d.code===802){ui("已扫码，请在手机上确认",false);return;}
     if(d.code===800){ui("二维码已过期，点下面换一个",false);clearInterval(timer);return;}
   }).catch(function(){});
}
function newQR(){
  ui("正在获取二维码…");
  fetch("/api/netease/qr/new",{method:"POST",headers:{"Content-Type":"application/json","x-wns-client":"1"},body:"{}"})
   .then(function(r){return r.json();})
   .then(function(d){
     if(d.alreadyLoggedIn){ui("这个设备已经登录过了",true);return;}
     if(!d.qrUrl){ui(d.msg||"二维码获取失败");return;}
     key=d.unikey||"";
     document.getElementById("qr").src=QR+encodeURIComponent(d.qrUrl);
     document.getElementById("openapp").href=d.qrUrl;
     ui("等待扫码或唤起 App…");
     clearInterval(timer);timer=setInterval(poll,2000);
   }).catch(function(){ui("网络异常，点下面重试");});
}
document.getElementById("again").addEventListener("click",newQR);
newQR();
</script></body></html>`;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = url.pathname;
  if (p === "/login" || p === "/login/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(loginPage());
  }
  if (p === "/" || p === "") {
    res.writeHead(302, { Location: "/index.html" });
    return res.end();
  }
  if (p.startsWith("/api/netease/")) {
    res.__acao = req.headers.origin || "*";
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": res.__acao,
        "Access-Control-Allow-Headers": "Content-Type, x-wns-client",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Max-Age": "86400" });
      return res.end("");
    }
    api(req, res, p).catch(() => json(res, 502, { code: 502, msg: "网易云服务异常" }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end("method not allowed"); }
  serveStatic(req, res, p);
});

server.listen(PORT, () => {
  console.log("字卡网站已启动：http://127.0.0.1:" + PORT + "/index.html");
  console.log("网易云接口：同源 /api/netease/*（Cookie 仅存服务端 data/sessions.json）");
});
