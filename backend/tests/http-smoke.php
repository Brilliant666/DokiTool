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
    [$status, $data] = request('/api/parse?schema_version=1.0&url=' . rawurlencode($url));
    $checks[] = ['name' => 'aggregate HTTP roundtrip ' . $platform, 'passed' => $status === 200 && ($data['code'] ?? null) === 'OK' && ($data['data']['extra'] ?? null) === ['received_url' => $url, 'received_host' => 'snap.dokitool.com', 'received_path' => '/parse']];
    if ($platform === 'weibo') {
        $checks[] = ['name' => 'public Weibo media ticket issued', 'passed' => ($data['data']['items'][0]['default']['access'] ?? '') === 'relay' && str_starts_with($data['data']['items'][0]['default']['url'] ?? '', '/api/media/weibo?ticket=')];
    }
}
foreach (['html' => [502, 'UPSTREAM_INVALID_RESPONSE'], 'http-failure' => [502, 'UPSTREAM_INVALID_RESPONSE'], 'redirect' => [502, 'UPSTREAM_INVALID_RESPONSE'], 'business-failure' => [404, 'CONTENT_UNAVAILABLE']] as $case => [$wantStatus, $wantCode]) {
    [$status, $data] = request('/api/parse?schema_version=1.0&url=' . rawurlencode('https://v.douyin.com/' . $case));
    $checks[] = ['name' => 'aggregate HTTP ' . $case, 'passed' => $status === $wantStatus && ($data['code'] ?? null) === $wantCode];
}
[$status, $data] = request('/api/resolve?schema_version=1.0&item_id=video&url=' . rawurlencode('https://v.douyin.com/fixture'));
$checks[] = ['name' => 'generic resolve keeps explicit item identity', 'passed' => $status === 200 && ($data['data']['default_item_id'] ?? '') === 'video'];
[$status, $data] = request('/api/resolve?schema_version=1.0&item_id=missing&url=' . rawurlencode('https://v.douyin.com/fixture'));
$checks[] = ['name' => 'resolve never substitutes missing requested item', 'passed' => $status === 404 && ($data['code'] ?? '') === 'CONTENT_UNAVAILABLE'];
[$status, $data] = request('/api/platforms?schema_version=1.0');
$checks[] = ['name' => 'public registry returns nine platforms', 'passed' => $status === 200 && count($data['data']['platforms'] ?? []) === 9];
[$status, $data] = request('/api/parse?schema_version=0.9');
$checks[] = ['name' => 'old browser receives readable schema version error', 'passed' => $status === 409 && ($data['code'] ?? '') === 'INVALID_INPUT'];
[$status, $data] = request('/api/douyin');
$checks[] = ['name' => 'removed legacy alias returns readable cutover error', 'passed' => $status === 410 && ($data['code'] ?? '') === 'INVALID_INPUT'];
foreach (['/api/svproxyurl.php', '/api/douyin/douyin.php', '/api/wyy.py', '/parse/douyin'] as $path) {
    [$status, $data] = request($path);
    $checks[] = ['name' => 'closed route ' . $path, 'passed' => $status === 404 && ($data['code'] ?? null) === 'INVALID_INPUT'];
}
$passed = count(array_filter($checks, static fn ($item) => $item['passed']));
echo json_encode(['suite' => 'backend-local-http', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
