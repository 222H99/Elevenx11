# Eleven×11 安卓安装包（v43-22）

## 文件

- `Eleven11-v43-22.apk`（内置 assets/index.html = 当前 v43-22 页面）
- 包名：`com.eleven.elevenx11`
- 版本：`2026-11-21v43-22`（versionCode 43）
- 最低系统：Android 7.0（API 24），targetSdk 33
- 签名：Android Debug 证书（仅用于直接安装测试，不能上架应用商店）

## 怎么装

1. 把 `Eleven11-v43-22.apk` 传到手机（微信/QQ/网盘/数据线都行）。
2. 点开文件安装；如果提示「未知来源」，在系统设置里允许当前应用安装未知应用。
3. 装好后桌面出现「Eleven×11」图标，点开就是完整 App。

## 覆盖安装

v43-22 与此前版本使用同一个 Android Debug 签名，可以直接覆盖安装，不需要卸载，本地数据保留。

如果装的是更早的 `Eleven11_bp101.apk`，签名不同，安卓会提示「签名不一致、无法覆盖安装」。请先导出备份 → 卸载旧 App → 安装 v43-22 → 导入备份。

## 网页 / APK 一致性

- 网页和 APK 内置的是同一个 `index.html`（MD5 `584ce5e4f19a9bb07ed5b4993b4a0a15`）。
- 页面构建号：`2026-11-21v43-22`；`sw.js` MD5 `1a6a66cad6a4705c5de24a83214b3290`；`version.json` MD5 `a3f653df2ad84b81580d59889ce8bcfb`。
- APK 启动地址 `https://app.local/index.html?v=43-22`；APK MD5 `f40d472280efd626c608f3dd6464c960`。

## v43-22 更新了什么

- **主屏幕 PWA 自动更新**：强制更新重载从只加 `__u` 改为同时加 `__bust`，绕过旧 SW 的整页缓存；SW 也把 `__u` 当绕缓存标记。
- SW 激活接管旧页面时，直接导航到带 `__bust` 的新地址，不再导航回原 URL 取旧缓存。
- 后台发现新版后的 reload 也改成带 `__bust` 的 `location.replace`，聊天中不打断，切后台/下次打开再换。
- v43-22 登录后先出主页、云端后台补，不再等 Supabase；冷启动 1.8 秒先进本地；版本检查 3 秒一次。
- v43-21 的 __bust 自动更新、v43-20 真实 manifest、v43-18 登录不整页重载全部保留。
