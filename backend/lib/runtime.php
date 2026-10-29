<?php
declare(strict_types=1);

/** Shared minimum transport policy for the exposed legacy parsers.
 * This is NOT a redirect/DNS SSRF sandbox; the FPM egress policy is a deployment gate.
 */
function snapResponseWriter(string &$body, int $maxBytes): Closure
{
    return static function ($handle, string $chunk) use (&$body, $maxBytes): int {
        if (strlen($chunk) > $maxBytes - strlen($body)) {
            return 0; // Abort before allocating the oversized response.
        }
        $body .= $chunk;
        return strlen($chunk);
    };
}

function snapCurlExec($handle, int $maxBytes = 8 * 1024 * 1024)
{
    $body = '';
    curl_setopt_array($handle, [
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        // Parsers request metadata/HTML, never whole media files.
        CURLOPT_WRITEFUNCTION => snapResponseWriter($body, $maxBytes),
    ]);
    return curl_exec($handle) === false ? false : $body;
}

function snapMediaUrl($value): string
{
    if (!is_string($value)) {
        return '';
    }
    $value = trim($value);
    if (str_starts_with($value, '//')) {
        $value = 'https:' . $value;
    }
    $parts = parse_url($value);
    return $parts && in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
        && !isset($parts['user']) && !isset($parts['pass']) && filter_var($value, FILTER_VALIDATE_URL) ? $value : '';
}
