<?php
declare(strict_types=1);
/** Actual parser extraction + actual adapter; synthetic inputs, never live acceptance.
 * Run one platform per process because upstream helpers have overlapping names.
 */
define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
require_once __DIR__ . '/../lib/gateway.php';
$platform = $argv[1] ?? 'douyin';
$sourceUrl = 'https://' . snapPlatforms()[$platform]['domains'][0] . '/fixture';
$cdn = 'https://media.example.test/';
switch ($platform) {
    case 'douyin':
        require __DIR__ . '/../api/douyin/DouyinParser.php';
        $parser = new DouyinParser(static fn () => null);
        $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser, ['desc' => 'Synthetic video', 'video' => ['duration' => 500, 'bit_rate' => [
            ['bit_rate' => 3000000, 'is_h265' => 1, 'play_addr' => ['width' => 2160, 'height' => 3840, 'url_list' => [$cdn . '4k.mp4', $cdn . '4k-mirror.mp4']]],
            ['bit_rate' => 8000000, 'play_addr' => ['width' => 720, 'height' => 1280, 'url_list' => [$cdn . '720.mp4']]],
        ]]], '1234567890123456'), true);
        break;
    case 'kuaishou':
        require __DIR__ . '/../api/kuaishou/KuaishouSpider.php';
        $parser = new KuaishouSpider('', 'fixture');
        $photo = ['photoType' => 'VIDEO', 'caption' => 'Synthetic video', 'mainMvUrls' => [['url' => $cdn . 'main.mp4']], 'manifest' => ['adaptationSet' => [['representation' => [
            ['url' => $cdn . '1080.mp4', 'backupUrl' => [$cdn . '1080-mirror.mp4'], 'width' => 1920, 'height' => 1080, 'codec' => 'h264', 'avgBitrate' => 3000000],
            ['url' => $cdn . '720.mp4', 'width' => 1280, 'height' => 720],
        ]]]]];
        $raw = (new ReflectionMethod($parser, 'extractFromInitState'))->invoke($parser, '<script>window.INIT_STATE=' . json_encode(['tusjoh-fixture' => ['photo' => $photo]]) . ';</script>');
        break;
    case 'bilibili':
        require __DIR__ . '/../api/bilibili/bilibili.php';
        $sourceUrl = 'https://www.bilibili.com/video/BV1234567890/?p=1';
        $raw = buildBilibiliResponse(['title' => 'Synthetic multipart', 'pages' => [['page' => 1, 'cid' => 1], ['page' => 2, 'cid' => 2]], 'ugc_season' => ['sections' => [['title' => 'Collection', 'episodes' => [['bvid' => 'BV1234567890'], ['bvid' => 'BV1234567891']]]]]], 'BV1234567890', 1,
            static fn () => ['code' => 0, 'data' => ['quality' => 64, 'durl' => [['url' => $cdn . '720.mp4']], 'dash' => ['video' => [['id' => 120, 'baseUrl' => $cdn . '4k.m4s', 'width' => 3840, 'height' => 2160, 'codecs' => 'avc1', 'bandwidth' => 8000000]], 'audio' => [['id' => 30280, 'baseUrl' => $cdn . 'audio.m4s', 'codecs' => 'mp4a', 'bandwidth' => 128000]]]]]);
        break;
    case 'xiaohongshu':
        require __DIR__ . '/../api/xiaohongshu/XiaohongshuParser.php';
        $parser = new XiaohongshuParser(null, static fn (string $url) => ['http_status' => 206, 'result' => ['metadata' => ['width' => 3840, 'height' => 2160, 'codec' => 'h264', 'size' => 60000000, 'duration' => 10, 'bit_rate' => 48000000, 'metadata_source' => 'mp4', 'container' => 'mov', 'mime_type' => 'video/quicktime']]]);
        $note = ['type' => 'video', 'title' => 'Synthetic original', 'video' => ['media' => ['stream' => ['h264' => [['masterUrl' => $cdn . '720.mp4', 'width' => 1280, 'height' => 720]]]], 'consumer' => ['originVideoKey' => 'spectrum/synthetic-fixture']]];
        $raw = ['code' => 200, 'data' => (new ReflectionMethod($parser, 'formatNoteData'))->invoke($parser, $note)];
        break;
    case 'toutiao':
        require __DIR__ . '/../api/toutiao.php';
        $video = ['title' => 'Synthetic video', 'videoPlayInfo' => ['video_duration' => 10, 'video_list' => [['main_url' => base64_encode($cdn . '720.mp4'), 'backup_url' => $cdn . '720-mirror.mp4', 'video_meta' => ['vwidth' => 1280, 'vheight' => 720, 'real_bitrate' => 1000000, 'codec_type' => 'h264']]]]];
        $raw = toutiaoResponseFromPage('<script id="RENDER_DATA">' . rawurlencode(json_encode(['data' => ['itemId' => '123456789', 'initialVideo' => $video]])) . '</script>', '123456789');
        break;
    case 'weibo':
        require __DIR__ . '/../api/weibo.php';
        $raw = formatWeiboResponse(['code' => 100000, 'data' => ['Component_Play_Playinfo' => ['title' => 'Synthetic video', 'urls' => ['720P' => 'https://f.video.weibocdn.com/720.mp4', '1080P' => 'https://f.video.weibocdn.com/1080.mp4']]]]);
        break;
    case 'pipixia':
        require __DIR__ . '/../api/ppxia.php';
        $raw = pipixiaItemResponse(['item_id' => '123456789', 'content' => 'Synthetic video', 'video' => ['video_high' => ['url_list' => [['url' => $cdn . '1080.mp4']], 'width' => 1920, 'height' => 1080]]], '123456789');
        break;
    case 'pipigx':
        require __DIR__ . '/../api/pipigx.php';
        $raw = processApiResponse(['code' => 200, 'response' => json_encode(['data' => ['post' => ['content' => 'Synthetic videos', 'videos' => [['url' => $cdn . 'one.mp4'], ['url' => $cdn . 'two.mp4']]]]])]);
        break;
    case 'zuiyou':
        require __DIR__ . '/../api/zuiyou.php';
        $raw = zuiyouResponse(['data' => ['post' => ['content' => 'Synthetic videos', 'videos' => [['url' => $cdn . 'one.mp4'], ['url' => $cdn . 'two.mp4']]]]]);
        break;
    default: throw new InvalidArgumentException('Unknown registered platform');
}
$payload = snapAdaptParser($platform, $raw, $sourceUrl);
if ($platform === 'weibo') [, $payload] = snapPreparePublicMedia($platform, $payload, 200, str_repeat('fixture-only-key-', 3));
snapValidateEnvelope($payload);
echo json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
