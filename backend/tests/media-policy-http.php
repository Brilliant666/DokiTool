<?php
declare(strict_types=1);
// Requires the actual public gateway and media-policy-http-router.php on separate loopback ports.
require_once __DIR__ . '/../lib/media-contract.php';
$base = $argv[1] ?? 'http://127.0.0.1:19286';
if (!preg_match('~^http://127\.0\.0\.1:\d+$~D', $base)) throw new RuntimeException('Loopback only');
$checks = []; $responses = [];
function httpPolicyCheck(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
function httpPolicyRequest(string $path): array {
    global $base, $responses;
    if (!str_starts_with($path, '/api/')) throw new RuntimeException('API-relative fixture only');
    $ch = curl_init($base . $path);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_PROXY => '', CURLOPT_HTTPHEADER => ['Host: attacker.test']]);
    $body = curl_exec($ch); $status = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    $payload = json_decode((string)$body, true, 128, JSON_THROW_ON_ERROR);
    snapValidateEnvelope($payload); $responses[] = $payload;
    if ($status !== 200) throw new RuntimeException('Unexpected local HTTP status: ' . $status);
    return $payload;
}
foreach (['douyin' => 'https://www.douyin.com/video/7628438784602389247', 'bilibili' => 'https://www.bilibili.com/video/BV1boV66YErZ/', 'weibo' => 'https://weibo.com/fixture'] as $platform => $url) {
    $path = '/api/parse?schema_version=1.0&url=' . rawurlencode($url);
    $normal = httpPolicyRequest($path); $debug = httpPolicyRequest($path . '&debug=1');
    $n = $normal['data']['items'][0]; $d = $debug['data']['items'][0];
    httpPolicyCheck($platform . ' ordinary versus full debug inventory', count($n['variants']) === ($platform === 'bilibili' ? 2 : 1) && count($d['variants']) === 3);
    $selectedFields = $platform === 'weibo' ? ['variant_id', 'source_id', 'access'] : array_keys($n['default']);
    httpPolicyCheck($platform . ' same file/source default survives public view', array_intersect_key($n['default'], array_flip($selectedFields)) === array_intersect_key($d['default'], array_flip($selectedFields)));
    httpPolicyCheck($platform . ' debug reaches internal fixed-Host boundary', $normal['data']['extra'] === ['received_debug' => false, 'received_host' => 'snap.dokitool.com'] && $debug['data']['extra'] === ['received_debug' => true, 'received_host' => 'snap.dokitool.com']);
    foreach (['normal' => $normal, 'debug' => $debug] as $view => $response) {
        $item = $response['data']['items'][0];
        foreach (['refresh' => $response['data']['refresh_url'], 'resolve' => $item['resolve_url']] as $operation => $link) {
            $next = httpPolicyRequest($link);
            httpPolicyCheck($platform . ' ' . $view . ' ' . $operation . ' preserves view and item identity', $next['data']['extra']['received_debug'] === ($view === 'debug') && count($next['data']['items'][0]['variants']) === count($item['variants']) && $next['data']['items'][0]['id'] === $item['id']);
        }
    }
    if ($platform === 'weibo') {
        $allRelay = true;
        foreach ($d['variants'] as $variant) foreach (snapDeliverySources($variant['delivery']) as $sources) foreach ($sources as $source) $allRelay = $allRelay && ($source['access'] ?? '') === 'relay';
        httpPolicyCheck('debug still uses public Weibo tickets for composed resources', $allRelay);
    }
}
foreach (['expired', 'rejected'] as $mode) {
    $payload = httpPolicyRequest('/api/parse?schema_version=1.0&url=' . rawurlencode('https://weibo.com/fixture?fixture=' . $mode));
    $item = $payload['data']['items'][0];
    httpPolicyCheck('Weibo ' . $mode . ' source cannot hide usable mux after public processing', count($item['variants']) === 3 && $item['default'] === null && $item['default_unavailable_reason'] === 'processing_required');
}
if (($argv[2] ?? '') === '--export') { echo json_encode($responses, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL; exit; }
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'media-policy-local-http', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks, 'evidence_scope' => 'Actual local HTTP gateway with synthetic upstream records; no platform network or browser saving.'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
