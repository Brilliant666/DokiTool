<?php
declare(strict_types=1);
/** PR8 regressions through production extraction, adaptation and selection.
 * All inputs are synthetic and this script never sends a network request.
 */
require_once __DIR__ . '/../api/douyin/DouyinParser.php';
require_once __DIR__ . '/../lib/media-adapters.php';
require_once __DIR__ . '/../lib/gateway.php';
define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
require_once __DIR__ . '/../api/weibo.php';

function reviewIdentityResponse(string $signature, int $expiresAt, string $fileId = 'fixture-1080-file', string $videoId = 'fixture-video', bool $reverse = false): array
{
    $urls = [];
    foreach ([0, 1] as $line) $urls[] = 'https://www.douyin.com/aweme/v1/play/?' . http_build_query([
        'video_id' => $videoId, 'file_id' => $fileId, 'ratio' => '1080p', 'line' => $line,
        'sign' => $signature, 'biz_sign' => $signature . '-business',
    ], '', '&', PHP_QUERY_RFC3986);
    if ($reverse) $urls = array_reverse($urls);
    $detail = ['desc' => 'Synthetic signed media renewal', 'video' => ['duration' => 10000,
        'cdn_url_expired' => $expiresAt, 'bit_rate' => [['format' => 'mp4', 'is_h265' => 0, 'bit_rate' => 2000000,
            'play_addr' => ['uri' => $videoId, 'file_hash' => hash('md5', $fileId), 'width' => 1920, 'height' => 1080,
                'data_size' => 2500000, 'url_list' => $urls]]]]];
    $parser = new DouyinParser(static fn () => null);
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser, $detail, '7628438784602389247'), true);
    $response = snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
    snapValidateEnvelope($response);
    return $response;
}

function reviewFullVariant(array $response): array
{
    foreach ($response['data']['items'][0]['variants'] as $variant) if (($variant['metadata']['height'] ?? null) === 1080) return $variant;
    throw new RuntimeException('Fixture did not reach the real full-file adapter');
}

function reviewSourcesByLine(array $variant): array
{
    $result = [];
    foreach ($variant['delivery']['sources'] as $source) {
        parse_str((string)parse_url($source['url'], PHP_URL_QUERY), $query);
        $result[(string)$query['line']] = $source;
    }
    ksort($result);
    return $result;
}

function reviewOriginalResponse(string $signature): array
{
    $parser = new DouyinParser(static fn () => ['url' => 'https://v3-web.douyinvod.com/renewed-' . $signature . '/original.mp4', 'metadata' => ['size' => 60000000, 'metadata_source' => 'mp4']]);
    $detail = ['desc' => 'Synthetic original endpoint without dimensions', 'video' => ['play_addr' => ['uri' => 'fixture-original-video']]];
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser, $detail, '7628438784602389247'), true);
    $response = snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
    snapValidateEnvelope($response);
    return $response;
}

function reviewCdnResponse(string $signature, int $expiresAt, bool $reverse = false): array
{
    $urls = [];
    foreach (['v26-web.douyinvod.com', 'v11-weba.douyinvod.com'] as $host) $urls[] = 'https://' . $host
        . '/' . hash('md5', $signature . $host) . '/' . dechex($expiresAt)
        . '/video/tos/cn/tos-cn-ve-15/fixture-stable-video-resource/?mime_type=video_mp4&custom=retained';
    if ($reverse) $urls = array_reverse($urls);
    $detail = ['desc' => 'Synthetic replay of observed Douyin CDN signing path', 'video' => ['duration' => 10000,
        'cdn_url_expired' => $expiresAt, 'bit_rate' => [['format' => 'mp4', 'bit_rate' => 2000000,
            'video_extra' => json_encode(['file_id' => 'fixture-cdn-file']),
            'play_addr' => ['uri' => 'fixture-cdn-video', 'file_hash' => hash('md5', 'fixture-cdn-file'),
                'width' => 1920, 'height' => 1080, 'url_list' => $urls]]]]];
    $parser = new DouyinParser(static fn () => null);
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser, $detail, '7628438784602389247'), true);
    $response = snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
    snapValidateEnvelope($response);
    return $response;
}

function reviewWeiboResponse(string $signature): array
{
    $media = 'https://f.video.weibocdn.com/fixture/1080.mp4?' . http_build_query([
        'media_id' => 'fixture-media', 'template' => '1920x1080', 'Expires' => time() + ($signature === 'before' ? 600 : 1800),
        'ssig' => 'synthetic-' . $signature, 'KID' => 'fixture-key-' . $signature,
    ], '', '&', PHP_QUERY_RFC3986);
    $raw = formatWeiboResponse(['code' => '100000', 'data' => ['Component_Play_Playinfo' => ['title' => 'Synthetic Weibo renewal', 'urls' => ['1080p' => $media]]]]);
    $response = snapAdaptParser('weibo', $raw, 'https://weibo.com/tv/show/1034:5339966948180025');
    [$status, $response] = snapPreparePublicMedia('weibo', $response, 200, str_repeat('synthetic-test-key', 3));
    if ($status !== 200) throw new RuntimeException('Fixture did not reach the real relay adapter');
    snapValidateEnvelope($response);
    return $response;
}

function reviewDouyinMuxResponse(bool $firstAudioMissing = false, bool $reverse = false, bool $fileIdentity = true): array
{
    $rates = [];
    foreach (['audio-a', 'audio-b'] as $line => $audioId) $rates[] = [
        'format' => 'dash', 'is_h265' => 1, 'bit_rate' => 4000000,
        'video_extra' => json_encode(($fileIdentity ? ['file_id' => 'shared-video-file'] : []) + ['audio_file_id' => $audioId]),
        'play_addr' => ($fileIdentity ? ['file_hash' => hash('md5', 'shared-video-file')] : []) + ['uri' => 'shared-video-uri', 'width' => 3840, 'height' => 2160,
            'url_list' => ['https://www.douyin.com/aweme/v1/play/dash/?file_id=shared-video-file&' . ($fileIdentity ? 'line=' . $line : 'sign=' . $audioId)]],
    ];
    if ($reverse) $rates = array_reverse($rates);
    $audio = [];
    foreach ($firstAudioMissing ? ['audio-b', 'unrelated-audio'] : ['audio-a', 'audio-b', 'unrelated-audio'] as $id) $audio[] = [
        'audio_meta' => ['media_type' => 'audio', 'file_id' => $id, 'url_list' => ['https://media.example/' . $id . '.m4a']],
    ];
    $detail = ['desc' => 'Synthetic same video with two matched audio representations',
        'video' => ['bit_rate' => $rates, 'bit_rate_audio' => $audio, 'cdn_url_expired' => time() + 600]];
    $parser = new DouyinParser(static fn () => null);
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser, $detail, '7628438784602389247'), true);
    $response = snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
    snapValidateEnvelope($response);
    return $response;
}

$now = time();
$before = reviewIdentityResponse('synthetic-before', $now + 600);
$after = reviewIdentityResponse('synthetic-after', $now + 1800, reverse: true);
$cases = [
    'original' => ['before' => reviewOriginalResponse('before'), 'after' => reviewOriginalResponse('after')],
    'weibo' => ['before' => reviewWeiboResponse('before'), 'after' => reviewWeiboResponse('after')],
    'cdn' => ['before' => reviewCdnResponse('before', $now + 600), 'after' => reviewCdnResponse('after', $now + 1800, true)],
];
if (($argv[1] ?? '') === '--export') {
    echo json_encode(compact('before', 'after', 'cases'), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL;
    exit;
}

$checks = [];
$check = static function (string $name, bool $passed, ?string $detail = null) use (&$checks): void {
    $entry = compact('name', 'passed');
    if ($detail !== null) $entry['detail'] = $detail;
    $checks[] = $entry;
};
$first = reviewFullVariant($before); $renewed = reviewFullVariant($after);
$firstSources = reviewSourcesByLine($first); $renewedSources = reviewSourcesByLine($renewed);
$check('same upstream media identity keeps variant ID after signing and expiry renewal', $first['id'] === $renewed['id']);
$check('explicit source line zero keeps ID after renewal and response reordering', $firstSources[0]['id'] === $renewedSources[0]['id']);
$check('explicit source line one keeps ID after renewal and response reordering', $firstSources[1]['id'] === $renewedSources[1]['id']);
$check('different playback lines retain distinct source identities', $renewedSources[0]['id'] !== $renewedSources[1]['id']);
$check('renewed delivery URL and expiry actually change', $firstSources[0]['url'] !== $renewedSources[0]['url'] && $firstSources[0]['expires_at'] !== $renewedSources[0]['expires_at']);
$otherFile = reviewFullVariant(reviewIdentityResponse('synthetic-after', $now + 1800, 'fixture-different-file'));
$check('different upstream file identity is never merged by removing all query values', $otherFile['id'] !== $renewed['id']);
$otherVideo = reviewFullVariant(reviewIdentityResponse('synthetic-after', $now + 1800, videoId: 'fixture-other-video'));
$check('resource-bearing video_id query remains significant', $otherVideo['id'] !== $renewed['id']);
foreach ($cases as $name => $pair) {
    $pick = static function (array $response): array {
        $item = $response['data']['items'][0];
        foreach ($item['variants'] as $variant) if ($variant['id'] === $item['default']['variant_id']) return $variant;
        throw new RuntimeException('Missing selected fixture variant');
    };
    $old = $pick($pair['before']); $new = $pick($pair['after']);
    $check($name . ' logical variant survives delivery renewal', $old['id'] === $new['id']);
    $check($name . ' selected source survives delivery renewal', $old['delivery']['sources'][0]['id'] === $new['delivery']['sources'][0]['id']);
    $check($name . ' actually receives a new delivery URL', $old['delivery']['sources'][0]['url'] !== $new['delivery']['sources'][0]['url']);
}

$sourceId = static fn (string $url): string => snapSources([$url])[0]['id'];
$cdnBefore = $cases['cdn']['before']['data']['items'][0]; $cdnAfter = $cases['cdn']['after']['data']['items'][0];
$check('CDN renewal regression exercises the actual v26-web to v26-luna selected production route', parse_url($cdnBefore['default']['url'], PHP_URL_HOST) === 'v26-luna.douyinvod.com');
$cdnSources = static function (array $item): array {
    $result = [];
    foreach ($item['variants'][0]['delivery']['sources'] as $source) $result[parse_url($source['url'], PHP_URL_HOST)] = $source['id'];
    ksort($result); return $result;
};
$check('both observed CDN routes retain separate source IDs across renewed signing paths', count($cdnSources($cdnBefore)) === 2 && $cdnSources($cdnBefore) === $cdnSources($cdnAfter));
$cdnPrefix = 'https://v26-luna.douyinvod.com/' . str_repeat('a', 32) . '/6b000001/video/tos/cn/tos-cn-ve-15/';
$check('CDN resource path changes retain distinct identities', $sourceId($cdnPrefix . 'first-file') !== $sourceId($cdnPrefix . 'second-file'));
$check('CDN unknown query selectors remain significant', $sourceId($cdnPrefix . 'first-file?selector=first') !== $sourceId($cdnPrefix . 'first-file?selector=second'));
$check('unrecognized CDN host does not gain signature path normalization', $sourceId(str_replace('v26-luna.douyinvod.com', 'unknown.douyinvod.com', $cdnPrefix) . 'first-file') !== $sourceId(str_replace(['v26-luna.douyinvod.com', str_repeat('a', 32)], ['unknown.douyinvod.com', str_repeat('b', 32)], $cdnPrefix) . 'first-file'));
$outside = str_replace('/video/tos/cn/', '/different/namespace/', $cdnPrefix);
$check('unrecognized resource path on a known CDN remains conservative', $sourceId($outside . 'first-file') !== $sourceId(str_replace(str_repeat('a', 32), str_repeat('b', 32), $outside) . 'first-file'));
$check('unknown provider signature-like query is never discarded', $sourceId('https://media.example/video.mp4?sign=a') !== $sourceId('https://media.example/video.mp4?sign=b'));
$check('lookalike provider hostname is never granted credential normalization', $sourceId('https://www.douyin.com.example/aweme/v1/play/?sign=a') !== $sourceId('https://www.douyin.com.example/aweme/v1/play/?sign=b'));
$check('unknown endpoint on a known host keeps all query parameters', $sourceId('https://www.douyin.com/custom?sign=a') !== $sourceId('https://www.douyin.com/custom?sign=b'));
$check('Weibo template remains a resource selector', $sourceId('https://f.video.weibocdn.com/x.mp4?media_id=x&template=1080&ssig=a') !== $sourceId('https://f.video.weibocdn.com/x.mp4?media_id=x&template=720&ssig=b'));
$check('duplicate resource query parameters are not collapsed', $sourceId('https://www.douyin.com/aweme/v1/play/?file_id=a&file_id=b&sign=a') !== $sourceId('https://www.douyin.com/aweme/v1/play/?file_id=b&sign=b'));
$check('duplicate resource parameter ordering retains last-value semantics', $sourceId('https://www.douyin.com/aweme/v1/play/?file_id=a&file_id=b&sign=a') !== $sourceId('https://www.douyin.com/aweme/v1/play/?file_id=b&file_id=a&sign=b'));
$check('unknown query parameters remain significant on known providers', $sourceId('https://www.douyin.com/aweme/v1/play/?file_id=a&custom=x&sign=a') !== $sourceId('https://www.douyin.com/aweme/v1/play/?file_id=a&custom=y&sign=b'));
$unknown = snapFileVariants([['url' => 'https://media.example/known-file.mp4']])[0];
$enriched = snapFileVariants([['url' => 'https://media.example/known-file.mp4', 'width' => 1920, 'height' => 1080, 'metadata_source' => 'mp4']])[0];
$check('metadata enrichment does not invent a new file identity', $unknown['id'] === $enriched['id']);
$sameFile = snapFileVariants([
    ['url' => 'https://media.example/expired.mp4', 'private_representation_id' => 'legacy-group-a', 'private_media_identity' => 'confirmed-same-file', 'expires_at' => gmdate('c', $now - 60)],
    ['url' => 'https://backup.example/current.mp4', 'private_representation_id' => 'legacy-group-b', 'private_media_identity' => 'confirmed-same-file', 'expires_at' => gmdate('c', $now + 600)],
]);
$check('same proven file split across old grouping keys retains all equivalent CDN sources', count($sameFile) === 1 && count($sameFile[0]['delivery']['sources']) === 2);
$check('expired first CDN cannot discard a valid same-file alternative', snapDeliveryUsable($sameFile[0]['delivery'], $now));
$staleSource = ['url' => 'https://f.video.weibocdn.com/x.mp4?media_id=x&ssig=expired', 'expires_at' => gmdate('c', $now - 60)];
$freshSource = ['url' => 'https://f.video.weibocdn.com/x.mp4?media_id=x&ssig=renewed', 'expires_at' => gmdate('c', $now + 60)];
$renewedSources = snapSources([$staleSource, $freshSource]);
$check('same source with a renewed credential keeps the actually usable URL and its exact expiry', count($renewedSources) === 1 && $renewedSources[0]['url'] === $freshSource['url'] && $renewedSources[0]['expires_at'] === $freshSource['expires_at']);
$check('source renewal deduplication is independent of response ordering', snapSources([$freshSource, $staleSource]) === $renewedSources);
$bilibili = static function (string $signature): array {
    $raw = ['code' => 200, 'data' => ['title' => 'Synthetic DASH renewal', 'extra' => ['bvid' => 'BV1boV66YErZ', 'current_page' => 1, 'pages' => [['page' => 1]]],
        'private_play' => ['dash' => ['video' => [['id' => 120, 'baseUrl' => 'https://upos-sz-estghw.bilivideo.com/fixture/video.m4s?deadline=1800000' . $signature . '&upsig=' . $signature, 'width' => 3840, 'height' => 2160]],
            'audio' => [['id' => 30280, 'baseUrl' => 'https://upos-sz-estghw.bilivideo.com/fixture/audio.m4s?deadline=1800000' . $signature . '&upsig=' . $signature]]]]]];
    $response = snapAdaptParser('bilibili', $raw, 'https://www.bilibili.com/video/BV1boV66YErZ/');
    snapValidateEnvelope($response);
    return $response;
};
$oldDash = $bilibili('100'); $newDash = $bilibili('200');
$oldMux = $oldDash['data']['items'][0]['variants'][0]; $newMux = $newDash['data']['items'][0]['variants'][0];
$check('Bilibili actual adapter keeps mux identity across track credential renewal', $oldMux['id'] === $newMux['id']);
$check('Bilibili keeps video and audio source identities across renewal',
    $oldMux['delivery']['resources'][0]['delivery']['sources'][0]['id'] === $newMux['delivery']['resources'][0]['delivery']['sources'][0]['id']
    && $oldMux['delivery']['resources'][1]['delivery']['sources'][0]['id'] === $newMux['delivery']['resources'][1]['delivery']['sources'][0]['id']);
$check('Bilibili still requires mux processing instead of exposing a bare-track default', $newDash['data']['items'][0]['default'] === null && $newDash['data']['items'][0]['default_unavailable_reason'] === 'processing_required');

$douyinMux = reviewDouyinMuxResponse();
$muxVariants = $douyinMux['data']['items'][0]['variants'];
$audioFiles = [];
foreach ($muxVariants as $variant) foreach ($variant['delivery']['resources'] ?? [] as $resource) {
    if ($resource['role'] === 'audio') $audioFiles[] = basename(parse_url($resource['delivery']['sources'][0]['url'], PHP_URL_PATH));
}
sort($audioFiles);
$check('actual Douyin parser preserves both explicitly matched audio alternatives for one video file', count($muxVariants) === 2 && $audioFiles === ['audio-a.m4a', 'audio-b.m4a']);
$check('unrelated global audio candidate is never paired with the video', !in_array('unrelated-audio.m4a', $audioFiles, true));
$missingFirstAudio = reviewDouyinMuxResponse(true);
$check('missing first audio cannot hide the later complete matched mux variant', count($missingFirstAudio['data']['items'][0]['variants']) === 1 && ($missingFirstAudio['data']['items'][0]['variants'][0]['delivery']['kind'] ?? '') === 'mux');
$reverseMux = reviewDouyinMuxResponse(reverse: true);
$muxIds = array_column($muxVariants, 'id'); $reverseMuxIds = array_column($reverseMux['data']['items'][0]['variants'], 'id');
sort($muxIds); sort($reverseMuxIds);
$check('same-video audio pairing identities do not depend on upstream response order', $muxIds === $reverseMuxIds);
$fallbackIdentityMux = reviewDouyinMuxResponse(fileIdentity: false);
$fallbackIdentityReversed = reviewDouyinMuxResponse(reverse: true, fileIdentity: false);
$fallbackIds = array_column($fallbackIdentityMux['data']['items'][0]['variants'], 'id');
$fallbackReverseIds = array_column($fallbackIdentityReversed['data']['items'][0]['variants'], 'id');
sort($fallbackIds); sort($fallbackReverseIds);
$check('equivalent signed sources without upstream file hashes retain both matched audio variants', count($fallbackIds) === 2 && $fallbackIds === $fallbackReverseIds);

$example = json_decode(file_get_contents(__DIR__ . '/../../docs/schema/unified-v1/examples/16-1080-file-and-higher-4k-mux.json'), true);
$accepted = true; $reason = null;
try { snapValidateEnvelope($example); } catch (UnexpectedValueException $error) { $accepted = false; $reason = $error->getMessage(); }
$check('PHP validator accepts example16 with higher mux dimensions on its video resource', $accepted, $reason);
$selected = snapFinalizeData($example['data']);
$check('production selector declares 4K mux higher than 1080 file using video resource geometry', ($selected['data']['items'][0]['higher_quality_variants'] ?? []) === [['variant_id' => '4k-mux', 'requires' => ['mux']]]);
$check('complete default remains the 1080 file while higher mux is only advertised', $selected['data']['items'][0]['default']['variant_id'] === '1080-file');

if (($argv[1] ?? '') === '--export-validation') {
    $responses = [$before, $after];
    foreach ($cases as $pair) array_push($responses, $pair['before'], $pair['after']);
    array_push($responses, $oldDash, $newDash, $selected, $douyinMux, $missingFirstAudio, $reverseMux, $fallbackIdentityMux, $fallbackIdentityReversed);
    echo json_encode($responses, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL;
    exit;
}

$passed = count(array_filter($checks, static fn ($entry) => $entry['passed']));
echo json_encode(['suite' => 'unified-review-identity', 'evidence' => 'Synthetic production parser/adapter regressions, not live platform acceptance', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
