<?php
declare(strict_types=1);
require_once __DIR__ . '/../lib/weibo-media.php';

$checks = [];
function mediaCheck(string $name, bool $passed): void { global $checks; $checks[] = ['name' => $name, 'passed' => $passed]; }
function mediaRejectsRange(string $value): bool {
    try { snapWeiboMediaRange($value); return false; } catch (InvalidArgumentException $error) { return true; }
}
$key = str_repeat('fixture-only-key-', 4); $now = 1000;
$url = 'https://f.video.weibocdn.com/o0/fixture.mp4?Expires=9999999999&ssig=fixture';
$relay = snapWeiboMediaUrl($url, $key, $now);
parse_str((string)parse_url($relay, PHP_URL_QUERY), $query);
$ticket = $query['ticket'];
mediaCheck('signed media path is relative and constrained', str_starts_with($relay, '/api/media/weibo?ticket='));
mediaCheck('valid ticket recovers the original signed URL', snapWeiboMediaVerifyTicket($ticket, $key, 1001)['u'] === $url);
mediaCheck('expired ticket rejected', snapWeiboMediaVerifyTicket($ticket, $key, 2800) === null);
mediaCheck('future-issued ticket rejected', snapWeiboMediaVerifyTicket($ticket, $key, 999) === null);
$shortRelay = snapWeiboMediaUrl($url, $key, 1000, 1050);
parse_str((string)parse_url($shortRelay, PHP_URL_QUERY), $shortQuery);
mediaCheck('known earlier upstream expiry bounds signed ticket', snapWeiboMediaVerifyTicket($shortQuery['ticket'], $key, 1001)['exp'] === 1050 && snapWeiboMediaVerifyTicket($shortQuery['ticket'], $key, 1050) === null);
mediaCheck('already expired source cannot mint ticket', snapWeiboMediaUrl($url, $key, 1000, 999) === null);
mediaCheck('wrong key rejected', snapWeiboMediaVerifyTicket($ticket, str_repeat('other', 10), 1001) === null);
$tampered = ($ticket[0] === 'A' ? 'B' : 'A') . substr($ticket, 1);
mediaCheck('payload tampering rejected', snapWeiboMediaVerifyTicket($tampered, $key, 1001) === null);
mediaCheck('signature tampering rejected', snapWeiboMediaVerifyTicket(substr($ticket, 0, -1) . ($ticket[-1] === 'A' ? 'B' : 'A'), $key, 1001) === null);
mediaCheck('weak key cannot mint links', snapWeiboMediaUrl($url, 'short', $now) === null);
foreach (['http://f.video.weibocdn.com/x', 'https://f.video.weibocdn.com.evil.test/x', 'https://evil.test/x',
    'https://user@f.video.weibocdn.com/x', 'https://user:pass@f.video.weibocdn.com/x',
    'https://f.video.weibocdn.com:8443/x', 'https://f.video.weibocdn.com/x#fragment',
    "https://f.video.weibocdn.com/x\r\nHost: example.test", 'https://f.video.weibocdn.com\\@example.test/x'] as $bad) {
    mediaCheck('foreign or malformed media URL cannot be signed: ' . bin2hex(substr($bad, 0, 70)), snapWeiboMediaUrl($bad, $key, $now) === null);
}
mediaCheck('explicit TLS default port allowed', snapWeiboMediaAllowedUrl('https://f.video.weibocdn.com:443/x'));
foreach (['127.0.0.1', '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.0.9', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '64:ff9b::7f00:1', '2001::1234', '2001:db8::1', '2002:7f00:1::', '3fff::1'] as $ip) {
    mediaCheck('nonpublic DNS address rejected: ' . $ip, !snapWeiboMediaPublicIp($ip));
}
mediaCheck('ordinary public addresses allowed', snapWeiboMediaPublicIp('93.184.216.34') && snapWeiboMediaPublicIp('2606:4700:4700::1111'));
mediaCheck('mixed safe and private DNS answers rejected as a whole', snapWeiboMediaResolve('f.video.weibocdn.com', fn () => ['93.184.216.34', '127.0.0.1']) === null);
mediaCheck('public answer selected after complete DNS validation', snapWeiboMediaResolve('f.video.weibocdn.com', fn () => ['2606:4700:4700::1111', '93.184.216.34']) === '93.184.216.34');
mediaCheck('empty DNS answer rejected', snapWeiboMediaResolve('f.video.weibocdn.com', fn () => []) === null);
mediaCheck('foreign host never resolved', snapWeiboMediaResolve('example.test', fn () => throw new Exception('not called')) === null);
foreach (['bytes=0-1,4-5', 'items=0-1', 'bytes=-', 'bytes=-0', 'bytes=5-4', 'bytes=1073741824-',
    'bytes=0-1073741824', 'bytes=-999999999999999999999', "bytes=0-1\r\nX: bad"] as $range) {
    mediaCheck('invalid or oversized Range rejected: ' . bin2hex($range), mediaRejectsRange($range));
}
mediaCheck('open range retained', snapWeiboMediaRange('bytes=16-') === ['header' => 'bytes=16-', 'start' => 16, 'end' => null]);
mediaCheck('suffix range retained', snapWeiboMediaRange('bytes=-8') === ['header' => 'bytes=-8', 'suffix' => 8]);
$resolverCalls = 0;
$resolver = static function () use (&$resolverCalls): array { $resolverCalls++; return ['93.184.216.34']; };
$prepared = snapWeiboMediaPrepare(['REQUEST_METHOD' => 'GET'], ['ticket' => $ticket], $key, 1001, $resolver);
mediaCheck('valid GET prepares a pinned address', $prepared['ok'] && $prepared['ip'] === '93.184.216.34' && $resolverCalls === 1);
mediaCheck('HEAD accepted', snapWeiboMediaPrepare(['REQUEST_METHOD' => 'HEAD'], ['ticket' => $ticket], $key, 1001, $resolver)['ok']);
foreach (['bytes=8-15', 'bytes=-8', 'bytes=64-', 'bytes=0-1,8-9', 'invalid'] as $headRange) {
    $headPrepared = snapWeiboMediaPrepare(['REQUEST_METHOD' => 'HEAD', 'HTTP_RANGE' => $headRange], ['ticket' => $ticket], $key, 1001, $resolver);
    mediaCheck('HEAD ignores Range per RFC 9110: ' . $headRange, $headPrepared['ok'] && $headPrepared['range'] === null);
}
$resolverCalls = 0;
mediaCheck('POST rejected before DNS', snapWeiboMediaPrepare(['REQUEST_METHOD' => 'POST'], ['ticket' => $ticket], $key, 1001, $resolver)['status'] === 405 && $resolverCalls === 0);
mediaCheck('arbitrary URL parameter rejected before DNS', snapWeiboMediaPrepare(['REQUEST_METHOD' => 'GET'], ['ticket' => $ticket, 'url' => $url], $key, 1001, $resolver)['status'] === 400 && $resolverCalls === 0);
mediaCheck('ticket arrays rejected before DNS', snapWeiboMediaPrepare(['REQUEST_METHOD' => 'GET'], ['ticket' => [$ticket]], $key, 1001, $resolver)['status'] === 400 && $resolverCalls === 0);
mediaCheck('bad ticket rejected before DNS', snapWeiboMediaPrepare(['REQUEST_METHOD' => 'GET'], ['ticket' => 'bad'], $key, 1001, $resolver)['status'] === 403 && $resolverCalls === 0);
mediaCheck('invalid Range rejected before DNS', snapWeiboMediaPrepare(['REQUEST_METHOD' => 'GET', 'HTTP_RANGE' => 'bytes=0-2,4-8'], ['ticket' => $ticket], $key, 1001, $resolver)['status'] === 416 && $resolverCalls === 0);

$bytes = pack('N', 32) . 'ftyp' . str_repeat('x', 24);
$headers = ['content-type' => 'video/mp4', 'content-length' => '32'];
$range = snapWeiboMediaRange('bytes=8-15');
$partial = $headers + ['content-range' => 'bytes 8-15/32']; $partial['content-length'] = '8';
mediaCheck('matching partial response accepted', snapWeiboMediaResponsePlan(206, $partial, $range)['ok']);
mediaCheck('ignored Range response rejected', !snapWeiboMediaResponsePlan(200, $headers, $range)['ok']);
mediaCheck('mismatched content range rejected', !snapWeiboMediaResponsePlan(206, $partial, snapWeiboMediaRange('bytes=9-16'))['ok']);
mediaCheck('range length mismatch rejected', !snapWeiboMediaResponsePlan(206, array_replace($partial, ['content-length' => '9']), $range)['ok']);
mediaCheck('unknown total rejected', !snapWeiboMediaResponsePlan(206, array_replace($partial, ['content-range' => 'bytes 8-15/*']), $range)['ok']);
mediaCheck('oversized total rejected', snapWeiboMediaResponsePlan(206, array_replace($partial, ['content-range' => 'bytes 8-15/1073741825']), $range)['status'] === 413);
mediaCheck('HTML never accepted as media', !snapWeiboMediaResponsePlan(200, array_replace($headers, ['content-type' => 'text/html']), null)['ok']);
mediaCheck('compressed upstream rejected', !snapWeiboMediaResponsePlan(200, $headers + ['content-encoding' => 'gzip'], null)['ok']);
mediaCheck('empty file rejected', !snapWeiboMediaResponsePlan(200, array_replace($headers, ['content-length' => '0']), null)['ok']);
mediaCheck('unknown file length rejected', !snapWeiboMediaResponsePlan(200, ['content-type' => 'video/mp4'], null)['ok']);
mediaCheck('duplicate content lengths rejected', !snapWeiboMediaResponsePlan(200, array_replace($headers, ['content-length' => '32, 32']), null)['ok']);
mediaCheck('redirect rejected without following Location', !snapWeiboMediaResponsePlan(302, ['location' => 'http://127.0.0.1/'], null)['ok']);
mediaCheck('upstream forbidden response rejected', !snapWeiboMediaResponsePlan(403, ['content-type' => 'text/html'], null)['ok']);
mediaCheck('valid unsatisfiable response has no upstream body', snapWeiboMediaResponsePlan(416, ['content-range' => 'bytes */32'], snapWeiboMediaRange('bytes=64-'))['headers']['Content-Length'] === '0');
mediaCheck('suffix matches resource end', snapWeiboMediaResponsePlan(206, ['content-type' => 'video/mp4', 'content-length' => '8', 'content-range' => 'bytes 24-31/32'], snapWeiboMediaRange('bytes=-8'))['ok']);

function mediaStreamFixture(array $request, int $status, array $headers, array $chunks, bool $complete = true, bool $cancelSink = false): array {
    $events = []; $output = ''; $calls = 0; $requests = [];
    $result = snapWeiboMediaStream($request,
        static function ($status, $headers) use (&$events): void { $events[] = ['status' => $status, 'headers' => $headers]; },
        static function ($chunk) use (&$output, $cancelSink): bool { if ($cancelSink) return false; $output .= $chunk; return true; },
        static function ($url, $ip, $method, $range, $head, $write) use ($status, $headers, $chunks, $complete, &$calls, &$requests): bool {
            $requests[] = ['method' => $method, 'range' => $range];
            if (!$head($status, $headers)) return false;
            foreach ($chunks as $chunk) { $calls++; if ($write($chunk) !== strlen($chunk)) return false; }
            return $complete;
        });
    return ['result' => $result, 'events' => $events, 'output' => $output, 'chunk_calls' => $calls, 'requests' => $requests];
}
$fixture = mediaStreamFixture($prepared, 200, $headers, [substr($bytes, 0, 3), substr($bytes, 3, 2), substr($bytes, 5)]);
mediaCheck('split MP4 signature streams exact bytes after validation', $fixture['result']['ok'] && $fixture['output'] === $bytes && count($fixture['events']) === 1);
mediaCheck('only explicitly selected response headers forwarded', !isset($fixture['events'][0]['headers']['Set-Cookie'], $fixture['events'][0]['headers']['Location']));
$shortRequest = array_replace($prepared, ['range' => snapWeiboMediaRange('bytes=0-1')]);
$fixture = mediaStreamFixture($shortRequest, 206, ['content-type' => 'video/mp4', 'content-length' => '2', 'content-range' => 'bytes 0-1/32'], [substr($bytes, 0, 2)]);
mediaCheck('Safari two-byte initial Range succeeds without waiting for eight bytes', $fixture['result']['ok'] && $fixture['output'] === substr($bytes, 0, 2) && $fixture['events'][0]['status'] === 206);
$fixture = mediaStreamFixture(array_replace($prepared, ['range' => $range]), 206, $partial, [substr($bytes, 8, 8)]);
mediaCheck('seek range streams bytes without MP4-header confusion', $fixture['result']['ok'] && $fixture['output'] === substr($bytes, 8, 8));
$fixture = mediaStreamFixture($prepared, 200, $headers, ['<!DOCTYPE html>' . str_repeat('x', 17)]);
mediaCheck('HTML mislabeled video rejected before success headers', !$fixture['result']['ok'] && !$fixture['result']['sent'] && $fixture['events'] === [] && $fixture['output'] === '');
$fixture = mediaStreamFixture($prepared, 403, ['content-type' => 'text/html'], ['private upstream error']);
mediaCheck('403 body never forwarded', !$fixture['result']['ok'] && $fixture['output'] === '' && $fixture['chunk_calls'] === 0);
$fixture = mediaStreamFixture($prepared, 200, $headers, [$bytes . 'overflow']);
mediaCheck('oversized body stopped before any oversized chunk output', !$fixture['result']['ok'] && $fixture['output'] === '');
$fixture = mediaStreamFixture($prepared, 200, $headers, [substr($bytes, 0, 8)], false);
mediaCheck('truncated stream remains failed after headers and never appends JSON', !$fixture['result']['ok'] && $fixture['result']['sent'] && $fixture['output'] === substr($bytes, 0, 8));
$fixture = mediaStreamFixture($prepared, 200, $headers, [$bytes], true, true);
mediaCheck('disconnected sink aborts stream', !$fixture['result']['ok'] && $fixture['output'] === '' && $fixture['chunk_calls'] === 1);
$headRequest = array_replace($prepared, ['method' => 'HEAD']);
$probeHeaders = ['content-type' => 'video/mp4', 'content-length' => '8', 'content-range' => 'bytes 0-7/32'];
$fixture = mediaStreamFixture($headRequest, 206, $probeHeaders, [substr($bytes, 0, 3), substr($bytes, 3, 5)]);
mediaCheck('HEAD probes exactly eight bytes with GET instead of native HEAD', $fixture['requests'] === [['method' => 'GET', 'range' => snapWeiboMediaRange('bytes=0-7')]] && $fixture['chunk_calls'] === 2);
mediaCheck('HEAD returns full metadata with no response body', $fixture['result']['ok'] && $fixture['output'] === '' && $fixture['result']['bytes'] === 0 && $fixture['events'][0]['status'] === 200 && $fixture['events'][0]['headers']['Content-Length'] === '32' && !isset($fixture['events'][0]['headers']['Content-Range']));
$fixture = mediaStreamFixture(array_replace($headRequest, ['range' => $range]), 206, $probeHeaders, [substr($bytes, 0, 8)]);
mediaCheck('HEAD with a Range still probes the signature and returns full metadata', $fixture['result']['ok'] && $fixture['output'] === '' && $fixture['events'][0]['status'] === 200 && $fixture['events'][0]['headers']['Content-Length'] === '32' && $fixture['requests'][0]['range']['header'] === 'bytes=0-7');
$fixture = mediaStreamFixture($headRequest, 200, $headers, [$bytes]);
mediaCheck('HEAD rejects ignored probe Range before downloading any body', !$fixture['result']['ok'] && !$fixture['result']['sent'] && $fixture['events'] === [] && $fixture['chunk_calls'] === 0);
$fixture = mediaStreamFixture($headRequest, 206, array_replace($probeHeaders, ['content-range' => 'bytes 0-7/1073741825']), [substr($bytes, 0, 8)]);
mediaCheck('HEAD retains total resource size limit before reading probe bytes', !$fixture['result']['ok'] && $fixture['result']['status'] === 413 && $fixture['chunk_calls'] === 0 && $fixture['events'] === []);
$fixture = mediaStreamFixture($headRequest, 206, $probeHeaders, ['<!DOCTYP']);
mediaCheck('HEAD requires MP4 signature before any success headers', !$fixture['result']['ok'] && !$fixture['result']['sent'] && $fixture['events'] === [] && $fixture['output'] === '');
$fixture = mediaStreamFixture($headRequest, 206, $probeHeaders, [substr($bytes, 0, 2)]);
mediaCheck('HEAD rejects a truncated probe', !$fixture['result']['ok'] && !$fixture['result']['sent'] && $fixture['events'] === []);
$fixture = mediaStreamFixture($headRequest, 206, $probeHeaders, [$bytes]);
mediaCheck('HEAD rejects oversized probe chunks without exposing a body', !$fixture['result']['ok'] && $fixture['events'] === [] && $fixture['output'] === '' && $fixture['chunk_calls'] === 1);
$fixture = mediaStreamFixture($headRequest, 206, array_replace($probeHeaders, ['content-length' => '7', 'content-range' => 'bytes 0-6/7']), [substr($bytes, 0, 7)]);
mediaCheck('HEAD rejects a resource too short to validate as MP4', !$fixture['result']['ok'] && !$fixture['result']['sent'] && $fixture['events'] === []);
$fixture = mediaStreamFixture($headRequest, 416, ['content-range' => 'bytes */0'], ['ignored HTML']);
mediaCheck('HEAD never treats an empty unsatisfiable probe as a video', !$fixture['result']['ok'] && $fixture['result']['status'] === 502 && $fixture['events'] === [] && $fixture['output'] === '');
$fixture = mediaStreamFixture($headRequest, 403, ['content-type' => 'text/html'], ['private upstream error']);
mediaCheck('HEAD never converts an upstream denial into success', !$fixture['result']['ok'] && $fixture['events'] === [] && $fixture['chunk_calls'] === 0);
$fixture = mediaStreamFixture(array_replace($prepared, ['range' => snapWeiboMediaRange('bytes=64-')]), 416, ['content-range' => 'bytes */32'], ['ignored HTML']);
mediaCheck('416 forwards only range metadata and no HTML', $fixture['result']['ok'] && $fixture['events'][0]['status'] === 416 && $fixture['output'] === '');

// Simulate 64 MiB in small chunks, measuring peak memory without accumulating a file.
if (function_exists('memory_reset_peak_usage')) memory_reset_peak_usage();
$baseline = memory_get_usage(true); $received = 0; $largest = 0; $headerEvents = 0;
$large = snapWeiboMediaStream($prepared,
    static function () use (&$headerEvents): void { $headerEvents++; },
    static function (string $chunk) use (&$received, &$largest): bool { $received += strlen($chunk); $largest = max($largest, strlen($chunk)); return true; },
    static function ($url, $ip, $method, $range, $head, $write) use ($bytes): bool {
        if (!$head(200, ['content-type' => 'video/mp4', 'content-length' => (string)(64 * 1024 * 1024)])) return false;
        $chunk = str_repeat('x', 65536);
        for ($i = 0; $i < 1024; $i++) {
            $value = $i === 0 ? substr($bytes, 0, 8) . substr($chunk, 8) : $chunk;
            if ($write($value) !== strlen($value)) return false;
        }
        return true;
    });
$memoryGrowth = memory_get_peak_usage(true) - $baseline;
mediaCheck('large media streams completely with small chunks', $large['ok'] && $received === 64 * 1024 * 1024 && $largest <= 65536 && $headerEvents === 1);
mediaCheck('large media does not accumulate in PHP memory', $memoryGrowth < 8 * 1024 * 1024);

$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'weibo-media', 'passed' => $passed, 'total' => count($checks), 'stream_memory_growth_bytes' => $memoryGrowth,
    'checks' => $checks], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
