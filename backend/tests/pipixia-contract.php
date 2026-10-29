<?php
declare(strict_types=1);
define('DOKITOOL_PARSER_LIBRARY_ONLY', true);
require __DIR__ . '/../api/ppxia.php';
$checks = [];
function checkPipixia(string $name, bool $passed): void { global $checks; $checks[] = compact('name', 'passed'); }
$id = '6879718018532776200';
$item = ['item_id_str' => $id, 'item_id' => 6879718018532776000, 'status' => 0,
    'content' => 'fixture', 'create_time' => 1601234567, 'stats' => ['like_count' => 0, 'comment_count' => 4],
    'author' => ['name' => 'author', 'avatar' => ['download_list' => [['url' => '//images.example/avatar.jpg']]]],
    'video' => ['duration' => 11.355, 'video_download' => ['width' => 1024, 'height' => 576,
        'url_list' => [['url' => 'https://video.example/main.mp4?token=a%26b'], ['url' => 'https://mirror.example/main.mp4']]],
        'video_high' => ['width' => 1920, 'height' => 1080, 'url_list' => [['url' => 'https://video.example/high.mp4']]]]];
$state = ['ppxItemDetail' => ['item' => $item], 'ppxCellComment' => ['cell_comments' => null]];
$raw = json_encode($state, JSON_UNESCAPED_SLASHES);
$html = '<html><script type="application/json">' . rawurlencode($raw) . '</script></html>';
$decoded = pipixiaPageItem($html);
checkPipixia('URL encoded page data works without any comments', $decoded === $item);
checkPipixia('raw JSON preserves percent escapes in signed media URLs', pipixiaPageItem('<script>' . $raw . '</script>') === $item);
checkPipixia('comments alone cannot substitute an unrelated original', pipixiaPageItem('<script>' . json_encode(['ppxCellComment' => ['cell_comments' => [['comment_info' => ['item' => $item]]]]]) . '</script>') === null);
checkPipixia('arbitrary scripts are not evaluated', pipixiaPageItem('<script>window.state=' . $raw . '</script>') === null);
checkPipixia('legacy URL needs no question mark', pipixiaItemId('https://h5.pipix.com/item/' . $id) === $id);
checkPipixia('modern path accepts trailing slash and query', pipixiaItemId('https://h5.pipix.com/ppx/item/' . $id . '/?from=share') === $id);
checkPipixia('item id query array rejected', pipixiaItemId('https://h5.pipix.com/?item_id[]=1') === null);
checkPipixia('lookalike host rejected', !pipixiaShareUrl('https://pipix.com.example/item/1'));
checkPipixia('credential URL rejected', !pipixiaShareUrl('https://evil.example@h5.pipix.com/item/1'));
$response = pipixiaItemResponse($decoded, $id);
$data = $response['data'];
checkPipixia('highest declared resolution selected with matching metadata', $response['code'] === 200 && $data['url'] === 'https://video.example/high.mp4' && $data['width'] === 1920 && $data['height'] === 1080 && $data['quality'] === '1080p');
checkPipixia('download and mirror retained with their own dimensions', count($data['video_backup']) === 2 && $data['video_backup'][0]['width'] === 1024 && $data['video_backup'][0]['quality'] === '576p');
checkPipixia('seconds and zero statistics preserved', $data['duration'] === 11.355 && $data['extra']['statistics']['digg_count'] === 0 && $data['create_time'] === 1601234567);
checkPipixia('avatar download list normalized', $data['avatar'] === 'https://images.example/avatar.jpg');
checkPipixia('rounded numeric id cannot override exact string id', pipixiaItemResponse($item, $id)['code'] === 200);
checkPipixia('unrelated item never returned', pipixiaItemResponse($item, '1')['error']['code'] === 'UPSTREAM_ITEM_MISMATCH');
$images = pipixiaItemResponse(['item_id_str' => $id, 'note' => ['multi_image' => [
    ['url_list' => [['url' => 'javascript:alert(1)'], ['url' => 'https://images.example/1.jpg']]],
    ['url_list' => [['url' => 'https://images.example/2.jpg']]],
]]], $id);
checkPipixia('image-only post normalized with usable image URLs', $images['code'] === 200 && $images['data']['type'] === 'image' && $images['data']['images'] === ['https://images.example/1.jpg', 'https://images.example/2.jpg']);
checkPipixia('empty media is not successful', pipixiaItemResponse(['item_id_str' => $id], $id)['error']['code'] === 'MEDIA_UNAVAILABLE');
checkPipixia('explicit unavailable item is distinguished', pipixiaItemResponse(['item_id_str' => $id, 'status' => 1], $id)['error']['code'] === 'ITEM_UNAVAILABLE');
$calls = [];
$result = pipixia('https://h5.pipix.com/s/sample/', function ($url, $timeout) use (&$calls, $id, $html) {
    $calls[] = $url;
    return count($calls) === 1 ? ['status' => 302, 'body' => '', 'location' => '/item/' . $id . '?share=1'] : ['status' => 200, 'body' => $html];
});
checkPipixia('short link fetches current page without redundant HEAD or comment calls', $result['code'] === 200 && $calls === ['https://h5.pipix.com/s/sample/', 'https://h5.pipix.com/ppx/item/' . $id]);
$calls = [];
$result = pipixia('https://h5.pipix.com/item/' . $id, function ($url) use (&$calls, $html) { $calls[] = $url; return ['status' => 200, 'body' => $html]; });
checkPipixia('direct legacy link requests only the modern page', $result['code'] === 200 && $calls === ['https://h5.pipix.com/ppx/item/' . $id]);
$result = pipixia('https://h5.pipix.com/s/sample/', fn () => ['status' => 302, 'body' => '', 'location' => 'http://127.0.0.1/private']);
checkPipixia('off-platform redirect rejected before next request', $result['error']['code'] === 'UPSTREAM_REDIRECT_INVALID');
$result = pipixia('https://h5.pipix.com/item/' . $id, fn () => ['status' => 200, 'body' => '']);
checkPipixia('empty upstream does not claim item deleted', $result['code'] === 502 && $result['error']['code'] === 'UPSTREAM_DATA_MISSING');
checkPipixia('rate limiting has a structured distinct cause', pipixiaTransportFailure(['status' => 429, 'body' => 'restricted'])['error']['code'] === 'UPSTREAM_RESTRICTED');
checkPipixia('timeouts have no misleading item-not-found message', pipixiaTransportFailure(['status' => 0, 'body' => false, 'errno' => CURLE_OPERATION_TIMEDOUT])['code'] === 504);
$passed = count(array_filter($checks, static fn ($check) => $check['passed']));
echo json_encode(['suite' => 'pipixia', 'passed' => $passed, 'total' => count($checks), 'checks' => $checks], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), PHP_EOL;
exit($passed === count($checks) ? 0 : 1);
