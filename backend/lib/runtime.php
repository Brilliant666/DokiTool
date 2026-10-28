<?php
declare(strict_types=1);

/** Shared minimum transport policy for the exposed legacy parsers.
 * This is NOT a redirect/DNS SSRF sandbox; the FPM egress policy is a deployment gate.
 */
function snapCurlExec($handle)
{
    curl_setopt_array($handle, [
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ]);
    return curl_exec($handle);
}
