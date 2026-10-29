<?php
declare(strict_types=1);

// A narrowly scoped media path, never a URL-fetching public proxy.
const SNAP_WEIBO_MEDIA_MAX_BYTES = 1073741824;
const SNAP_WEIBO_MEDIA_TTL = 1800;

function snapWeiboMediaKey(?string $key = null): ?string
{
    $key ??= (($value = getenv('SNAP_MEDIA_SIGNING_KEY')) !== false ? $value : '');
    return strlen($key) >= 32 && strlen($key) <= 512 ? $key : null;
}

function snapWeiboMediaAllowedUrl(string $url): bool
{
    if (strlen($url) > 4096 || preg_match('/[\\\\\x00-\x20\x7f]/', $url)
        || !filter_var($url, FILTER_VALIDATE_URL)) return false;
    $parts = parse_url($url);
    return $parts && ($parts['scheme'] ?? '') === 'https'
        && ($parts['host'] ?? '') === 'f.video.weibocdn.com'
        && (!isset($parts['port']) || $parts['port'] === 443)
        && !isset($parts['user']) && !isset($parts['pass'])
        && !isset($parts['fragment']) && str_starts_with($parts['path'] ?? '', '/');
}

function snapWeiboMediaBase64(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

/** Called only by the public adapter after a successful, registered Weibo parse. */
function snapWeiboMediaUrl(string $url, ?string $key = null, ?int $now = null): ?string
{
    $key = snapWeiboMediaKey($key);
    if ($key === null || !snapWeiboMediaAllowedUrl($url)) return null;
    $now ??= time();
    $payload = snapWeiboMediaBase64(json_encode(['v' => 1, 'u' => $url, 'iat' => $now,
        'exp' => $now + SNAP_WEIBO_MEDIA_TTL], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    $signature = snapWeiboMediaBase64(hash_hmac('sha256', $payload, $key, true));
    return '/api/media/weibo?ticket=' . $payload . '.' . $signature;
}

function snapWeiboMediaVerifyTicket(string $ticket, ?string $key = null, ?int $now = null): ?array
{
    $key = snapWeiboMediaKey($key);
    if ($key === null || strlen($ticket) > 8192
        || !preg_match('/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/D', $ticket, $parts)) return null;
    $expected = snapWeiboMediaBase64(hash_hmac('sha256', $parts[1], $key, true));
    if (!hash_equals($expected, $parts[2])) return null;
    $decoded = base64_decode(strtr($parts[1], '-_', '+/'), true);
    $payload = is_string($decoded) ? json_decode($decoded, true, 16) : null;
    $now ??= time();
    if (!is_array($payload) || ($payload['v'] ?? null) !== 1
        || !is_string($payload['u'] ?? null) || !snapWeiboMediaAllowedUrl($payload['u'])
        || !is_int($payload['iat'] ?? null) || !is_int($payload['exp'] ?? null)
        || $payload['iat'] > $now || $payload['exp'] <= $now
        || $payload['exp'] - $payload['iat'] !== SNAP_WEIBO_MEDIA_TTL) return null;
    return $payload;
}

/** One bounded byte range only; never forward arbitrary request headers. */
function snapWeiboMediaRange(?string $header): ?array
{
    if ($header === null || $header === '') return null;
    if (strlen($header) > 80 || !preg_match('/^bytes=([0-9]*)-([0-9]*)$/D', trim($header), $match)
        || ($match[1] === '' && $match[2] === '')) throw new InvalidArgumentException('Invalid media Range');
    foreach ([$match[1], $match[2]] as $number) {
        if ($number !== '' && (strlen($number) > 10 || (int)$number > SNAP_WEIBO_MEDIA_MAX_BYTES)) {
            throw new InvalidArgumentException('Media Range exceeds byte budget');
        }
    }
    if ($match[1] === '') {
        $suffix = (int)$match[2];
        if ($suffix < 1) throw new InvalidArgumentException('Empty media suffix');
        return ['header' => 'bytes=-' . $suffix, 'suffix' => $suffix];
    }
    $start = (int)$match[1]; $end = $match[2] === '' ? null : (int)$match[2];
    if ($start >= SNAP_WEIBO_MEDIA_MAX_BYTES || ($end !== null && ($end < $start || $end >= SNAP_WEIBO_MEDIA_MAX_BYTES))) {
        throw new InvalidArgumentException('Invalid media range bounds');
    }
    return ['header' => 'bytes=' . $start . '-' . ($end ?? ''), 'start' => $start, 'end' => $end];
}

function snapWeiboMediaInCidr(string $packed, string $network, int $bits): bool
{
    $base = inet_pton($network);
    if ($base === false || strlen($base) !== strlen($packed)) return false;
    $whole = intdiv($bits, 8); $rest = $bits % 8;
    return substr($packed, 0, $whole) === substr($base, 0, $whole)
        && ($rest === 0 || ((ord($packed[$whole]) ^ ord($base[$whole])) & (255 << (8 - $rest))) === 0);
}

function snapWeiboMediaPublicIp(string $ip): bool
{
    $packed = @inet_pton($ip);
    if ($packed === false) return false;
    if (strlen($packed) === 4) {
        foreach ([['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
            ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
            ['192.168.0.0', 16], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
            ['203.0.113.0', 24], ['224.0.0.0', 3]] as [$network, $bits]) {
            if (snapWeiboMediaInCidr($packed, $network, $bits)) return false;
        }
        return true;
    }
    if (!snapWeiboMediaInCidr($packed, '2000::', 3)) return false;
    foreach ([['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as [$network, $bits]) {
        if (snapWeiboMediaInCidr($packed, $network, $bits)) return false;
    }
    return true;
}

/** Resolve once, reject every non-public answer, then pin the chosen address in cURL. */
function snapWeiboMediaResolve(string $host, ?callable $resolver = null): ?string
{
    if ($host !== 'f.video.weibocdn.com') return null;
    $resolver ??= static function (string $name): array {
        $records = @dns_get_record($name, DNS_A | DNS_AAAA);
        $addresses = [];
        foreach (is_array($records) ? $records : [] as $record) {
            $value = $record['ip'] ?? $record['ipv6'] ?? null;
            if (is_string($value)) $addresses[] = $value;
        }
        return $addresses;
    };
    $addresses = $resolver($host);
    if (!is_array($addresses) || !$addresses) return null;
    foreach ($addresses as $address) {
        if (!is_string($address) || !snapWeiboMediaPublicIp($address)) return null;
    }
    // IPv4 first avoids requiring IPv6 connectivity; all answers above were checked.
    usort($addresses, static fn (string $a, string $b): int => strlen(inet_pton($a)) <=> strlen(inet_pton($b)));
    return $addresses[0];
}

function snapWeiboMediaPrepare(array $server, array $query, ?string $key = null, ?int $now = null, ?callable $resolver = null): array
{
    $method = $server['REQUEST_METHOD'] ?? '';
    if (!in_array($method, ['GET', 'HEAD'], true)) return ['ok' => false, 'status' => 405, 'message' => '仅支持 GET 和 HEAD'];
    $key = snapWeiboMediaKey($key);
    if ($key === null) return ['ok' => false, 'status' => 503, 'message' => '微博媒体服务未配置完成'];
    if (array_diff(array_keys($query), ['ticket']) || !is_string($query['ticket'] ?? null)) {
        return ['ok' => false, 'status' => 400, 'message' => '媒体链接参数无效，请重新解析'];
    }
    $ticket = snapWeiboMediaVerifyTicket($query['ticket'], $key, $now);
    if ($ticket === null) return ['ok' => false, 'status' => 403, 'message' => '媒体链接无效或已过期，请重新解析'];
    // RFC 9110 section 14.2: Range applies to GET and is ignored for HEAD.
    try { $range = $method === 'HEAD' ? null : snapWeiboMediaRange($server['HTTP_RANGE'] ?? null); }
    catch (InvalidArgumentException $error) { return ['ok' => false, 'status' => 416, 'message' => '视频请求范围无效']; }
    $ip = snapWeiboMediaResolve('f.video.weibocdn.com', $resolver);
    if ($ip === null) return ['ok' => false, 'status' => 502, 'message' => '微博媒体地址暂不可用，请稍后重试'];
    return ['ok' => true, 'method' => $method, 'url' => $ticket['u'], 'ip' => $ip, 'range' => $range];
}

/** Validate upstream status/headers completely before forwarding any bytes. */
function snapWeiboMediaResponsePlan(int $status, array $headers, ?array $range): array
{
    $fail = static fn (string $message, int $code = 502): array => ['ok' => false, 'status' => $code, 'message' => $message];
    $common = ['Cache-Control' => 'private, no-store', 'X-Content-Type-Options' => 'nosniff', 'Accept-Ranges' => 'bytes', 'X-Accel-Buffering' => 'no'];
    if ($status === 416 && $range !== null
        && preg_match('/^bytes \*\/([0-9]{1,10})$/D', $headers['content-range'] ?? '', $match)
        && (int)$match[1] <= SNAP_WEIBO_MEDIA_MAX_BYTES) {
        return ['ok' => true, 'status' => 416, 'length' => 0, 'start' => null,
            'headers' => $common + ['Content-Range' => 'bytes */' . (int)$match[1], 'Content-Length' => '0']];
    }
    if (!in_array($status, [200, 206], true)) return $fail('微博媒体暂不可用，请重新解析或稍后重试');
    if (($headers['content-encoding'] ?? 'identity') !== 'identity') return $fail('微博媒体编码响应异常');
    $mime = strtolower(trim(explode(';', $headers['content-type'] ?? '')[0]));
    if (!in_array($mime, ['video/mp4', 'application/octet-stream'], true)) return $fail('微博未返回可播放的视频文件');
    if (!preg_match('/^[0-9]{1,10}$/D', $headers['content-length'] ?? '')) return $fail('微博媒体长度未知或无效');
    $length = (int)$headers['content-length'];
    if ($length < 1) return $fail('微博返回了空视频文件');
    if ($length > SNAP_WEIBO_MEDIA_MAX_BYTES) return $fail('视频超过单文件 1 GiB 限制', 413);
    $start = 0;
    $out = $common + ['Content-Type' => 'video/mp4', 'Content-Length' => (string)$length,
        'Content-Disposition' => 'inline; filename="weibo-video.mp4"'];
    if ($range === null) {
        if ($status !== 200 || isset($headers['content-range'])) return $fail('微博返回了意外的部分视频');
        if ($length < 8) return $fail('微博视频文件头无效');
    } else {
        if ($status !== 206 || !preg_match('/^bytes ([0-9]{1,10})-([0-9]{1,10})\/([0-9]{1,10})$/D', $headers['content-range'] ?? '', $match)) {
            return $fail('微博未按请求返回视频范围');
        }
        $start = (int)$match[1]; $end = (int)$match[2]; $total = (int)$match[3];
        if ($total > SNAP_WEIBO_MEDIA_MAX_BYTES) return $fail('视频超过单文件 1 GiB 限制', 413);
        if ($start > $end || $end >= $total || $end - $start + 1 !== $length) return $fail('微博视频范围长度不一致');
        $expectedStart = isset($range['suffix']) ? max(0, $total - $range['suffix']) : $range['start'];
        $expectedEnd = isset($range['suffix']) ? $total - 1 : min($range['end'] ?? $total - 1, $total - 1);
        if ($start !== $expectedStart || $end !== $expectedEnd) return $fail('微博视频范围与请求不符');
        $out['Content-Range'] = 'bytes ' . $start . '-' . $end . '/' . $total;
    }
    return ['ok' => true, 'status' => $status, 'headers' => $out, 'length' => $length, 'start' => $start];
}

/** The injected transport used in tests obeys these same header/chunk callbacks. */
function snapWeiboMediaCurl(string $url, string $ip, string $method, ?array $range, callable $receiveHeaders, callable $receiveChunk): bool
{
    $host = 'f.video.weibocdn.com'; $status = 0; $headers = [];
    $handle = curl_init($url);
    $requestHeaders = ['Accept: video/mp4,application/octet-stream', 'Accept-Encoding: identity', 'Referer: https://weibo.com/'];
    if ($range !== null) $requestHeaders[] = 'Range: ' . $range['header'];
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => false, CURLOPT_HEADER => false, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROXY => '', CURLOPT_NOPROXY => '*', CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_RESOLVE => [$host . ':443:' . (str_contains($ip, ':') ? '[' . $ip . ']' : $ip)],
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 300, CURLOPT_LOW_SPEED_LIMIT => 1024, CURLOPT_LOW_SPEED_TIME => 30,
        CURLOPT_USERAGENT => 'Mozilla/5.0', CURLOPT_HTTPHEADER => $requestHeaders,
        CURLOPT_NOBODY => $method === 'HEAD', CURLOPT_NOPROGRESS => false,
        CURLOPT_XFERINFOFUNCTION => static fn ($ch, $downloadTotal, $downloaded, $uploadTotal, $uploaded): int => connection_aborted() ? 1 : 0,
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$status, &$headers, $receiveHeaders): int {
            if (preg_match('~^HTTP/\S+\s+([0-9]{3})\b~', $line, $match)) { $status = (int)$match[1]; $headers = []; }
            elseif (trim($line) === '') {
                if ($status >= 200 && !$receiveHeaders($status, $headers)) return 0;
            } elseif (str_contains($line, ':')) {
                [$name, $value] = explode(':', $line, 2); $name = strtolower(trim($name)); $value = trim($value);
                // Joining duplicates makes critical values fail strict validation.
                $headers[$name] = isset($headers[$name]) ? $headers[$name] . ', ' . $value : $value;
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => static fn ($ch, string $chunk): int => $receiveChunk($chunk),
    ]);
    $ok = curl_exec($handle) !== false;
    curl_close($handle);
    return $ok;
}

/** Streams with at most the first eight bytes retained, never the media body. */
function snapWeiboMediaStream(array $request, callable $sendHeaders, callable $sendChunk, ?callable $transport = null): array
{
    if ($request['method'] === 'HEAD') {
        // This CDN denies native HEAD. Probe only the MP4 signature with a bounded
        // GET; ordinary range validation rejects a server that sends the full file.
        $metadata = null;
        $probe = snapWeiboMediaStream(array_replace($request, ['method' => 'GET', 'range' => snapWeiboMediaRange('bytes=0-7')]),
            static function (int $status, array $headers) use (&$metadata): void { $metadata = $headers; },
            static fn (string $chunk): bool => true, $transport);
        if (!$probe['ok'] || $probe['status'] !== 206 || $probe['bytes'] !== 8
            || !preg_match('/^bytes 0-7\/([0-9]{1,10})$/D', $metadata['Content-Range'] ?? '', $match)) {
            return ['ok' => false, 'sent' => false, 'status' => !$probe['ok'] ? $probe['status'] : 502,
                'message' => $probe['message'] ?? '微博视频元信息暂不可用，请重试或重新解析', 'bytes' => 0];
        }
        $metadata['Content-Length'] = $match[1];
        unset($metadata['Content-Range']);
        $sendHeaders(200, $metadata);
        return ['ok' => true, 'sent' => true, 'status' => 200, 'bytes' => 0];
    }
    $transport ??= 'snapWeiboMediaCurl'; $plan = null; $sent = false; $written = 0; $prefix = ''; $rejected = false;
    $start = static function () use (&$sent, &$plan, $sendHeaders): void {
        if (!$sent) { $sendHeaders($plan['status'], $plan['headers']); $sent = true; }
    };
    $receiveHeaders = static function (int $status, array $headers) use (&$plan, &$sent, &$rejected, $request): bool {
        if ($sent) { $rejected = true; return false; }
        $plan = snapWeiboMediaResponsePlan($status, $headers, $request['range']);
        return $plan['ok'];
    };
    $receiveChunk = static function (string $chunk) use (&$plan, &$written, &$prefix, &$rejected, $start, $sendChunk, $request): int {
        if (!$plan || !$plan['ok'] || $plan['status'] === 416) return 0;
        if (strlen($chunk) > $plan['length'] - $written) { $rejected = true; return 0; }
        $length = strlen($chunk); $written += $length;
        if ($plan['start'] === 0 && $plan['length'] >= 8 && $written - $length < 8) {
            $needed = 8 - strlen($prefix); $prefix .= substr($chunk, 0, $needed); $chunk = substr($chunk, $needed);
            if (strlen($prefix) < 8) return $length;
            if (substr($prefix, 4, 4) !== 'ftyp') { $rejected = true; return 0; }
            $start();
            if ($sendChunk($prefix) === false) { $rejected = true; return 0; }
            $prefix = '';
        } else { $start(); }
        if ($chunk !== '' && $sendChunk($chunk) === false) { $rejected = true; return 0; }
        return $length;
    };
    $ok = $transport($request['url'], $request['ip'], $request['method'], $request['range'], $receiveHeaders, $receiveChunk);
    if ($plan && $plan['ok'] && $plan['status'] === 416) { $start(); return ['ok' => true, 'sent' => $sent, 'status' => 416, 'bytes' => 0]; }
    if ($ok && !$rejected && $plan && $plan['ok'] && $written === $plan['length'] && $prefix === '') {
        $start(); return ['ok' => true, 'sent' => $sent, 'status' => $plan['status'], 'bytes' => $written];
    }
    return ['ok' => false, 'sent' => $sent, 'status' => (!$plan || ($plan['ok'] ?? false)) ? 502 : $plan['status'],
        'message' => $plan['message'] ?? '微博视频传输未完成，请重试或重新解析', 'bytes' => $written];
}

function snapWeiboMediaError(int $status, string $message, bool $head): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: private, no-store');
    header('X-Content-Type-Options: nosniff'); header('Accept-Ranges: bytes');
    if ($status === 405) header('Allow: GET, HEAD');
    if (!$head) echo json_encode(['code' => $status, 'msg' => $message, 'data' => null], JSON_UNESCAPED_UNICODE);
}

/** Public entrypoint, before any JSON-output buffer or parser execution. */
function snapHandleWeiboMedia(): void
{
    $head = ($_SERVER['REQUEST_METHOD'] ?? '') === 'HEAD';
    try { $request = snapWeiboMediaPrepare($_SERVER, $_GET); }
    catch (Throwable $error) { snapWeiboMediaError(502, '微博媒体服务暂不可用，请稍后重试', $head); return; }
    if (!$request['ok']) { snapWeiboMediaError($request['status'], $request['message'], $head); return; }
    if (!extension_loaded('curl')) { snapWeiboMediaError(503, '微博媒体服务未配置完成', $head); return; }
    while (ob_get_level() > 0) ob_end_clean();
    ini_set('zlib.output_compression', '0');
    @set_time_limit(310);
    $headersSent = false;
    try { $result = snapWeiboMediaStream($request,
        static function (int $status, array $headers) use (&$headersSent): void {
            $headersSent = true;
            http_response_code($status);
            foreach ($headers as $name => $value) header($name . ': ' . $value);
        },
        static function (string $chunk): bool { echo $chunk; flush(); return !connection_aborted(); }); }
    catch (Throwable $error) {
        if (!$headersSent) snapWeiboMediaError(502, '微博媒体服务暂不可用，请稍后重试', $head);
        return;
    }
    // Once media bytes have been sent, never corrupt the file by appending JSON.
    if (!$result['ok'] && !$result['sent']) snapWeiboMediaError($result['status'], $result['message'], $head);
}
