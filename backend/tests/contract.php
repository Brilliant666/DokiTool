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

check('six public aliases only', count(snapPublicRoutes()) === 6);
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

$media = ['code' => 200, 'data' => [
    'title' => '契约样本', 'url' => 'https://media.example/video.mp4',
    'images' => ['https://media.example/a.jpg'],
    'live_photo' => [['image' => 'https://media.example/live.jpg', 'video' => 'https://media.example/live.mp4']],
    'video_backup' => [['quality' => '720p', 'url' => 'https://media.example/720.mp4']],
    'videos' => [['index' => 1, 'title' => 'P1', 'url' => 'https://media.example/p1.mp4'], ['index' => 2, 'title' => 'P2', 'error' => ' unavailable']],
    'extra' => ['pages' => [['page' => 1, 'cid' => 101], ['page' => 2, 'cid' => 102]], 'current_page' => 1],
]];
check('full media contract preserved', snapDecodeResponse(json_encode($media)) === [200, $media]);
$business = ['code' => 404, 'msg' => '作品不可用', 'data' => []];
check('HTTP 200 business failure preserved', snapDecodeResponse(json_encode($business)) === [200, $business]);
check('HTTP 404 business failure preserved', snapDecodeResponse(json_encode($business), 404) === [404, $business]);
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
check('aggregate ignores request Host and scheme', $seen === ['http://127.0.0.1:9081/parse/bilibili?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1234567890%3Fp%3D2', 'snap.dokitool.com']);
check('aggregate network failure', snapForward('douyin', 'https://v.douyin.com/abc', fn () => ['ok' => false])[0] === 502);
check('aggregate platform mismatch blocks transport', snapForward('douyin', 'https://www.bilibili.com/video/BV1234567890', fn () => throw new RuntimeException('must not run'))[0] === 400);

foreach ([
    ['/api/svproxyurl.php', 'GET', [], 404], ['/api/douyin-home/home.php', 'GET', [], 404],
    ['/api/wyy.py', 'GET', [], 404], ['/api/douyin/douyin.php', 'GET', [], 404],
    ['/api/v1/session', 'GET', [], 404], ['/parse/douyin', 'GET', [], 404],
    ['/api/douyin', 'POST', [], 405], ['/api/douyin', 'GET', [], 400],
    ['/api/douyin', 'GET', ['url' => ['x']], 400], ['/api/douyin', 'GET', ['url' => 'https://b23.tv/abc'], 400],
] as [$path, $method, $query, $expected]) {
    $_SERVER = ['REQUEST_URI' => $path, 'REQUEST_METHOD' => $method]; $_GET = $query;
    http_response_code(200); ob_start(); snapHandle(); $body = ob_get_clean();
    check('public dispatch ' . $method . ' ' . $path . ' ' . $expected, http_response_code() === $expected && json_decode($body, true)['code'] === $expected);
}

$passed = count(array_filter($checks, static fn ($item) => $item['passed']));
echo json_encode(['suite' => 'backend-contract', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
