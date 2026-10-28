<?php
// LOCAL TEST ROUTER ONLY. Never deploy as a parser or expose publicly.
header('Content-Type: application/json');
if (($_SERVER['HTTP_HOST'] ?? '') !== 'snap.dokitool.com') { http_response_code(403); echo '{"code":403}'; return; }
$url = $_GET['url'] ?? '';
if (str_contains($url, '/html')) { echo '<html>upstream error</html>'; return; }
if (str_contains($url, '/http-failure')) { http_response_code(500); echo '{"code":200,"data":{"url":"https://media.example/video.mp4"}}'; return; }
if (str_contains($url, '/redirect')) { http_response_code(302); header('Location: http://127.0.0.1:1/never-follow'); echo '{"code":200}'; return; }
if (str_contains($url, '/business-failure')) { echo '{"code":404,"msg":"fixture unavailable","data":[]}'; return; }
echo json_encode(['code' => 200, 'data' => ['title' => 'Local fixture', 'url' => 'https://media.example/video.mp4', 'extra' => ['received_url' => $url, 'received_host' => $_SERVER['HTTP_HOST'], 'received_path' => parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH)]]]);
