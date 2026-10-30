<?php
declare(strict_types=1);

require_once __DIR__ . '/../../lib/media-probe.php';

/** Only original-key CDN hosts are eligible for server-side container probing. */
final class XiaohongshuMediaProbe extends SnapMediaProbe
{
    private ?int $lastStatus = null;
    private int $receivedBytes = 0;
    private ?string $container = null;

    public function __construct(?callable $transport = null)
    {
        $request = $transport ?? [self::class, 'request'];
        parent::__construct(function (string $url, int $offset, int $length, float $deadline) use ($request): ?array {
            $response = $request($url, $offset, $length, $deadline);
            if (is_array($response)) {
                $this->lastStatus = $response['status'] ?? null;
                $this->receivedBytes += strlen($response['body'] ?? '');
                if ($offset === 0 && substr($response['body'] ?? '', 4, 4) === 'ftyp') {
                    $this->container = substr($response['body'], 8, 4) === 'qt  ' ? 'mov' : 'mp4';
                }
            }
            return $response;
        });
    }

    public static function allowedUrl(string $url): bool
    {
        $parts = parse_url($url);
        return strlen($url) <= 8192 && !preg_match('/[\\\\\x00-\x20\x7f]/', $url)
            && filter_var($url, FILTER_VALIDATE_URL) && $parts
            && ($parts['scheme'] ?? '') === 'https'
            && !isset($parts['user']) && !isset($parts['pass']) && !isset($parts['fragment'])
            && (!isset($parts['port']) || $parts['port'] === 443)
            && in_array($parts['host'] ?? '', ['sns-video-qn.xhscdn.com', 'sns-video-al.xhscdn.com', 'sns-video-qc.xhscdn.com', 'sns-video-bd.xhscdn.com'], true)
            && preg_match('~^/[A-Za-z0-9_/-]+$~D', $parts['path'] ?? '') === 1
            && !str_contains($parts['path'], '..');
    }

    protected static function mediaTypes(): array
    {
        return [...parent::mediaTypes(), 'video/quicktime'];
    }

    public function inspect(string $url, float $deadline): array
    {
        $this->lastStatus = null;
        $this->receivedBytes = 0;
        $this->container = null;
        $result = $this->probe($url, $deadline);
        if (!empty($result['metadata']) && $this->container !== null) {
            $result['metadata']['container'] = $this->container;
            $result['metadata']['mime_type'] = $this->container === 'mov' ? 'video/quicktime' : 'video/mp4';
        }
        return ['result' => $result, 'http_status' => $this->lastStatus, 'read_bytes' => $this->receivedBytes];
    }
}
