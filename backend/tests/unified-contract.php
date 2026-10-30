<?php
declare(strict_types=1);
require __DIR__ . '/../lib/media-adapters.php';
$checks = [];
function expectUnified(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
function rejectsUnified(array $payload): bool { try { snapValidateEnvelope($payload); return false; } catch (UnexpectedValueException $error) { return true; } }
function fileVariant(string $id, int $width, int $height, array $source = []): array {
    return ['id' => $id, 'metadata' => ['width' => $width, 'height' => $height, 'evidence' => 'probe'], 'delivery' => ['kind' => 'file', 'sources' => [$source + ['url' => 'https://media.example/' . $id . '.mp4']]]];
}
$now = 1800000000;
$low = fileVariant('720', 1280, 720); $high = fileVariant('4k', 3840, 2160);
$mux = $high; $mux['id'] = 'mux-4k'; $mux['delivery'] = ['kind' => 'mux', 'resources' => [
    ['id' => 'video', 'role' => 'video', 'metadata' => $high['metadata'], 'delivery' => $high['delivery']],
    ['id' => 'audio', 'role' => 'audio', 'delivery' => ['kind' => 'file', 'sources' => [['url' => 'https://media.example/audio.m4s']]]],
], 'output' => ['container' => 'mp4', 'extension' => 'mp4', 'mime_type' => 'video/mp4']];
$wrap = static fn ($variants) => snapFinalizeData(['platform' => 'fixture', 'items' => [['id' => 'main', 'type' => 'video', 'default' => null, 'variants' => $variants]]], $now);
$payload = $wrap([$low, $high, $mux]); snapValidateEnvelope($payload);
expectUnified('highest complete file beats same-quality mux and first array item', $payload['data']['items'][0]['default']['variant_id'] === '4k');
$reordered = $payload; $reordered['data']['items'][0]['variants'] = array_reverse($reordered['data']['items'][0]['variants']);
expectUnified('order independent pointer validation', !rejectsUnified($reordered));
$onlyMux = $wrap([$mux]); snapValidateEnvelope($onlyMux);
expectUnified('bare video/audio tracks never become complete default', $onlyMux['data']['items'][0]['default'] === null && $onlyMux['data']['items'][0]['default_unavailable_reason'] === 'processing_required');
$higher = $wrap([$low, $mux]); snapValidateEnvelope($higher);
expectUnified('higher processing capability explicitly referenced', $higher['data']['items'][0]['higher_quality_variants'] === [['variant_id' => 'mux-4k', 'requires' => ['mux']]]);
$expired = $high; $expired['delivery']['sources'][0]['expires_at'] = gmdate('Y-m-d\TH:i:s\Z', $now - 1);
expectUnified('expired 4K cannot replace current complete file', $wrap([$expired, $low])['data']['items'][0]['default']['variant_id'] === '720');
expectUnified('all expired sources require refresh', $wrap([$expired])['data']['items'][0]['default_unavailable_reason'] === 'needs_refresh');
$blocked = $high; $blocked['delivery']['sources'][0]['browser_fetch'] = 'blocked';
expectUnified('CORS restriction alone does not remove native eligible file', $wrap([$blocked, $low])['data']['items'][0]['default']['variant_id'] === '4k');
$fallback = $high; $fallback['delivery']['sources'] = [['id' => 'expired', 'url' => 'https://media.example/expired', 'expires_at' => gmdate('c', $now - 1)], ['id' => 'live', 'url' => 'https://media.example/live', 'access' => 'direct', 'expires_at' => gmdate('c', $now + 10)]];
$sources = $wrap([$fallback]); snapValidateEnvelope($sources);
expectUnified('source selection and expiry projection agree', $sources['data']['items'][0]['default']['source_id'] === 'live');
$sourceReorder = $sources; $sourceReorder['data']['items'][0]['variants'][0]['delivery']['sources'] = array_reverse($fallback['delivery']['sources']);
expectUnified('source reorder cannot break stable default identity', !rejectsUnified($sourceReorder));
$invalid = $payload; $invalid['data']['items'][0]['default']['url'] = 'https://media.example/other';
expectUnified('default URL mismatch rejected', rejectsUnified($invalid));
$invalid = $sources; unset($invalid['data']['items'][0]['default']['source_id']);
expectUnified('ambiguous default source rejected', rejectsUnified($invalid));
$invalid = $sources; $invalid['data']['items'][0]['default']['expires_at'] = gmdate('c', $now + 99);
expectUnified('default expiry mismatch rejected', rejectsUnified($invalid));
$invalid = $payload; $invalid['data']['items'][0]['default'] = ['variant_id' => '720', 'url' => $low['delivery']['sources'][0]['url']];
expectUnified('lower default than proven usable file rejected', rejectsUnified($invalid));
$invalid = $higher; $invalid['data']['items'][0]['higher_quality_variants'][0]['requires'] = ['dash'];
expectUnified('incorrect required capability rejected', rejectsUnified($invalid));
$invalid = $payload; $invalid['data']['items'][0]['variants'][0]['metadata']['evidence'] = 'unknown';
expectUnified('unknown technical evidence rejected', rejectsUnified($invalid));
$live = snapAdaptParser('xiaohongshu', ['code' => 200, 'data' => ['type' => 'live', 'images' => ['https://media.example/first.jpg', 'https://media.example/second.jpg'], 'live_photo' => [['image' => 'https://media.example/first.jpg', 'video_candidates' => [['url' => 'https://media.example/motion.mp4', 'width' => 1080, 'height' => 1920], ['url' => 'https://media.example/motion720.mp4', 'width' => 720, 'height' => 1280]]]]]], 'https://www.rednote.com/explore/fixture');
snapValidateEnvelope($live);
expectUnified('live pair and ordinary image preserve album order', array_column($live['data']['items'], 'type') === ['live_photo', 'image']);
expectUnified('all motion variants preserved', count($live['data']['items'][0]['variants']) === 2 && $live['data']['items'][0]['default'] === null);
$unknown = snapFileVariants([['url' => 'https://media.example/a'], ['url' => 'https://media.example/b']]);
expectUnified('unknown sources not merged by guessed equivalence', count($unknown) === 2);
$pending = ['id' => 'pending', 'state' => 'deferred', 'reason' => ['code' => 'BACKEND_VERIFICATION_REQUIRED', 'message' => '等待后端验证']];
$mixed = $wrap([$pending, $low]); snapValidateEnvelope($mixed);
expectUnified('deferred candidate cannot replace ready complete file', $mixed['data']['items'][0]['default']['variant_id'] === '720' && !isset($mixed['data']['items'][0]['higher_quality_variants']));
$pendingOnly = $wrap([$pending]); snapValidateEnvelope($pendingOnly);
expectUnified('only deferred candidates explicitly need resolve', $pendingOnly['data']['items'][0]['default'] === null && $pendingOnly['data']['items'][0]['default_unavailable_reason'] === 'needs_resolve');
$invalid = $mixed; $invalid['data']['items'][0]['default']['variant_id'] = 'pending';
expectUnified('deferred candidate cannot be referenced by default', rejectsUnified($invalid));
$trackOnly = snapBilibiliVariants(['private_play' => ['dash' => ['video' => [['id' => 120, 'baseUrl' => 'https://media.example/bare.m4s', 'width' => 3840, 'height' => 2160]]]]]);
$trackResult = $wrap($trackOnly); snapValidateEnvelope($trackResult);
expectUnified('Bilibili missing audio is explicit deferred candidate not complete media', $trackResult['data']['items'][0]['default'] === null && $trackOnly[0]['reason']['code'] === 'MISSING_AUDIO_TRACK' && !isset($trackOnly[0]['delivery']));
expectUnified('complete fallback remains selectable with missing audio DASH', $wrap(array_merge($trackOnly, [$low]))['data']['items'][0]['default']['variant_id'] === '720');
$candidates = [['url' => 'https://media.example/1080.mp4', 'width' => 1920, 'height' => 1080], ['url' => 'https://media.example/720.mp4', 'width' => 1280, 'height' => 720]];
$before = snapFileVariants($candidates); $after = snapFileVariants(array_reverse($candidates));
expectUnified('reordering candidates cannot reuse an ID for another quality', $before[0]['id'] === $after[1]['id'] && $before[1]['id'] === $after[0]['id']);
$sourceList = [['url' => 'https://media.example/a.mp4'], ['url' => 'https://media.example/b.mp4']];
$before = snapSources($sourceList); $after = snapSources(array_reverse($sourceList));
expectUnified('reordering sources preserves explicit source identity', $before[0]['id'] === $after[1]['id'] && $before[1]['id'] === $after[0]['id']);
$multiAudio = snapBilibiliVariants(['private_play' => ['dash' => ['video' => [['id' => 120, 'baseUrl' => 'https://media.example/video.m4s', 'width' => 3840, 'height' => 2160]], 'audio' => [
    ['id' => 30280, 'baseUrl' => 'https://media.example/192k.m4s', 'bandwidth' => 192000], ['id' => 30216, 'baseUrl' => 'https://media.example/64k.m4s', 'bandwidth' => 64000],
]]]]);
expectUnified('audio encodings create independent mux variants not compulsory simultaneous tracks', count($multiAudio) === 2 && count($multiAudio[0]['delivery']['resources']) === 2 && count($multiAudio[1]['delivery']['resources']) === 2);
$multiAudio[1]['delivery']['resources'][1]['delivery']['sources'][0]['expires_at'] = gmdate('c', $now - 1);
expectUnified('expired audio alternative cannot invalidate another complete pairing', snapDeliveryUsable($multiAudio[0]['delivery'], $now) && !snapDeliveryUsable($multiAudio[1]['delivery'], $now));
foreach (['next Monday', '2026-02-30T12:00:00Z', '2026-10-30T25:00:00Z', '2026-10-30T12:00:00+25:00'] as $date) {
    $invalid = $payload; $invalid['data']['generated_at'] = $date;
    expectUnified('strict RFC3339 rejects ' . $date, rejectsUnified($invalid));
}
$invalid = $payload; $invalid['data']['source_url'] = 'https://[invalid/';
expectUnified('URI format rejects malformed authority', rejectsUnified($invalid));
foreach (['/api/%252e%252e/private', '/api/%255cprivate'] as $relay) {
    $invalid = $payload; $invalid['data']['items'][0]['variants'][1]['delivery']['sources'][0] = ['url' => $relay, 'access' => 'relay'];
    $invalid['data']['items'][0]['default'] = ['variant_id' => '4k', 'url' => $relay, 'access' => 'relay'];
    expectUnified('nested relay path encoding rejected', rejectsUnified($invalid));
}
$safeRelay = fileVariant('relay', 1920, 1080, ['url' => '/api/media/weibo?ticket=signed%252etext', 'access' => 'relay']);
expectUnified('signed relay query bytes are not path-decoded', !rejectsUnified($wrap([$safeRelay])));
require_once __DIR__ . '/../api/kuaishou/KuaishouSpider.php';
$kuaishou = new KuaishouSpider('', 'fixture');
$extractCandidates = new ReflectionMethod($kuaishou, 'mediaCandidates');
foreach (['avgBitrate', 'maxBitrate'] as $field) {
    $candidates = $extractCandidates->invoke($kuaishou, ['adaptationSet' => [['representation' => [['url' => 'https://media.example/ks.mp4', 'width' => 720, 'height' => 1280, $field => 3469]]]]], []);
    $variants = snapFileVariants($candidates); $metadata = $variants[0]['metadata'];
    expectUnified('Kuaishou ' . $field . ' with unknown unit is omitted without guessing total or video bps', !isset($metadata['bitrate_bps']) && !isset($metadata['video_bitrate_bps']) && $metadata['width'] === 720 && $metadata['height'] === 1280);
}
foreach (['https://media.example/manifest.mpd', 'https://media.example/MANIFEST.MPD?signature=preserved%2Bvalue'] as $manifestUrl) {
    $manifest = snapAdaptParser('kuaishou', ['code' => 200, 'data' => ['type' => 'video', 'url' => $manifestUrl]], 'https://v.kuaishou.com/fixture');
    snapValidateEnvelope($manifest); $manifestItem = $manifest['data']['items'][0];
    expectUnified('actual adapter identifies MPD pathname without using query as a file extension', $manifestItem['variants'][0]['delivery']['kind'] === 'dash' && $manifestItem['variants'][0]['delivery']['sources'][0]['url'] === $manifestUrl);
    expectUnified('DASH manifest never becomes a directly downloadable complete file', $manifestItem['default'] === null && $manifestItem['default_unavailable_reason'] === 'processing_required');
}
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'unified-contract', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
exit($passed === count($checks) ? 0 : 1);
