<?php
declare(strict_types=1);
// Synthetic upstream records through actual formatters/adapters. No network IO.
require_once __DIR__ . '/../lib/gateway.php';
require_once __DIR__ . '/../api/douyin/DouyinParser.php';

function policyDouyinFixture(string $mode = 'normal', string $signature = 'before'): array
{
    $rates = [];
    if ($mode !== 'unavailable') $rates[] = ['format' => 'mp4', 'fps' => 30, 'hdr_type' => 'sdr', 'has_audio' => true,
        'video_extra' => json_encode(['file_id' => 'complete-file', 'audio_channels' => 2]),
        'play_addr' => ['uri' => 'complete-uri', 'file_hash' => hash('md5', 'complete-file'), 'width' => 3840, 'height' => 2160, 'url_list' => [
            'https://www.douyin.com/aweme/v1/play/?file_id=complete-file&line=0&sign=' . $signature,
            'https://www.douyin.com/aweme/v1/play/?file_id=complete-file&line=1&sign=' . $signature,
        ]]];
    foreach (['audio-main', 'audio-alt'] as $audioId) $rates[] = ['format' => 'dash', 'fps' => $mode === 'protected' ? 60 : 30,
        'hdr_type' => $mode === 'protected' ? 'hdr10' : 'sdr',
        'video_extra' => json_encode(['file_id' => 'video-track', 'audio_file_id' => $audioId]),
        'play_addr' => ['uri' => 'track-uri', 'file_hash' => hash('md5', 'video-track'), 'width' => 3840, 'height' => 2160,
            'url_list' => ['https://www.douyin.com/aweme/v1/play/dash/?file_id=video-track&sign=' . $signature]]];
    $audio = [];
    foreach (['audio-main', 'audio-alt'] as $audioId) $audio[] = ['audio_meta' => ['file_id' => $audioId, 'media_type' => 'audio',
        'url_list' => ['https://media.example/' . $audioId . '.m4a'],
        'sub_info' => json_encode(['audio_channels' => 2, 'audio_language' => 'en', 'audio_profile' => 'aac', 'audio_sample_rate' => 48000])]];
    $parser = new DouyinParser(static fn () => null);
    $raw = json_decode((new ReflectionMethod($parser, 'formatData'))->invoke($parser,
        ['desc' => 'Synthetic policy fixture', 'video' => ['bit_rate' => $rates, 'bit_rate_audio' => $audio, 'cdn_url_expired' => time() + ($signature === 'before' ? 600 : 1800)]],
        '7628438784602389247'), true);
    return snapAdaptParser('douyin', $raw, 'https://www.douyin.com/video/7628438784602389247');
}

function policyBilibiliFixture(bool $hdr = false): array
{
    $play = ['width' => 3840, 'height' => 2160, 'durl' => [['url' => 'https://media.example/full.mp4']],
        'dash' => ['video' => [['id' => $hdr ? 125 : 120, 'baseUrl' => 'https://media.example/video.m4s', 'width' => 3840, 'height' => 2160, 'frameRate' => $hdr ? '60000/1001' : '30']],
            'audio' => [
                ['id' => 30280, 'baseUrl' => 'https://media.example/audio-en.m4a', 'channels' => 2, 'lang' => 'en', 'language_role' => 'main'],
                ['id' => 30281, 'baseUrl' => 'https://media.example/audio-ja.m4a', 'channels' => 6, 'lang' => 'ja', 'language_role' => 'alternate'],
            ]]];
    return snapAdaptParser('bilibili', ['code' => 200, 'data' => ['title' => 'Synthetic Bilibili policy', 'private_play' => $play,
        'extra' => ['bvid' => 'BV1boV66YErZ', 'current_page' => 1, 'pages' => [['page' => 1]]]]], 'https://www.bilibili.com/video/BV1boV66YErZ/');
}

/** Exercise source rejection/signing before filtering, without fetching media. */
function policyWeiboFixture(string $mode = 'normal'): array
{
    $payload = policyDouyinFixture();
    $payload['data']['platform'] = 'weibo';
    foreach ($payload['data']['items'] as &$item) foreach ($item['variants'] as &$variant) {
        $isFile = $variant['delivery']['kind'] === 'file';
        $variant['delivery'] = snapMapDeliverySources($variant['delivery'], static function (array $source) use ($mode, $isFile): array {
            $host = $isFile && $mode === 'rejected' ? 'other.example' : 'f.video.weibocdn.com';
            $source['url'] = 'https://' . $host . '/fixture-' . ($source['id'] ?? hash('sha256', $source['url'])) . '.mp4';
            if ($isFile && $mode === 'expired') $source['expires_at'] = gmdate('c', time() - 60);
            return $source;
        });
    }
    unset($item, $variant);
    return snapFinalizeData($payload['data']);
}
