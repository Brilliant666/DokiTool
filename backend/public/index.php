<?php
declare(strict_types=1);
require __DIR__ . '/../lib/gateway.php';
try {
    snapHandle();
} catch (Throwable $error) {
    snapSend(snapError(503, '解析服务配置异常'), 503);
}
