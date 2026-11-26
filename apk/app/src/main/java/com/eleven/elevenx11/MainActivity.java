package com.eleven.elevenx11;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.database.Cursor;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.os.Environment;
import android.media.AudioAttributes;
import android.media.MediaRecorder;
import android.media.ExifInterface;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

import org.json.JSONObject;

public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_NOTIFY = 1002;
    private static final int REQ_IMAGE = 1003;
    private static final int REQ_MIC = 1004;
    private static final int REQ_STORAGE = 1005;
    /* v43-236b26：系统级录音兜底。WebView 的 getUserMedia 在部分机型上会抛
       InvalidStateError（麦克风被系统占用/WebView 音频后端异常），这时改用原生
       MediaRecorder 直接录 m4a，录完把音频回传给页面，发语音不再受 WebView 限制。 */
    private MediaRecorder nativeRec = null;
    private File nativeRecFile = null;
    private long nativeRecStartMs = 0;
    private static final String CH_MSG = "eleven_messages";
    private static final String CH_SILENT = "eleven_silent";
    private WebView webView;
    private boolean pendingOpenChat = false;
    private ValueCallback<Uri[]> filePathCallback;
    private String imagePickToken = null;
    private PermissionRequest pendingMicRequest = null;
    /* v43-209：WebView 不带 Web Speech，APK 里的听写改走系统 SpeechRecognizer。 */
    private SpeechRecognizer speechRecognizer = null;
    private String pendingDownloadUrl = null;
    private long lastApkDownloadId = -1;
    private long pendingInstallId = -1;
    private String lastApkDownloadUrl = "";
    private boolean installSettingsOpened = false;
    private BroadcastReceiver downloadReceiver = null;

    /* v43-169：状态栏透明 + 网页延伸到状态栏下面；顶部安全区由网页 --native-safe-top 补。 */
    private void applySystemBars(boolean darkTheme) {
        Window window = getWindow();
        try {
            if (Build.VERSION.SDK_INT >= 21) {
                window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            }
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(darkTheme ? Color.BLACK : Color.WHITE);
        } catch (Exception ignored) {}
        try {
            int flags = window.getDecorView().getSystemUiVisibility();
            flags |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            if (Build.VERSION.SDK_INT >= 23) {
                if (!darkTheme) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            if (Build.VERSION.SDK_INT >= 26) {
                if (!darkTheme) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            window.getDecorView().setSystemUiVisibility(flags);
        } catch (Exception ignored) {}
    }

    private int statusBarHeightPx() {
        try {
            int res = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (res > 0) return getResources().getDimensionPixelSize(res);
        } catch (Exception ignored) {}
        return 0;
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pendingOpenChat = getIntent() != null && getIntent().getBooleanExtra("open_chat", false);

        createNotificationChannels();
        /* 更新包下载完成后自动打开安装器；用户只点一次“检查更新”。 */
        try{
            downloadReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    try{
                        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if(id < 0 || id != lastApkDownloadId) return;
                        pendingInstallId = id;
                        installDownloadedApk(id);
                    }catch(Exception ignored){}
                }
            };
            IntentFilter df = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            if(Build.VERSION.SDK_INT >= 33) registerReceiver(downloadReceiver, df, Context.RECEIVER_EXPORTED);
            else registerReceiver(downloadReceiver, df);
        }catch(Exception ignored){ downloadReceiver = null; }

        /* 系统栏/WebView 底色跟随上次主题：浅色用户启动不再先黑一下 */
        boolean sysDark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        /* v43-55：没保存过主题时默认浅色。系统深色不再让 App 自己变黑。 */
        boolean darkTheme = getSharedPreferences("e11_native", MODE_PRIVATE).getBoolean("dark", false);
        /* v43-127：WebView/窗口底色用深灰而不是纯黑，冷启动解析 2MB 页面时不再像死黑屏；
           顶栏和导航栏仍保持纯黑/纯白。 */
        int themeBg = darkTheme ? Color.rgb(20,20,22) : Color.WHITE;
        Window window = getWindow();
        /* 退出/被系统回收时窗口底色也用当前主题色，避免露出启动图的图标或黑白底 */
        window.setBackgroundDrawable(new ColorDrawable(themeBg));
        /* v43-169：状态栏改成透明并让网页延伸到状态栏下面，聊天/桌面/主页壁纸才能盖住电量栏。 */
        applySystemBars(darkTheme);

        webView = new WebView(this);
        webView.setBackgroundColor(themeBg);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        /* 网页版用的是普通 Chrome；WebView 默认 UA 带 "; wv"，部分第三方接口会降级/拦截。
           换成普通 Chrome 移动端 UA，同时允许第三方 Cookie，尽量和网页版同一环境。 */
        settings.setUserAgentString("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }
        if (Build.VERSION.SDK_INT >= 21) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidUI");
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                // blob: 下载由页面里的 AndroidUI 导出脚本接管；这里只处理普通 http(s) 链接。
                if (url == null || url.startsWith("blob:") || url.startsWith("data:")) return;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    toast("没有可以打开这个下载链接的应用");
                }
            }
        });

        String pageUrl = "https://app.local/index.html?v=" + BuildConfig.VERSION_CODE;
        if (pendingOpenChat) pageUrl += "#chat";
        webView.loadUrl(pageUrl);
        /* v43-235z60f12：APK 启动就自己查线上版本，不依赖网页空闲后的检查。
           发现更高 versionCode 就自动开始下载，完成后照旧自动拉起安装器。 */
        checkNativeAutoUpdate();
    }

    private void checkNativeAutoUpdate() {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL u = new URL("https://4mhd000knq3sz.doubao.link/app/app_17j7cuqfra0/version.json?__apk=" + System.currentTimeMillis());
                conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                conn.setUseCaches(false);
                conn.setRequestProperty("Cache-Control", "no-cache, no-store");
                conn.setRequestProperty("Accept", "application/json,text/plain,*/*");
                int code = conn.getResponseCode();
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in == null) return;
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                in.close();
                if (code < 200 || code >= 300) return;
                JSONObject j = new JSONObject(sb.toString());
                int remote = j.optInt("versionCode", 0);
                String apk = j.optString("apk", "");
                if (remote <= BuildConfig.VERSION_CODE || !apk.startsWith("https://")) return;
                SharedPreferences sp = getSharedPreferences("e11_native", MODE_PRIVATE);
                if (sp.getInt("autoUpdateCode", 0) >= remote) return;
                sp.edit().putInt("autoUpdateCode", remote).apply();
                final String apkUrl = apk;
                runOnUiThread(() -> {
                    try {
                        toast("发现新版本，正在自动更新");
                        startApkDownload(apkUrl);
                    } catch (Exception ignored) {}
                });
            } catch (Exception ignored) {
            } finally {
                if (conn != null) try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_IMAGE) {
            final String token = imagePickToken;
            imagePickToken = null;
            if (token == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                evalJs("window.__androidPickCancel(" + JSONObject.quote(token) + ")");
                return;
            }
            final Uri uri = data.getData();
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String dataUrl = null;
                    String err = null;
                    try {
                        dataUrl = imageUriToDataUrl(uri);
                    } catch (Throwable t) {
                        err = t.getMessage() == null ? "图片读取失败" : t.getMessage();
                    }
                    final String outUrl = dataUrl;
                    final String outErr = err;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (outUrl != null) {
                                evalJs("window.__androidPickedImage(" + JSONObject.quote(token) + "," + JSONObject.quote(outUrl) + ")");
                            } else {
                                evalJs("window.__androidPickError(" + JSONObject.quote(token) + "," + JSONObject.quote(outErr == null ? "图片读取失败" : outErr) + ")");
                            }
                        }
                    });
                }
            }).start();
            return;
        }
        if (requestCode != REQ_FILE) return;
        if (filePathCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if(pendingInstallId >= 0){
            try{
                if(Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls()){
                    installDownloadedApk(pendingInstallId);
                }
            }catch(Exception ignored){}
        }
        /* 从主屏幕/别的应用切回来：先把窗口和 WebView 底色补成本次主题色，
           再让页面补图；这一步能消掉回前台第一帧的黑屏。 */
        if (webView != null) {
            try {
                boolean dark = getSharedPreferences("e11_native", MODE_PRIVATE).getBoolean("dark", false);
                int bg = dark ? Color.rgb(20,20,22) : Color.WHITE;
                getWindow().setBackgroundDrawable(new ColorDrawable(bg));
                applySystemBars(dark);
                webView.setBackgroundColor(bg);
            } catch (Exception ignored) {}
        }
        if (webView != null) {
            try { webView.onResume(); } catch (Exception ignored) {}
            /* 用户去系统设置授权后回来：立即把 true 回传页面，别等页面自己超时。 */
            try{
                if (Build.VERSION.SDK_INT >= 23 &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED){
                    evalJs("window.__nativeMicGranted&&window.__nativeMicGranted(true)");
                }
            }catch(Exception ignored){}
            webView.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (webView == null) return;
                    webView.evaluateJavascript(
                        "(function(){try{if(window.__androidResume)window.__androidResume();}catch(e){}})();",
                        null);
                }
            }, 180);
        }
    }

    @Override
    protected void onPause() {
        /* 用户按 Home/切应用时先让网页立即落盘，避免改完字卡、日记、一起听后
           进程被系统回收，回来少一段数据。 */
        if (webView != null) {
            try {
                webView.evaluateJavascript(
                    "(function(){try{if(window.__androidPause)window.__androidPause();}catch(e){}})();",
                    null);
            } catch (Exception ignored) {}
        }
        if (webView != null) {
            try { webView.onPause(); } catch (Exception ignored) {}
        }
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra("open_chat", false)) {
            pendingOpenChat = true;
            openChatInWebView();
        } else if (intent != null && Intent.ACTION_MAIN.equals(intent.getAction())) {
            /* 点桌面图标把还活着的任务拉到前台：回桌面，不沿用上次的聊天页。
               通知点开带 open_chat，走上面的直达聊天分支。 */
            if (webView != null) {
                webView.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (webView == null) return;
                        webView.evaluateJavascript(
                            "(function(){try{if(window.__androidLauncherHome)window.__androidLauncherHome();}catch(e){}})();",
                            null);
                    }
                }, 120);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFY) {
            try {
                getPreferences(Context.MODE_PRIVATE).edit().putBoolean("notifyAsked", true).apply();
            } catch (Exception ignored) {}
        }
        if (requestCode == REQ_MIC) {
            PermissionRequest pr = pendingMicRequest;
            pendingMicRequest = null;
            boolean micOk = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (pr == null) {
                /* 页面通过 AndroidUI.requestMicPermission() 主动申请时，还没有 WebView 的
                   pendingMicRequest，这里也要把结果回传给页面，否则页面一直等。 */
                try {
                    evalJs("window.__nativeMicGranted&&window.__nativeMicGranted(" + (micOk ? "true" : "false") + ")");
                } catch (Exception ignored) {}
                if (!micOk) toast("需要麦克风权限才能发语音，请在系统设置里允许");
                return;
            }
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            try {
                if (ok) pr.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                else {
                    pr.deny();
                    toast("需要麦克风权限才能发语音，请在系统设置里允许");
                }
                /* v43-185z33f：拒绝时也必须回传 false，旧代码无条件回传成功，
                   页面以为授权成功又去 getUserMedia，最后只看到「没拿到麦克风权限」。 */
                evalJs("window.__nativeMicGranted&&window.__nativeMicGranted(" + (ok ? "true" : "false") + ")");
            } catch (Exception ignored) {}
        }
        if (requestCode == REQ_STORAGE) {
            String url = pendingDownloadUrl;
            pendingDownloadUrl = null;
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (url != null) {
                if (ok) startApkDownload(url);
                else openExternal(url);
            }
        }
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast("没有可以打开这个下载链接的应用");
        }
    }

    /* 下载完成后直接拉起系统安装器；Android 8+ 没给“安装未知应用”权限时先跳设置，返回后继续。 */
    private void installDownloadedApk(long id) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        int status = -1;
        Cursor c = null;
        try{
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            if(c != null && c.moveToFirst()){
                int idx = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                if(idx >= 0) status = c.getInt(idx);
            }
        }catch(Exception ignored){
        }finally{
            try{ if(c != null) c.close(); }catch(Exception ignored){}
        }
        if(status != DownloadManager.STATUS_SUCCESSFUL){
            if(status == DownloadManager.STATUS_FAILED){
                pendingInstallId = -1;
                toast("更新包下载失败，请重新检查更新");
            }
            return;
        }
        if(Build.VERSION.SDK_INT >= 26){
            try{
                if(!getPackageManager().canRequestPackageInstalls()){
                    if(!installSettingsOpened){
                        installSettingsOpened = true;
                        toast("请允许 Eleven×11 安装更新，返回后自动继续");
                        try{
                            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName())));
                        }catch(Exception e){
                            openExternal(lastApkDownloadUrl);
                        }
                    }
                    return;
                }
            }catch(Exception ignored){}
        }
        Uri apk = null;
        try{ apk = dm.getUriForDownloadedFile(id); }catch(Exception ignored){}
        if(apk == null){
            toast("找不到更新包，请重新检查更新");
            pendingInstallId = -1;
            return;
        }
        try{
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(apk, "application/vnd.android.package-archive");
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(it);
            pendingInstallId = -1;
            installSettingsOpened = false;
        }catch(Exception e){
            toast("无法打开安装器，请在下载通知里点安装");
        }
    }

    private void startApkDownload(String url) {
        if (url == null || !url.startsWith("https://")) {
            toast("下载地址无效");
            return;
        }
        lastApkDownloadUrl = url;
        if (Build.VERSION.SDK_INT <= 28 &&
                checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUrl = url;
            try {
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            } catch (Exception e) {
                pendingDownloadUrl = null;
                openExternal(url);
            }
            return;
        }
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("Eleven×11 更新包");
            req.setDescription("下载完成后自动打开安装");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Eleven11-update.apk");
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                openExternal(url);
                return;
            }
            long downloadId = dm.enqueue(req);
            lastApkDownloadId = downloadId;
            pendingInstallId = -1;
            installSettingsOpened = false;
            toast("正在下载更新，完成后自动打开安装");
        } catch (Exception e) {
            openExternal(url);
        }
    }

    private void openChatInWebView() {
        if (webView == null) return;
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("(function(){try{if(typeof showView==='function')showView('view-chat');}catch(e){}})();", null);
                pendingOpenChat = false;
            }
        }, 500);
    }

    private boolean superBack(int keyCode, KeyEvent event) {
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null) {
            /* 页面里的二级页统一回聊天页；只有页面自己说“没有可返回的页面”时才走浏览历史/退出。
               以前直接 webView.goBack()，在单页应用里会退到上一个 URL，表现为白屏或闪退。 */
            webView.evaluateJavascript(
                "(function(){try{return window.__androidBack?!!window.__androidBack():false}catch(e){return false}})()",
                value -> {
                    if (!"true".equals(value)) {
                        if (webView != null && webView.canGoBack()) webView.goBack();
                        else superBack(keyCode, event);
                    }
                });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if(downloadReceiver != null){
            try{ unregisterReceiver(downloadReceiver); }catch(Exception ignored){}
            downloadReceiver = null;
        }
        destroySpeechRecognizer();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidUI");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel msg = new NotificationChannel(CH_MSG, "消息通知", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("对方来消息、动态、信件、留言提醒");
        msg.enableVibration(true);
        msg.setVibrationPattern(new long[]{0, 220, 120, 220});
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        msg.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, attrs);
        nm.createNotificationChannel(msg);

        NotificationChannel silent = new NotificationChannel(CH_SILENT, "静默通知", NotificationManager.IMPORTANCE_DEFAULT);
        silent.setDescription("拍一拍等不响铃的提醒");
        silent.setSound(null, null);
        silent.enableVibration(false);
        nm.createNotificationChannel(silent);
    }

    private String notificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            boolean asked;
            try { asked = getPreferences(Context.MODE_PRIVATE).getBoolean("notifyAsked", false); }
            catch (Exception e) { asked = false; }
            return asked ? "denied" : "default";
        }
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.areNotificationsEnabled()) return "denied";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = nm.getNotificationChannel(CH_MSG);
            if (c != null && c.getImportance() == NotificationManager.IMPORTANCE_NONE) return "denied";
        }
        return "granted";
    }

    private boolean requestNotifyPermission() {
        if ("granted".equals(notificationPermission())) return true;
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (!"denied".equals(notificationPermission())) {
                try { getPreferences(Context.MODE_PRIVATE).edit().putBoolean("notifyAsked", true).apply(); } catch (Exception ignored) {}
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                return true;
            }
        }
        try {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private PendingIntent chatPendingIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra("open_chat", true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 200, i, flags);
    }

    private boolean showNotification(String title, String body, String tag, boolean silent) {
        if (!"granted".equals(notificationPermission())) return false;
        createNotificationChannels();
        String t = title == null || title.trim().isEmpty() ? "Eleven×11" : title;
        String b = body == null ? "" : body;
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, silent ? CH_SILENT : CH_MSG);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setContentTitle(t)
                .setContentText(b)
                .setSmallIcon(R.drawable.ic_notify)
                .setAutoCancel(true)
                .setContentIntent(chatPendingIntent())
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setStyle(new Notification.BigTextStyle().bigText(b));
        if (Build.VERSION.SDK_INT < 26) {
            if (silent) {
                builder.setDefaults(0);
                builder.setSound(null);
                builder.setVibrate(null);
            } else {
                builder.setDefaults(Notification.DEFAULT_ALL);
                builder.setPriority(Notification.PRIORITY_HIGH);
            }
        }
        Notification n = builder.build();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        int id = (tag == null ? 0 : tag.hashCode()) & 0x7fffffff;
        if (id == 0) id = 1;
        if (tag == null || tag.isEmpty()) nm.notify(id, n);
        else nm.notify(tag, id, n);
        return true;
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    /* iOS 风格提示：深色半透明胶囊 + 圆角 + 底部居中，替换 Android 默认灰色 Toast */
                    float d = getResources().getDisplayMetrics().density;
                    TextView tv = new TextView(MainActivity.this);
                    tv.setText(msg == null ? "" : msg);
                    tv.setTextColor(Color.WHITE);
                    tv.setTextSize(14);
                    tv.setGravity(Gravity.CENTER);
                    int ph = Math.round(16 * d), pv = Math.round(10 * d);
                    tv.setPadding(ph, pv, ph, pv);
                    tv.setMaxWidth(Math.round(310 * d));
                    GradientDrawable bg = new GradientDrawable();
                    bg.setColor(Color.argb(226, 28, 28, 30));
                    bg.setCornerRadius(Math.round(15 * d));
                    tv.setBackground(bg);
                    tv.setElevation(Math.round(8 * d));
                    Toast t = new Toast(MainActivity.this);
                    t.setDuration(Toast.LENGTH_SHORT);
                    t.setView(tv);
                    t.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL, 0, Math.round(96 * d));
                    t.show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private void injectPageHelpers() {
        if (webView == null) return;
        // 1) 跟随页面夜间/白天切换系统状态栏和导航栏，不再出现黑底黑字或白底白字。
        String themeJs = "(function(){try{"
                + "if(window.__e11ThemeObserver)return;window.__e11ThemeObserver=1;"
                + "var last=null;function apply(){try{"
                + "var d=!!(document.body&&document.body.classList.contains('ui-dark'));"
                + "if(d!==last){last=d;AndroidUI.setTheme(d);}"
                + "}catch(e){}}"
                + "if(document.body){try{new MutationObserver(apply).observe(document.body,{attributes:true,attributeFilter:['class']});}catch(e){}apply();}"
                + "else{document.addEventListener('DOMContentLoaded',apply);}"
                + "}catch(e){}})();";
        webView.evaluateJavascript(themeJs, null);

        // 2) blob: 下载转成原生保存。网页里的“导出备份/导出 JSON”用 a[download] + blob，
        //    Android WebView 默认不会下载 blob，这里把它读成 base64 后交给原生写入下载目录。
        String downloadJs = "(function(){try{"
                + "if(window.__e11BlobDownload)return;window.__e11BlobDownload=1;"
                + "document.addEventListener('click',function(ev){"
                + "var t=ev.target;var a=t&&t.closest?t.closest('a[download]'):null;"
                + "if(!a)return;var href=a.href||'';if(!/^blob:/.test(href))return;"
                + "ev.preventDefault();ev.stopPropagation();"
                + "var name=a.getAttribute('download')||'Eleven11_backup.json';"
                + "fetch(href).then(function(r){return r.blob();}).then(function(b){"
                + "var fr=new FileReader();fr.onload=function(){"
                + "var s=String(fr.result||'');var i=s.indexOf(',');"
                + "if(i<0){AndroidUI.toast('导出失败，请重试');return;}"
                + "AndroidUI.saveFile(name,s.slice(i+1),b.type||'application/octet-stream');"
                + "};fr.readAsDataURL(b);"
                + "}).catch(function(){AndroidUI.toast('导出失败，请重试');});"
                + "},true);"
                + "}catch(e){}})();";
        webView.evaluateJavascript(downloadJs, null);
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null || !"app.local".equals(uri.getHost())) return null;

            String path = uri.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
            if (path.startsWith("/")) path = path.substring(1);
            if (path.contains("..")) return null;

            try {
                InputStream in = getAssets().open(path);
                String mime = guessMime(path);
                String encoding = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") ? "UTF-8" : null;
                return new WebResourceResponse(mime, encoding, in);
            } catch (IOException e) {
                byte[] body = ("Not found: " + path).getBytes(StandardCharsets.UTF_8);
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(body));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) return true;
            if ("app.local".equals(uri.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception e) {
                toast("没有可以打开这个链接的应用");
            }
            return true;
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if ("app.local".equals(uri.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception e) {
                toast("没有可以打开这个链接的应用");
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            injectPageHelpers();
            if (pendingOpenChat) {
                openChatInWebView();
            }
        }
    }

    private class AppChromeClient extends WebChromeClient {
        /* v43-41：WebView 默认会拒绝 getUserMedia。页面要录音时先申请系统
           RECORD_AUDIO 运行时权限，拿到后仅授予 AUDIO_CAPTURE；摄像头等一律拒绝。 */
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            if (request == null) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    boolean wantsAudio = false;
                    try {
                        for (String res : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) wantsAudio = true;
                        }
                    } catch (Exception ignored) {}
                    if (!wantsAudio) {
                        try { request.deny(); } catch (Exception ignored) {}
                        return;
                    }
                    if (Build.VERSION.SDK_INT >= 23 &&
                        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        try { request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); } catch (Exception ignored) {}
                        return;
                    }
                    if (pendingMicRequest != null) {
                        try { pendingMicRequest.deny(); } catch (Exception ignored) {}
                    }
                    pendingMicRequest = request;
                    try {
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    } catch (Exception e) {
                        pendingMicRequest = null;
                        try { request.deny(); } catch (Exception ignored) {}
                        toast("无法申请麦克风权限");
                    }
                }
            });
        }

        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                        FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
            }
            filePathCallback = callback;
            try {
                Intent intent = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                return true;
            } catch (Exception e) {
                filePathCallback = null;
                toast("无法打开文件选择器");
                return false;
            }
        }
    }

    private void destroySpeechRecognizer() {
        try {
            if (speechRecognizer != null) {
                speechRecognizer.cancel();
                speechRecognizer.destroy();
            }
        } catch (Exception ignored) {}
        speechRecognizer = null;
    }

    private void startSpeechRecognizer(final String lang) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 23 &&
                        checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        evalJs("window.__nativeSpeechError&&window.__nativeSpeechError('perm')");
                        return;
                    }
                    destroySpeechRecognizer();
                    if (!SpeechRecognizer.isRecognitionAvailable(MainActivity.this)) {
                        evalJs("window.__nativeSpeechError&&window.__nativeSpeechError('unavailable')");
                        return;
                    }
                    speechRecognizer = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
                    speechRecognizer.setRecognitionListener(new RecognitionListener() {
                        @Override public void onReadyForSpeech(Bundle params) {
                            evalJs("window.__nativeSpeech&&window.__nativeSpeech('ready')");
                        }
                        @Override public void onBeginningOfSpeech() {}
                        @Override public void onRmsChanged(float rmsdB) {}
                        @Override public void onBufferReceived(byte[] buffer) {}
                        @Override public void onEndOfSpeech() {
                            evalJs("window.__nativeSpeech&&window.__nativeSpeech('end')");
                        }
                        @Override public void onError(int error) {
                            evalJs("window.__nativeSpeechError&&window.__nativeSpeechError('" + error + "')");
                            destroySpeechRecognizer();
                        }
                        @Override public void onResults(Bundle results) {
                            String text = "";
                            try {
                                java.util.ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                                if (list != null && !list.isEmpty()) text = list.get(0);
                            } catch (Exception ignored) {}
                            evalJs("window.__nativeSpeechResult&&window.__nativeSpeechResult(" + JSONObject.quote(text) + ",true)");
                            destroySpeechRecognizer();
                        }
                        @Override public void onPartialResults(Bundle partialResults) {
                            String text = "";
                            try {
                                java.util.ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                                if (list != null && !list.isEmpty()) text = list.get(0);
                            } catch (Exception ignored) {}
                            if (text != null && !text.isEmpty())
                                evalJs("window.__nativeSpeechResult&&window.__nativeSpeechResult(" + JSONObject.quote(text) + ",false)");
                        }
                        @Override public void onEvent(int eventType, Bundle params) {}
                    });
                    Intent it = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    it.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    it.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang == null || lang.isEmpty() ? "zh-CN" : lang);
                    it.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                    it.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                    speechRecognizer.startListening(it);
                } catch (Exception e) {
                    evalJs("window.__nativeSpeechError&&window.__nativeSpeechError('start')");
                }
            }
        });
    }

    private void destroyNativeRec() {
        try {
            if (nativeRec != null) {
                try { nativeRec.stop(); } catch (Exception ignored) {}
                try { nativeRec.reset(); } catch (Exception ignored) {}
                try { nativeRec.release(); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
        nativeRec = null;
        try { if (nativeRecFile != null && nativeRecFile.exists()) nativeRecFile.delete(); } catch (Exception ignored) {}
        nativeRecFile = null;
        nativeRecStartMs = 0;
    }

    private byte[] readFileBytes(File f) {
        if (f == null || !f.exists()) return null;
        try {
            InputStream in = new java.io.FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            try { in.close(); } catch (Exception ignored) {}
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private class AndroidBridge {
        @JavascriptInterface
        public boolean hasNativeSpeech() {
            try {
                return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public void startNativeSpeech(final String lang) {
            startSpeechRecognizer(lang);
        }

        @JavascriptInterface
        public void stopNativeSpeech() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { if (speechRecognizer != null) speechRecognizer.stopListening(); } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void cancelNativeSpeech() {
            runOnUiThread(new Runnable() {
                @Override public void run() { destroySpeechRecognizer(); }
            });
        }

        @JavascriptInterface
        public boolean hasNativeRecorder() { return true; }

        @JavascriptInterface
        public void startNativeRec() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        destroyNativeRec();
                        if (Build.VERSION.SDK_INT >= 23 &&
                            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                            evalJs("window.__nativeRecError&&window.__nativeRecError('还没有麦克风权限')");
                            return;
                        }
                        File f = new File(getCacheDir(), "nrec_" + System.currentTimeMillis() + ".m4a");
                        MediaRecorder mr = new MediaRecorder();
                        mr.setAudioSource(MediaRecorder.AudioSource.MIC);
                        mr.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                        mr.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
                        mr.setAudioEncodingBitRate(32000);
                        mr.setAudioSamplingRate(44100);
                        mr.setOutputFile(f.getAbsolutePath());
                        mr.prepare();
                        mr.start();
                        nativeRec = mr;
                        nativeRecFile = f;
                        nativeRecStartMs = SystemClock.elapsedRealtime();
                        evalJs("window.__nativeRecStarted&&window.__nativeRecStarted()");
                    } catch (Exception e) {
                        destroyNativeRec();
                        evalJs("window.__nativeRecError&&window.__nativeRecError('系统录音启动失败')");
                    }
                }
            });
        }

        @JavascriptInterface
        public void stopNativeRec() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    MediaRecorder mr = nativeRec;
                    File f = nativeRecFile;
                    long dur = nativeRecStartMs > 0 ? (SystemClock.elapsedRealtime() - nativeRecStartMs) : 0;
                    nativeRec = null;
                    nativeRecFile = null;
                    nativeRecStartMs = 0;
                    if (mr == null) {
                        evalJs("window.__nativeRecError&&window.__nativeRecError('没有在录音')");
                        return;
                    }
                    try { mr.stop(); } catch (Exception e) {
                        try { mr.reset(); } catch (Exception ignored) {}
                        try { mr.release(); } catch (Exception ignored) {}
                        if (f != null) { try { f.delete(); } catch (Exception ignored) {} }
                        evalJs("window.__nativeRecError&&window.__nativeRecError('没录到声音')");
                        return;
                    }
                    try { mr.reset(); } catch (Exception ignored) {}
                    try { mr.release(); } catch (Exception ignored) {}
                    try {
                        byte[] data = readFileBytes(f);
                        if (f != null) { try { f.delete(); } catch (Exception ignored) {} }
                        if (data == null || data.length < 512) {
                            evalJs("window.__nativeRecError&&window.__nativeRecError('没录到声音，按住稍久一点')");
                            return;
                        }
                        String b64 = Base64.encodeToString(data, Base64.NO_WRAP);
                        evalJs("window.__nativeRecDone&&window.__nativeRecDone('audio/mp4'," + dur + ",'" + b64 + "')");
                    } catch (Exception e) {
                        evalJs("window.__nativeRecError&&window.__nativeRecError('录音回传失败')");
                    }
                }
            });
        }

        @JavascriptInterface
        public void cancelNativeRec() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    MediaRecorder mr = nativeRec;
                    File f = nativeRecFile;
                    nativeRec = null;
                    nativeRecFile = null;
                    nativeRecStartMs = 0;
                    if (mr != null) {
                        try { mr.stop(); } catch (Exception ignored) {}
                        try { mr.reset(); } catch (Exception ignored) {}
                        try { mr.release(); } catch (Exception ignored) {}
                    }
                    if (f != null) { try { f.delete(); } catch (Exception ignored) {} }
                }
            });
        }

        @JavascriptInterface
        public void setTheme(final boolean dark) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    getSharedPreferences("e11_native", MODE_PRIVATE).edit().putBoolean("dark", dark).apply();
                    Window window = getWindow();
                    int bg = dark ? Color.rgb(20,20,22) : Color.WHITE;
                    window.setBackgroundDrawable(new ColorDrawable(bg));
                    applySystemBars(dark);
                    try { if (webView != null) webView.setBackgroundColor(bg); } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public boolean hasMicPermission() {
            try {
                return Build.VERSION.SDK_INT < 23 ||
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface
        public void requestMicPermission() {
            /* v43-183z34：录音前先确保系统麦克风权限，避免 getUserMedia 与
               WebView 的 onPermissionRequest 互相等待，表现成“点了麦克风没反应”。 */
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (Build.VERSION.SDK_INT < 23 || hasMicPermission()) {
                            evalJs("window.__nativeMicGranted&&window.__nativeMicGranted()");
                            return;
                        }
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    } catch (Exception e) {
                        toast("无法申请麦克风权限");
                    }
                }
            });
        }

        @JavascriptInterface
        public void openAppSettings() {
            /* v43-185z33f：用户永久拒绝录音权限后，系统不再弹窗；直接打开本应用设置页。 */
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent it = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        it.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(it);
                    } catch (Exception e) {
                        toast("请到系统设置 → 应用 → Eleven×11 → 权限里打开麦克风");
                    }
                }
            });
        }

        @JavascriptInterface
        public int getScreenWidthDp() {
            /* v43-183z21：部分系统“显示大小”放大后，网页里 screen.width/dpr 只报 349，
               但屏幕实际是 1080/2.75≈393，舞台只铺到右边留白。这里直接给真实 dp 宽。 */
            try {
                DisplayMetrics dm = getResources().getDisplayMetrics();
                if (dm != null && dm.density > 0 && dm.widthPixels > 0) return Math.round(dm.widthPixels / dm.density);
                return dm != null ? dm.widthPixels : 0;
            } catch (Exception ignored) { return 0; }
        }

        @JavascriptInterface
        public int getVisibleBottomDp() {
            /* v43-183z9：部分 Android WebView / 输入法不会让 visualViewport 变矮，
               网页算不出键盘高度，输入栏就藏到键盘下面。这里直接读系统“可见窗口”
               的底边（不含输入法），网页可据此把聊天页收上来。CSS px 就是 dp。 */
            try {
                Rect r = new Rect();
                getWindow().getDecorView().getWindowVisibleDisplayFrame(r);
                float density = getResources().getDisplayMetrics().density;
                if (density > 0 && r.bottom > 0) return Math.round(r.bottom / density);
                return r.bottom;
            } catch (Exception ignored) {
                return 0;
            }
        }

        @JavascriptInterface
        public int getStatusBarHeight() {
            /* WebView 的 CSS px 等于 dp，不是物理像素。以前直接返回 px，
               高密度/刘海机型会把 108px 当成 108 CSS px，顶栏出现巨大空白。 */
            try {
                float density = getResources().getDisplayMetrics().density;
                int px = statusBarHeightPx();
                if (density > 0 && px > 0) return Math.round(px / density);
                return px;
            } catch (Exception ignored) {
                return 0;
            }
        }

        /* darkIcons=true 表示状态栏用深色图标（浅色壁纸）；false 用白色图标（深色壁纸）。 */
        @JavascriptInterface
        public void setStatusBarIcons(final boolean darkIcons) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        int flags = getWindow().getDecorView().getSystemUiVisibility();
                        flags |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
                        if (Build.VERSION.SDK_INT >= 23) {
                            if (darkIcons) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                            else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        }
                        getWindow().getDecorView().setSystemUiVisibility(flags);
                    } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public String notifyPermissionStatus() {
            return notificationPermission();
        }

        @JavascriptInterface
        public boolean requestNotifyPermission() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.requestNotifyPermission();
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean notify(String title, String body, String tag, boolean silent) {
            return showNotification(title, body, tag, silent);
        }

        /* 打开 App / 弹出邀请层时撤掉同 tag 的系统通知：
           否则后台收到的通知会一直挂在通知栏，和页内邀请弹窗同时出现。 */
        @JavascriptInterface
        public void cancelNotify(String tag) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;
                String t = tag == null ? "" : tag;
                int id = (t.isEmpty() ? 0 : t.hashCode()) & 0x7fffffff;
                if (id == 0) id = 1;
                if (t.isEmpty()) nm.cancel(id); else nm.cancel(t, id);
            } catch (Throwable ignored) {}
        }

        /* 原生代理 Railway 后端：APK 的 app.local 不在后端 CORS 白名单，
           由原生带上线上网页 Origin 发请求，突破浏览器同源限制。
           仅允许固定的 Railway /api/ 前缀，避免任意网络访问。 */
        @JavascriptInterface
        public String api(String url, String method, String headersJson, String body) {
            HttpURLConnection conn = null;
            try {
                if (url == null) return "{\"status\":502,\"body\":\"blocked\"}";
                boolean allowed = url.startsWith("https://elevenx11-production.up.railway.app/api/")
                        || url.startsWith("https://mqdrndfnftoagqarvmij.supabase.co/auth/v1/")
                        || url.startsWith("https://mqdrndfnftoagqarvmij.supabase.co/storage/v1/")
                        || url.startsWith("https://4mhd000knq3sz.doubao.link/app/app_17j7cuqfra0/version.json");
                if (!allowed) return "{\"status\":502,\"body\":\"blocked\"}";
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                String m = method == null ? "GET" : method.toUpperCase();
                if (!m.equals("POST") && !m.equals("PUT") && !m.equals("PATCH") && !m.equals("DELETE")) m = "GET";
                conn.setRequestMethod(m);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(15000);
                conn.setDoInput(true);
                conn.setUseCaches(false);
                conn.setRequestProperty("Origin", "https://4mhd000knq3sz.doubao.link");
                conn.setRequestProperty("Referer", "https://4mhd000knq3sz.doubao.link/");
                conn.setRequestProperty("Accept", "application/json, text/plain, */*");
                conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");

                try {
                    JSONObject hs = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> it = hs.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        String lk = k == null ? "" : k.toLowerCase();
                        if (lk.equals("host") || lk.equals("origin") || lk.equals("referer")
                                || lk.equals("content-length") || lk.equals("connection")) continue;
                        String v = hs.optString(k, "");
                        if (!v.isEmpty()) conn.setRequestProperty(k, v);
                    }
                } catch (Exception ignored) {}

                if (m.equals("POST") || m.equals("PUT") || m.equals("PATCH")) {
                    conn.setDoOutput(true);
                    byte[] payload = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                    OutputStream out = conn.getOutputStream();
                    out.write(payload);
                    out.close();
                }

                int code = conn.getResponseCode();
                InputStream in = null;
                try {
                    in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
                } catch (Exception e) {
                    in = conn.getErrorStream();
                }
                if (in == null) in = new ByteArrayInputStream(new byte[0]);
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                in.close();

                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("body", sb.toString());
                return out.toString();
            } catch (Exception e) {
                try {
                    JSONObject out = new JSONObject();
                    /* status=0 让前端识别成网络错误并自动重试，而不是当成后端 502 */
                    out.put("status", 0);
                    out.put("body", "{\"code\":0,\"msg\":\"native network error\"}");
                    return out.toString();
                } catch (Exception e2) {
                    return "{\"status\":0,\"body\":\"native network error\"}";
                }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /* v43-235：检查更新专用。只允许线上 version.json，连接 2.5 秒、读取 3.5 秒，
           不再走 api() 的 8 秒连接 / 15 秒读取，避免点“检查更新”要等十几秒。 */
        @JavascriptInterface
        public String versionInfo(String url) {
            HttpURLConnection conn = null;
            try {
                if (url == null || !url.startsWith("https://4mhd000knq3sz.doubao.link/app/app_17j7cuqfra0/version.json")) {
                    return "{\"status\":502,\"body\":\"blocked\"}";
                }
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(2500);
                conn.setReadTimeout(3500);
                conn.setDoInput(true);
                conn.setUseCaches(false);
                conn.setRequestProperty("Origin", "https://4mhd000knq3sz.doubao.link");
                conn.setRequestProperty("Referer", "https://4mhd000knq3sz.doubao.link/");
                conn.setRequestProperty("Accept", "application/json,text/plain,*/*");
                conn.setRequestProperty("Cache-Control", "no-cache");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                int code = conn.getResponseCode();
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in == null) in = new ByteArrayInputStream(new byte[0]);
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                in.close();
                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("body", sb.toString());
                return out.toString();
            } catch (Exception e) {
                return "{\"status\":0,\"body\":\"native network error\"}";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /* 用户自己填的 AI / TTS 接口：APK 里第三方接口常被 CORS 拦，交给原生发。
           只允许 https，避免明文；返回 base64，JSON 和音频都能原样交给页面。 */
        @JavascriptInterface
        public String apiAny(String url, String method, String headersJson, String body) {
            HttpURLConnection conn = null;
            try {
                if (url == null || !url.startsWith("https://")) return "{\"status\":502,\"body\":\"blocked\",\"contentType\":\"text/plain\"}";
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                String m = method == null ? "GET" : method.toUpperCase();
                if (!m.equals("POST") && !m.equals("PUT") && !m.equals("PATCH") && !m.equals("DELETE")) m = "GET";
                conn.setRequestMethod(m);
                conn.setConnectTimeout(12000);
                conn.setReadTimeout(45000);
                conn.setDoInput(true);
                conn.setUseCaches(false);
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                try {
                    JSONObject hs = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> it = hs.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        String lk = k == null ? "" : k.toLowerCase();
                        if (lk.equals("host") || lk.equals("origin") || lk.equals("referer")
                                || lk.equals("content-length") || lk.equals("connection")
                                || lk.startsWith("sec-")) continue;
                        String v = hs.optString(k, "");
                        if (!v.isEmpty()) conn.setRequestProperty(k, v);
                    }
                } catch (Exception ignored) {}
                if (m.equals("POST") || m.equals("PUT") || m.equals("PATCH")) {
                    conn.setDoOutput(true);
                    byte[] payload = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
                    OutputStream out = conn.getOutputStream();
                    out.write(payload);
                    out.close();
                }
                int code = conn.getResponseCode();
                InputStream in = null;
                try {
                    in = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
                } catch (Exception e) {
                    in = conn.getErrorStream();
                }
                if (in == null) in = new ByteArrayInputStream(new byte[0]);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                in.close();
                byte[] bytes = bos.toByteArray();
                String ct = conn.getContentType();
                if (ct == null || ct.isEmpty()) ct = "application/octet-stream";
                JSONObject out = new JSONObject();
                out.put("status", code);
                out.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP));
                out.put("contentType", ct);
                out.put("encoding", "base64");
                return out.toString();
            } catch (Exception e) {
                try {
                    JSONObject out = new JSONObject();
                    out.put("status", 0);
                    out.put("body", "");
                    out.put("contentType", "text/plain");
                    out.put("encoding", "base64");
                    out.put("message", e.getMessage() == null ? "native network error" : e.getMessage());
                    return out.toString();
                } catch (Exception e2) {
                    return "{\"status\":0,\"body\":\"\",\"contentType\":\"text/plain\",\"encoding\":\"base64\"}";
                }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @JavascriptInterface
        public void saveFile(String name, String base64, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safe = name == null ? "Eleven11_backup.json" : name;
                safe = safe.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (safe.trim().isEmpty()) safe = "Eleven11_backup.json";
                String type = mime == null || mime.trim().isEmpty() ? "application/octet-stream" : mime;

                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    values.put(MediaStore.Downloads.MIME_TYPE, type);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Eleven11");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IOException("无法创建下载文件");
                    OutputStream out = getContentResolver().openOutputStream(uri);
                    if (out == null) throw new IOException("无法写入下载文件");
                    out.write(bytes);
                    out.close();
                    toast("已保存到「下载/Eleven11」：" + safe);
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getFilesDir();
                    File target = new File(dir, safe);
                    FileOutputStream out = new FileOutputStream(target);
                    out.write(bytes);
                    out.close();
                    toast("已保存：" + target.getAbsolutePath());
                }
            } catch (Exception e) {
                toast("保存失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
            }
        }

        @JavascriptInterface
        public void pickImage(String token) {
            imagePickToken = token;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                        intent.setType("image/*");
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        startActivityForResult(Intent.createChooser(intent, "选择照片"), REQ_IMAGE);
                    } catch (Exception e) {
                        evalJs("window.__androidPickError(" + JSONObject.quote(imagePickToken == null ? "" : imagePickToken) + "," + JSONObject.quote("无法打开相册") + ")");
                        imagePickToken = null;
                    }
                }
            });
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || !url.startsWith("https://")) return;
            openExternal(url);
        }

        @JavascriptInterface
        public void downloadApk(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startApkDownload(url);
                }
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            MainActivity.this.toast(msg);
        }
    }

    private void evalJs(String js) {
        try {
            if (webView != null) webView.evaluateJavascript(js, null);
        } catch (Exception ignored) {}
    }

    /* 相册照片统一在原生解码成 JPEG/PNG：HEIC、超大图、部分厂商相册返回的 URI，
       WebView 的 <input type=file> 可能直接读不出来，表现为“有些照片换不了” */
    private String imageUriToDataUrl(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        InputStream is = getContentResolver().openInputStream(uri);
        if (is == null) throw new IOException("无法读取图片");
        try { BitmapFactory.decodeStream(is, null, bounds); } finally { is.close(); }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("图片格式不支持");

        int sample = 1;
        int maxSide = Math.max(bounds.outWidth, bounds.outHeight);
        while (maxSide / sample > 1600) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        is = getContentResolver().openInputStream(uri);
        if (is == null) throw new IOException("无法读取图片");
        Bitmap bmp;
        try { bmp = BitmapFactory.decodeStream(is, null, opts); } finally { is.close(); }
        if (bmp == null) throw new IOException("图片解码失败");

        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try {
            InputStream ex = getContentResolver().openInputStream(uri);
            if (ex != null) {
                try {
                    ExifInterface exif = new ExifInterface(ex);
                    orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                } finally { ex.close(); }
            }
        } catch (Exception ignored) {}
        int rotate = 0;
        if (orientation == ExifInterface.ORIENTATION_ROTATE_90) rotate = 90;
        else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) rotate = 180;
        else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) rotate = 270;
        if (rotate != 0) {
            Matrix m = new Matrix();
            m.postRotate(rotate);
            Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (rotated != bmp) { bmp.recycle(); bmp = rotated; }
        }

        boolean alpha = bmp.hasAlpha();
        String mime = alpha ? "image/png" : "image/jpeg";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, alpha ? 100 : 86, out);
        bmp.recycle();
        return "data:" + mime + ";base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    private String guessMime(String path) {
        String p = path == null ? "" : path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }
}
