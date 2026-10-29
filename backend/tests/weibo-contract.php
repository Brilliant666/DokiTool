<?php
declare(strict_types=1);
define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
require __DIR__ . '/../api/weibo.php';
$checks = [];
function expect(string $name, bool $passed): void { global $checks; $checks[] = ['name' => $name, 'passed' => $passed]; }
function reply(array|string $body, int $status = 200, string $url = 'https://weibo.com/tv/api/component'): array
{
    return ['body' => is_array($body) ? json_encode($body) : $body, 'status' => $status, 'url' => $url, 'error' => false];
}
function sequence(array $responses, array &$calls): Closure
{
    return static function (string $url, ?string $post, string $referer) use (&$responses, &$calls): array {
        $calls[] = compact('url', 'post', 'referer');
        if (!$responses) { throw new RuntimeException('Unexpected extra network request'); }
        return array_shift($responses);
    };
}
$fid = '1034:5339966948180025';
$target = ['kind' => 'video', 'id' => $fid];
expect('TV identity parses without query contamination', weiboTarget('https://weibo.com/tv/show/' . $fid . '?from=old_pc_videoshow') === $target);
expect('video query identity accepts encoded colon', weiboTarget('https://video.weibo.com/show?fid=1034%3A5339966948180025') === $target);
expect('array fid rejected safely', weiboTarget('https://video.weibo.com/show?fid[]=1034:5339966948180025') === null);
expect('untrusted host and credentials rejected', weiboTarget('https://weibo.com.example/tv/show/' . $fid) === null && weiboTarget('https://user@weibo.com/tv/show/' . $fid) === null);
expect('invalid media IDs rejected', weiboTarget('https://weibo.com/tv/show/not-a-video') === null);
expect('desktop and mobile status URLs share status API', weiboTarget('https://weibo.com/8492187319/RgLP2uuC9') === ['kind' => 'status', 'id' => 'RgLP2uuC9'] && weiboTarget('https://m.weibo.cn/detail/5339970807267525') === ['kind' => 'status', 'id' => '5339970807267525']);
expect('official guarded JSONP decoded without execution', weiboJsonp('window.gen_callback && gen_callback({"retcode":20000000});', 'gen_callback') === ['retcode' => 20000000]);
expect('unrelated callback cannot be executed or accepted', weiboJsonp('evil({"retcode":20000000});', 'gen_callback') === null && weiboJsonp('gen_callback({"retcode":20000000});alert(1)', 'gen_callback') === null);
expect('valid JSON title cannot trigger visitor bootstrap', !weiboIsVisitor(reply(['title' => 'Sina Visitor System'])));
$component = ['code' => '100000', 'data' => ['Component_Play_Playinfo' => ['mid' => '5339970807267525',
    'title' => 'Fixture video', 'urls' => ['高清 720P' => '//media.example/720.mp4', '高清 1080P' => '//media.example/1080.mp4'],
    'duration_time' => 194.199, 'real_date' => 1788630795, 'date' => '1月前', 'play_count' => '1,304',
    'attitudes_count' => 0, 'comments_count' => '6', 'reposts_count' => '4', 'topics' => [['content' => '公开话题']]]]];
$status = ['created_at' => 'Sun Sep 06 02:08:34 +0800 2026', 'attitudes_count' => 0, 'comments_count' => 6, 'reposts_count' => 4,
    'page_info' => ['media_info' => ['online_users_number' => 1304, 'playback_list' => [
        ['play_info' => ['url' => '//media.example/720.mp4', 'mime' => 'video/mp4', 'label' => 'mp4_720p', 'width' => 1280, 'height' => 720, 'bitrate' => 8000000]],
        ['play_info' => ['url' => '//media.example/1080.mp4', 'mime' => 'video/mp4', 'label' => 'mp4_1080p', 'width' => 1920, 'height' => 1080, 'bitrate' => 5596775, 'video_codecs' => 'avc1.640032', 'size' => 135861723]],
        ['play_info' => ['url' => '//images.example/scrubber.jpg', 'mime' => 'image/jpeg', 'label' => 'scrubber_hd', 'width' => 7680, 'height' => 4320]],
    ]]]];
$visitor = reply('<title>Sina Visitor System</title>', 200, 'https://passport.weibo.com/visitor/visitor');
$guest = reply('window.gen_callback && gen_callback({"retcode":20000000,"data":{"tid":"fixture-guest","new_tid":true,"confidence":100}});');
$cookie = reply('window.cross_domain && cross_domain({"retcode":20000000,"msg":"succ"});');
$calls = [];
$result = weiboResolve($target, sequence([$visitor, $guest, $cookie, reply($component), reply($status)], $calls));
$data = $result['data'] ?? [];
expect('anonymous visitor sequence recovers real JSON', $result['code'] === 200 && count($calls) === 5);
expect('component request remains POST with matching TV referer', str_starts_with($calls[0]['post'], 'data=') && $calls[0]['referer'] === 'https://weibo.com/tv/show/' . $fid && $calls[3]['post'] === $calls[0]['post']);
expect('only official visitor endpoints used', str_starts_with($calls[1]['url'], 'https://passport.weibo.com/visitor/genvisitor') && str_starts_with($calls[2]['url'], 'https://passport.weibo.com/visitor/visitor?'));
expect('status enrichment uses returned mid', $calls[4]['url'] === 'https://weibo.com/ajax/statuses/show?id=5339970807267525' && $calls[4]['post'] === null);
expect('1080p selected over higher bitrate 720p', $data['url'] === 'https://media.example/1080.mp4' && $data['quality'] === '1080p');
expect('metadata belongs to main stream', $data['width'] === 1920 && $data['height'] === 1080 && $data['bit_rate'] === 5596775 && $data['codec'] === 'avc1.640032' && $data['size'] === 135861723);
expect('same URLs deduplicated and scrubber JPEG excluded', count($data['video_backup']) === 2);
expect('duration retains source fraction', $data['duration'] === 194.199);
expect('exact publish timestamp replaces relative date', $data['publish_time'] === '2026-09-06 02:08:34');
expect('zero likes and exact numeric statistics retained', $data['extra']['statistics'] === ['play_count' => 1304, 'digg_count' => 0, 'comment_count' => 6, 'share_count' => 4]);
expect('source topics retained', $data['extra']['hashtags'] === ['公开话题']);
expect('guest token does not appear in business response', !str_contains(json_encode($result), 'fixture-guest'));
$calls = [];
$failed = weiboResolve($target, sequence([$visitor, $guest, $cookie, $visitor], $calls));
expect('visitor failure is bounded and never called missing video', $failed['code'] === 503 && count($calls) === 4 && !isset($failed['data']));
$calls = [];
$failed = weiboResolve($target, sequence([$visitor, reply('gen_callback({"retcode":50000000});')], $calls));
expect('guest setup denial stops without repeated attempts', $failed['code'] === 503 && count($calls) === 2);
$calls = [];
expect('HTTP denial preserved as access restriction', weiboResolve($target, sequence([reply('Forbidden', 403)], $calls))['code'] === 503 && count($calls) === 1);
$calls = [];
expect('unexpected HTML has distinct upstream format error', weiboResolve($target, sequence([reply('<html>upstream failure</html>')], $calls))['code'] === 502);
$calls = [];
$fallback = weiboResolve($target, sequence([reply($component), reply('Forbidden', 403)], $calls));
expect('detail failure retains independently playable component', $fallback['code'] === 200 && $fallback['data']['quality'] === '1080p' && !isset($fallback['data']['codec']));
expect('component comma counts normalized and source date retained', $fallback['data']['extra']['statistics']['play_count'] === 1304 && $fallback['data']['create_time'] === 1788630795);
$calls = [];
$fallback = weiboResolve($target, sequence([$visitor, $guest, $cookie, reply($component), $visitor], $calls));
expect('second endpoint cannot start another guest loop', $fallback['code'] === 200 && count($calls) === 5);
expect('empty media remains a business failure', formatWeiboResponse(['code' => 100000, 'data' => ['Component_Play_Playinfo' => ['title' => 'empty', 'urls' => []]]])['code'] === 404);
expect('upstream business denial is not declared nonexistent', formatWeiboResponse(['code' => 403, 'msg' => 'no permission'])['code'] === 503);
expect('empty status JSON is not mistaken for a missing video', formatWeiboStatusResponse([])['code'] === 502);
expect('malformed nested media shapes fail without warnings', formatWeiboResponse(['code' => 100000, 'data' => ['Component_Play_Playinfo' => ['urls' => 'unexpected']]])['code'] === 404);
expect('only explicit source dimensions used', !isset(weiboCandidate('https://media.example/file.mp4', '1080p')['width']));
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'weibo-session-contract', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
