<?php
declare(strict_types=1);
// Process-level test harness: preserves legacy entrypoint exit() behavior, never included by deploy entrypoints.
$_SERVER = [
    'REQUEST_URI' => $argv[1] ?? '/',
    'REQUEST_METHOD' => $argv[2] ?? 'GET',
    'REMOTE_ADDR' => $argv[4] ?? '127.0.0.1',
    'HTTP_HOST' => $argv[5] ?? 'snap.dokitool.com',
];
$_GET = json_decode($argv[3] ?? '{}', true) ?? [];
register_shutdown_function(static function (): void {
    while (ob_get_level() > 0) { ob_end_flush(); }
    fwrite(STDERR, json_encode(['httpStatus' => http_response_code() ?: 200]) . PHP_EOL);
});
require __DIR__ . (($argv[6] ?? '') === 'internal' ? '/../internal/index.php' : '/../public/index.php');
