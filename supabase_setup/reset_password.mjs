// 重置某个账号的密码（站主本地运行；service_role 只放环境变量）
// 用法：
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node reset_password.mjs 001
// 可选：AUTH_EMAIL_DOMAIN=eleven11.local（默认与前端一致）
// 输出一行新密码；同时会把 must_change_password 设回 true，让对方下次登录时自己改。

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOMAIN = process.env.AUTH_EMAIL_DOMAIN || "eleven11.local";
const account = process.argv[2];

if (!URL || !SERVICE_KEY) {
  console.error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!account) {
  console.error("用法：node reset_password.mjs 001");
  process.exit(1);
}

const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let password = "";
for (let i = 0; i < 10; i++) password += alphabet[crypto.randomInt(0, alphabet.length)];

const email = `${account}@${DOMAIN}`;
const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) throw error;
const user = (data.users || []).find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`没有找到账号：${email}`);
  process.exit(1);
}
const { error: upErr } = await admin.auth.admin.updateUserById(user.id, {
  password,
  user_metadata: { ...(user.user_metadata || {}), account, must_change_password: true },
});
if (upErr) throw upErr;
console.log(`${account} ${email} 新密码：${password}`);
console.log("把新密码单独发给对方；对方首次登录会被要求再改一次。");
