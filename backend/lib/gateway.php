<?php
declare(strict_types=1);
require_once __DIR__ . '/runtime.php';

/** DokiTool adapter. Original parser files and their MIT notices remain in api/. */
function snapPlatforms(): array
{
    return [
        'douyin' => ['file' => 'douyin/douyin.php', 'domains' => ['douyin.com', 'iesdouyin.com']],
        'kuaishou' => ['file' => 'kuaishou/ksjx.php', 'domains' => ['kuaishou.com']],
        'bilibili' => ['file' => 'bilibili/bilibili.php', 'domains' => ['bilibili.com', 'b23.tv']],
        'xiaohongshu' => ['file' => 'xiaohongshu/xhsjx.php', 'domains' => ['xiaohongshu.com', 'xhslink.com']],
        'toutiao' => ['file' => 'toutiao.php', 'domains' => ['toutiao.com', 'toutiaoimg.com']],
        'weibo' => ['file' => 'weibo.php', 'domains' => ['weibo.com', 'weibo.cn']],
        'pipixia' => ['file' => 'ppxia.php', 'domains' => ['pipix.com']],
        'pipigx' => ['file' => 'pipigx.php', 'domains' => ['pipigx.com', 'ippzone.com']],
        'zuiyou' => ['file' => 'zuiyou.php', 'domains' => ['izuiyou.com']],
    ];
}

function snapPublicRoutes(): array
{
    return [
        '/api/short_videos' => 'all', '/api/douyin' => 'douyin',
        '/api/ksjx' => 'kuaishou', '/api/bilibili' => 'bilibili',
        '/api/xhsjx' => 'xiaohongshu', '/api/toutiao' => 'toutiao',
    ];
}

/** Only successful parser output can mint a short-lived, fixed-provider media ticket. */
function snapPreparePublicMedia(string $platform, array $payload, int $status = 200, ?string $key = null): array
{
    if ($platform !== 'weibo' || $status !== 200 || (int)($payload['code'] ?? 0) !== 200 || !is_array($payload['data'] ?? null)) {
        return [$status, $payload];
    }
    require_once __DIR__ . '/weibo-media.php';
    $key ??= getenv('SNAP_MEDIA_SIGNING_KEY') ?: '';
    if (snapWeiboMediaKey($key) === null) {
        return [503, snapError(503, '微博播放服务尚未配置，请联系站点维护者')];
    }
    $data = $payload['data'];
    $playback = snapWeiboMediaUrl((string)($data['url'] ?? ''), $key);
    if ($playback === null) {
        return [502, snapError(502, '微博暂未提供本站支持的视频源，请稍后重试')];
    }
    $data['playback_url'] = $playback;
    $data['media_delivery'] = 'weibo-relay';
    $backups = [];
    foreach (is_array($data['video_backup'] ?? null) ? $data['video_backup'] : [] as $source) {
        if (!is_array($source)) { continue; }
        $ticket = snapWeiboMediaUrl((string)($source['url'] ?? ''), $key);
        if ($ticket === null) { continue; }
        $source['playback_url'] = $ticket;
        $backups[] = $source;
    }
    $data['video_backup'] = $backups;
    $payload['data'] = $data;
    return [$status, $payload];
}

function snapError(int $code, string $message): array
{
    return ['code' => $code, 'msg' => $message, 'data' => null];
}

function snapSend(array $payload, int $status = 200): void
{
    http_response_code($status);
    header_remove('Access-Control-Allow-Origin');
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

/** Exact host or dot-delimited subdomain match; URL text/path cannot select a platform. */
function snapPlatformForUrl(string $url): ?string
{
    $parts = parse_url($url);
    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
        || isset($parts['user']) || isset($parts['pass'])
        || preg_match('/[\\\\\x00-\x20\x7f]/', $url)
        || !filter_var($url, FILTER_VALIDATE_URL)) {
        return null;
    }
    if (isset($parts['port']) && $parts['port'] !== (strtolower($parts['scheme']) === 'https' ? 443 : 80)) {
        return null;
    }
    $host = strtolower($parts['host'] ?? '');
    foreach (snapPlatforms() as $platform => $config) {
        foreach ($config['domains'] as $domain) {
            if ($host === $domain || str_ends_with($host, '.' . $domain)) {
                return $platform;
            }
        }
    }
    return null;
}

/** Accept a URL or the first URL in copied share text. Preserve its encoded query (including Bilibili p). */
function snapInputUrl(array $query): ?string
{
    $input = $query['url'] ?? null;
    if (!is_string($input) || strlen($input) > 8192) {
        return null;
    }
    if (!preg_match('~https?://[^\s"\'<>]+~i', trim($input), $matches)) {
        return null;
    }
    return preg_replace('/[\'"，。；,.;!?！？）)]+$/u', '', $matches[0]);
}

function snapInternalSettings(?array $settings = null): array
{
    $origin = rtrim($settings['origin'] ?? (getenv('SNAP_INTERNAL_ORIGIN') ?: 'http://127.0.0.1:9081'), '/');
    $host = strtolower($settings['host'] ?? (getenv('SNAP_INTERNAL_HOST') ?: 'snap.dokitool.com'));
    $parts = parse_url($origin);
    if (!$parts || ($parts['scheme'] ?? '') !== 'http'
        || !in_array($parts['host'] ?? '', ['127.0.0.1', '[::1]'], true)
        || !isset($parts['port']) || $parts['port'] < 1024
        || isset($parts['path']) || isset($parts['query']) || isset($parts['fragment'])
        || isset($parts['user']) || isset($parts['pass'])
        || !preg_match('/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/D', $host)) {
        throw new RuntimeException('Invalid internal gateway configuration');
    }
    return ['origin' => $origin, 'host' => $host];
}

function snapInternalRequestAllowed(array $server, ?array $settings = null): bool
{
    $settings = snapInternalSettings($settings);
    return in_array($server['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)
        && strtolower($server['HTTP_HOST'] ?? '') === $settings['host'];
}

/** Return [HTTP status, envelope]. A JSON scalar or HTML is never a successful parser response. */
function snapDecodeResponse(string $body, int $status = 200): array
{
    $decoded = json_decode($body, true);
    if (!is_array($decoded) || !array_key_exists('code', $decoded) || !is_numeric($decoded['code'])) {
        return [502, snapError(502, '解析接口返回格式异常')];
    }
    if ($status < 200 || $status >= 300) {
        if ($status >= 400 && $status <= 599 && (int)$decoded['code'] !== 200) {
            return [$status, $decoded];
        }
        // Internal transport failures must not look like successful parsing.
        return [502, snapError(502, '内部解析接口请求失败')];
    }
    if ((int)$decoded['code'] === 200 && is_array($decoded['data'] ?? null)) {
        $decoded['data'] = snapNormalizeMedia($decoded['data']);
    }
    // Preserve upstream business codes, including failures delivered with HTTP 200.
    return [200, $decoded];
}

/** Adapt known legacy field aliases without changing business failures or source selection. */
function snapNormalizeMedia(array $data): array
{
    if (!snapMediaUrl($data['url'] ?? null) && snapMediaUrl($data['video'] ?? null)) {
        $data['url'] = snapMediaUrl($data['video']);
    }
    if (empty($data['images']) && is_array($data['imgurl'] ?? null)) {
        $data['images'] = array_values(array_filter(array_map('snapMediaUrl', $data['imgurl'])));
    }
    if (is_string($data['music'] ?? null)) {
        $data['music'] = ['url' => snapMediaUrl($data['music'])];
    }
    if (is_array($data['video_backup'] ?? null)) {
        $backups = [];
        foreach ($data['video_backup'] as $item) {
            $item = is_string($item) ? ['url' => $item] : $item;
            if (is_array($item) && snapMediaUrl($item['url'] ?? null)) {
                $item['url'] = snapMediaUrl($item['url']);
                $backups[] = $item;
            }
        }
        $data['video_backup'] = $backups;
    }
    return $data;
}

/** The aggregate request goes only to a configured loopback origin and a fixed Host. */
function snapForward(string $platform, string $url, ?callable $transport = null, ?array $settings = null): array
{
    if (!isset(snapPlatforms()[$platform]) || snapPlatformForUrl($url) !== $platform) {
        return [400, snapError(400, '链接平台不匹配或不受支持')];
    }
    $config = snapInternalSettings($settings);
    $endpoint = $config['origin'] . '/parse/' . $platform . '?url=' . rawurlencode($url);
    if ($transport !== null) {
        $response = $transport($endpoint, $config['host']);
    } else {
        $ch = curl_init($endpoint);
        $body = '';
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => ['Host: ' . $config['host'], 'Accept: application/json'],
            CURLOPT_PROXY => '',
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 45,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP,
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body): int {
                if (strlen($body) + strlen($chunk) > 4 * 1024 * 1024) {
                    return 0;
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($ch);
        $response = ['body' => $body, 'status' => (int)curl_getinfo($ch, CURLINFO_HTTP_CODE), 'ok' => $ok !== false];
        curl_close($ch);
    }
    if (!($response['ok'] ?? false)) {
        return [502, snapError(502, '内部解析接口连接失败或超时')];
    }
    return snapDecodeResponse((string)($response['body'] ?? ''), (int)($response['status'] ?? 0));
}

/** Run one legacy entrypoint, including entrypoints that exit, without leaking PHP warnings as HTML. */
function snapRunParser(string $platform, string $url): void
{
    $file = __DIR__ . '/../api/' . snapPlatforms()[$platform]['file'];
    $_GET = ['url' => $url];
    $_POST = [];
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $_SERVER['REQUEST_URI'] = '/?url=' . rawurlencode($url);
    ini_set('display_errors', '0');
    ini_set('default_socket_timeout', '20');
    stream_context_set_default([
        'http' => ['timeout' => 20, 'max_redirects' => 5],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
    ob_start(static function (string $body): string {
        [$status, $payload] = snapDecodeResponse($body, http_response_code() ?: 200);
        http_response_code($status);
        header_remove('Access-Control-Allow-Origin');
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        return json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    });
    chdir(dirname($file));
    try {
        require $file;
    } catch (Throwable $error) {
        ob_clean();
        http_response_code(500);
        echo json_encode(snapError(500, '解析服务暂时不可用，请稍后重试'), JSON_UNESCAPED_UNICODE);
    }
    ob_end_flush();
}

function snapHandle(bool $internal = false): void
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if ($internal && !snapInternalRequestAllowed($_SERVER)) {
        snapSend(snapError(403, '禁止访问内部接口'), 403);
        return;
    }
    // Streaming must stay outside the legacy JSON output-buffer adapter.
    if (!$internal && $path === '/api/media/weibo') {
        require_once __DIR__ . '/weibo-media.php';
        snapHandleWeiboMedia();
        return;
    }
    $routes = $internal ? array_combine(
        array_map(static fn ($key) => '/parse/' . $key, array_keys(snapPlatforms())),
        array_keys(snapPlatforms())
    ) : snapPublicRoutes();
    if (!is_string($path) || !isset($routes[$path])) {
        snapSend(snapError(404, '接口不存在'), 404);
        return;
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
        header('Allow: GET');
        snapSend(snapError(405, '仅支持 GET 请求'), 405);
        return;
    }
    $url = snapInputUrl($_GET);
    $platform = $url === null ? null : snapPlatformForUrl($url);
    $route = $routes[$path];
    if ($url === null || $platform === null || ($route !== 'all' && $route !== $platform)) {
        snapSend(snapError(400, '请输入对应平台的有效分享链接'), 400);
        return;
    }
    if (!extension_loaded('curl')) {
        snapSend(snapError(503, '解析服务未配置完成'), 503);
        return;
    }
    if ($route === 'all') {
        require __DIR__ . '/../api/sv.php';
        return;
    }
    snapRunParser($platform, $url);
}
