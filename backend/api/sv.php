<?php
/**
 * @Author: JH-Ahua
 * @CreateTime: 2025/8/6 上午12:56
 * @UpdateTime: 2026/10/19
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 短视频聚合解析：一个入口自动识别平台，转发到对应的单平台解析接口
 */

// DokiTool adaptation: requests go to a fixed loopback gateway, never request Host/X-Forwarded-Proto.
require_once __DIR__ . '/../lib/gateway.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET');
    snapSend(snapError(405, '仅支持 GET 请求'), 405);
    return;
}
$url = snapInputUrl($_GET);
$platform = $url === null ? null : snapPlatformForUrl($url);
if ($platform === null) {
    snapSend(snapError(400, '请输入受支持平台的有效分享链接'), 400);
    return;
}
if (!extension_loaded('curl')) {
    snapSend(snapError(503, '解析服务未配置完成'), 503);
    return;
}
try {
    [$status, $payload] = snapForward($platform, $url);
    snapSend($payload, $status);
} catch (Throwable $error) {
    snapSend(snapError(503, '解析服务配置异常'), 503);
}
