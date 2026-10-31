<?php
declare(strict_types=1);
require_once __DIR__ . '/../lib/gateway.php';
require_once __DIR__ . '/media-policy-fixtures.php';
$checks = []; $responses = [];
function policyCheck(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
function policyFile(string $id = 'complete', array $metadata = [], array $source = []): array {
    return ['id' => $id, 'metadata' => $metadata + ['width' => 3840, 'height' => 2160, 'evidence' => 'upstream'],
        'delivery' => ['kind' => 'file', 'sources' => [$source + ['id' => 'direct', 'url' => 'https://media.example/' . $id . '.mp4']]]];
}
function policyMux(array $video = [], array $audio = [], array $metadata = []): array {
    $variant = ['id' => 'separated', 'delivery' => ['kind' => 'mux', 'resources' => [
        ['id' => 'video', 'role' => 'video', 'metadata' => $video + ['width' => 3840, 'height' => 2160, 'evidence' => 'upstream'], 'delivery' => ['kind' => 'file', 'sources' => [['url' => 'https://media.example/video.m4s']]]],
        ['id' => 'audio', 'role' => 'audio', 'metadata' => $audio + ['audio_channels' => 2, 'evidence' => 'upstream'], 'delivery' => ['kind' => 'file', 'sources' => [['url' => 'https://media.example/audio.m4a']]]],
    ], 'output' => ['container' => 'mp4', 'extension' => 'mp4']]];
    if ($metadata) $variant['metadata'] = $metadata + ['evidence' => 'upstream'];
    return $variant;
}
function policyView(array $variants, bool $debug = false): array {
    global $responses;
    $full = snapFinalizeData(['platform' => 'fixture', 'refresh_url' => '/api/parse?schema_version=1.0&url=https%3A%2F%2Fmedia.example%2Fwork',
        'items' => [['id' => 'video', 'type' => 'video', 'resolve_url' => '/api/resolve?schema_version=1.0&item_id=video&url=https%3A%2F%2Fmedia.example%2Fwork', 'default' => null, 'variants' => $variants]]]);
    [$status, $payload] = snapPreparePublicMedia('fixture', $full, 200, null, $debug);
    if ($status !== 200) throw new RuntimeException('Unexpected fixture failure');
    snapValidateEnvelope($payload); $responses[] = $payload;
    return $payload['data']['items'][0];
}
$file = policyFile(); $mux = policyMux();
$normal = policyView([$file, $mux]); $debug = policyView([$file, $mux], true);
policyCheck('normal public response removes a same-resolution unprotected mux', count($normal['variants']) === 1);
policyCheck('debug public response retains all normalized representations', count($debug['variants']) === 2);
policyCheck('surviving default and source identities are unchanged between views', $normal['default'] === $debug['default']);
policyCheck('ordinary stereo with unknown complete-file channels does not create protection', count(policyView([$file, policyMux([], ['audio_channels' => 2])])['variants']) === 1);
$languageViews = [];
foreach (['valid' => [], 'expired' => ['expires_at' => gmdate('c', time() - 60)], 'unavailable' => ['availability' => 'unavailable']] as $state => $source) {
    $variants = [policyFile('4k-unknown-language'), policyFile('1080-main-en', ['width' => 1920, 'height' => 1080, 'audio_language' => 'en', 'audio_language_role' => 'main'], $source), policyMux(audio: ['audio_language' => 'ja'])];
    $languageViews[$state] = policyView($variants);
    $full = policyView($variants, true);
    policyCheck('confirmed main language still protects Japanese mux when its source is ' . $state,
        count($languageViews[$state]['variants']) === 3 && $languageViews[$state]['variants'] === $full['variants']);
}
policyCheck('source expiry and availability do not change the language-protected inventory or selected file',
    array_column($languageViews['valid']['variants'], 'id') === array_column($languageViews['expired']['variants'], 'id')
    && array_column($languageViews['valid']['variants'], 'id') === array_column($languageViews['unavailable']['variants'], 'id')
    && $languageViews['valid']['default'] === $languageViews['expired']['default']
    && $languageViews['valid']['default'] === $languageViews['unavailable']['default']);
$locatedLanguageViews = [];
foreach (['valid', 'expired'] as $state) {
    foreach (['variant', 'resource'] as $location) {
        $facts = ['audio_language' => 'en', 'audio_language_role' => 'main'];
        $main = policyMux(['width' => 1920, 'height' => 1080], $location === 'resource' ? $facts : [], $location === 'variant' ? $facts : []);
        $main['id'] = 'main-en';
        if ($state === 'expired') foreach ($main['delivery']['resources'] as &$resource) $resource['delivery']['sources'][0]['expires_at'] = '2000-01-01T00:00:00Z';
        unset($resource);
        $variants = [$file, $main, policyMux(audio: ['audio_language' => 'ja'])];
        $view = $locatedLanguageViews[$state][$location] = policyView($variants);
        $diagnostic = policyView($variants, true);
        policyCheck($state . ' main language on ' . $location . ' protects the associated Japanese mux',
            in_array('separated', array_column($view['variants'], 'id'), true) && count($diagnostic['variants']) === 3);
        policyCheck($state . ' main language on ' . $location . ' preserves the complete default', $view['default'] === $diagnostic['default']);
    }
    policyCheck($state . ' language facts at variant or resource yield the same public inventory',
        array_column($locatedLanguageViews[$state]['variant']['variants'], 'id') === array_column($locatedLanguageViews[$state]['resource']['variants'], 'id'));
}
$conflictLanguageViews = [];
foreach (['variant', 'resource'] as $location) {
    $facts = ['audio_language_role' => 'main', 'field_conflicts' => ['audio_language' => [
        ['value' => 'en', 'evidence' => 'upstream'], ['value' => 'fr', 'evidence' => 'probe'],
    ]]];
    $main = policyMux(['width' => 1920, 'height' => 1080], $location === 'resource' ? $facts : [], $location === 'variant' ? $facts : []);
    $main['id'] = 'conflicting-main';
    $conflictLanguageViews[$location] = policyView([$file, $main, policyMux(audio: ['audio_language' => 'ja'])]);
    policyCheck('conflicting language evidence on ' . $location . ' remains conservative in public and debug',
        count($conflictLanguageViews[$location]['variants']) === 3
        && count(policyView([$file, $main, policyMux(audio: ['audio_language' => 'ja'])], true)['variants']) === 3);
}
policyCheck('conflicting parent and resource language facts protect the same inventory',
    array_column($conflictLanguageViews['variant']['variants'], 'id') === array_column($conflictLanguageViews['resource']['variants'], 'id'));
foreach ([false, true] as $reverse) {
    $mainFacts = ['audio_language' => 'en', 'audio_language_role' => 'main'];
    $alternateFacts = ['audio_language' => 'fr', 'audio_language_role' => 'alternate'];
    $main = policyMux(['width' => 1920, 'height' => 1080], $reverse ? $mainFacts : $alternateFacts, $reverse ? $alternateFacts : $mainFacts);
    $main['id'] = 'cross-layer-main';
    policyCheck('cross-layer conflicts retain main language evidence regardless of layer order ' . (int)$reverse,
        count(policyView([$file, $main, policyMux(audio: ['audio_language' => 'ja'])])['variants']) === 3);
}
$multi = policyMux(audio: ['audio_language' => 'ja'], metadata: ['audio_language' => 'en', 'audio_language_role' => 'main']);
$otherAudio = $multi['delivery']['resources'][1]; $otherAudio['id'] = 'other-audio';
$otherAudio['metadata']['audio_language'] = 'de';
$multi['delivery']['resources'][] = $otherAudio;
policyCheck('unassignable parent audio facts conservatively retain the multiple-track mux', count(policyView([$file, $multi])['variants']) === 2);
$multi['delivery']['resources'][2]['metadata']['audio_language'] = 'en';
$multi['delivery']['resources'][2]['metadata']['audio_language_role'] = 'main';
$multi['id'] = 'multiple-audio';
policyCheck('explicitly associated main audio still protects a different language in a multiple-track work',
    count(policyView([$file, $multi, policyMux(audio: ['audio_language' => 'ja'])])['variants']) === 3);
policyCheck('expired complete file cannot remove a processing version', count(policyView([policyFile(source: ['expires_at' => gmdate('c', time() - 60)]), $mux])['variants']) === 2);
policyCheck('explicitly silent file cannot replace a complete audio-video combination', count(policyView([policyFile(metadata: ['has_audio' => false]), $mux])['variants']) === 2);
policyCheck('mux-only work remains processing-required with a null complete default', policyView([$mux])['default_unavailable_reason'] === 'processing_required');
foreach ([
    ['59.94 and 60 fps are the same protected tier', ['fps' => 59.94], ['fps' => 60], [], 1],
    ['60 fps survives a 30 fps complete alternative', ['fps' => 30], ['fps' => 60], [], 2],
    ['60 fps survives unknown complete fps', [], ['fps' => 60], [], 2],
    ['ordinary 30 fps does not require a known complete fps', [], ['fps' => 30], [], 1],
    ['30 fps tolerance is also applied at protection threshold', [], ['fps' => 30.2], [], 1],
    ['HDR survives unknown complete dynamic range', [], ['hdr_type' => 'hdr10'], [], 2],
    ['same confirmed HDR type covers the processing candidate', ['hdr_type' => 'hdr10'], ['hdr_type' => 'hdr10'], [], 1],
    ['different HDR types do not cover one another', ['hdr_type' => 'hlg'], ['hdr_type' => 'hdr10'], [], 2],
    ['confirmed HDR of unknown type cannot be proved covered', ['hdr_type' => 'hdr_unknown'], ['hdr_type' => 'hdr_unknown'], [], 2],
    ['a lone language field does not prove an alternate language', [], [], ['audio_language' => 'ja'], 1],
    ['explicit alternate language survives unknown file language', [], [], ['audio_language' => 'ja', 'audio_language_role' => 'alternate'], 2],
    ['different confirmed file language proves the language difference', ['audio_language' => 'en'], [], ['audio_language' => 'ja'], 2],
    ['same confirmed language covers an alternate language resource', ['audio_language' => 'ja'], [], ['audio_language' => 'ja', 'audio_language_role' => 'alternate'], 1],
    ['six channels survive unknown complete channels', [], [], ['audio_channels' => 6], 2],
    ['eight complete channels cover six channel audio', ['audio_channels' => 8], [], ['audio_channels' => 6], 1],
] as [$name, $complete, $video, $audio, $count]) policyCheck($name, count(policyView([policyFile(metadata: $complete), policyMux($video, $audio)])['variants']) === $count);
$splitAdvantages = policyView([policyFile('4k60-sdr', ['fps' => 60, 'hdr_type' => 'sdr']), policyFile('4k30-hdr', ['fps' => 30, 'hdr_type' => 'hdr10']), policyMux(['fps' => 60, 'hdr_type' => 'hdr10'])]);
policyCheck('two files cannot combine frame-rate and HDR advantages', count($splitAdvantages['variants']) === 3);
policyCheck('4K SDR and 1080 HDR cannot cover one 4K HDR mux', count(policyView([policyFile('4k-sdr', ['hdr_type' => 'sdr']), policyFile('1080-hdr', ['width' => 1920, 'height' => 1080, 'hdr_type' => 'hdr10']), policyMux(['hdr_type' => 'hdr10'])])['variants']) === 3);
policyCheck('unknown complete dimensions cannot cover known mux geometry', count(policyView([['id' => 'unknown', 'delivery' => $file['delivery']], $mux])['variants']) === 2);
policyCheck('different aspect ratios are not treated as coverage', count(policyView([policyFile(metadata: ['width' => 3840, 'height' => 1600]), $mux])['variants']) === 2);
policyCheck('unavailable complete sources do not hide the mux', count(policyView([policyFile(source: ['availability' => 'unavailable']), $mux])['variants']) === 2);
$higher = policyView([policyFile(metadata: ['width' => 1920, 'height' => 1080]), $mux]);
policyCheck('higher spatial mux survives with valid capability reference', ($higher['higher_quality_variants'] ?? []) === [['variant_id' => 'separated', 'requires' => ['mux']]]);
$conflicting = policyMux(['width' => 3840, 'height' => 2160], metadata: ['width' => 1280, 'height' => 720]);
$conflictResult = policyView([$file, $conflicting]);
policyCheck('conflicting summary and resource geometry is retained without false higher claim', count($conflictResult['variants']) === 2 && empty($conflictResult['higher_quality_variants']));
policyCheck('conflicting frame-rate evidence conservatively retains mux', count(policyView([$file, policyMux(['fps' => 60], metadata: ['fps' => 30])])['variants']) === 2);
policyCheck('conflicting language evidence conservatively retains mux', count(policyView([$file, policyMux([], ['audio_language' => 'ja'], ['audio_language' => 'en'])])['variants']) === 2);
$fpsConflict = ['field_conflicts' => ['fps' => [['value' => 30, 'evidence' => 'upstream'], ['value' => 60, 'evidence' => 'upstream']]]];
policyCheck('aggregated conflicting FPS preserves the mux and confirmed file default',
    count(policyView([$file, policyMux($fpsConflict)])['variants']) === 2
    && policyView([$file, policyMux($fpsConflict)])['default'] === $normal['default']);
policyCheck('aggregated conflicting complete-file FPS cannot prove coverage',
    count(policyView([policyFile(metadata: $fpsConflict), policyMux(['fps' => 60])])['variants']) === 2);
$languageConflict = ['audio_language_role' => 'main', 'field_conflicts' => ['audio_language' => [
    ['value' => 'en', 'evidence' => 'upstream'], ['value' => 'fr', 'evidence' => 'probe'],
]]];
policyCheck('expired conflicting file language facts still protect a different language',
    count(policyView([$file, policyFile('language-facts', $languageConflict, ['expires_at' => gmdate('c', time() - 60)]), policyMux(audio: ['audio_language' => 'ja'])])['variants']) === 3);
$mainRoleConflict = policyMux(audio: ['audio_language' => 'en', 'field_conflicts' => ['audio_language_role' => [
    ['value' => 'alternate', 'evidence' => 'upstream'], ['value' => 'main', 'evidence' => 'upstream'],
]]]);
$mainRoleConflict['id'] = 'main-role-conflict';
policyCheck('a recorded main-role observation still supplies language evidence when roles conflict',
    count(policyView([$file, $mainRoleConflict, policyMux(audio: ['audio_language' => 'ja'])])['variants']) === 3);
$pending = ['id' => 'pending', 'state' => 'deferred', 'reason' => ['code' => 'PENDING', 'message' => 'Not resolved']];
policyCheck('deferred versions are outside the filtering scope', count(policyView([$file, $pending])['variants']) === 2);
$manifest = ['id' => 'adaptive', 'delivery' => ['kind' => 'dash', 'scope' => 'adaptive', 'sources' => [['url' => 'https://media.example/manifest.mpd']]]];
policyCheck('adaptive manifests are outside the filtering scope', count(policyView([$file, $manifest])['variants']) === 2);
policyCheck('debug refresh and resolve links retain the requested view', str_contains($responses[1]['data']['refresh_url'], 'debug=1') && str_contains($responses[1]['data']['items'][0]['resolve_url'], 'debug=1'));
policyCheck('ordinary navigation remains ordinary', !str_contains($responses[0]['data']['refresh_url'], 'debug=') && !str_contains($responses[0]['data']['items'][0]['resolve_url'], 'debug='));
$integration = [];
foreach (['normal', 'debug', 'renewed', 'protected', 'unavailable'] as $mode) {
    $full = policyDouyinFixture(in_array($mode, ['protected', 'unavailable'], true) ? $mode : 'normal', $mode === 'renewed' ? 'after' : 'before');
    [$status, $payload] = snapPreparePublicMedia('douyin', $full, 200, null, $mode === 'debug');
    snapValidateEnvelope($payload); $responses[] = $payload; $integration[$mode] = $payload;
}
policyCheck('actual Douyin formatter retains both explicit audio pairings in debug', count($integration['debug']['data']['items'][0]['variants']) === 3);
policyCheck('actual Douyin ordinary public response removes both unprotected mux combinations', count($integration['normal']['data']['items'][0]['variants']) === 1);
policyCheck('actual Douyin FPS and HDR metadata protects both matched mux versions', count($integration['protected']['data']['items'][0]['variants']) === 3);
policyCheck('actual Douyin selected file identity survives view and credential renewal', $integration['normal']['data']['items'][0]['default']['variant_id'] === $integration['debug']['data']['items'][0]['default']['variant_id'] && $integration['normal']['data']['items'][0]['default']['variant_id'] === $integration['renewed']['data']['items'][0]['default']['variant_id']);
foreach ([false, true] as $hdr) {
    $full = policyBilibiliFixture($hdr);
    [$status, $product] = snapPreparePublicMedia('bilibili', $full);
    [$status, $diagnostic] = snapPreparePublicMedia('bilibili', $full, debug: true);
    $responses[] = $product; $responses[] = $diagnostic;
    policyCheck('actual Bilibili ' . ($hdr ? 'HDR and fractional FPS' : 'matched language and channels') . ' reach policy from associated resources', count($product['data']['items'][0]['variants']) === ($hdr ? 3 : 2));
    policyCheck('actual Bilibili full pairing inventory remains visible in debug', count($diagnostic['data']['items'][0]['variants']) === 3);
}
foreach (['normal', 'expired', 'rejected'] as $mode) foreach ([false, true] as $diagnostic) {
    [$status, $payload] = snapPreparePublicMedia('weibo', policyWeiboFixture($mode), 200, str_repeat('fixture-key-', 4), $diagnostic);
    snapValidateEnvelope($payload); $responses[] = $payload;
    $item = $payload['data']['items'][0];
    policyCheck('Weibo ' . $mode . ' ' . ($diagnostic ? 'debug' : 'normal') . ' applies source qualification before product filtering', $status === 200 && count($item['variants']) === ($mode === 'normal' && !$diagnostic ? 1 : 3) && ($mode === 'normal' || ($item['default'] === null && $item['default_unavailable_reason'] === 'processing_required')));
    if ($diagnostic && $mode === 'normal') {
        $relay = true;
        foreach ($item['variants'] as $variant) foreach (snapDeliverySources($variant['delivery']) as $sources) foreach ($sources as $source) $relay = $relay && ($source['access'] ?? '') === 'relay';
        policyCheck('debug composed sources keep public relay security boundary', $relay);
    }
}
$capturedEndpoint = '';
snapForward('douyin', 'https://www.douyin.com/video/7628438784602389247', static function ($endpoint, $host) use (&$capturedEndpoint) {
    $capturedEndpoint = $endpoint;
    return ['ok' => true, 'status' => 200, 'body' => json_encode(policyDouyinFixture())];
}, debug: true);
policyCheck('public forwarding propagates debug to the internal parser boundary', str_ends_with($capturedEndpoint, '&debug=1'));
foreach ([['hdr_type' => 'HDR'], ['hdr_type' => 'hdr10', 'evidence' => 'unknown'], ['audio_language_role' => 'alternate'], ['audio_language' => 'ja', 'audio_language_role' => 'dub'], ['hdr_type' => 'hlg', 'evidence' => 'mixed', 'field_evidence' => ['width' => 'upstream', 'height' => 'upstream']]] as $index => $invalid) {
    $rejected = false;
    try { policyView([policyFile(metadata: $invalid), $mux]); } catch (UnexpectedValueException $error) { $rejected = true; }
    policyCheck('new capability metadata invalid case ' . $index . ' is rejected before filtering', $rejected);
}
policyCheck('codec and unrecognized numeric HDR marker do not invent HDR', snapVideoFacts(['codec' => 'hevc', 'hdr_type' => 1]) === []);
policyCheck('unknown language tag or audio ID does not imply alternate language', snapAudioFacts(['language' => 'und', 'audio_language_role' => 'alternate', 'id' => 30280]) === []);
if (($argv[1] ?? '') === '--export-integration') { echo json_encode($integration, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL; exit; }
if (($argv[1] ?? '') === '--export') { echo json_encode($responses, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL; exit; }
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'media-policy', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
