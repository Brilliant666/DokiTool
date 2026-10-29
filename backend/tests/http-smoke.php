<?php
declare(strict_types=1);
// Requires public gateway at 127.0.0.1:19186 and mock-internal.php at 127.0.0.1:19187.
$base = $argv[1] ?? 'http://127.0.0.1:19186';
if (!preg_match('~^http://127\.0\.0\.1:\d+$~D', $base)) { throw new RuntimeException('Loopback only'); }
$checks = [];
function request(string $path): array {
    global $base;
    $ch = curl_init($base . $path);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_PROXY => '', CURLOPT_HTTPHEADER => ['Host: attacker.test', 'X-Forwarded-Proto: https']]);
    $body = curl_exec($ch); $status = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    return [$status, json_decode((string)$body, true)];
}
foreach (['douyin' => 'https://v.douyin.com/fixture', 'kuaishou' => 'https://v.kuaishou.com/fixture', 'bilibili' => 'https://www.bilibili.com/video/BV1234567890?p=2', 'xiaohongshu' => 'https://xhslink.com/fixture', 'toutiao' => 'https://www.toutiao.com/video/fixture', 'weibo' => 'https://weibo.com/fixture', 'pipixia' => 'https://h5.pipix.com/fixture', 'pipigx' => 'https://h5.pipigx.com/fixture', 'zuiyou' => 'https://share.izuiyou.com/fixture'] as $platform => $url) {
    [$status, $data] = request('/api/short_videos?url=' . rawurlencode($url));
    $checks[] = ['name' => 'aggregate HTTP roundtrip ' . $platform, 'passed' => $status === 200 && ($data['code'] ?? null) === 200 && ($data['data']['extra'] ?? null) === ['received_url' => $url, 'received_host' => 'snap.dokitool.com', 'received_path' => '/parse/' . $platform]];
    if ($platform === 'weibo') {
        $checks[] = ['name' => 'public Weibo media ticket issued', 'passed' => ($data['data']['media_delivery'] ?? '') === 'weibo-relay' && str_starts_with($data['data']['playback_url'] ?? '', '/api/media/weibo?ticket=')];
    }
}
foreach (['html' => [502, 502], 'http-failure' => [502, 502], 'redirect' => [502, 502], 'business-failure' => [200, 404]] as $case => [$wantStatus, $wantCode]) {
    [$status, $data] = request('/api/short_videos?url=' . rawurlencode('https://v.douyin.com/' . $case));
    $checks[] = ['name' => 'aggregate HTTP ' . $case, 'passed' => $status === $wantStatus && ($data['code'] ?? null) === $wantCode];
}
// This Bilibili path exits before any external request. It exercises the real legacy exit + output buffer.
[$status, $data] = request('/api/bilibili?url=' . rawurlencode('https://www.bilibili.com/not-a-video'));
$checks[] = ['name' => 'real parser business rejection via exit()', 'passed' => $status === 200 && ($data['code'] ?? null) === -1];
foreach (['/api/svproxyurl.php', '/api/douyin/douyin.php', '/api/wyy.py', '/parse/douyin'] as $path) {
    [$status, $data] = request($path);
    $checks[] = ['name' => 'closed route ' . $path, 'passed' => $status === 404 && ($data['code'] ?? null) === 404];
}
$passed = count(array_filter($checks, static fn ($item) => $item['passed']));
echo json_encode(['suite' => 'backend-local-http', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
