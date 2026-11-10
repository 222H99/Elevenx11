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
const QR_TTL = 100 * 1000; // 二维码有效期 100 秒（网易云侧约 2 分钟就失效，缓存更久会扫出“授权失败”）
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
  /* 跨域托管（页面在 GitHub Pages 等）时，浏览器不给带 Cookie，改用 x-wns-sid 头 */
  const hs = String(req.headers["x-wns-sid"] || "").trim();
  if (/^[a-f0-9]{32,}$/.test(hs)) return hs;
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
  if (res.__sid && !obj.sid) obj.sid = res.__sid;
  const body = JSON.stringify(obj);
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": res.__acao || "*",
    "Access-Control-Allow-Headers": "Content-Type, x-wns-client, x-wns-sid",
    "Access-Control-Expose-Headers": "x-wns-sid",
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
  res.__sid = s.id;
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
/* ---------- 服务端二维码（SVG，不依赖外网图床） ---------- */
var __qrlib = (function(){
var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}(function(){return qrcode});
return (typeof qrcode !== "undefined") ? qrcode : null;
})();
function qrSvg(data){
  try {
    if (typeof __qrlib !== "function") return null;
    var q = __qrlib(0, "M"); q.addData(String(data)); q.make();
    return q.createSvgTag({ cellSize: 8, margin: 6, scalable: true });
  } catch (e) { return null; }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const p = url.pathname;
  if (p === "/login" || p === "/login/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(loginPage());
  }
  if (p === "/" || p === "") {
    /* 根地址直接返回首页内容，并明确禁止缓存：永远拿最新版 */
    try {
      const buf = fs.readFileSync(path.join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0" });
      return res.end(buf);
    } catch (e) { res.writeHead(500); return res.end("index missing"); }
  }
  if (p === "/qr.svg") {
    const data = url.searchParams.get("data") || "";
    const svg = qrSvg(data);
    if (!svg) { res.writeHead(500); return res.end("qr fail"); }
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(svg);
  }
  if (p === "/diag") {
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>自检</title>
<style>body{background:#111;color:#ddd;font:15px/1.6 -apple-system,sans-serif;padding:18px}h3{color:#fff;margin:18px 0 6px}
pre{background:#1b1b1e;padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:13px}
.ok{color:#54d17a}.bad{color:#ff6b6b}</style></head><body>
<h3>自检页面</h3><div id="log"></div>
<script>
var out=document.getElementById('log');
function p(t,c){var d=document.createElement('div');d.className=c||'';d.textContent=t;out.appendChild(d);}
function show(t,c){var pre=document.createElement('pre');pre.className=c||'';pre.textContent=t;out.appendChild(pre);}
p('当前地址：'+location.href);
p('页面来源：'+location.origin);
p('协议：'+location.protocol);
(function(){
  var t0=Date.now();
  fetch('/api/netease/session',{method:'POST',mode:'cors',headers:{'Content-Type':'application/json','x-wns-client':'1'},body:'{}'})
   .then(function(r){return r.text().then(function(txt){
      p('接口 /api/netease/session → HTTP '+r.status+'（用时 '+((Date.now()-t0)/1000).toFixed(2)+'s）', r.ok?'ok':'bad');
      show(txt.slice(0,600));
    });})
   .catch(function(e){p('接口请求失败：'+(e&&e.message||e),'bad');});
})();
</script></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }
  if (p === "/x" || p === "/x/") {
    /* 备用入口：任何浏览器都不会命中旧缓存 */
    try {
      const buf = fs.readFileSync(path.join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" });
      return res.end(buf);
    } catch (e) { res.writeHead(404); return res.end("not found"); }
  }
  if (p.startsWith("/api/netease/")) {
    res.__acao = req.headers.origin || "*";
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": res.__acao,
        "Access-Control-Allow-Headers": "Content-Type, x-wns-client, x-wns-sid",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Max-Age": "86400" });
      return res.end("");
    }
    api(req, res, p).catch(() => json(res, 502, { code: 502, msg: "网易云服务异常" }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end("method not allowed"); }
  /* 兜底：任何打错的网址都直接给最新首页（禁止缓存），避免用户看到旧版 */
  if (req.method === "GET" && !p.startsWith("/api/")) {
    try {
      const buf = fs.readFileSync(path.join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0" });
      return res.end(buf);
    } catch (e) {}
  }
  serveStatic(req, res, p);
});

server.listen(PORT, () => {
  console.log("字卡网站已启动：http://127.0.0.1:" + PORT + "/index.html");
  console.log("网易云接口：同源 /api/netease/*（Cookie 仅存服务端 data/sessions.json）");
});
