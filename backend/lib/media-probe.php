<?php
declare(strict_types=1);

require_once __DIR__ . '/weibo-media.php';

/** Read container metadata only. Never expose a general URL fetch/relay endpoint. */
abstract class SnapMediaProbe
{
    public const MAX_BYTES = 1048576;
    public const MAX_REQUESTS = 12;
    public const TIMEOUT_SECONDS = 6;
    private const MAX_FILE_BYTES = 4294967296;
    private const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36';

    private $transport;
    private float $deadline;
    private int $bytes = 0;
    private int $requests = 0;
    private int $redirects = 0;
    private ?int $size = null;

    public function __construct(?callable $transport = null)
    {
        $this->transport = $transport ?? [static::class, 'request'];
    }

    abstract public static function allowedUrl(string $url): bool;

    protected static function mediaTypes(): array
    {
        return ['video/mp4', 'application/octet-stream', 'video/x-m4v'];
    }

    /** All DNS answers must be public. Pin the selected IP to prevent rebinding. */
    public static function resolve(string $host, ?callable $resolver = null): ?string
    {
        $resolver ??= static function (string $name): array {
            $records = @dns_get_record($name, DNS_A | DNS_AAAA);
            $ips = [];
            foreach (is_array($records) ? $records : [] as $record) {
                $ip = $record['ip'] ?? $record['ipv6'] ?? null;
                if (is_string($ip)) $ips[] = $ip;
            }
            return $ips;
        };
        $ips = $resolver($host);
        if (!is_array($ips) || !$ips) return null;
        foreach ($ips as $ip) {
            if (!is_string($ip) || !snapWeiboMediaPublicIp($ip)) return null;
        }
        usort($ips, static fn (string $a, string $b): int => strlen(inet_pton($a)) <=> strlen(inet_pton($b)));
        return $ips[0];
    }

    /** cURL follows no redirects and accepts no proxy or caller-supplied headers. */
    public static function request(string $url, int $offset, int $length, float $deadline): ?array
    {
        if (!static::allowedUrl($url) || microtime(true) >= $deadline) return null;
        $host = (string)parse_url($url, PHP_URL_HOST);
        $ip = self::resolve($host);
        $remaining = (int)(($deadline - microtime(true)) * 1000);
        if ($ip === null || $remaining < 1) return null;
        $status = 0; $headers = []; $headerBytes = 0; $body = ''; $complete = false; $rejected = false;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_USERAGENT => self::UA, CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROXY => '', CURLOPT_NOPROXY => '*',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CONNECTTIMEOUT_MS => min(2000, $remaining), CURLOPT_TIMEOUT_MS => $remaining,
            CURLOPT_RESOLVE => [$host . ':443:' . (str_contains($ip, ':') ? '[' . $ip . ']' : $ip)],
            CURLOPT_RANGE => $offset . '-' . ($offset + $length - 1),
            CURLOPT_HTTPHEADER => ['Accept-Encoding: identity', 'Accept: video/mp4, application/octet-stream'],
            CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$status, &$headers, &$headerBytes, &$complete, &$rejected): int {
                $headerBytes += strlen($line);
                if ($headerBytes > 16384) { $rejected = true; return 0; }
                if (preg_match('/^HTTP\/\S+ ([0-9]{3})/', $line, $m)) { $status = (int)$m[1]; $headers = []; $complete = false; }
                elseif (trim($line) === '') {
                    $complete = true;
                    // Redirect bodies are irrelevant and may be arbitrarily large.
                    if (in_array($status, [301, 302, 303, 307, 308], true)) return 0;
                } elseif (str_contains($line, ':')) {
                    [$name, $value] = explode(':', $line, 2); $name = strtolower(trim($name));
                    // Ignore legal repeated fields such as Server-Timing/Set-Cookie.
                    if (!in_array($name, ['location', 'content-range', 'content-length', 'content-type', 'content-encoding'], true)) return strlen($line);
                    if (isset($headers[$name])) { $rejected = true; return 0; }
                    $headers[$name] = trim($value);
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body, $length, &$rejected): int {
                if (strlen($chunk) > $length - strlen($body)) { $rejected = true; return 0; }
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($ch); $error = curl_errno($ch); curl_close($ch);
        $redirect = in_array($status, [301, 302, 303, 307, 308], true);
        if ($rejected || !$complete || ($ok === false && !($redirect && $error === CURLE_WRITE_ERROR))) return null;
        return ['status' => $status, 'headers' => $headers, 'body' => $body];
    }

    private function read(string &$url, int $offset, int $length): ?string
    {
        if ($offset < 0 || $length < 1 || $length > self::MAX_BYTES - $this->bytes) return null;
        while ($this->requests < self::MAX_REQUESTS && microtime(true) < $this->deadline) {
            if (!static::allowedUrl($url)) return null;
            $this->requests++;
            $r = ($this->transport)($url, $offset, $length, $this->deadline);
            if (!is_array($r) || !is_string($r['body'] ?? null) || strlen($r['body']) > $length) return null;
            $this->bytes += strlen($r['body']);
            $h = $r['headers'] ?? []; $status = $r['status'] ?? 0;
            if (in_array($status, [301, 302, 303, 307, 308], true)) {
                if (++$this->redirects > 3 || !is_string($h['location'] ?? null)) return null;
                $next = $h['location'];
                if (str_starts_with($next, '//')) $next = 'https:' . $next;
                elseif (str_starts_with($next, '/')) $next = 'https://' . parse_url($url, PHP_URL_HOST) . $next;
                elseif (str_starts_with($next, 'http://')) $next = 'https://' . substr($next, 7);
                if (!static::allowedUrl($next)) return null;
                $url = $next;
                continue;
            }
            if (!in_array($status, [200, 206], true) || ($h['content-encoding'] ?? 'identity') !== 'identity'
                || !in_array(strtolower(trim(explode(';', $h['content-type'] ?? '')[0])), static::mediaTypes(), true)) return null;
            $actual = strlen($r['body']);
            if ($status === 206) {
                if (!preg_match('/^bytes ([0-9]{1,10})-([0-9]{1,10})\/([0-9]{1,10})$/D', $h['content-range'] ?? '', $m)) return null;
                $size = (int)$m[3];
                if ((int)$m[1] !== $offset || (int)$m[2] !== $offset + $actual - 1
                    || (int)$m[2] >= $size || $actual !== min($length, $size - $offset)) return null;
            } else {
                // A server ignoring Range is only safe for a complete, small file.
                if ($offset !== 0 || !ctype_digit($h['content-length'] ?? '') || (int)$h['content-length'] !== $actual) return null;
                $size = $actual;
            }
            if ($size < 8 || $size > self::MAX_FILE_BYTES || ($this->size !== null && $this->size !== $size)) return null;
            $this->size = $size;
            return $r['body'];
        }
        return null;
    }

    /** A successful URL can survive an unsupported/truncated metadata layout. */
    public function probe(string $url, ?float $deadline = null): ?array
    {
        $this->deadline = min(microtime(true) + self::TIMEOUT_SECONDS, $deadline ?? INF);
        $this->bytes = $this->requests = $this->redirects = 0; $this->size = null;
        $prefix = $this->read($url, 0, 65536);
        if ($prefix === null || strlen($prefix) < 16 || substr($prefix, 4, 4) !== 'ftyp') return null;
        $result = ['url' => $url, 'metadata' => []];
        $offset = 0;
        for ($i = 0; $i < 24 && $offset < $this->size; $i++) {
            $head = $offset + 16 <= strlen($prefix) ? substr($prefix, $offset, 16) : $this->read($url, $offset, min(16, $this->size - $offset));
            if ($head === null) break;
            $result['url'] = $url;
            $atom = self::atom($head, 0, $this->size - $offset, false);
            if ($atom === null) break;
            if ($atom['type'] === 'moov') {
                if ($atom['size'] > self::MAX_BYTES - $this->bytes) break;
                $moov = $offset + $atom['size'] <= strlen($prefix) ? substr($prefix, $offset, $atom['size']) : $this->read($url, $offset, $atom['size']);
                if ($moov !== null) {
                    $result['url'] = $url;
                    $result['metadata'] = self::metadata($moov, $this->size) ?? [];
                }
                break;
            }
            $offset += $atom['size'];
        }
        return $result;
    }

    private static function u32(string $data, int $offset): int
    {
        return unpack('N', substr($data, $offset, 4))[1];
    }

    private static function u64(string $data, int $offset): ?int
    {
        $high = self::u32($data, $offset); $low = self::u32($data, $offset + 4);
        return $high <= 0x1fffff ? $high * 4294967296 + $low : null;
    }

    private static function atom(string $data, int $offset, int $available, bool $complete = true): ?array
    {
        if (strlen($data) - $offset < 8 || $available < 8) return null;
        $size = self::u32($data, $offset); $header = 8;
        if ($size === 1) {
            if (strlen($data) - $offset < 16) return null;
            $size = self::u64($data, $offset + 8); $header = 16;
        } elseif ($size === 0) $size = $available;
        if ($size === null || $size < $header || $size > $available || ($complete && $size > strlen($data) - $offset)) return null;
        return ['type' => substr($data, $offset + 4, 4), 'size' => $size, 'header' => $header];
    }

    private static function children(string $data): ?array
    {
        $out = []; $offset = 0; $length = strlen($data);
        while ($offset < $length && count($out) < 4096) {
            $atom = self::atom($data, $offset, $length - $offset);
            if ($atom === null) return null;
            $out[] = ['type' => $atom['type'], 'data' => substr($data, $offset + $atom['header'], $atom['size'] - $atom['header'])];
            $offset += $atom['size'];
        }
        return $offset === $length ? $out : null;
    }

    private static function child(string $data, string $type): ?string
    {
        $found = null; $children = self::children($data);
        if ($children === null) return null;
        foreach ($children as $item) {
            if ($item['type'] !== $type) continue;
            if ($found !== null) return null;
            $found = $item['data'];
        }
        return $found;
    }

    /** ISO BMFF video track: dimensions/codec from stsd, bitrate from stsz/mdhd. */
    public static function metadata(string $moov, int $fileSize): ?array
    {
        $root = self::atom($moov, 0, strlen($moov));
        if ($root === null || $root['type'] !== 'moov' || $root['size'] !== strlen($moov)) return null;
        $children = self::children(substr($moov, $root['header']));
        if ($children === null) return null;
        $video = null;
        foreach ($children as $track) {
            if ($track['type'] !== 'trak') continue;
            $mdia = self::child($track['data'], 'mdia');
            if ($mdia === null) continue;
            $handler = self::child($mdia, 'hdlr');
            if ($handler === null || strlen($handler) < 12 || substr($handler, 8, 4) !== 'vide') continue;
            if ($video !== null) return null; // Ambiguous multi-video containers are not ranked.
            $mdhd = self::child($mdia, 'mdhd'); $minf = self::child($mdia, 'minf');
            if ($mdhd === null || $minf === null || strlen($mdhd) < 20) return null;
            $version = ord($mdhd[0]);
            if ($version === 0) { $scale = self::u32($mdhd, 12); $ticks = self::u32($mdhd, 16); }
            elseif ($version === 1 && strlen($mdhd) >= 32) { $scale = self::u32($mdhd, 20); $ticks = self::u64($mdhd, 24); }
            else return null;
            if ($scale < 1 || $ticks === null || $ticks < 1) return null;
            $duration = $ticks / $scale;
            if ($duration < 0.01 || $duration > 86400) return null;
            $stbl = self::child($minf, 'stbl');
            if ($stbl === null) return null;
            $stsd = self::child($stbl, 'stsd'); $stsz = self::child($stbl, 'stsz');
            if ($stsd === null || strlen($stsd) < 44 || self::u32($stsd, 4) !== 1 || $stsz === null || strlen($stsz) < 12) return null;
            $entry = self::atom($stsd, 8, strlen($stsd) - 8);
            if ($entry === null || $entry['header'] !== 8 || $entry['size'] < 86) return null;
            $codec = ['avc1' => 'h264', 'avc3' => 'h264', 'hvc1' => 'hevc', 'hev1' => 'hevc', 'av01' => 'av1'][$entry['type']] ?? null;
            $width = unpack('n', substr($stsd, 40, 2))[1]; $height = unpack('n', substr($stsd, 42, 2))[1];
            if ($codec === null || $width < 1 || $height < 1 || $width > 16384 || $height > 16384) return null;
            $fixed = self::u32($stsz, 4); $count = self::u32($stsz, 8);
            if ($count < 1 || $count > 1000000 || strlen($stsz) !== ($fixed === 0 ? 12 + $count * 4 : 12)) return null;
            $bytes = $fixed * $count;
            if ($fixed === 0) for ($i = 0; $i < $count; $i++) $bytes += self::u32($stsz, 12 + $i * 4);
            if ($bytes < 1 || $bytes > $fileSize) return null;
            $video = ['width' => $width, 'height' => $height, 'codec' => $codec, 'duration' => round($duration, 3),
                'bit_rate' => (int)round($bytes * 8 / $duration), 'size' => $fileSize, 'metadata_source' => 'mp4'];
        }
        return $video;
    }
}
