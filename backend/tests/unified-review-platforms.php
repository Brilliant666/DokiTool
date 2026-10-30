<?php
declare(strict_types=1);

define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
require_once __DIR__ . '/../api/zuiyou.php';
require_once __DIR__ . '/../api/toutiao.php';
require_once __DIR__ . '/../api/xiaohongshu/XiaohongshuParser.php';
require_once __DIR__ . '/../lib/media-adapters.php';

set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});
$checks = [];
$envelopes = [];

function reviewPlatformCheck(int $issue, string $name, bool $passed, mixed $actual = null): void
{
    global $checks;
    $checks[] = compact('issue', 'name', 'passed', 'actual');
}

/** Exercise the same adapter and validation boundary used by the parser runner. */
function reviewPlatformOutput(int $issue, string $platform, array $raw, string $url): array
{
    global $envelopes;
    reviewPlatformCheck($issue, $platform . ' real extractor succeeds', ($raw['code'] ?? null) === 200, $raw['code'] ?? null);
    $output = snapAdaptParser($platform, $raw, $url);
    $envelopes[] = $output;
    try {
        snapValidateEnvelope($output);
        reviewPlatformCheck($issue, $platform . ' output passes public contract validation', true);
    } catch (Throwable $error) {
        reviewPlatformCheck($issue, $platform . ' output passes public contract validation', false, $error->getMessage());
    }
    return $output['data'] ?? [];
}

// Upstream map insertion order is not the post's ordered imgs sequence.
$videoUrls = [
    42 => 'https://media.example.test/zuiyou-first.mp4',
    11 => 'https://media.example.test/zuiyou-second.mp4',
    78 => 'https://media.example.test/zuiyou-third.mp4',
];
$post = ['content' => 'Ordered multi-video fixture', 'member' => ['name' => 'Fixture author'],
    'imgs' => [['id' => 42], ['id' => 11], ['id' => 78]],
    'videos' => [11 => ['url' => $videoUrls[11]], 78 => ['url' => $videoUrls[78]], 42 => ['url' => $videoUrls[42]]]];
$zuiyouRaw = zuiyouResponse(['data' => ['post' => $post]]);
$zuiyou = reviewPlatformOutput(5, 'zuiyou', $zuiyouRaw, 'https://www.izuiyou.com/detail/123456');
$orderedUrls = array_map(static fn (array $item) => $item['default']['url'] ?? null, $zuiyou['items']);
$defaultItem = array_values(array_filter($zuiyou['items'], static fn (array $item) => $item['id'] === ($zuiyou['default_item_id'] ?? null)))[0] ?? [];
reviewPlatformCheck(5, 'parser main video comes from first imgs entry', $zuiyouRaw['data']['url'] === $videoUrls[42], $zuiyouRaw['data']['url']);
reviewPlatformCheck(5, 'unified items preserve imgs video order', $orderedUrls === array_values($videoUrls), $orderedUrls);
reviewPlatformCheck(5, 'default item preserves parser main video', ($defaultItem['default']['url'] ?? null) === $zuiyouRaw['data']['url'], $defaultItem['default']['url'] ?? null);
reviewPlatformCheck(5, 'all three distinct videos survive adaptation', count(array_unique($orderedUrls)) === 3, count(array_unique($orderedUrls)));
reviewPlatformCheck(5, 'parser retains upstream video-map IDs in content order', array_column($zuiyouRaw['data']['private_videos'], 'private_video_id') === ['42', '11', '78'], array_column($zuiyouRaw['data']['private_videos'], 'private_video_id'));

// Retain upstream identities when an earlier videos-map entry disappears.
// An empty URL still occupies its old array slot, so it is a separate control.
$zuiyouResolve = ['before' => $envelopes[0]];
$missingFirst = $post; unset($missingFirst['videos'][42]);
$missingSelected = $post; unset($missingSelected['videos'][11]);
$emptyFirstUrl = $post; $emptyFirstUrl['videos'][42]['url'] = '';
$idsByUrl = static function (array $items): array {
    $ids = [];
    foreach ($items as $item) if (isset($item['default']['url'])) $ids[$item['default']['url']] = $item['id'];
    return $ids;
};
$initialIds = $idsByUrl($zuiyou['items']);
foreach (['missing_first' => $missingFirst, 'missing_selected' => $missingSelected, 'empty_first_url' => $emptyFirstUrl] as $name => $changedPost) {
    $changedRaw = zuiyouResponse(['data' => ['post' => $changedPost]]);
    $changed = reviewPlatformOutput(5, 'zuiyou', $changedRaw, 'https://www.izuiyou.com/detail/123456');
    $zuiyouResolve[$name] = $envelopes[array_key_last($envelopes)];
    $changedIds = $idsByUrl($changed['items']);
    foreach ($changedIds as $mediaUrl => $itemId) {
        reviewPlatformCheck(5, $name . ' keeps the surviving upstream video identity', $itemId === $initialIds[$mediaUrl],
            ['url' => $mediaUrl, 'before' => $initialIds[$mediaUrl], 'after' => $itemId]);
    }
    $missingUrl = $name === 'missing_selected' ? $videoUrls[11] : $videoUrls[42];
    reviewPlatformCheck(5, $name . ' cannot reuse the absent item ID for a neighbor', !in_array($initialIds[$missingUrl], $changedIds, true), array_values($changedIds));
    $expectedUrls = $name === 'missing_selected' ? [$videoUrls[42], $videoUrls[78]] : [$videoUrls[11], $videoUrls[78]];
    reviewPlatformCheck(5, $name . ' keeps content order and every surviving video', array_keys($changedIds) === $expectedUrls, array_keys($changedIds));
    reviewPlatformCheck(5, $name . ' keeps first surviving video as default', $changed['default_item_id'] === $changed['items'][0]['id'], $changed['default_item_id']);
}

$gaps = $post;
$gaps['imgs'] = [[], ['id' => ['invalid']], ['id' => 999], ['id' => 78], ['id' => 78], ['id' => 42]];
$gapRaw = zuiyouResponse(['data' => ['post' => $gaps]]);
$gapData = reviewPlatformOutput(5, 'zuiyou', $gapRaw, 'https://www.izuiyou.com/detail/123456');
$gapUrls = array_map(static fn (array $item) => $item['default']['url'] ?? null, $gapData['items']);
reviewPlatformCheck(5, 'missing video IDs are skipped and unreferenced videos survive at the end', $gapUrls === [$videoUrls[78], $videoUrls[42], $videoUrls[11]], $gapUrls);
reviewPlatformCheck(5, 'duplicate imgs IDs do not duplicate videos', count($gapData['items']) === 3, count($gapData['items']));
reviewPlatformCheck(5, 'main video uses first playable ordered entry after missing IDs', $gapRaw['data']['url'] === $videoUrls[78], $gapRaw['data']['url']);
$imageRaw = zuiyouResponse(['data' => ['post' => ['imgs' => [['urls' => ['origin' => ['urls' => ['https://media.example.test/still.jpg']]]]]]]]);
$imageData = reviewPlatformOutput(5, 'zuiyou', $imageRaw, 'https://www.izuiyou.com/detail/123456');
reviewPlatformCheck(5, 'a post without videos remains an image item', count($imageData['items']) === 1 && $imageData['items'][0]['type'] === 'image', array_column($imageData['items'], 'type'));

$toutiaoId = '1234567890123456789';
$authorDescription = 'Author biography, not a description of this work.';
foreach (['userInfo', 'itemCell.userInfo'] as $authorPath) {
    $video = ['title' => 'Independent work title', 'videoPlayInfo' => ['video_list' => [
        ['main_url' => 'https://media.example.test/toutiao.mp4'],
    ]]];
    $author = ['name' => 'Fixture author', 'userId' => '42', 'description' => $authorDescription];
    if ($authorPath === 'userInfo') $video['userInfo'] = $author;
    else $video['itemCell']['userInfo'] = $author;
    $html = '<script id="RENDER_DATA">' . rawurlencode(json_encode(['data' => ['itemId' => $toutiaoId, 'initialVideo' => $video]], JSON_THROW_ON_ERROR)) . '</script>';
    $raw = toutiaoResponseFromPage($html, $toutiaoId);
    $data = reviewPlatformOutput(6, 'toutiao', $raw, 'https://www.toutiao.com/video/' . $toutiaoId . '/');
    reviewPlatformCheck(6, $authorPath . ' biography stays on author', ($data['author']['description'] ?? null) === $authorDescription, $data['author']['description'] ?? null);
    reviewPlatformCheck(6, $authorPath . ' biography is not exposed as work description', !array_key_exists('description', $data), $data['description'] ?? null);
    reviewPlatformCheck(6, $authorPath . ' work title remains independent', ($data['title'] ?? null) === $video['title'], $data['title'] ?? null);
}

$xhsUrl = 'https://www.rednote.com/explore/fixture01?xsec_token=synthetic-test';
$statisticsCases = [
    'mixed counters including zero' => [
        ['likedCount' => '0', 'commentCount' => 12, 'shareCount' => 0, 'collectedCount' => '34'],
        ['likes' => 0, 'comments' => 12, 'shares' => 0, 'saves' => 34],
    ],
    'only an observed zero' => [['likedCount' => 0], ['likes' => 0]],
    'no observed counters' => [[], []],
    'invalid or missing counters' => [['likedCount' => null, 'commentCount' => '', 'shareCount' => 'unknown', 'collectedCount' => -1], []],
];
foreach ($statisticsCases as $name => [$upstream, $expected]) {
    $note = ['noteId' => 'fixture01', 'type' => 'video', 'title' => 'Statistics fixture', 'interactInfo' => $upstream,
        'video' => ['media' => ['stream' => ['h264' => [[
            'masterUrl' => 'https://media.example.test/xiaohongshu.mp4', 'width' => 1280, 'height' => 720,
        ]]]]]];
    $html = '<script>window.__INITIAL_STATE__=' . json_encode(['note' => ['noteDetailMap' => ['fixture01' => ['note' => $note]]]], JSON_THROW_ON_ERROR) . ';</script>';
    $requests = [];
    $parser = new XiaohongshuParser(static function (string $url) use ($html, &$requests): array {
        $requests[] = $url;
        return ['status' => 200, 'url' => $url, 'body' => $html];
    }, static function (): never {
        throw new RuntimeException('This statistics fixture must not request a media probe.');
    });
    $raw = json_decode($parser->parse($xhsUrl), true, 512, JSON_THROW_ON_ERROR);
    $data = reviewPlatformOutput(7, 'xiaohongshu', $raw, $xhsUrl);
    $statistics = $data['statistics'] ?? [];
    $actual = array_map(static fn (array $counter) => $counter['value'], $statistics);
    reviewPlatformCheck(7, $name . ' preserves exactly the observed counters', $actual === $expected, $actual);
    foreach ($expected as $counter => $value) {
        if ($value !== 0) continue;
        reviewPlatformCheck(7, $name . ' preserves known zero for ' . $counter,
            isset($statistics[$counter]) && $statistics[$counter]['value'] === 0 && ($statistics[$counter]['state'] ?? 'known') === 'known',
            $statistics[$counter] ?? null);
    }
    reviewPlatformCheck(7, $name . ' runs the supplied page through the actual parser', $requests === [$xhsUrl], count($requests));
}

$failed = array_filter($checks, static fn (array $check) => !$check['passed']);
$report = ['suite' => 'unified-review-platforms', 'evidence' => 'Offline upstream fixtures through actual extractor and public adapter; not live platform acceptance',
    'passed' => count($checks) - count($failed), 'total' => count($checks), 'checks' => $checks];
$output = in_array('--export-zuiyou-resolve', $argv, true) ? $zuiyouResolve : (in_array('--export', $argv, true) ? $envelopes : $report);
echo json_encode($output,
    JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
exit($failed ? 1 : 0);
