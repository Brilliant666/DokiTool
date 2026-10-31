<?php
declare(strict_types=1);
require_once __DIR__ . '/../lib/gateway.php';
require_once __DIR__ . '/../api/douyin/DouyinParser.php';

// Synthetic upstream input through the real formatter, adapter and public view.
// Distinct observations of one pairing must reach aggregation before deduplication.
$checks = []; $responses = [];
function observationCheck(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
function observationProduct(array $facts, bool $mainTrack, string $signature = 'before'): array
{
    static $expiresAt = null;
    $expiresAt ??= time() + 1800;
    $file = ['format' => 'mp4', 'fps' => 30, 'hdr_type' => 'sdr', 'has_audio' => true,
        'video_extra' => json_encode(['file_id' => 'complete', 'audio_channels' => 2]),
        'play_addr' => ['uri' => 'complete-uri', 'file_hash' => md5('complete'), 'width' => 3840, 'height' => 2160,
            'url_list' => ['https://www.douyin.com/aweme/v1/play/?file_id=complete&sign=' . $signature]]];
    $tracks = array_map(static fn ($metadata) => $metadata + ['format' => 'dash',
        'video_extra' => json_encode(['file_id' => 'shared-video', 'audio_file_id' => 'matched-audio']),
        'play_addr' => ['uri' => 'shared-uri', 'file_hash' => md5('shared-video'), 'width' => 3840, 'height' => 2160,
            'url_list' => ['https://www.douyin.com/aweme/v1/play/dash/?file_id=shared-video&sign=' . $signature]]], $facts);
    $audio = [];
    foreach (['matched-audio', 'unrelated-audio'] as $id) $audio[] = ['audio_meta' => ['file_id' => $id, 'media_type' => 'audio',
        'url_list' => ['https://media.example/' . $id . '.m4a'], 'sub_info' => json_encode(['audio_channels' => 2, 'audio_profile' => 'aac'])]];
    $parser = new DouyinParser(static fn () => null);
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser,
        ['desc' => 'Same pairing observation fixture', 'video' => [
            'bit_rate' => $mainTrack ? array_merge($tracks, [$file]) : array_merge([$file], $tracks),
            'bit_rate_audio' => $audio, 'cdn_url_expired' => $expiresAt]], '7628438784602389247'), true);
    $full = snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
    global $responses;
    $result = ['raw' => $raw['data']];
    foreach ([false, true] as $debug) {
        [$status, $payload] = snapPreparePublicMedia('douyin', $full, debug: $debug);
        if ($status !== 200) throw new RuntimeException('Unexpected public status');
        snapValidateEnvelope($payload); $responses[] = $payload;
        $result[$debug ? 'debug' : 'normal'] = $payload['data']['items'][0];
    }
    return $result;
}
function observationInventory(array $item): array
{
    $result = [];
    foreach ($item['variants'] as $variant) {
        $resources = [];
        foreach ($variant['delivery']['resources'] ?? [] as $resource) $resources[$resource['role']] = [
            'metadata' => $resource['metadata'] ?? [], 'source_ids' => array_column($resource['delivery']['sources'], 'id')];
        $result[$variant['id']] = ['metadata' => $variant['metadata'] ?? [], 'resources' => $resources,
            'source_ids' => array_column($variant['delivery']['sources'] ?? [], 'id')];
    }
    ksort($result);
    return $result;
}
function rawPairCount(array $raw): int
{
    return count(array_filter(array_merge([$raw], $raw['video_backup']),
        static fn ($candidate) => ($candidate['private_audio_id'] ?? '') === 'matched-audio'));
}
$identities = null;
foreach ([false, true] as $mainTrack) foreach ([
    'fps' => [[], ['fps' => 60]], 'hdr_type' => [[], ['hdr_type' => 'hdr10']],
    'fps-conflict' => [['fps' => 30], ['fps' => 60]],
    'hdr_type-conflict' => [['hdr_type' => 'sdr'], ['hdr_type' => 'hdr10']],
] as $case => $facts) {
    $name = ($mainTrack ? 'main plus backup' : 'backup plus backup') . ' / ' . $case;
    $forward = observationProduct($facts, $mainTrack);
    $reverse = observationProduct(array_reverse($facts), $mainTrack);
    $renewed = observationProduct($facts, $mainTrack, 'renewed');
    observationCheck($name . ' exercises the requested main or backup position', (($forward['raw']['private_delivery_kind'] ?? '') === 'video_track') === $mainTrack);
    observationCheck($name . ' keeps both distinct formatter observations, excluding the repeated main', rawPairCount($forward['raw']) === 2 && rawPairCount($reverse['raw']) === 2);
    foreach (['normal', 'debug'] as $view) {
        $item = $forward[$view];
        $muxes = array_values(array_filter($item['variants'], static fn ($variant) => ($variant['delivery']['kind'] ?? '') === 'mux'));
        observationCheck($name . ' / ' . $view . ' retains one complete file and one protected matched mux', count($item['variants']) === 2 && count($muxes) === 1);
        observationCheck($name . ' / ' . $view . ' is invariant under input reversal', observationInventory($item) === observationInventory($reverse[$view]));
        observationCheck($name . ' / ' . $view . ' preserves candidate/source identity and facts after URL renewal', observationInventory($item) === observationInventory($renewed[$view]));
        $audioUrls = [];
        foreach ($muxes as $mux) foreach ($mux['delivery']['resources'] as $resource) if ($resource['role'] === 'audio') $audioUrls[] = $resource['delivery']['sources'][0]['url'];
        observationCheck($name . ' / ' . $view . ' never borrows an unrelated audio track', $audioUrls === ['https://media.example/matched-audio.m4a']);
        $field = explode('-', $case)[0];
        $metadata = $muxes[0]['metadata'] ?? [];
        if (str_contains($case, 'conflict')) {
            $values = array_column($metadata['field_conflicts'][$field] ?? [], 'value'); sort($values);
            $expected = array_column($facts, $field); sort($expected);
            observationCheck($name . ' / ' . $view . ' retains both conflicting observations without a scalar winner', !isset($metadata[$field]) && $values == $expected);
        } else observationCheck($name . ' / ' . $view . ' keeps a later confirmed capability', ($metadata[$field] ?? null) == $facts[1][$field]);
        $keys = array_keys(observationInventory($item));
        $identities ??= $keys;
        observationCheck($name . ' / ' . $view . ' does not put capability metadata into stable IDs', $keys === $identities);
    }
    observationCheck($name . ' preserves the service-selected complete default across view and order',
        $forward['normal']['default'] === $forward['debug']['default'] && $forward['normal']['default'] === $reverse['normal']['default']);
}
foreach ([false, true] as $mainTrack) {
    $duplicate = observationProduct([['fps' => 60], ['fps' => 60]], $mainTrack);
    observationCheck('fully identical pairing still deduplicates with mainTrack=' . (int)$mainTrack, rawPairCount($duplicate['raw']) === 1);
    observationCheck('fully identical pair keeps one normalized mux with mainTrack=' . (int)$mainTrack, count($duplicate['normal']['variants']) === 2);
}
if (($argv[1] ?? '') === '--export') { echo json_encode($responses, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . PHP_EOL; exit; }
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'douyin-observation', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
