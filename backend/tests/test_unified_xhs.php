<?php
declare(strict_types=1);
require_once __DIR__ . '/../api/xiaohongshu/XiaohongshuParser.php';

$checks = [];
function xhsCheck(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
function xhsPage(array $note): string {
    return '<script type="text/javascript">window.__INITIAL_STATE__=' . json_encode(['note' => ['noteDetailMap' => ['fixture01' => ['note' => $note]]]], JSON_UNESCAPED_SLASHES) . ';</script>';
}
$input = 'https://www.rednote.com/explore/fixture01?xsec_token=fixture%2Btoken%2Fvalue%3D&xsec_source=pc_feed';
$note = ['noteId' => 'fixture01', 'type' => 'video', 'title' => 'undefined is title text', 'imageList' => [['url' => 'https://image.example.test/cover.jpg']],
    'video' => ['media' => ['stream' => [
        'h264' => [['masterUrl' => 'https://cdn.example.test/720.mp4', 'backupUrls' => ['https://backup.example.test/720.mp4'], 'width' => 1280, 'height' => 720, 'duration' => 10000, 'avgBitrate' => 900000]],
        'h265' => [['masterUrl' => 'https://cdn.example.test/hevc.mp4', 'width' => 1920, 'height' => 1080]],
        'av1' => [['masterUrl' => 'https://cdn.example.test/av1.mp4', 'width' => 1920, 'height' => 1080]],
    ]], 'mediaV2' => json_encode(['video' => ['width' => 7680, 'height' => 4320], 'opaque1' => [
        'hd_screencast_stream' => ['master_url' => 'https://cdn.example.test/hd.mp4', 'width' => 1920, 'height' => 1080, 'video_codec' => 'hevc'],
        'default_screencast_stream' => ['master_url' => 'https://cdn.example.test/720.mp4', 'backup_urls' => ['https://third.example.test/720.mp4']],
    ]]), 'consumer' => ['originVideoKey' => 'spectrum/synthetic-fixture']]];
$calls = []; $probeCalls = [];
$parser = new XiaohongshuParser(function (string $url) use (&$calls, $note): array {
    $calls[] = $url;
    return ['status' => 200, 'url' => $url, 'body' => xhsPage($note)];
}, function (string $url, float $deadline) use (&$probeCalls): array {
    $probeCalls[] = $url;
    if (str_contains($url, '-qn.')) return ['result' => null, 'http_status' => 403];
    return ['http_status' => 206, 'result' => ['metadata' => ['width' => 3840, 'height' => 2160, 'codec' => 'h264', 'bit_rate' => 50000000, 'duration' => 10, 'size' => 63000000, 'metadata_source' => 'mp4', 'container' => 'mov', 'mime_type' => 'video/quicktime']]];
});
$parsed = json_decode($parser->parse($input), true);
$data = $parsed['data']; $all = $data['video_candidates']; $original = $all[count($all) - 1];
xhsCheck('rednote explore is requested directly with signed query bytes unchanged', $calls === [$input]);
xhsCheck('all codec and mediaV2 representations survive with stream duplicate merged', count($all) === 5);
xhsCheck('same-stream backups are retained across mediaV2 duplication', count($all[0]['sources']) === 3);
xhsCheck('measured original coexists with 720p rather than fallback-only extraction', $all[0]['width'] === 1280 && $original['width'] === 3840 && $original['height'] === 2160);
xhsCheck('a failed origin CDN does not discard the next source', count($probeCalls) === 2 && $original['sources'][0]['availability'] === 'unavailable' && $original['sources'][1]['availability'] === 'available');
xhsCheck('all origin CDN candidates stay available for declared equivalent-source handling', count($original['sources']) === 4 && str_contains($original['url'], '-al.'));
xhsCheck('actual QuickTime container and MIME survive probing', $original['container'] === 'mov' && $original['mime_type'] === 'video/quicktime');
xhsCheck('source upload dimensions are never borrowed by candidates', count(array_filter($all, fn ($c) => ($c['width'] ?? 0) === 7680)) === 0);
xhsCheck('video cover is not an independent album image', $data['images'] === [] && $data['cover'] === 'https://image.example.test/cover.jpg');
xhsCheck('string title containing undefined is untouched', $data['title'] === 'undefined is title text');
xhsCheck('duration from stream is converted from milliseconds exactly once', $all[0]['duration'] === 10);
$fromXhs = json_decode($parser->parse(str_replace('www.rednote.com', 'www.xiaohongshu.com', $input)), true);
xhsCheck('xiaohongshu link checks rednote desktop first without re-encoding query', $calls[count($calls)-1] === $input && $fromXhs['code'] === 200);
$discovery = str_replace('/explore/', '/discovery/item/', $input);
$parser->parse($discovery);
xhsCheck('rednote discovery is not misclassified as a short link', $calls[count($calls)-1] === $discovery);

$unmeasured = new XiaohongshuParser(fn ($url) => ['status' => 200, 'url' => $url, 'body' => xhsPage($note)], fn () => []);
$unknown = json_decode($unmeasured->parse($input), true)['data']['video_candidates'];
$unknown = $unknown[count($unknown)-1];
xhsCheck('unmeasured origin retains unknown dimensions despite source metadata', !isset($unknown['width'], $unknown['height'], $unknown['bit_rate']) && $unknown['is_original']);
$unavailable = new XiaohongshuParser(fn ($url) => ['status' => 200, 'url' => $url, 'body' => xhsPage($note)], fn () => ['result' => null, 'http_status' => 403]);
$denied = json_decode($unavailable->parse($input), true)['data']['video_candidates'];
xhsCheck('all explicitly failed CDNs retain individual unavailable states', array_column($denied[count($denied)-1]['sources'], 'availability') === array_fill(0,4,'unavailable'));
$empty = new XiaohongshuParser(fn ($url) => ['status' => 200, 'url' => $url, 'body' => '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{}}};</script>']);
xhsCheck('HTTP200 empty note map is an explicit failure', json_decode($empty->parse($input),true)['code'] === 404);
$network = new XiaohongshuParser(fn ($url) => ['status' => 0, 'url' => $url, 'body' => '']);
xhsCheck('transport failure does not masquerade as a missing note', json_decode($network->parse($input),true)['code'] === 502);
$js = substr(xhsPage($note), 0, -strlen('};</script>')) . ',"set":new Set([]),"map":new Map([]),"none":undefined};</script>';
$jsParser = new XiaohongshuParser(fn ($url) => ['status'=>200,'url'=>$url,'body'=>$js], fn()=>[]);
xhsCheck('empty JS Set Map and undefined are normalized without evaluation', json_decode($jsParser->parse($input),true)['code'] === 200);

$album = ['noteId'=>'fixture01','type'=>'normal','imageList'=>[
    ['url'=>'https://images.example.test/first.jpg','stream'=>['h264'=>[['masterUrl'=>'https://cdn.example.test/live.mp4','width'=>1080,'height'=>1920]]]],
    ['url'=>'https://images.example.test/second.jpg'],
]];
$albumParser = new XiaohongshuParser(fn($url)=>['status'=>200,'url'=>$url,'body'=>xhsPage($album)],fn()=>[]);
$mixed = json_decode($albumParser->parse($input),true)['data'];
xhsCheck('mixed static and live photos retain original image order and pair identity', count($mixed['images'])===2 && $mixed['live_photo'][0]['image']===$mixed['images'][0] && $mixed['type']==='live');
xhsCheck('live motion representations remain available to unified adapter', count($mixed['live_photo'][0]['video_candidates'])===1);
foreach (['qn','al','qc','bd'] as $cdn) xhsCheck('allow origin CDN '.$cdn, XiaohongshuMediaProbe::allowedUrl('https://sns-video-'.$cdn.'.xhscdn.com/spectrum/fixture'));
foreach (['https://user@sns-video-qn.xhscdn.com/spectrum/f','https://sns-video-qn.xhscdn.com.evil.test/spectrum/f','https://127.0.0.1/f','http://sns-video-qn.xhscdn.com/f','https://sns-video-qn.xhscdn.com/../f'] as $url) xhsCheck('reject unsafe origin media '.parse_url($url,PHP_URL_HOST), !XiaohongshuMediaProbe::allowedUrl($url));

$originEntry = 'https://sns-video-qn.xhscdn.com/spectrum/fixture';
$redirectedCdn = 'https://edge-a.example.net/original.mov';
$container = pack('N', 20) . 'ftypqt  ' . pack('N', 0) . 'qt  ' . pack('N', 8) . 'free';
$mediaRequests = [];
$mediaProbe = new XiaohongshuMediaProbe(static function (string $url, int $offset, int $length) use ($originEntry, $redirectedCdn, $container, &$mediaRequests): array {
    $mediaRequests[] = $url;
    if ($url === $originEntry) return ['status' => 302, 'headers' => ['location' => $redirectedCdn], 'body' => ''];
    $body = substr($container, $offset, $length);
    return ['status' => 206, 'headers' => ['content-type' => 'video/quicktime',
        'content-range' => 'bytes ' . $offset . '-' . ($offset + strlen($body) - 1) . '/' . strlen($container)], 'body' => $body];
});
$redirected = $mediaProbe->inspect($originEntry, microtime(true) + 6);
xhsCheck('trusted original entry can redirect to a public CDN outside the entry list', $redirected['result']['url'] === $redirectedCdn
    && $redirected['http_status'] === 206 && $mediaRequests[0] === $originEntry && count($mediaRequests) >= 2
    && array_unique(array_slice($mediaRequests, 1)) === [$redirectedCdn]);
xhsCheck('redirect does not invent unmeasured dimensions or change deferred scope', $redirected['result']['metadata'] === []);
$mediaRequests = [];
xhsCheck('a redirected CDN cannot be supplied as an initial XHS entry', $mediaProbe->inspect($redirectedCdn, microtime(true) + 6)['result'] === null && $mediaRequests === []);

$failed = array_filter($checks, fn ($check) => !$check['passed']);
echo json_encode(['suite'=>'unified-xhs','evidence'=>'synthetic offline fixtures, not live platform acceptance','passed'=>count($checks)-count($failed),'total'=>count($checks),'checks'=>$checks], JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
exit($failed ? 1 : 0);
