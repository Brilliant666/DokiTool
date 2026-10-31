<?php
declare(strict_types=1);
require_once __DIR__ . '/../lib/gateway.php';
require_once __DIR__ . '/../api/douyin/DouyinParser.php';

// Synthetic upstream records, executed through the production formatter,
// adapter, default selector and ordinary/debug gateway view. No network IO.
$checks = []; $responses = [];
function mergeCheck(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
function mergeProduct(array $first, array $second, bool $reverse, bool $mediaIdentity, string $signature = 'before'): array
{
    $file = ['format' => 'mp4', 'fps' => 30, 'hdr_type' => 'sdr', 'has_audio' => true,
        'video_extra' => json_encode(['file_id' => 'complete-file', 'audio_channels' => 2]),
        'play_addr' => ['uri' => 'complete-uri', 'file_hash' => md5('complete-file'), 'width' => 3840, 'height' => 2160,
            'url_list' => ['https://www.douyin.com/aweme/v1/play/?file_id=complete-file&sign=' . $signature]]];
    $tracks = []; $audio = [];
    foreach (['audio-a' => $first, 'audio-b' => $second] as $audioId => $facts) {
        $extra = ['audio_file_id' => $audioId];
        $address = ['width' => 3840, 'height' => 2160,
            'url_list' => ['https://www.douyin.com/aweme/v1/play/dash/?file_id=video-track&sign=' . $signature]];
        if ($mediaIdentity) { $extra['file_id'] = 'video-track'; $address['file_hash'] = md5('video-track'); }
        $tracks[] = $facts + ['format' => 'dash', 'video_extra' => json_encode($extra), 'play_addr' => $address];
        $audio[] = ['audio_meta' => ['file_id' => $audioId, 'media_type' => 'audio',
            'url_list' => ['https://media.example/' . $audioId . '.m4a'],
            'sub_info' => json_encode(['audio_channels' => 2, 'audio_language' => 'en', 'audio_profile' => 'aac'])]];
    }
    // A valid unrelated audio must never be introduced by metadata aggregation.
    $audio[] = ['audio_meta' => ['file_id' => 'unpaired', 'media_type' => 'audio', 'url_list' => ['https://media.example/unpaired.m4a']]];
    $parser = new DouyinParser(static fn () => null);
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser,
        ['desc' => 'Metadata merge product-path fixture', 'video' => ['bit_rate' => array_merge([$file], $reverse ? array_reverse($tracks) : $tracks),
            'bit_rate_audio' => $audio, 'cdn_url_expired' => time() + 1800]], '7628438784602389247'), true);
    $full = snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
    global $responses;
    $views = [];
    foreach ([false, true] as $debug) {
        [$status, $payload] = snapPreparePublicMedia('douyin', $full, debug: $debug);
        if ($status !== 200) throw new RuntimeException('Unexpected public response');
        snapValidateEnvelope($payload); $responses[] = $payload;
        $views[$debug ? 'debug' : 'normal'] = $payload['data']['items'][0];
    }
    return $views;
}
function mergeInventory(array $item): array
{
    $inventory = [];
    foreach ($item['variants'] as $variant) {
        $resources = [];
        foreach ($variant['delivery']['resources'] ?? [] as $resource) {
            $resources[$resource['role']] = ['metadata' => $resource['metadata'] ?? [], 'sources' => array_column($resource['delivery']['sources'], 'id')];
        }
        $inventory[$variant['id']] = ['metadata' => $variant['metadata'] ?? [], 'resources' => $resources];
    }
    ksort($inventory);
    return $inventory;
}
foreach ([true, false] as $identity) foreach ([
    'fps' => [[], ['fps' => 60]],
    'hdr_type' => [[], ['hdr_type' => 'hdr10']],
    'fps-conflict' => [['fps' => 30], ['fps' => 60]],
    'hdr_type-conflict' => [['hdr_type' => 'sdr'], ['hdr_type' => 'hdr10']],
] as $case => [$first, $second]) {
    $name = ($identity ? 'representation merge' : 'final ID merge') . ' / ' . $case;
    $forward = mergeProduct($first, $second, false, $identity);
    $reverse = mergeProduct($first, $second, true, $identity);
    $renewed = mergeProduct($first, $second, false, $identity, 'renewed');
    foreach (['normal', 'debug'] as $view) {
        $item = $forward[$view]; $variants = $item['variants'];
        mergeCheck($name . ' / ' . $view . ' retains the file and both protected or conflicting mux pairs', count($variants) === 3);
        mergeCheck($name . ' / ' . $view . ' metadata and identities are independent of input order', mergeInventory($item) === mergeInventory($reverse[$view]));
        mergeCheck($name . ' / ' . $view . ' source renewal preserves all candidate/source identities and facts', mergeInventory($item) === mergeInventory($renewed[$view]));
        $audioUrls = [];
        foreach ($variants as $variant) foreach ($variant['delivery']['resources'] ?? [] as $resource) if ($resource['role'] === 'audio') $audioUrls[] = $resource['delivery']['sources'][0]['url'];
        sort($audioUrls);
        mergeCheck($name . ' / ' . $view . ' retains only explicitly matched A/B audio', $audioUrls === ['https://media.example/audio-a.m4a', 'https://media.example/audio-b.m4a']);
        if (!str_contains($case, 'conflict')) {
            $values = [];
            foreach ($variants as $variant) if ($variant['delivery']['kind'] === 'mux') $values[] = $variant['metadata'][$case] ?? null;
            $expected = $case === 'fps' ? (float)$second[$case] : $second[$case];
            mergeCheck($name . ' / ' . $view . ' fills later confirmed capability on shared video identity', $values === [$expected, $expected]);
        } else {
            $field = explode('-', $case)[0]; $factsRetained = true;
            foreach ($variants as $variant) if ($variant['delivery']['kind'] === 'mux') {
                foreach ([$variant['metadata'], $variant['delivery']['resources'][0]['metadata']] as $metadata) {
                    $expected = [$first[$field], $second[$field]]; sort($expected);
                    $values = array_column($metadata['field_conflicts'][$field] ?? [], 'value'); sort($values);
                    $factsRetained = $factsRetained && !isset($metadata[$field]) && $values == $expected;
                }
            }
            mergeCheck($name . ' / ' . $view . ' exposes both trusted conflicting facts without a scalar winner', count($variants) === 3 && $factsRetained);
        }
    }
    mergeCheck($name . ' / service default remains the same complete file in both views and input orders',
        $forward['normal']['default'] === $forward['debug']['default'] && $forward['normal']['default'] === $reverse['normal']['default']);
}
$mixed = snapMergeMetadata(['width' => 3840, 'height' => 2160, 'fps' => 30.0, 'evidence' => 'upstream'], ['fps' => 60.0, 'video_codec' => 'hevc', 'evidence' => 'probe']);
mergeCheck('technical facts retain correct individual evidence after compatible merge', $mixed['evidence'] === 'mixed'
    && $mixed['field_evidence'] === ['height' => 'upstream', 'video_codec' => 'probe', 'width' => 'upstream']
    && $mixed['field_conflicts']['fps'] === [['value' => 30.0, 'evidence' => 'upstream'], ['value' => 60.0, 'evidence' => 'probe']]);
$again = snapMergeMetadata($mixed, ['fps' => 60.0, 'evidence' => 'probe']);
mergeCheck('a later agreeing observation does not erase an earlier conflict', $again === $mixed);
$third = ['fps' => 90.0, 'evidence' => 'upstream'];
mergeCheck('conflicting facts remain associative across both aggregation layers',
    snapMergeMetadata($again, $third) === snapMergeMetadata($third, snapMergeMetadata($mixed, ['fps' => 60.0, 'evidence' => 'probe'])));
$formatA = ['container' => 'mp4', 'extension' => 'mp4', 'mime_type' => 'video/mp4', 'width' => 3840, 'evidence' => 'probe'];
$formatB = ['height' => 2160, 'evidence' => 'upstream'];
$formatC = ['container' => 'webm', 'extension' => 'webm', 'mime_type' => 'video/webm', 'evidence' => 'upstream'];
$formatMixed = snapMergeMetadata(snapMergeMetadata($formatA, $formatB), $formatC);
mergeCheck('format evidence survives three observations and both merge groupings', $formatMixed === snapMergeMetadata($formatC, snapMergeMetadata($formatB, $formatA))
    && $formatMixed === snapMergeMetadata($formatA, snapMergeMetadata($formatB, $formatC)));
$formatProduct = $responses[0]; $formatProduct['data']['items'][0]['variants'][0]['metadata'] = $formatMixed;
snapValidateEnvelope($formatProduct); $responses[] = $formatProduct;
mergeCheck('format conflicts keep actual probe and upstream evidence', $formatMixed['field_conflicts']['container'] === [
    ['value' => 'mp4', 'evidence' => 'probe'], ['value' => 'webm', 'evidence' => 'upstream']]);
foreach ([
    ['fps' => [['value' => 60, 'evidence' => 'upstream'], ['value' => 60, 'evidence' => 'probe']]],
    ['fps' => [['value' => '30', 'evidence' => 'upstream'], ['value' => '60', 'evidence' => 'upstream']]],
    ['fps' => [['value' => 30, 'evidence' => 'unknown'], ['value' => 60, 'evidence' => 'probe']]],
    ['unknown' => [['value' => 30, 'evidence' => 'upstream'], ['value' => 60, 'evidence' => 'probe']]],
    ['audio_language' => [['value' => '   ', 'evidence' => 'upstream'], ['value' => 'ja', 'evidence' => 'upstream']]],
    ['fps' => [['value' => 30, 'evidence' => 'upstream'], ['value' => 30.0, 'evidence' => 'probe']]],
] as $index => $conflicts) {
    $invalid = $responses[0]; $invalid['data']['items'][0]['variants'][0]['metadata'] = ['field_conflicts' => $conflicts];
    $rejected = false;
    try { snapValidateEnvelope($invalid); } catch (UnexpectedValueException $error) { $rejected = true; }
    mergeCheck('invalid conflict contract ' . $index . ' is rejected', $rejected);
}
$invalid = $responses[0]; $invalid['data']['items'][0]['variants'][1]['delivery']['resources'][0]['metadata'] = [
    'field_conflicts' => ['has_audio' => [['value' => false, 'evidence' => 'upstream'], ['value' => true, 'evidence' => 'probe']]]];
$rejected = false;
try { snapValidateEnvelope($invalid); } catch (UnexpectedValueException $error) { $rejected = true; }
mergeCheck('conflicting embedded audio cannot bypass video resource role constraints', $rejected);
$invalid = $responses[0]; $invalid['data']['items'][0]['variants'][0]['metadata'] = ['audio_language' => '   ', 'audio_language_role' => 'main', 'evidence' => 'upstream'];
$rejected = false;
try { snapValidateEnvelope($invalid); } catch (UnexpectedValueException $error) { $rejected = true; }
mergeCheck('a language role cannot use blank scalar language as evidence', $rejected);
if (($argv[1] ?? '') === '--export') { echo json_encode($responses, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL; exit; }
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'media-merge', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
