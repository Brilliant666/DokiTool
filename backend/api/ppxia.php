<?php
require_once __DIR__ . '/../lib/runtime.php';
/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/2/23 下午11:21
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 皮皮虾去水印解析
 */

function pipixiaFailure(int $code, string $message, string $reason): array
{
    return ['code' => $code, 'msg' => $message, 'error' => ['code' => $reason, 'platform' => 'pipixia']];
}

function pipixiaShareUrl(string $url): bool
{
    $parts = parse_url($url);
    $host = strtolower($parts['host'] ?? '');
    return $parts && in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
        && ($host === 'pipix.com' || str_ends_with($host, '.pipix.com'))
        && !isset($parts['user']) && !isset($parts['pass'])
        && (!isset($parts['port']) || in_array($parts['port'], [80, 443], true));
}

function pipixiaItemId(string $url): ?string
{
    if (!pipixiaShareUrl($url)) return null;
    $parts = parse_url($url);
    if (preg_match('~^/(?:ppx/)?item/([1-9][0-9]{0,19})/?$~D', $parts['path'] ?? '', $match)) return $match[1];
    parse_str($parts['query'] ?? '', $query);
    $id = $query['item_id'] ?? null;
    return is_string($id) && preg_match('/^[1-9][0-9]{0,19}$/D', $id) ? $id : null;
}

/** Redirects are followed explicitly so an upstream redirect cannot choose another host. */
function pipixiaRequest(string $url, int $timeout): array
{
    $headers = [];
    $handle = curl_init($url);
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => $timeout,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        CURLOPT_HTTPHEADER => ['Accept: text/html,application/json', 'Referer: https://h5.pipix.com/'],
        CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$headers): int {
            if (str_contains($line, ':')) {
                [$name, $value] = explode(':', $line, 2);
                $headers[strtolower(trim($name))] = trim($value);
            }
            return strlen($line);
        },
    ]);
    $body = snapCurlExec($handle, 2 * 1024 * 1024);
    $result = ['status' => curl_getinfo($handle, CURLINFO_HTTP_CODE), 'body' => $body,
        'location' => $headers['location'] ?? '', 'errno' => curl_errno($handle)];
    curl_close($handle);
    return $result;
}

function pipixiaRedirect(string $from, string $location): ?string
{
    if (str_starts_with($location, '//')) $location = 'https:' . $location;
    elseif (str_starts_with($location, '/')) $location = 'https://' . parse_url($from, PHP_URL_HOST) . $location;
    if (!pipixiaShareUrl($location)) return null;
    return preg_replace('~^http://~i', 'https://', $location);
}

function pipixiaTransportFailure(array $response): ?array
{
    if (($response['body'] ?? false) === false) {
        return pipixiaFailure(($response['errno'] ?? 0) === CURLE_OPERATION_TIMEDOUT ? 504 : 502,
            '皮皮虾上游请求失败，请稍后重试', 'UPSTREAM_REQUEST_FAILED');
    }
    $status = (int)($response['status'] ?? 0);
    if (in_array($status, [401, 403, 429], true)) {
        return pipixiaFailure(502, '皮皮虾暂时限制访问，请稍后重试', 'UPSTREAM_RESTRICTED');
    }
    if ($status < 200 || $status >= 400) {
        return pipixiaFailure(502, '皮皮虾页面暂时不可用，请检查分享链接或稍后重试', 'UPSTREAM_HTTP_ERROR');
    }
    return null;
}

/** Decode inert page JSON only; never execute scripts or use comment-attached media. */
function pipixiaPageItem(string $html): ?array
{
    preg_match_all('~<script\b[^>]*>(.*?)</script>~is', $html, $scripts);
    foreach ($scripts[1] as $script) {
        if (!str_contains($script, 'ppxItemDetail')) continue;
        $state = json_decode(trim($script), true, 64, JSON_BIGINT_AS_STRING);
        if (!is_array($state)) $state = json_decode(rawurldecode(trim($script)), true, 64, JSON_BIGINT_AS_STRING);
        if (is_array($state) && is_array($state['ppxItemDetail']['item'] ?? null)) return $state['ppxItemDetail']['item'];
    }
    return null;
}

function pipixiaUrls($media): array
{
    if (!is_array($media)) return [];
    $urls = [];
    foreach (['url_list', 'download_list'] as $key) {
        foreach (is_array($media[$key] ?? null) ? $media[$key] : [] as $entry) {
            $url = snapMediaUrl(is_array($entry) ? ($entry['url'] ?? null) : $entry);
            if ($url !== '' && !in_array($url, $urls, true)) $urls[] = $url;
        }
    }
    return $urls;
}

function pipixiaItemResponse(array $item, string $expectedId): array
{
    $actualId = $item['item_id_str'] ?? $item['item_id'] ?? null;
    if ((!is_string($actualId) && !is_int($actualId)) || (string)$actualId !== $expectedId) {
        return pipixiaFailure(502, '皮皮虾返回的作品与分享链接不一致', 'UPSTREAM_ITEM_MISMATCH');
    }
    if (!empty($item['status'])) return pipixiaFailure(404, '该皮皮虾作品当前不可访问', 'ITEM_UNAVAILABLE');
    $video = is_array($item['video'] ?? null) ? $item['video'] : [];
    $candidates = [];
    $sources = [$item['origin_video_download'] ?? null];
    foreach (['video_download', 'video_high', 'video_mid', 'video_low', 'video_fallback'] as $name) $sources[] = $video[$name] ?? null;
    foreach ($sources as $source) {
        foreach (pipixiaUrls($source) as $url) {
            if (isset($candidates[$url])) continue;
            $candidate = ['url' => $url, 'quality' => 'unknown'];
            foreach (['width', 'height'] as $key) {
                if (is_numeric($source[$key] ?? null) && $source[$key] > 0) $candidate[$key] = (int)$source[$key];
            }
            if (isset($candidate['width'], $candidate['height'])) $candidate['quality'] = min($candidate['width'], $candidate['height']) . 'p';
            $candidate['label'] = $candidate['quality'] === 'unknown' ? '视频源' : $candidate['quality'];
            $candidates[$url] = $candidate;
        }
    }
    $candidates = array_values($candidates);
    usort($candidates, static fn ($a, $b) => (($b['width'] ?? 0) * ($b['height'] ?? 0)) <=> (($a['width'] ?? 0) * ($a['height'] ?? 0)));
    $images = [];
    $note = is_array($item['note'] ?? null) ? $item['note'] : [];
    foreach (is_array($note['multi_image'] ?? null) ? $note['multi_image'] : [] as $image) {
        $url = pipixiaUrls($image)[0] ?? '';
        if ($url !== '' && !in_array($url, $images, true)) $images[] = $url;
    }
    if (!$candidates && !$images) return pipixiaFailure(404, '该皮皮虾作品没有可用的视频或图片', 'MEDIA_UNAVAILABLE');
    $author = is_array($item['author'] ?? null) ? $item['author'] : [];
    $selected = $candidates[0] ?? [];
    $data = [
        'id' => $expectedId, 'type' => $candidates ? 'video' : 'image',
        'title' => is_string($item['content'] ?? null) ? $item['content'] : '',
        'author' => $author['name'] ?? '', 'avatar' => pipixiaUrls($author['avatar'] ?? null)[0] ?? '',
        'cover' => pipixiaUrls($item['cover'] ?? null)[0] ?? pipixiaUrls($video['cover_image'] ?? null)[0] ?? $images[0] ?? '',
        'url' => $selected['url'] ?? '', 'images' => $images, 'imgurl' => $images,
        'video_backup' => array_slice($candidates, 1),
    ];
    foreach (['width', 'height', 'quality'] as $key) if (isset($selected[$key])) $data[$key] = $selected[$key];
    $duration = $video['duration'] ?? $item['duration'] ?? null;
    if (is_numeric($duration) && $duration >= 0) $data['duration'] = (float)$duration;
    if (is_numeric($item['create_time'] ?? null) && $item['create_time'] > 0) $data['create_time'] = (int)$item['create_time'];
    $statistics = [];
    foreach (['like_count' => 'digg_count', 'comment_count' => 'comment_count', 'share_count' => 'share_count', 'play_count' => 'play_count', 'view_count' => 'view_count'] as $source => $target) {
        $count = $item['stats'][$source] ?? null;
        if (is_numeric($count) && $count >= 0) $statistics[$target] = (int)$count;
    }
    if ($statistics) $data['extra']['statistics'] = $statistics;
    return ['code' => 200, 'msg' => '解析成功', 'data' => $data];
}

function pipixia(string $url, ?callable $request = null): array
{
    if (!pipixiaShareUrl($url)) return pipixiaFailure(400, '请输入有效的皮皮虾分享链接', 'INVALID_URL');
    $request ??= 'pipixiaRequest';
    $deadline = microtime(true) + 20;
    $url = preg_replace('~^http://~i', 'https://', $url);
    try {
        $id = pipixiaItemId($url);
        for ($redirects = 0; $id === null && $redirects < 5; $redirects++) {
            $response = $request($url, max(1, (int)ceil($deadline - microtime(true))));
            if ($failure = pipixiaTransportFailure($response)) return $failure;
            if (($response['status'] ?? 0) < 300 || ($response['status'] ?? 0) >= 400) break;
            $url = pipixiaRedirect($url, (string)($response['location'] ?? ''));
            if ($url === null) return pipixiaFailure(502, '皮皮虾分享链接跳转异常', 'UPSTREAM_REDIRECT_INVALID');
            $id = pipixiaItemId($url);
            if (microtime(true) >= $deadline) return pipixiaFailure(504, '皮皮虾上游请求超时', 'UPSTREAM_TIMEOUT');
        }
        if ($id === null) return pipixiaFailure(400, '无法从皮皮虾分享链接识别作品，请重新复制分享链接', 'ITEM_ID_MISSING');
        // Legacy /item/ pages only contain a JS shell. The current page embeds the item itself.
        $response = $request('https://h5.pipix.com/ppx/item/' . $id, max(1, (int)ceil($deadline - microtime(true))));
        if ($failure = pipixiaTransportFailure($response)) return $failure;
        $item = pipixiaPageItem((string)$response['body']);
        if ($item === null) return pipixiaFailure(502, '皮皮虾页面未返回作品数据，可能暂时限制访问，请稍后重试', 'UPSTREAM_DATA_MISSING');
        return pipixiaItemResponse($item, $id);
    } catch (Throwable $error) {
        return pipixiaFailure(502, '皮皮虾解析暂时失败，请稍后重试', 'UPSTREAM_PARSE_FAILED');
    }
}

if (defined('DOKITOOL_PARSER_LIBRARY_ONLY')) return;
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json; charset=utf-8');
$url = $_GET['url'] ?? '';
$result = is_string($url) && $url !== '' ? pipixia($url) : pipixiaFailure(400, '链接不能为空', 'INVALID_URL');
echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
