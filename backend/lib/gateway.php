<?php
declare(strict_types=1);
require_once __DIR__ . '/runtime.php';

require_once __DIR__ . '/platforms.php';
require_once __DIR__ . '/media-adapters.php';
require_once __DIR__ . '/media-policy.php';

function snapPublicRoutes(): array
{
    return ['/api/parse' => 'parse', '/api/resolve' => 'resolve', '/api/platforms' => 'platforms'];
}

function snapError(int $status, string $message): array
{
    $code = match ($status) {
        400, 404, 405, 409, 410 => 'INVALID_INPUT', 403 => 'UPSTREAM_BLOCKED',
        429 => 'RATE_LIMITED', 500 => 'INTERNAL_ERROR', 503 => 'SERVICE_NOT_CONFIGURED',
        504 => 'UPSTREAM_TIMEOUT', default => 'UPSTREAM_INVALID_RESPONSE',
    };
    return snapContractError($code, $message, in_array($status, [429, 502, 504], true));
}

function snapEnvelopeStatus(array $payload): int
{
    return match ($payload['code']) {
        'OK' => 200, 'INVALID_INPUT', 'UNSUPPORTED_PLATFORM' => 400,
        'NO_MEDIA', 'CONTENT_UNAVAILABLE' => 404, 'UPSTREAM_BLOCKED' => 403,
        'RATE_LIMITED' => 429, 'UPSTREAM_TIMEOUT' => 504, 'SERVICE_NOT_CONFIGURED' => 503,
        'INTERNAL_ERROR' => 500, default => 502,
    };
}

/** Only a registered successful Weibo result may mint a fixed-provider relay ticket. */
function snapPreparePublicMedia(string $platform, array $payload, int $status = 200, ?string $key = null, bool $debug = false): array
{
    if ($status !== 200 || ($payload['code'] ?? '') !== 'OK') return [$status, $payload];
    // Filtering must not hide malformed metadata or broken full-inventory references.
    snapValidateEnvelope($payload);
    if ($platform !== 'weibo') {
        $payload = snapPublicMediaView($payload, $debug); snapValidateEnvelope($payload);
        return [$status, $payload];
    }
    require_once __DIR__ . '/weibo-media.php';
    $key ??= getenv('SNAP_MEDIA_SIGNING_KEY') ?: '';
    if (snapWeiboMediaKey($key) === null) return [503, snapError(503, '微博播放服务尚未配置，请联系站点维护者')];
    $now = time(); $recognized = 0;
    foreach ($payload['data']['items'] as &$item) {
        foreach ($item['variants'] ?? [] as $i => $variant) {
            if (($variant['state'] ?? 'ready') !== 'ready') continue;
            $variant['delivery'] = snapMapDeliverySources($variant['delivery'], static function (array $source) use ($key, $now, &$recognized): array {
                if (!snapWeiboMediaAllowedUrl($source['url'])) { $source['availability'] = 'unavailable'; return $source; }
                $recognized++;
                if (!snapSourceUsable($source, $now)) return $source;
                $expiry = min(isset($source['expires_at']) ? (int)strtotime($source['expires_at']) : $now + SNAP_WEIBO_MEDIA_TTL, $now + SNAP_WEIBO_MEDIA_TTL);
                $ticket = snapWeiboMediaUrl($source['url'], $key, $now, $expiry);
                if ($ticket === null) { $source['availability'] = 'unavailable'; return $source; }
                $source['url'] = $ticket; $source['access'] = 'relay';
                $source['expires_at'] = gmdate('Y-m-d\TH:i:s\Z', $expiry);
                return $source;
            });
            $item['variants'][$i] = $variant;
        }
    }
    unset($item);
    if (!$recognized) return [502, snapError(502, '微博暂未提供本站支持的视频源，请稍后重试')];
    $payload = snapPublicMediaView($payload, $debug, $now);
    snapValidateEnvelope($payload);
    return [200, $payload];
}

/** Apply the same source boundary to simple and composed deliveries. IDs stay intact. */
function snapMapDeliverySources(array $delivery, callable $map): array
{
    if (isset($delivery['sources'])) $delivery['sources'] = array_map($map, $delivery['sources']);
    if (isset($delivery['init'])) $delivery['init']['sources'] = array_map($map, $delivery['init']['sources']);
    foreach ($delivery['pieces'] ?? [] as $index => $piece) $delivery['pieces'][$index]['sources'] = array_map($map, $piece['sources']);
    foreach ($delivery['resources'] ?? [] as $index => $resource) $delivery['resources'][$index]['delivery'] = snapMapDeliverySources($resource['delivery'], $map);
    return $delivery;
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

/** The internal boundary accepts only the new contract; legacy data never leaks through. */
function snapDecodeResponse(string $body, int $status = 200): array
{
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) return [502, snapError(502, '解析接口返回格式异常')];
    try { snapValidateEnvelope($decoded); }
    catch (Throwable $error) { return [502, snapError(502, '解析接口合同校验失败')]; }
    $expected = snapEnvelopeStatus($decoded);
    if ($status !== $expected) return [502, snapError(502, '内部解析接口状态不一致')];
    return [$expected, $decoded];
}

/** The aggregate request goes only to a configured loopback origin and a fixed Host. */
function snapForward(string $platform, string $url, ?callable $transport = null, ?array $settings = null, bool $debug = false): array
{
    if (!isset(snapPlatforms()[$platform]) || snapPlatformForUrl($url) !== $platform) {
        return [400, snapError(400, '链接平台不匹配或不受支持')];
    }
    $config = snapInternalSettings($settings);
    $endpoint = $config['origin'] . '/parse?platform=' . rawurlencode($platform) . '&url=' . rawurlencode($url);
    if ($debug) $endpoint .= '&debug=1';
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
function snapRunParser(string $platform, string $url, bool $debug = false): void
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
    ob_start(static function (string $body) use ($platform, $url, $debug): string {
        try {
            $raw = json_decode($body, true, 128, JSON_THROW_ON_ERROR);
            if (!is_array($raw)) throw new UnexpectedValueException('Invalid parser output');
            $payload = snapAdaptParser($platform, $raw, $url);
            // Internal transport always retains the normalized inventory. Only
            // the public gateway can filter after source signing/availability.
            if ($debug && ($payload['code'] ?? '') === 'OK') $payload = snapPublicMediaView($payload, true);
            if ((http_response_code() ?: 200) >= 400 && $payload['code'] === 'OK') throw new UnexpectedValueException('Failed parser returned success');
            snapValidateEnvelope($payload);
            $status = snapEnvelopeStatus($payload);
        } catch (Throwable $error) {
            $status = 502; $payload = snapError(502, '上游返回不完整或不符合媒体合同的数据');
        }
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
        echo json_encode(['code' => 500, 'msg' => '解析服务暂时不可用，请稍后重试'], JSON_UNESCAPED_UNICODE);
    }
    ob_end_flush();
}

function snapHandle(bool $internal = false): void
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if ($internal && !snapInternalRequestAllowed($_SERVER)) {
        snapSend(snapError(403, '禁止访问内部接口'), 403); return;
    }
    if (!$internal && $path === '/api/media/weibo') {
        require_once __DIR__ . '/weibo-media.php'; snapHandleWeiboMedia(); return;
    }
    if (!$internal && in_array($path, ['/api/short_videos', '/api/douyin', '/api/ksjx', '/api/bilibili', '/api/xhsjx', '/api/toutiao'], true)) {
        snapSend(snapError(410, '接口已更新，请等待当前下载结束后刷新页面'), 410); return;
    }
    if ((!$internal && !isset(snapPublicRoutes()[$path ?? ''])) || ($internal && $path !== '/parse')) {
        snapSend(snapError(404, '接口不存在'), 404); return;
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
        header('Allow: GET'); snapSend(snapError(405, '仅支持 GET 请求'), 405); return;
    }
    if (!$internal && ($_GET['schema_version'] ?? null) !== SNAP_SCHEMA_VERSION) {
        snapSend(snapError(409, '接口版本已更新，请等待当前下载结束后刷新页面'), 409); return;
    }
    if ($path === '/api/platforms') { snapSend(snapPlatformCatalog()); return; }
    $url = snapInputUrl($_GET); $platform = $url === null ? null : snapPlatformForUrl($url);
    $requestedPlatform = $_GET['platform'] ?? 'all';
    if ($url === null || $platform === null || !is_string($requestedPlatform) || ($requestedPlatform !== 'all' && $requestedPlatform !== $platform)) {
        snapSend(snapError(400, '请输入对应平台的有效分享链接'), 400); return;
    }
    $itemId = $_GET['item_id'] ?? null;
    if ($path === '/api/resolve' && (!is_string($itemId) || $itemId === '' || strlen($itemId) > 256)) {
        snapSend(snapError(400, '缺少有效的媒体条目标识'), 400); return;
    }
    if (!extension_loaded('curl')) { snapSend(snapError(503, '解析服务未配置完成'), 503); return; }
    $debug = ($_GET['debug'] ?? null) === '1';
    if ($internal) { snapRunParser($platform, $url, $debug); return; }
    [$status, $payload] = snapForward($platform, $url, debug: $debug);
    [$status, $payload] = snapPreparePublicMedia($platform, $payload, $status, debug: $debug);
    if ($status === 200 && $path === '/api/resolve') {
        $items = array_values(array_filter($payload['data']['items'], static fn ($i) => $i['id'] === $itemId));
        if (!$items || ($items[0]['state'] ?? 'ready') !== 'ready') {
            snapSend(snapContractError('CONTENT_UNAVAILABLE', '请求的媒体条目暂时不可用'), 404); return;
        }
        $payload['data']['default_item_id'] = $itemId;
        snapValidateEnvelope($payload);
    }
    snapSend($payload, $status);
}
