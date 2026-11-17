// 批量创建 001–050（服务端脚本；service_role 只放本机环境变量，绝不放网页/仓库）
//
// 1) npm i @supabase/supabase-js
// 2) 设置环境变量：
//    SUPABASE_URL=https://xxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY=...
//    AUTH_EMAIL_DOMAIN=eleven11.local   # 前端默认域；如 Supabase 拒绝，改成 eleven11.app
// 3) node create_accounts.mjs
//
// 默认给每个账号生成独立的随机初始密码，并标记 must_change_password=true。
// 产出 accounts.csv：账号,登录邮箱,初始密码,状态。CSV 含密码，自己保存，不发群、不提交仓库。
// 如果你想用统一密码，显式设置 INITIAL_PASSWORD=...（不推荐，知道一个就能试所有人）。

import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOMAIN = process.env.AUTH_EMAIL_DOMAIN || "eleven11.local";
const FIXED_PASSWORD = process.env.INITIAL_PASSWORD || "";
const START = Number(process.env.ACCOUNT_START || 1);
const END = Number(process.env.ACCOUNT_END || 50);

if (!URL || !SERVICE_KEY) {
  console.error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(URL)) {
  console.error("SUPABASE_URL 应形如 https://xxxx.supabase.co");
  process.exit(1);
}

const admin = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const pad = (n) => String(n).padStart(3, "0");
const accounts = [];
for (let i = START; i <= END; i++) accounts.push(pad(i));

/* 10 位随机密码：去掉容易混淆的 0/O/1/l/I，约 57 bit 熵 */
function newPassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

async function existingByEmail(email) {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return (data?.users || []).find((u) => (u.email || "").toLowerCase() === email.toLowerCase()) || null;
}

async function ensureAccount(account, password) {
  const email = `${account}@${DOMAIN}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { account, must_change_password: true },
  });
  if (!error && data?.user) return { user: data.user, created: true };

  const old = await existingByEmail(email);
  if (!old) throw error || new Error(`创建失败：${email}`);
  const { data: updated, error: upErr } = await admin.auth.admin.updateUserById(old.id, {
    password,
    email_confirm: true,
    user_metadata: { ...(old.user_metadata || {}), account, must_change_password: true },
  });
  if (upErr) throw upErr;
  return { user: updated?.user || old, created: false };
}

async function ensureProfile(user, account) {
  const { error } = await admin.from("profiles").upsert({
    id: user.id,
    account,
    nickname: account,
    status: "active",
  });
  if (error) throw new Error(`profiles 写入失败：${error.message}`);
}

const rows = [["账号", "登录邮箱", "初始密码", "状态"]];
let ok = 0, fail = 0;

for (const account of accounts) {
  const password = FIXED_PASSWORD || newPassword();
  try {
    const { user, created } = await ensureAccount(account, password);
    await ensureProfile(user, account);
    rows.push([account, `${account}@${DOMAIN}`, password, created ? "新建" : "已存在/已重置"]);
    ok++;
    // 不在终端打印密码，只打印账号与状态；密码只进本地 CSV
    console.log(`${account}  ${created ? "新建" : "已存在，已重置"}  ${account}@${DOMAIN}`);
  } catch (e) {
    fail++;
    rows.push([account, `${account}@${DOMAIN}`, "", "失败：" + (e?.message || "unknown")]);
    console.error(`${account} 失败：${e?.message || e}`);
  }
}

const csv = "\uFEFF" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
fs.writeFileSync(new URL("./accounts.csv", import.meta.url), csv, "utf8");

console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
console.log("账号密码表：supabase_setup/accounts.csv（含密码，别外发）");
if (fail) process.exitCode = 1;
