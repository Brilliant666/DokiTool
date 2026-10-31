<?php
declare(strict_types=1);
require __DIR__ . '/../lib/gateway.php';

$checks = [];
function check(string $name, bool $condition): void
{
    global $checks;
    $checks[] = ['name' => $name, 'passed' => $condition];
}
function fails(callable $operation): bool
{
    try { $operation(); return false; } catch (RuntimeException $error) { return true; }
}

check('three generic public routes', count(snapPublicRoutes()) === 3);
foreach (snapPlatforms() as $platform => $config) {
    check('entrypoint exists: ' . $platform, is_file(__DIR__ . '/../api/' . $config['file']));
}
foreach ([
    'https://v.douyin.com/abc/' => 'douyin', 'https://www.iesdouyin.com/share/video/1' => 'douyin',
    'https://v.kuaishou.com/abc' => 'kuaishou', 'https://www.bilibili.com/video/BV1234567890?p=2' => 'bilibili',
    'https://b23.tv/abc' => 'bilibili', 'https://xhslink.com/abc' => 'xiaohongshu',
    'https://www.toutiao.com/video/1' => 'toutiao', 'https://weibo.com/tv/show/1' => 'weibo',
    'https://h5.pipix.com/s/abc' => 'pipixia', 'https://h5.pipigx.com/pp/post?pid=1&mid=2' => 'pipigx',
    'https://share.izuiyou.com/detail/1' => 'zuiyou',
] as $url => $platform) {
    check('platform: ' . $platform . ' ' . parse_url($url, PHP_URL_HOST), snapPlatformForUrl($url) === $platform);
}
foreach ([
    'http://127.0.0.1/douyin', 'http://169.254.169.254/douyin', 'http://[::1]/douyin',
    'https://douyin.com.evil.test/1', 'https://evil.test/?url=https://douyin.com',
    'https://douyin.com@evil.test/1', 'https://user:pass@www.douyin.com/1',
    'ftp://www.douyin.com/1', 'https://www.douyin.com:8443/1',
    "https://www.douyin.com/1\r\nX-Test: a", 'https://www.douyin.com\@evil.test/1',
] as $url) {
    check('reject malformed or foreign URL: ' . $url, snapPlatformForUrl($url) === null);
}
check('share text extraction', snapInputUrl(['url' => '分享 https://v.douyin.com/abc/。']) === 'https://v.douyin.com/abc/');
check('reject url array', snapInputUrl(['url' => ['x']]) === null);
check('reject oversized input', snapInputUrl(['url' => str_repeat('x', 9000)]) === null);
check('preserve Bilibili query', snapInputUrl(['url' => 'https://www.bilibili.com/video/BV1234567890?p=2&foo=x%26y']) === 'https://www.bilibili.com/video/BV1234567890?p=2&foo=x%26y');
check('loopback internal access', snapInternalRequestAllowed(['REMOTE_ADDR' => '127.0.0.1', 'HTTP_HOST' => 'snap.dokitool.com']));
check('reject public internal access', !snapInternalRequestAllowed(['REMOTE_ADDR' => '8.8.8.8', 'HTTP_HOST' => 'snap.dokitool.com']));
check('reject wrong internal host', !snapInternalRequestAllowed(['REMOTE_ADDR' => '127.0.0.1', 'HTTP_HOST' => 'evil.test']));
foreach (['https://evil.test:9081', 'http://127.0.0.1:9081/path', 'http://user@127.0.0.1:9081', 'http://127.0.0.1:9081?x=1'] as $origin) {
    check('reject bad internal origin: ' . $origin, fails(fn () => snapInternalSettings(['origin' => $origin])));
}
check('reject internal Host injection', fails(fn () => snapInternalSettings(['host' => "snap.dokitool.com\r\nInjected: x"])));

$media = snapAdaptParser('douyin', ['code' => 200, 'data' => ['title' => '契约样本', 'url' => 'https://media.example/video.mp4']], 'https://v.douyin.com/example');
check('unified media contract accepted', snapDecodeResponse(json_encode($media)) === [200, $media]);
$business = snapContractError('CONTENT_UNAVAILABLE', '作品不可用');
check('HTTP 200 business failure is rejected', snapDecodeResponse(json_encode($business))[0] === 502);
check('HTTP 404 business failure preserved', snapDecodeResponse(json_encode($business), 404) === [404, $business]);
check('legacy envelope rejected', snapDecodeResponse('{"code":200,"data":{"url":"https://media.example/video.mp4"}}')[0] === 502);
foreach (['<html>error</html>', '', 'null', '"ok"', '[]', '{"data":{}}', '{"code":[],"data":{}}'] as $body) {
    check('reject non-envelope: ' . $body, snapDecodeResponse($body)[0] === 502);
}
check('HTTP failure cannot become success', snapDecodeResponse(json_encode($media), 500)[0] === 502);
check('internal redirect rejected', snapDecodeResponse(json_encode($media), 302)[0] === 502);

$_SERVER['HTTP_HOST'] = 'attacker.test';
$_SERVER['HTTP_X_FORWARDED_PROTO'] = 'https';
$seen = [];
$result = snapForward('bilibili', 'https://www.bilibili.com/video/BV1234567890?p=2', function ($url, $host) use (&$seen, $media) {
    $seen = [$url, $host];
    return ['ok' => true, 'status' => 200, 'body' => json_encode($media)];
});
check('aggregate success', $result === [200, $media]);
check('aggregate ignores request Host and scheme', $seen === ['http://127.0.0.1:9081/parse?platform=bilibili&url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1234567890%3Fp%3D2', 'snap.dokitool.com']);
check('aggregate network failure', snapForward('douyin', 'https://v.douyin.com/abc', fn () => ['ok' => false])[0] === 502);
check('aggregate platform mismatch blocks transport', snapForward('douyin', 'https://www.bilibili.com/video/BV1234567890', fn () => throw new RuntimeException('must not run'))[0] === 400);

foreach ([
    ['/api/svproxyurl.php', 'GET', [], 404], ['/api/douyin-home/home.php', 'GET', [], 404],
    ['/api/wyy.py', 'GET', [], 404], ['/api/douyin/douyin.php', 'GET', [], 404],
    ['/api/v1/session', 'GET', [], 404], ['/parse/douyin', 'GET', [], 404],
    ['/api/douyin', 'GET', [], 410], ['/api/short_videos', 'GET', [], 410],
    ['/api/parse', 'POST', [], 405], ['/api/parse', 'GET', [], 409],
    ['/api/parse', 'GET', ['schema_version' => '1.0', 'url' => ['x']], 400],
    ['/api/parse', 'GET', ['schema_version' => '1.0', 'url' => 'https://b23.tv/abc', 'platform' => 'douyin'], 400],
] as [$path, $method, $query, $expected]) {
    $_SERVER = ['REQUEST_URI' => $path, 'REQUEST_METHOD' => $method]; $_GET = $query;
    http_response_code(200); ob_start(); snapHandle(); $body = ob_get_clean();
    check('public dispatch ' . $method . ' ' . $path . ' ' . $expected, http_response_code() === $expected && json_decode($body, true)['code'] === 'INVALID_INPUT');
}

$body = '';
$write = snapResponseWriter($body, 16);
check('bounded metadata accepts response at limit', $write(null, '12345678') === 8 && $write(null, 'abcdefgh') === 8 && strlen($body) === 16);
check('bounded metadata aborts before growing buffer', $write(null, 'overflow') === 0 && $body === '12345678abcdefgh');
check('media protocol-relative source normalized', snapMediaUrl('//media.example/video.mp4') === 'https://media.example/video.mp4');
check('media userinfo rejected', snapMediaUrl('https://user@media.example/video.mp4') === '' && snapMediaUrl('https://user:pass@media.example/video.mp4') === '');
check('legacy normalizer removed from public gateway', !function_exists('snapNormalizeMedia'));
$fixtureKey = str_repeat('fixture-key-only-', 3);
$weibo = snapAdaptParser('weibo', ['code' => 200, 'data' => ['url' => 'https://f.video.weibocdn.com/main.mp4', 'width' => 1920, 'height' => 1080,
    'video_backup' => [['url' => 'https://f.video.weibocdn.com/main.mp4', 'width' => 1920, 'height' => 1080], ['url' => 'https://f.video.weibocdn.com/backup.mp4', 'quality' => '720p'], ['url' => 'https://untrusted.example/video.mp4']]]], 'https://weibo.com/example');
[$status, $prepared] = snapPreparePublicMedia('weibo', $weibo, 200, $fixtureKey);
$default = $prepared['data']['items'][0]['default'];
check('signed media delivery reflected in backend default', $status === 200 && $default['access'] === 'relay' && str_starts_with($default['url'], '/api/media/weibo?ticket='));
check('selected dimensions retained', $prepared['data']['items'][0]['variants'][0]['metadata']['width'] === 1920);
check('unknown media hosts are not eligible', $prepared['data']['items'][0]['variants'][2]['delivery']['sources'][0]['availability'] === 'unavailable');
check('missing signing configuration fails clearly', snapPreparePublicMedia('weibo', $weibo, 200, '')[0] === 503);
[$directStatus, $directPayload] = snapPreparePublicMedia('douyin', $media, 200, $fixtureKey);
check('other platforms retain original direct file and source selection', $directStatus === 200 && $directPayload['data']['items'] === $media['data']['items']);
check('business failures never mint tickets', snapPreparePublicMedia('weibo', $business, 404, $fixtureKey) === [404, $business]);
check('HTTP failures never mint tickets', snapPreparePublicMedia('weibo', $weibo, 502, $fixtureKey) === [502, $weibo]);
$foreign = snapAdaptParser('weibo', ['code' => 200, 'data' => ['url' => 'https://evil.test/a.mp4']], 'https://weibo.com/example');
check('unsupported main source is not a false playback success', snapPreparePublicMedia('weibo', $foreign, 200, $fixtureKey)[0] === 502);
check('signing key is never returned', !str_contains(json_encode($prepared), $fixtureKey));
$expiry = gmdate('Y-m-d\TH:i:s\Z', time() + 60);
$limited = snapFinalizeData(['platform' => 'weibo', 'items' => [['id' => 'video', 'type' => 'video', 'default' => null, 'variants' => [['id' => 'main', 'delivery' => ['kind' => 'file', 'sources' => [['url' => 'https://f.video.weibocdn.com/limited.mp4', 'expires_at' => $expiry]]]]]]]]);
[, $preparedLimited] = snapPreparePublicMedia('weibo', $limited, 200, $fixtureKey);
$limitedDefault = $preparedLimited['data']['items'][0]['default']; parse_str(parse_url($limitedDefault['url'], PHP_URL_QUERY), $ticketQuery);
$ticketData = snapWeiboMediaVerifyTicket($ticketQuery['ticket'], $fixtureKey);
check('relay projection and ticket never extend upstream expiry', $limitedDefault['expires_at'] === $expiry && $ticketData['exp'] === strtotime($expiry));
$limited['data']['items'][0]['variants'][0]['delivery']['sources'][0]['expires_at'] = gmdate('c', time() - 10);
$limited = snapFinalizeData($limited['data']);
[$expiredStatus, $expiredPrepared] = snapPreparePublicMedia('weibo', $limited, 200, $fixtureKey);
check('signing does not revive an expired CDN source', $expiredStatus === 200 && $expiredPrepared['data']['items'][0]['default'] === null && $expiredPrepared['data']['items'][0]['default_unavailable_reason'] === 'needs_refresh');
check('rednote registered', snapPlatformForUrl('https://www.rednote.com/explore/example') === 'xiaohongshu');
check('catalog contains nine public descriptors', count(snapPlatformCatalog()['data']['platforms']) === 9 && !isset(snapPlatformCatalog()['data']['platforms'][0]['file']));

$passed = count(array_filter($checks, static fn ($item) => $item['passed']));
echo json_encode(['suite' => 'backend-contract', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
