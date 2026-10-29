<?php
declare(strict_types=1);
require_once __DIR__ . '/../api/douyin/DouyinParser.php';
$checks = [];
function check(string $name, bool $passed): void { global $checks; $checks[] = ['name' => $name, 'passed' => $passed]; }
function box(string $type, string $payload): string { return pack('N', strlen($payload) + 8) . $type . $payload; }
function movie(int $width = 2160, int $height = 3840, string $codec = 'hvc1', int $sampleSize = 500000, int $version = 0, bool $variable = false): string
{
    $entry = str_repeat("\0", 78); $entry = substr_replace($entry, pack('nn', $width, $height), 24, 4);
    $stsd = box('stsd', pack('NN', 0, 1) . box($codec, $entry));
    $stsz = box('stsz', pack('NNN', 0, $variable ? 0 : $sampleSize, 10) . ($variable ? str_repeat(pack('N', $sampleSize), 10) : ''));
    $mdhd = $version === 0 ? pack('NNNNN', 0, 0, 0, 1000, 10000) : pack('N*', 0x01000000, 0, 0, 0, 0, 1000, 0, 10000);
    $mdia = box('mdia', box('mdhd', $mdhd) . box('hdlr', str_repeat("\0", 8) . 'vide') . box('minf', box('stbl', $stsd . $stsz)));
    return box('moov', box('trak', $mdia));
}
$original = 'https://aweme.snssdk.com/aweme/v1/play/?video_id=fixture&ratio=default&line=0';
$cdn = 'https://v5-test.douyinvod.com/fixture.mp4';
$ftyp = box('ftyp', 'isom' . pack('N', 0) . 'isom');
$moov = movie();
$metadata = SnapDouyinMediaProbe::metadata($moov, 6000000);
check('video sample bytes and duration produce a measured bitrate', $metadata === ['width' => 2160, 'height' => 3840, 'codec' => 'hevc', 'duration' => 10.0, 'bit_rate' => 4000000, 'size' => 6000000, 'metadata_source' => 'mp4']);
check('variable sample sizes and version 1 duration are supported', SnapDouyinMediaProbe::metadata(movie(1920, 1080, 'avc1', 100000, 1, true), 6000000)['bit_rate'] === 800000);
check('truncated movie does not invent metadata', SnapDouyinMediaProbe::metadata(substr($moov, 0, -1), 6000000) === null);
check('sample byte count cannot exceed file size', SnapDouyinMediaProbe::metadata($moov, 1000) === null);
check('unsupported codec stays unknown', SnapDouyinMediaProbe::metadata(movie(2160, 3840, 'zzzz'), 6000000) === null);
check('invalid dimensions stay unknown', SnapDouyinMediaProbe::metadata(movie(0), 6000000) === null);
check('multiple video tracks are not guessed', SnapDouyinMediaProbe::metadata(box('moov', substr($moov, 8) . substr($moov, 8)), 6000000) === null);
check('malformed child size rejected', SnapDouyinMediaProbe::metadata(box('moov', pack('N', 4) . 'trak'), 6000000) === null);
$extended = pack('N', 1) . 'moov' . pack('NN', 0, strlen($moov) + 8) . substr($moov, 8);
check('extended-size movie atom supported', SnapDouyinMediaProbe::metadata($extended, 6000000) === $metadata);
check('unsafe extended size rejected without integer overflow', SnapDouyinMediaProbe::metadata(pack('N', 1) . 'moov' . pack('NN', 0xffffffff, 0xffffffff), 6000000) === null);

foreach ([$original, $cdn, 'https://v11-o.douyinvod.com/a', 'https://v5-hl-mly-ov.zjcdn.com/a'] as $url) check('allow official media host ' . parse_url($url, PHP_URL_HOST), SnapDouyinMediaProbe::allowedUrl($url));
foreach (['http://v5-test.douyinvod.com/a', 'https://v5-test.douyinvod.com:444/a', 'https://v5-test.douyinvod.com.evil.test/a', 'https://evil.douyinvod.com/a', 'https://127.0.0.1/a', 'https://user@v5-test.douyinvod.com/a', 'https://v5-test.douyinvod.com/a#fragment', 'https://aweme.snssdk.com/other', "https://v5-test.douyinvod.com/\na"] as $url) check('reject unsafe URL ' . str_replace("\n", '', $url), !SnapDouyinMediaProbe::allowedUrl($url));
check('public IPv4 resolution accepted', SnapDouyinMediaProbe::resolve('v5-test.douyinvod.com', fn () => ['1.1.1.1']) === '1.1.1.1');
foreach ([['127.0.0.1'], ['10.0.0.1'], ['1.1.1.1', '192.168.0.1'], ['::1'], ['::ffff:127.0.0.1'], ['2001:db8::1'], []] as $ips) check('reject private/mixed/empty DNS answers ' . implode(',', $ips), SnapDouyinMediaProbe::resolve('v5-test.douyinvod.com', fn () => $ips) === null);

// A synthetic container with a large mdat and trailing moov exercises random access:
// the transport only supplies requested slices; the entire media is never fetched.
$file = $ftyp . box('mdat', str_repeat('x', 6000000)) . $moov;
$reads = []; $received = 0;
$transport = static function (string $url, int $offset, int $length) use ($original, $cdn, $file, &$reads, &$received): array {
    $reads[] = [$url, $offset, $length];
    if ($url === $original) return ['status' => 302, 'headers' => ['location' => $cdn], 'body' => ''];
    $body = substr($file, $offset, $length); $received += strlen($body);
    return ['status' => 206, 'headers' => ['content-type' => 'video/mp4', 'content-range' => 'bytes ' . $offset . '-' . ($offset + strlen($body) - 1) . '/' . strlen($file)], 'body' => $body];
};
$result = (new SnapDouyinMediaProbe($transport))->probe($original);
check('original resolves to final CDN and measured video metadata', $result['url'] === $cdn && $result['metadata']['width'] === 2160 && $result['metadata']['bit_rate'] === 4000000);
check('large mdat skipped and trailing moov read within byte/request budget', $received < 70000 && count($reads) <= 5 && array_filter($reads, fn ($read) => $read[1] === strlen($ftyp) + 6000008));
check('every request has a finite range', !array_filter($reads, fn ($read) => $read[2] < 1 || $read[2] > SnapDouyinMediaProbe::MAX_BYTES));
$unavailableCdn = 'https://v7-test.douyinvod.com/unavailable.mp4';
$redirectFailure = (new SnapDouyinMediaProbe(static function ($url, $offset, $length) use ($cdn, $unavailableCdn, $transport): ?array {
    if ($url === $unavailableCdn) return null;
    if ($offset > 0) return ['status' => 302, 'headers' => ['location' => $unavailableCdn], 'body' => ''];
    return $transport($cdn, $offset, $length);
}))->probe($cdn);
check('failed later redirect preserves last successfully read CDN URL', $redirectFailure['url'] === $cdn && $redirectFailure['metadata'] === []);
$unsafeCalls = 0;
$badRedirect = new SnapDouyinMediaProbe(static function () use (&$unsafeCalls): array { $unsafeCalls++; return ['status' => 302, 'headers' => ['location' => 'https://127.0.0.1/admin'], 'body' => '']; });
check('unsafe redirect stops before second request', $badRedirect->probe($original) === null && $unsafeCalls === 1);
$loops = 0;
$loop = new SnapDouyinMediaProbe(static function () use (&$loops, $cdn): array { $loops++; return ['status' => 302, 'headers' => ['location' => $cdn], 'body' => '']; });
check('redirect loop is bounded', $loop->probe($original) === null && $loops === 4);
$upgradedUrls = [];
$upgraded = (new SnapDouyinMediaProbe(static function ($url, $offset, $length) use (&$upgradedUrls, $original, $cdn, $transport): array {
    $upgradedUrls[] = $url;
    return $url === $original ? ['status' => 302, 'headers' => ['location' => str_replace('https:', 'http:', $cdn)], 'body' => ''] : $transport($url, $offset, $length);
}))->probe($original);
check('legacy HTTP redirect upgraded to HTTPS before any CDN request', $upgraded['metadata']['width'] === 2160 && !array_filter($upgradedUrls, fn ($url) => !str_starts_with($url, 'https://')));
check('unavailable media does not fail the parser enhancement', (new SnapDouyinMediaProbe(fn () => null))->probe($original) === null);
$smallFile = $ftyp . box('mdat', str_repeat('x', 100)) . movie(720, 1280, 'avc1', 1);
$small = (new SnapDouyinMediaProbe(fn () => ['status' => 200, 'headers' => ['content-type' => 'video/mp4', 'content-length' => (string)strlen($smallFile)], 'body' => $smallFile]))->probe($cdn);
check('small complete non-Range response supported', $small['metadata']['width'] === 720);
foreach ([['content-type' => 'text/html'], ['content-range' => 'bytes 1-65536/' . strlen($file)], ['content-encoding' => 'gzip']] as $patch) {
    $bad = (new SnapDouyinMediaProbe(static function ($url, $offset, $length) use ($transport, $cdn, $patch): array { $r = $transport($cdn, $offset, $length); $r['headers'] = array_replace($r['headers'], $patch); return $r; }))->probe($cdn);
    check('reject incorrect media response ' . key($patch), $bad === null);
}
$oversize = $ftyp . pack('N', 2000000) . 'moov' . str_repeat('x', 2000000);
$oversizeReads = 0;
$unknown = (new SnapDouyinMediaProbe(static function ($url, $offset, $length) use ($oversize, &$oversizeReads): array { $oversizeReads++; $body = substr($oversize, $offset, $length); return ['status' => 206, 'headers' => ['content-type' => 'video/mp4', 'content-range' => 'bytes ' . $offset . '-' . ($offset + strlen($body) - 1) . '/' . strlen($oversize)], 'body' => $body]; }))->probe($cdn);
check('oversized movie metadata remains unknown without large fetch', $unknown['metadata'] === [] && $unknown['url'] === $cdn && $oversizeReads === 1);

$source = ['video' => ['play_addr' => ['uri' => 'fixture'], 'bit_rate' => [
    ['bit_rate' => 1700000, 'is_h265' => 1, 'play_addr' => ['width' => 2160, 'height' => 3840, 'url_list' => ['https://v3-test.douyinvod.com/standard.mp4']]],
]]];
$format = new ReflectionMethod(DouyinParser::class, 'formatData');
$parseWith = static function (?array $probe) use ($format, $source): array { return json_decode($format->invoke(new DouyinParser(fn () => $probe), $source, '1234567890123456'), true)['data']; };
$high = $parseWith(['url' => $cdn, 'metadata' => $metadata]);
check('measured higher bitrate 4K becomes primary', str_starts_with($high['url'], $cdn) && $high['bit_rate'] === 4000000 && $high['size'] === 6000000 && $high['duration'] === 10);
check('previous primary remains usable backup with its own metadata', $high['video_backup'][0]['bit_rate'] === 1700000 && str_contains($high['video_backup'][0]['url'], 'standard.mp4'));
check('measured original retains dimensions instead of vague original quality', $high['quality'] === '2160p' && $high['is_original'] === true && $high['metadata_source'] === 'mp4');
$lowMeta = SnapDouyinMediaProbe::metadata(movie(720, 1280, 'avc1', 600000), 7000000);
$low = $parseWith(['url' => $cdn, 'metadata' => $lowMeta]);
check('original 720p never displaces 4K even with a larger bitrate', str_contains($low['url'], 'standard.mp4') && $low['width'] === 2160 && $low['video_backup'][0]['width'] === 720);
$failed = $parseWith(null);
check('probe failure keeps known main and unknown original fallback', str_contains($failed['url'], 'standard.mp4') && $failed['video_backup'][0]['quality'] === 'unknown');
$unmeasured = $parseWith(['url' => $cdn, 'metadata' => []]);
check('resolved CDN with unknown metadata remains a backup', str_contains($unmeasured['url'], 'standard.mp4') && str_starts_with($unmeasured['video_backup'][0]['url'], $cdn) && !isset($unmeasured['video_backup'][0]['width']));
$thrown = json_decode($format->invoke(new DouyinParser(fn () => throw new RuntimeException('optional probe')), $source, '1234567890123456'), true);
check('optional probe exception preserves parse success', $thrown['code'] === 200 && str_contains($thrown['data']['url'], 'standard.mp4'));
$passed = count(array_filter($checks, fn ($check) => $check['passed']));
echo json_encode(['suite' => 'douyin-media', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
