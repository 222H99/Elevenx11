# Eleven×11 账号后端：Supabase Auth + 每账号私有 Storage

目标：站主把账号发给别人登录；每个账号只能读自己的云端存档，网页里没有任何“查看别人数据”的入口。

这不是端到端加密。**站主持有 Supabase `service_role` 时，技术上仍可在 Supabase 后台读取 Storage 内容**；本方案说的是“应用层账号隔离”，不是“服务端绝对看不到”。不要把这个 key 放进网页或发给用户。

## 0. 前端现状

`index.html` 已经接入：

- 全屏登录层（未登录时应用内容隐藏）；
- 首次登录强制改密；
- 登录后用 `vault/<自己的 user_id>/latest.json` 读写云端存档；
- 退出登录清理本机缓存并回到登录层；
- 每个账号独立 IndexedDB（001 保留旧库接历史数据，其他账号按 user_id 分库）；
- 设置页显示当前账号与同步状态，只显示当前账号。

当前真实项目已填好：

```js
var DEFAULTS={url:"https://mqdrndfnftoagqarvmij.supabase.co",key:"sb_publishable_L8bXeUSTh6wbZqeoVIqGXw_C4W6txeE",domain:"eleven11.local"};
```

- `schema.sql` 已执行：`vault_meta` 表、私有 `vault` bucket、Storage RLS 策略已存在。
- 001–050 已创建，每账号独立初始密码，写在 `accounts.csv`。
- 公开注册目前仍是开着的，必须按第 3 节关闭。
- `anon` / `publishable` key 可以公开；`service_role` **只能**留在本机环境变量，不能进网页。

## 1. 创建 Supabase 项目

1. 打开 https://supabase.com/dashboard → New project；
2. 记下 Project URL 和 anon public key；
3. 不要开启公开注册。

## 2. 执行 SQL

SQL Editor 里整段运行 `schema.sql`。会创建：

- `vault_meta`：每个账号的存档元信息（RLS 只允许本人）；
- `profiles`：当前项目里这张表是已有表（`id/space_id/nickname`），前端不使用；`schema.sql` 的 profiles 段只用于全新项目；
- 私有 bucket `vault`；
- Storage 策略：只能读写 `vault/<自己的 auth.uid()>/`。

## 3. 关闭公开注册

Authentication → Providers → Email：

- 关掉 **Allow new users to sign up**；
- 邮箱确认可关闭（建号脚本用 `email_confirm: true`）。

这样只有你用 service_role 建出来的账号能登录，别人不能自助注册。

**当前状态：`disable_signup` 仍为 `false`，50 个账号已建完，下一步就是关掉这个开关。**

## 4. 创建 001–050（每账号独立初始密码）

```bash
cd supabase_setup
npm init -y
npm i @supabase/supabase-js

export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="你的 service_role key"
export AUTH_EMAIL_DOMAIN="eleven11.local"

node create_accounts.mjs
```

**当前 001–050 已经全部创建完成，不需要再跑这个脚本。** `accounts.csv` 里是真实初始密码。以后新增账号或需要 service_role 重置时才用下面的脚本。

脚本会给每个账号生成 10 位独立随机初始密码，写入 `user_metadata.must_change_password=true`，并生成 `accounts.csv`（账号,登录邮箱,初始密码,状态）。

**`accounts.csv` 含密码：自己保存，不要发群、不要提交仓库。** 发账号时只把某一行单独发给对方。

前端账号输入框只填 `001`，会映射成 `001@eleven11.local`；填完整邮箱也支持。

> 如果 Supabase 拒绝 `@eleven11.local` 这种域名，把 `AUTH_EMAIL_DOMAIN` 改成 `eleven11.app`，并同步改前端 `DEFAULTS.domain`。已有账号需要按新域重建。

## 5. 重置某个人的密码

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node reset_password.mjs 001
```

输出一行新密码；同时把 `must_change_password` 设回 true，对方下次登录会再改一次。把新密码单独发给对方。

## 6. 云端存档路径

```text
vault/<user_id>/latest.json
```

上传：

```http
POST {SUPABASE_URL}/storage/v1/object/vault/<user_id>/latest.json
Authorization: Bearer {access_token}
apikey: {ANON_KEY}
x-upsert: true
Content-Type: application/json
```

下载：

```http
GET {SUPABASE_URL}/storage/v1/object/vault/<user_id>/latest.json
Authorization: Bearer {access_token}
apikey: {ANON_KEY}
```

## 7. 本地验证

真实项目已经验证：

1. 001、002、003、020、043、044–050 都能用各自初始密码登录；
2. 001 和 002 各自上传 `vault/<自己的 user_id>/latest.json` 成功，并能读回自己的内容；
3. 001 用自己 token 读 002 的对象返回 404 `NoSuchKey`，反向也一样，Storage RLS 隔离生效；
4. 临时账号 999 验证了 `PUT /auth/v1/user` 改密：旧密码登录失败、新密码登录成功、`must_change_password` 变为 `false`，验证后已删除；
5. 本地浏览器打开登录页时，只显示账号/密码/登录，应用内容被隐藏。

还没在真实浏览器里由人工完成“输入 001 密码 → 首登改密 → 发消息 → 刷新 → 退出 → 重登恢复”的整段 UI 流程；发布后请先用 001 做一次。

## 8. 发布

已发布到固定入口：

- URL：`https://4mhd000knq3sz.doubao.link/app/app_17j7cuqfra0`
- release：`7709173175121021966`，状态 `finished`
- 入口版本已包含账号登录、首次改密、云同步、切号清理

发布后先用 001 登录、改密、发一条消息、刷新、退出、再登录，确认云端恢复；再把账号逐条发给别人。不要群发 `accounts.csv`。

## 9. 安全边界

- 网页只有 anon key，没有 service_role；
- RLS 限制每个账号只能访问 `auth.uid()` 自己的对象；
- 站主后台仍可用 service_role 读 Storage（这是 Supabase 管理权限，不是网页入口）；
- 不要为了“方便”做统一密码、公开注册、或者在网页里放管理端列表；
- 账号泄露时用 `reset_password.mjs` 重置，不要共用密码。
