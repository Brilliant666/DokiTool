<?php
declare(strict_types=1);
define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
require __DIR__ . '/../api/toutiao.php';
set_error_handler(static function (int $severity, string $message): never { throw new ErrorException($message, 0, $severity); });
$checks = [];
function expectToutiao(string $name, bool $passed): void { global $checks; $checks[] = ['name' => $name, 'passed' => $passed]; }
function toutiaoFixture(array $video, string $id = '7501991960077500979'): string {
    return "<script type='application/json' data-test='yes' id = 'RENDER_DATA'>" . rawurlencode(json_encode(['data' => ['itemId' => $id, 'initialVideo' => $video]])) . '</script>';
}
$id = '7501991960077500979';
$url = 'https://www.toutiao.com/video/' . $id . '/?wid=1765247684252';
expectToutiao('canonical ID ignores wid', toutiaoVideoId($url) === $id);
expectToutiao('mobile i link ID', toutiaoVideoId('https://m.toutiao.com/i' . $id . '/') === $id);
expectToutiao('query ID stays a string', toutiaoVideoId('https://m.toutiao.com/share/?group_id=' . $id) === $id);
expectToutiao('host and wid digits do not count', toutiaoVideoId('https://m2.toutiao.com/is/abc/?wid=1765247684252') === null);
expectToutiao('array query ID rejected', toutiaoVideoId('https://m.toutiao.com/share/?item_id[]=123456') === null);
expectToutiao('external URL rejected', !toutiaoAllowedUrl('https://toutiao.com.example/video/' . $id));
expectToutiao('credentials rejected', !toutiaoAllowedUrl('https://user@www.toutiao.com/video/' . $id));
expectToutiao('nonstandard port rejected', !toutiaoAllowedUrl('https://www.toutiao.com:8080/video/' . $id));
expectToutiao('relative redirect stays on platform', toutiaoRedirectUrl('https://m.toutiao.com/is/abc/', '/video/' . $id) === 'https://m.toutiao.com/video/' . $id);
expectToutiao('redirect cannot leave platform', toutiaoRedirectUrl($url, 'https://example.com/video/' . $id) === null);
$video = ['title' => 'A+B', 'publishTime' => 1746700800, 'diggCount' => 0, 'commentCount' => 16, 'playCount' => 92696, 'repinCount' => 165,
    'coverUrl' => 'https://media.example/cover.jpg', 'userInfo' => ['name' => '作者', 'userId' => '42', 'avatarUrl' => 'https://media.example/avatar.jpg'],
    'videoPlayInfo' => ['video_duration' => 149.718, 'video_list' => [
        ['main_url' => 'https://media.example/720.mp4', 'video_meta' => ['vwidth' => 1280, 'vheight' => 720, 'real_bitrate' => 9000000]],
        ['main_url' => base64_encode('https://media.example/1080.mp4'), 'backup_url' => 'https://mirror.example/1080.mp4', 'video_meta' => ['vwidth' => 1920, 'vheight' => 1080, 'real_bitrate' => 1384591, 'codec_type' => 'h264', 'size' => 25912280]],
        ['main_url' => 'https://media.example/unknown.mp4'],
        ['main_url' => 'javascript:alert(1)'],
    ]]];
$html = toutiaoFixture($video);
$result = toutiaoResponseFromPage($html, $id);
$data = $result['data'];
expectToutiao('attribute order and single quotes supported', $result['code'] === 200);
expectToutiao('plus sign survives percent decode', $data['title'] === 'A+B');
expectToutiao('highest resolution beats bitrate and array position', $data['url'] === 'https://media.example/1080.mp4' && $data['quality'] === '1080p');
expectToutiao('selected source metadata retained', $data['width'] === 1920 && $data['height'] === 1080 && $data['codec'] === 'h264' && $data['bit_rate'] === 1384591 && $data['size'] === 25912280);
expectToutiao('backup alternatives are typed and sorted', count($data['video_backup']) === 3 && $data['video_backup'][0]['url'] === 'https://mirror.example/1080.mp4' && $data['video_backup'][1]['width'] === 1280);
expectToutiao('unknown metadata remains unknown', $data['video_backup'][2]['quality'] === 'unknown' && !isset($data['video_backup'][2]['width'], $data['video_backup'][2]['codec']));
expectToutiao('fractional duration is seconds', $data['duration'] === 149.718);
expectToutiao('publication preserved', $data['create_time'] === 1746700800);
expectToutiao('zero statistics retained and counters mapped', $data['extra']['statistics'] === ['digg_count' => 0, 'comment_count' => 16, 'collect_count' => 165, 'play_count' => 92696]);
expectToutiao('current author path retained', $data['author'] === '作者' && $data['userID'] === '42');
$legacy = $video;
$legacy['itemCell'] = ['userInfo' => ['name' => '旧作者', 'userID' => 84, 'avatarURL' => 'https://media.example/old.jpg', 'description' => '简介']];
expectToutiao('legacy author path retained', toutiaoResponseFromPage(toutiaoFixture($legacy), $id)['data']['author'] === '旧作者');
expectToutiao('challenge is not reported as expired', toutiaoResponseFromPage('<script>__ac_signature</script>', $id)['code'] === 429);
expectToutiao('malformed JSON remains error', toutiaoResponseFromPage('<script id="RENDER_DATA">%7Bbad</script>', $id)['code'] === 502);
expectToutiao('data-id attribute cannot impersonate render script', toutiaoResponseFromPage(str_replace(' id = ', ' data-id = ', $html), $id)['code'] === 404);
expectToutiao('malformed root ID returns an error without warning', toutiaoResponseFromPage('<script id="RENDER_DATA">{"data":{"itemId":[],"initialVideo":{}}}</script>', $id)['code'] === 404);
expectToutiao('missing video remains error', toutiaoResponseFromPage(toutiaoFixture([]), $id)['code'] === 404);
expectToutiao('different item never substituted', toutiaoResponseFromPage($html, '123456') ['code'] === 404);
expectToutiao('unsafe decoded media rejected', toutiaoMediaUrl(base64_encode('file:///etc/passwd')) === '');
expectToutiao('protocol-relative URL normalized', toutiaoMediaUrl('//media.example/video.mp4') === 'https://media.example/video.mp4');
$calls = [];
$response = toutiao($url, static function (string $target, array $options) use (&$calls, $html): array {
    $calls[] = ['url' => $target, 'options' => $options];
    return count($calls) === 1 ? ['ok' => true, 'status' => 200, 'ttwid' => 'anonymous-test-value'] : ['ok' => true, 'status' => 200, 'body' => $html];
});
expectToutiao('canonical parse uses just anonymous initialization and page', $response['code'] === 200 && count($calls) === 2 && $calls[0]['url'] === 'https://ttwid.bytedance.com/ttwid/union/register/' && $calls[1]['url'] === 'https://www.toutiao.com/video/' . $id . '/');
expectToutiao('cookie only forwarded to canonical page', !isset($calls[0]['options']['ttwid']) && $calls[1]['options']['ttwid'] === 'anonymous-test-value');
expectToutiao('cookie absent from parser output', !str_contains(json_encode($response), 'anonymous-test-value'));
$calls = [];
$response = toutiao('https://m.toutiao.com/is/abc/', static function (string $target, array $options) use (&$calls, $url, $html): array {
    $calls[] = $target;
    return match (count($calls)) { 1 => ['ok' => true, 'status' => 302, 'location' => $url], 2 => ['ok' => true, 'status' => 200, 'ttwid' => 'anonymous'], default => ['ok' => true, 'status' => 200, 'body' => $html] };
});
expectToutiao('short link resolves before session initialization', $response['code'] === 200 && count($calls) === 3);
$calls = 0;
$response = toutiao('https://m.toutiao.com/is/abc/', static function () use (&$calls): array { $calls++; return ['ok' => true, 'status' => 302, 'location' => 'https://example.com/private']; });
expectToutiao('foreign redirect not requested', $response['code'] === 400 && $calls === 1);
$calls = 0;
$response = toutiao('https://m.toutiao.com/is/abc/', static function () use (&$calls): array { $calls++; return ['ok' => true, 'status' => 302, 'location' => 'https://m.toutiao.com/is/abc/']; });
expectToutiao('redirect loop bounded', $response['code'] === 400 && $calls === 3);
expectToutiao('no anonymous cookie yields explicit failure', toutiao($url, static fn () => ['ok' => true, 'status' => 200, 'ttwid' => ''])['code'] === 502);
$calls = 0;
$response = toutiao($url, static function () use (&$calls): array { return ++$calls === 1 ? ['ok' => true, 'status' => 200, 'ttwid' => 'anonymous'] : ['ok' => false, 'status' => 0]; });
expectToutiao('transport failure not empty success', $response['code'] === 502);
$calls = 0;
$response = toutiao($url, static function () use (&$calls): array { return ++$calls === 1 ? ['ok' => true, 'status' => 200, 'ttwid' => 'anonymous'] : ['ok' => true, 'status' => 429, 'body' => '']; });
expectToutiao('HTTP rate limit remains explicit', $response['code'] === 429);
$now = 100.0;
$timeouts = [];
$response = toutiao('https://m.toutiao.com/is/start/', static function (string $target, array $options) use (&$now, &$timeouts, $url, $html): array {
    $timeouts[] = $options['timeout'];
    $step = count($timeouts);
    $now += $step <= 3 ? 8 : 4;
    return match ($step) {
        1, 2 => ['ok' => true, 'status' => 302, 'location' => 'https://m.toutiao.com/is/next/'],
        3 => ['ok' => true, 'status' => 302, 'location' => $url],
        4 => ['ok' => true, 'status' => 200, 'ttwid' => 'anonymous'],
        default => ['ok' => true, 'status' => 200, 'body' => $html],
    };
}, static function () use (&$now): float { return $now; });
expectToutiao('all five serial requests consume one 35-second budget', $response['code'] === 200 && $timeouts === [20, 20, 19, 11, 7]);
$now = 0.0;
$calls = 0;
$response = toutiao('https://m.toutiao.com/is/start/', static function () use (&$now, &$calls): array {
    $calls++;
    $now = 34.5;
    return ['ok' => true, 'status' => 302, 'location' => 'https://m.toutiao.com/is/next/'];
}, static function () use (&$now): float { return $now; });
expectToutiao('subsecond remainder stops redirects without exceeding budget', $response['code'] === 502 && str_contains($response['msg'], '超时') && $calls === 1);
$now = 0.0;
$calls = 0;
$response = toutiao($url, static function () use (&$now, &$calls): array {
    $calls++;
    $now = 35.0;
    return ['ok' => true, 'status' => 200, 'ttwid' => 'anonymous'];
}, static function () use (&$now): float { return $now; });
expectToutiao('exhausted initialization budget never starts page request', $response['code'] === 502 && str_contains($response['msg'], '超时') && $calls === 1);
$failed = array_values(array_filter($checks, static fn (array $check): bool => !$check['passed']));
echo json_encode(['suite' => 'toutiao', 'passed' => count($checks) - count($failed), 'total' => count($checks), 'failures' => $failed], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;
exit($failed ? 1 : 0);
