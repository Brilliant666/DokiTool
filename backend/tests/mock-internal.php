<?php
// LOCAL TEST ROUTER ONLY. Never deploy or expose publicly.
require __DIR__ . '/../lib/media-adapters.php';
header('Content-Type: application/json');
if (($_SERVER['HTTP_HOST'] ?? '') !== 'snap.dokitool.com') { http_response_code(403); echo json_encode(snapContractError('UPSTREAM_BLOCKED','Host mismatch')); return; }
$url = $_GET['url'] ?? '';
if (str_contains($url, '/html')) { echo '<html>upstream error</html>'; return; }
if (str_contains($url, '/http-failure')) { http_response_code(500); echo '{"code":200,"data":{"url":"https://media.example/video.mp4"}}'; return; }
if (str_contains($url, '/redirect')) { http_response_code(302); header('Location: http://127.0.0.1:1/never-follow'); echo '{"code":200}'; return; }
if (str_contains($url, '/business-failure')) { http_response_code(404); echo json_encode(snapContractError('CONTENT_UNAVAILABLE','Fixture unavailable')); return; }
$platform = $_GET['platform'] ?? 'douyin';
$media = $platform === 'weibo' ? 'https://f.video.weibocdn.com/fixture.mp4' : 'https://media.example/video.mp4';
$payload = snapFinalizeData(['platform' => $platform, 'source_url' => $url, 'items' => [['id' => 'video', 'type' => 'video', 'default' => null, 'variants' => snapFileVariants([['url' => $media]])]], 'extra' => ['received_url' => $url, 'received_host' => $_SERVER['HTTP_HOST'], 'received_path' => parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH)]]);
echo json_encode($payload);
