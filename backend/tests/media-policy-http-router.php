<?php
declare(strict_types=1);
// LOCAL SYNTHETIC TEST ROUTER ONLY. Never deploy or expose publicly.
require_once __DIR__ . '/media-policy-fixtures.php';
if (!snapInternalRequestAllowed($_SERVER)) { snapSend(snapError(403, 'Local fixed-Host fixture only'), 403); return; }
if (parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) !== '/parse') { snapSend(snapError(404, 'Unknown fixture route'), 404); return; }
$url = snapInputUrl($_GET); $platform = $_GET['platform'] ?? '';
if ($url === null || snapPlatformForUrl($url) !== $platform) { snapSend(snapError(400, 'Fixture platform mismatch'), 400); return; }
$query = []; parse_str(parse_url($url, PHP_URL_QUERY) ?? '', $query);
$mode = $query['fixture'] ?? 'normal'; $debug = ($_GET['debug'] ?? null) === '1';
$payload = match ($platform) {
    'douyin' => policyDouyinFixture($mode),
    'bilibili' => policyBilibiliFixture($mode === 'hdr'),
    'weibo' => policyWeiboFixture($mode),
    default => snapContractError('UNSUPPORTED_PLATFORM', 'No fixture for this platform'),
};
if ($payload['code'] === 'OK') {
    $payload['data']['refresh_url'] = '/api/parse?schema_version=1.0&url=' . rawurlencode($url);
    foreach ($payload['data']['items'] as &$item) $item['resolve_url'] = '/api/resolve?schema_version=1.0&item_id=' . rawurlencode($item['id']) . '&url=' . rawurlencode($url);
    unset($item);
    $payload['data']['extra'] = ['received_debug' => $debug, 'received_host' => $_SERVER['HTTP_HOST']];
    // Match snapRunParser: full normalized inventory in both internal views.
    // The real public gateway performs signing and policy selection afterward.
    if ($debug) $payload = snapPublicMediaView($payload, true);
}
snapValidateEnvelope($payload);
snapSend($payload, snapEnvelopeStatus($payload));
