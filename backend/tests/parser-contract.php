<?php
declare(strict_types=1);
// Each legacy parser has global helper names, so execute fixtures in separate processes.
define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
$suite = $argv[1] ?? '';
$checks = [];
function expect(string $name, bool $passed): void { global $checks; $checks[] = ['name' => $name, 'passed' => $passed]; }

switch ($suite) {
case 'douyin':
    require __DIR__ . '/../api/douyin/DouyinParser.php';
    $parser = new DouyinParser();
    $format = new ReflectionMethod($parser, 'formatData');
    $source = ['desc' => 'Quality fixture', 'create_time' => 1786603757,
        'statistics' => ['digg_count' => 0, 'comment_count' => 12, 'aweme_id' => '1'],
        'text_extra' => [['hashtag_name' => '旅行'], ['hashtag_name' => '旅行']],
        'cha_list' => [['cha_name' => '记录']], 'video_tag' => [['tag_name' => '生活']],
        'video' => ['duration' => 2000, 'play_addr' => ['uri' => 'fixture-id'], 'bit_rate' => [
            ['bit_rate' => 8000000, 'is_h265' => 0, 'play_addr' => ['width' => 720, 'height' => 1280, 'url_list' => ['https://media.example/720.mp4']]],
            ['bit_rate' => 3000000, 'is_h265' => 1, 'play_addr' => ['width' => 2160, 'height' => 3840, 'data_size' => 123456, 'url_list' => ['https://media.example/4k.mp4', 'https://mirror.example/4k.mp4']]],
        ]]];
    $result = json_decode($format->invoke($parser, $source, '1234567890123456'), true);
    $data = $result['data'];
    expect('4K remains main despite larger bitrate low resolution and original fallback', str_starts_with($data['url'], 'https://media.example/4k.mp4'));
    expect('main metadata describes selected source', $data['width'] === 2160 && $data['height'] === 3840 && $data['bit_rate'] === 3000000 && $data['codec'] === 'hevc' && $data['size'] === 123456);
    expect('original is not an unconditional quality label', $data['quality'] === '2160p');
    expect('all alternate candidates retained as objects', count($data['video_backup']) === 3 && isset($data['video_backup'][0]['url']));
    expect('backup metadata belongs to that quality', $data['video_backup'][1]['width'] === 720 && $data['video_backup'][1]['codec'] === 'h264');
    expect('source zero statistics preserved, IDs not treated as counters', $data['extra']['statistics'] === ['digg_count' => 0, 'comment_count' => 12]);
    expect('hashtags and tags preserved without duplicates', $data['extra']['hashtags'] === ['旅行', '记录'] && $data['extra']['video_tags'] === ['生活']);
    expect('publish timestamp retained', $data['create_time'] === 1786603757 && $data['publish_time'] === '2026-08-13 14:49:17');
    $fallback = json_decode($format->invoke($parser, ['video' => ['play_addr' => ['url_list' => ['https://media.example/unknown.mp4']]]], '1'), true)['data'];
    expect('missing metadata not invented', !isset($fallback['width'], $fallback['codec'], $fallback['bit_rate']) && $fallback['quality'] === 'unknown');
    expect('missing statistics remain absent', !isset($fallback['extra']['statistics']));
    break;
case 'pipigx':
    require __DIR__ . '/../api/pipigx.php';
    expect('encoded outer gateway URL does not destroy inner parameters', extractParamsFromUrl('https://h5.pipigx.com/pp/post?pid=123&mid=456') === ['pid' => '123', 'mid' => '456']);
    expect('array parameters rejected', extractParamsFromUrl('https://h5.pipigx.com/pp/post?pid[]=123&mid=456') === false);
    expect('nonnumeric parameters rejected', extractParamsFromUrl('https://h5.pipigx.com/pp/post?pid=oops&mid=456') === false);
    $response = processApiResponse(['code' => 200, 'response' => json_encode(['data' => ['post' => ['content' => 'fixture', 'videos' => [['url' => 'https://media.example/pipi.mp4', 'thumb' => '123']]]]])]);
    expect('video normalized to url', $response['code'] === 200 && $response['data']['url'] === 'https://media.example/pipi.mp4');
    expect('empty media is business failure', processApiResponse(['code' => 200, 'response' => '{"data":{"post":{"content":"missing"}}}'])['code'] === 404);
    expect('transport error does not access missing response', processApiResponse(['code' => 500, 'msg' => 'transport'])['code'] === 500);
    break;
case 'bilibili':
    require __DIR__ . '/../api/bilibili/bilibili.php';
    $pages = [];
    for ($i = 1; $i <= 10; $i++) { $pages[] = ['page' => $i, 'cid' => 100 + $i, 'part' => 'P' . $i, 'duration' => 120]; }
    $calls = [];
    $result = buildBilibiliResponse(['title' => 'fixture', 'pages' => $pages], 'BV1234567890', 2, function ($cid) use (&$calls) {
        $calls[] = $cid;
        return ['code' => 0, 'data' => ['durl' => [['url' => 'https://source.example/p2.mp4', 'backup_url' => ['https://mirror.example/p2.mp4']]]]];
    });
    $data = $result['data'];
    expect('only requested part fetched', $calls === [102]);
    expect('top level URL is requested P2 not last P', $data['url'] === 'https://source.example/p2.mp4' && $data['extra']['current_page'] === 2);
    expect('other parts carry lazy resolution identity', $data['videos'][9]['url'] === '' && $data['videos'][9]['cid'] === '110' && $data['videos'][9]['lazyResolve'] && str_ends_with($data['videos'][9]['pageUrl'], '?p=10'));
    expect('source host and backup retained', $data['video_backup'][0]['url'] === 'https://mirror.example/p2.mp4');
    expect('duration not reduced by a second', $data['videos'][0]['durationFormat'] === '00:02:00');
    $failed = buildBilibiliResponse(['pages' => $pages], 'BV1234567890', 2, fn ($cid) => ['code' => -1]);
    expect('failed target never substitutes another part', $failed['code'] === 404 && !isset($failed['data']['url']));
    expect('invalid part never triggers play call', buildBilibiliResponse(['pages' => $pages], 'BV1234567890', 11, fn () => throw new Exception('not called'))['code'] === 404);
    expect('query p survives cleaning', cleanUrlParameters('https://www.bilibili.com/video/BV1234567890/?p=2&x=a%26b') === 'https://www.bilibili.com/video/BV1234567890/?p=2&x=a%26b');
    expect('short-link target p preserved', bilibiliRedirectTarget('https://b23.tv/example', 'https://www.bilibili.com/video/BV1234567890?p=3') === 'https://www.bilibili.com/video/BV1234567890?p=3');
    expect('explicit short-link p wins', bilibiliRedirectTarget('https://b23.tv/example?p=2', 'https://www.bilibili.com/video/BV1234567890?p=3') === 'https://www.bilibili.com/video/BV1234567890?p=2');
    ob_start(); $missing = extractBilibiliBVId(false); $noise = ob_get_clean();
    expect('failed HTML ID extraction never pollutes JSON', $missing === null && $noise === '');
    break;
case 'zuiyou':
    require __DIR__ . '/../api/zuiyou.php';
    expect('empty post cannot return successful empty media', zuiyouResponse(['data' => ['post' => []]])['code'] === 404);
    expect('missing video cannot overwrite error with 200', zuiyouResponse(['data' => ['post' => ['content' => 'missing', 'imgs' => [['id' => 1]], 'videos' => [1 => ['url' => '']]]]])['code'] === 404);
    $data = zuiyouResponse(['data' => ['post' => ['content' => 'video', 'imgs' => [['id' => 42]], 'videos' => [42 => ['url' => 'http://media.example/original.mp4']]]]]);
    expect('real source URL is preserved', $data['code'] === 200 && $data['data']['url'] === 'http://media.example/original.mp4');
    $images = zuiyouResponse(['data' => ['post' => ['imgs' => [['urls' => ['origin' => ['urls' => ['https://media.example/image.jpg']]]]]]]]);
    expect('image-only post exposes images', $images['code'] === 200 && $images['data']['type'] === 'image' && $images['data']['images'] === ['https://media.example/image.jpg']);
    expect('query arrays are rejected safely', getParamFromUrl('https://share.izuiyou.com/post?pid[]=1', 'pid') === null);
    break;
case 'weibo':
    require __DIR__ . '/../api/weibo.php';
    $response = formatWeiboResponse(['code' => 100000, 'data' => ['Component_Play_Playinfo' => [
        'title' => 'fixture', 'avatar' => '//images.example/avatar.jpg', 'cover_image' => 'https://images.example/cover.jpg',
        'urls' => ['720P' => '//media.example/720.mp4', '1080P' => 'https://media.example/1080.mp4'],
    ]]]);
    expect('avatar uses direct URL not missing proxy plus base64', $response['data']['author']['avatar'] === 'https://images.example/avatar.jpg');
    expect('absolute cover is not double-prefixed', $response['data']['cover'] === 'https://images.example/cover.jpg');
    expect('highest advertised stream stays selected', $response['data']['url'] === 'https://media.example/1080.mp4');
    expect('empty source is business failure', formatWeiboResponse(['code' => 100000, 'data' => ['Component_Play_Playinfo' => ['title' => 'missing', 'urls' => []]]])['code'] === 404);
    break;
default:
    throw new InvalidArgumentException('Unknown parser fixture suite');
}
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => $suite, 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
