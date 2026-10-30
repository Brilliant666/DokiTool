<?php
declare(strict_types=1);

require_once __DIR__ . '/media-probe.php';

/** Douyin endpoints for the shared bounded ISO BMFF metadata reader. */
final class SnapDouyinMediaProbe extends SnapMediaProbe
{
    public static function allowedUrl(string $url): bool
    {
        if (strlen($url) > 8192 || preg_match('/[\\\\\x00-\x20\x7f]/', $url)
            || !filter_var($url, FILTER_VALIDATE_URL)) return false;
        $p = parse_url($url);
        if (!$p || ($p['scheme'] ?? '') !== 'https'
            || isset($p['user']) || isset($p['pass']) || isset($p['fragment'])
            || (isset($p['port']) && $p['port'] !== 443)) return false;
        $host = $p['host'] ?? '';
        return ($host === 'aweme.snssdk.com' && ($p['path'] ?? '') === '/aweme/v1/play/')
            || (bool)preg_match('/^v[0-9][a-z0-9-]*\.(?:douyinvod\.com|zjcdn\.com)$/D', $host);
    }

}
