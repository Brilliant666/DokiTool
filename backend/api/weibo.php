<?php
require_once __DIR__ . '/../lib/runtime.php';
/**
 *@Author: JH-Ahua
 *@CreateTime: 2026/4/30 23:27
 *@email: admin@bugpk.com
 *@blog: www.jiuhunwl.cn
 *@Api: api.bugpk.com
 *@tip: 微博视频解析。DokiTool: 官方匿名访客会话及真实画质元数据适配。
 */
@set_time_limit(60);
header('Access-Control-Allow-Origin: *');

function main()
{
    $params = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? $_POST : $_GET;
    $target = weiboTarget($params['url'] ?? null);
    if ($target === null) { outputError('请输入有效的微博视频或微博正文链接', 400); }
    outputSuccess(weiboFetchTarget($target));
}

/** Parse identity only; requests always go to fixed official API hosts. */
function weiboTarget($url): ?array
{
    if (!is_string($url) || strlen($url) > 8192 || preg_match('/[\\\\\x00-\x20\x7f]/', $url)) { return null; }
    $parts = parse_url($url);
    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)
        || isset($parts['user']) || isset($parts['pass'])
        || (isset($parts['port']) && !in_array($parts['port'], [80, 443], true))) { return null; }
    $host = strtolower($parts['host'] ?? '');
    $path = rawurldecode($parts['path'] ?? '');
    parse_str($parts['query'] ?? '', $query);
    $fid = null;
    if ($host === 'video.weibo.com' && rtrim($path, '/') === '/show') {
        $fid = $query['fid'] ?? null;
    } elseif (in_array($host, ['weibo.com', 'www.weibo.com'], true)) {
        if (preg_match('~^/tv/(?:show|v)/([^/]+)/?$~', $path, $match)) { $fid = $match[1]; }
        elseif (preg_match('~^/tv/(?:show|v)/?$~', $path)) { $fid = $query['fid'] ?? null; }
        elseif (preg_match('~^/\d+/([A-Za-z0-9]{1,32})/?$~', $path, $match)) { return ['kind' => 'status', 'id' => $match[1]]; }
    } elseif ($host === 'm.weibo.cn' && preg_match('~^/(?:status|detail)/([A-Za-z0-9]{1,32})/?$~', $path, $match)) {
        return ['kind' => 'status', 'id' => $match[1]];
    }
    return is_string($fid) && preg_match('/^\d{1,8}:(?:\d{16,24}|[a-fA-F0-9]{32})$/D', $fid)
        ? ['kind' => 'video', 'id' => $fid] : null;
}

function extractVideoId($url)
{
    $target = weiboTarget($url);
    return ($target['kind'] ?? '') === 'video' ? $target['id'] : '';
}

function getRequestHeaders($referer = 'https://weibo.com/')
{
    return ['Referer: ' . $referer, 'Accept: application/json, text/plain, */*',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'];
}

function fetchVideoInfo($videoId, $headers = [])
{
    return weiboFetchTarget(['kind' => 'video', 'id' => $videoId]);
}

function weiboFetchTarget(array $target): array
{
    $handle = curl_init();
    $deadline = microtime(true) + 35;
    curl_setopt_array($handle, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_ENCODING => '', CURLOPT_COOKIEFILE => '']); // Memory only; no Cookie jar file.
    $request = static function (string $url, ?string $post, string $referer) use ($handle, $deadline): array {
        $remaining = (int)ceil($deadline - microtime(true));
        if ($remaining <= 0) { return ['error' => true, 'status' => 0, 'body' => '', 'url' => $url]; }
        curl_setopt_array($handle, [CURLOPT_URL => $url, CURLOPT_TIMEOUT => min(20, $remaining), CURLOPT_HTTPHEADER => getRequestHeaders($referer)]);
        if ($post !== null) { curl_setopt_array($handle, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $post]); }
        else { curl_setopt($handle, CURLOPT_HTTPGET, true); }
        $body = snapCurlExec($handle, 2 * 1024 * 1024);
        return ['body' => $body === false ? '' : $body, 'error' => $body === false,
            'status' => (int)curl_getinfo($handle, CURLINFO_HTTP_CODE), 'url' => curl_getinfo($handle, CURLINFO_EFFECTIVE_URL)];
    };
    try { return weiboResolve($target, $request); }
    finally { curl_close($handle); }
}

/** One anonymous guest initialization at most, shared by component and status requests. */
function weiboResolve(array $target, callable $request): array
{
    $guestAttempted = false;
    if (($target['kind'] ?? '') === 'status') {
        $status = weiboJsonRequest($request, 'https://weibo.com/ajax/statuses/show?id=' . rawurlencode($target['id']), null, 'https://weibo.com/', $guestAttempted);
        return isset($status['failure']) ? $status['failure'] : formatWeiboStatusResponse($status['json']);
    }
    $fid = $target['id'];
    $component = weiboJsonRequest($request, 'https://weibo.com/tv/api/component?page=' . rawurlencode('/tv/show/' . $fid),
        'data=' . rawurlencode(json_encode(['Component_Play_Playinfo' => ['oid' => $fid]])), 'https://weibo.com/tv/show/' . $fid, $guestAttempted);
    if (isset($component['failure'])) { return $component['failure']; }
    $result = formatWeiboResponse($component['json']);
    if ($result['code'] !== 200) { return $result; }
    $mid = $component['json']['data']['Component_Play_Playinfo']['mid'] ?? null;
    if (is_scalar($mid) && preg_match('/^\d{1,24}$/D', (string)$mid)) {
        $status = weiboJsonRequest($request, 'https://weibo.com/ajax/statuses/show?id=' . rawurlencode((string)$mid), null, 'https://weibo.com/', $guestAttempted);
        // Optional metadata failure must not discard an already playable component.
        if (isset($status['json']['page_info']['media_info'])) { $result = formatWeiboResponse($component['json'], $status['json']); }
    }
    return $result;
}

function weiboTransportFailure(array $response): ?array
{
    if (!empty($response['error']) || ($response['status'] ?? 0) === 0) { return ['code' => 503, 'msg' => '微博接口暂时无法连接，请稍后重试']; }
    $status = (int)$response['status'];
    if (in_array($status, [401, 403, 429], true)) { return ['code' => 503, 'msg' => '微博当前限制匿名访问，请稍后重试']; }
    if ($status >= 400) { return ['code' => 502, 'msg' => '微博接口请求失败（HTTP ' . $status . '）']; }
    return null;
}

function weiboIsVisitor(array $response): bool
{
    return strtolower((string)parse_url($response['url'] ?? '', PHP_URL_HOST)) === 'passport.weibo.com'
        || preg_match('~^\s*(?:<!DOCTYPE[^>]*>\s*)?<(?:html|title)\b~i', $response['body'] ?? '')
            && str_contains($response['body'] ?? '', 'Sina Visitor System');
}

function weiboJsonp(string $body, string $callback): ?array
{
    $name = preg_quote($callback, '/');
    // Official responses use `window.callback && callback({...});`. Decode JSON only, never execute JavaScript.
    if (preg_match('/^\s*(?:(?:window\.)?' . $name . '\s*&&\s*)?' . $name . '\s*\((\{.*\})\);?\s*$/s', $body, $match)) { $body = $match[1]; }
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

function weiboStartGuest(callable $request, string $referer): bool
{
    // Public first-visit protocol verified against the official service; no CAPTCHA/login is attempted.
    // Protocol reference: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/weibo.py
    $response = $request('https://passport.weibo.com/visitor/genvisitor', http_build_query([
        'cb' => 'gen_callback', 'fp' => json_encode(['os' => '1', 'browser' => 'Chrome131,0,0,0',
            'fonts' => 'undefined', 'screenInfo' => '1920*1080*24', 'plugins' => '']),
    ]), $referer);
    if (weiboTransportFailure($response) !== null) { return false; }
    $visitor = weiboJsonp($response['body'], 'gen_callback');
    $data = $visitor['data'] ?? [];
    if (($visitor['retcode'] ?? 0) != 20000000 || !is_string($data['tid'] ?? null) || strlen($data['tid']) > 512 || $data['tid'] === '') { return false; }
    $response = $request('https://passport.weibo.com/visitor/visitor?' . http_build_query([
        'a' => 'incarnate', 't' => $data['tid'], 'w' => !empty($data['new_tid']) ? 3 : 2,
        'c' => sprintf('%03d', min(100, max(0, (int)($data['confidence'] ?? 100)))),
        'gc' => '', 'cb' => 'cross_domain', 'from' => 'weibo', '_rand' => random_int(1, 1000000) / 1000000,
    ]), null, $referer);
    return weiboTransportFailure($response) === null && (weiboJsonp($response['body'], 'cross_domain')['retcode'] ?? 0) == 20000000;
}

function weiboJsonRequest(callable $request, string $url, ?string $post, string $referer, bool &$guestAttempted): array
{
    $response = $request($url, $post, $referer);
    if (($failure = weiboTransportFailure($response)) !== null) { return ['failure' => $failure]; }
    if (weiboIsVisitor($response)) {
        if ($guestAttempted) { return ['failure' => ['code' => 503, 'msg' => '微博匿名访客会话仍受限制，请稍后重试']]; }
        $guestAttempted = true;
        if (!weiboStartGuest($request, $response['url'] ?? 'https://weibo.com/')) { return ['failure' => ['code' => 503, 'msg' => '微博匿名访客会话暂不可用，请稍后重试']]; }
        $response = $request($url, $post, $referer);
        if (($failure = weiboTransportFailure($response)) !== null) { return ['failure' => $failure]; }
        if (weiboIsVisitor($response)) { return ['failure' => ['code' => 503, 'msg' => '微博匿名访客会话仍受限制，请稍后重试']]; }
    }
    $json = json_decode($response['body'] ?? '', true);
    return is_array($json) ? ['json' => $json] : ['failure' => ['code' => 502, 'msg' => '微博返回了无法识别的接口响应，请稍后重试']];
}

function weiboCount($value): ?int
{
    if (is_string($value) && preg_match('/^\d{1,3}(?:,\d{3})+$/D', $value)) { $value = str_replace(',', '', $value); }
    return is_numeric($value) && is_finite((float)$value) && (float)$value >= 0 ? (int)$value : null;
}

function weiboCandidate($url, string $label, array $info = []): ?array
{
    $url = snapMediaUrl($url);
    if ($url === '') { return null; }
    $candidate = ['url' => $url, 'label' => $label, 'quality' => 'unknown'];
    foreach (['width' => 'width', 'height' => 'height', 'bitrate' => 'bit_rate', 'size' => 'size', 'fps' => 'fps'] as $source => $key) {
        if (($number = weiboCount($info[$source] ?? null)) !== null && $number > 0) { $candidate[$key] = $number; }
    }
    if (!isset($candidate['width'], $candidate['height'])) {
        parse_str(parse_url($url, PHP_URL_QUERY) ?? '', $query);
        if (is_string($query['template'] ?? null) && preg_match('/^(\d{2,5})x(\d{2,5})(?:\.|$)/', $query['template'], $resolution)) {
            $candidate['width'] = (int)$resolution[1]; $candidate['height'] = (int)$resolution[2];
        }
    }
    if (isset($candidate['width'], $candidate['height'])) { $candidate['quality'] = min($candidate['width'], $candidate['height']) . 'p'; }
    elseif (preg_match('/(\d{3,4})p/i', $label, $quality)) { $candidate['quality'] = $quality[1] . 'p'; }
    elseif (preg_match('/\b([248])k\b/i', $label, $quality)) { $candidate['quality'] = [2 => '1440p', 4 => '2160p', 8 => '4320p'][(int)$quality[1]]; }
    if (is_string($info['video_codecs'] ?? null) && $info['video_codecs'] !== '') { $candidate['codec'] = $info['video_codecs']; }
    return $candidate;
}

function weiboCandidates(array $videoInfo, array $status): array
{
    $media = $status['page_info']['media_info'] ?? [];
    if (!is_array($media)) { $media = []; }
    $candidates = [];
    foreach ((is_array($media['playback_list'] ?? null) ? $media['playback_list'] : []) as $playback) {
        $info = $playback['play_info'] ?? [];
        if (!is_array($info) || !is_string($info['mime'] ?? null) || !str_starts_with($info['mime'], 'video/')) { continue; }
        $label = $info['label'] ?? $info['quality_desc'] ?? '';
        $candidate = weiboCandidate($info['url'] ?? null, is_string($label) ? $label : '', $info);
        if ($candidate !== null) { $candidates[$candidate['url']] = $candidate; }
    }
    foreach ((is_array($videoInfo['urls'] ?? null) ? $videoInfo['urls'] : []) as $label => $url) {
        $candidate = weiboCandidate($url, (string)$label);
        if ($candidate !== null && !isset($candidates[$candidate['url']])) { $candidates[$candidate['url']] = $candidate; }
    }
    if (!$candidates) {
        foreach (['mp4_1080p_mp4', 'mp4_720p_mp4', 'mp4_hd_url', 'mp4_sd_url', 'stream_url_hd', 'stream_url'] as $key) {
            $candidate = weiboCandidate($media[$key] ?? null, $key);
            if ($candidate !== null) { $candidates[$candidate['url']] = $candidate; }
        }
    }
    $candidates = array_values($candidates);
    usort($candidates, static function (array $a, array $b): int {
        $rank = static fn (array $item): array => [(int)$item['quality'], ($item['width'] ?? 0) * ($item['height'] ?? 0), $item['bit_rate'] ?? 0];
        return $rank($b) <=> $rank($a);
    });
    return $candidates;
}

function formatWeiboStatusResponse(array $status): array
{
    if (isset($status['ok']) && !$status['ok']) { return ['code' => 503, 'msg' => '微博未返回可用的正文数据，可能暂时限制访问或作品不可见']; }
    if (!isset($status['id']) && !isset($status['idstr']) && !isset($status['page_info']['media_info'])) { return ['code' => 502, 'msg' => '微博返回的正文数据不完整']; }
    if (empty($status['page_info']['media_info'])) { return ['code' => 404, 'msg' => '该微博正文没有可用的视频']; }
    return weiboVideoResult([], $status);
}

function formatWeiboResponse(array $responseData, array $status = []): array
{
    if (($responseData['code'] ?? null) != 100000) { return ['code' => 503, 'msg' => '微博未返回可用的作品数据，可能暂时限制访问或作品不可见']; }
    $videoInfo = $responseData['data']['Component_Play_Playinfo'] ?? null;
    if (!is_array($videoInfo) || !$videoInfo) { return ['code' => 502, 'msg' => '微博返回的作品数据不完整']; }
    return weiboVideoResult($videoInfo, $status);
}

function weiboVideoResult(array $videoInfo, array $status): array
{
    $candidates = weiboCandidates($videoInfo, $status);
    if (!$candidates) { return ['code' => 404, 'msg' => '作品没有可用的视频地址']; }
    $media = $status['page_info']['media_info'] ?? [];
    $user = $status['user'] ?? [];
    $title = $videoInfo['title'] ?? $media['video_title'] ?? $status['text_raw'] ?? '';
    $extra = ['ip_info' => $videoInfo['ip_info_str'] ?? '', 'date' => $videoInfo['date'] ?? ''];
    $counts = ['play_count' => $media['online_users_number'] ?? $videoInfo['play_count'] ?? null,
        'digg_count' => $status['attitudes_count'] ?? $videoInfo['attitudes_count'] ?? null,
        'comment_count' => $status['comments_count'] ?? $videoInfo['comments_count'] ?? null,
        'share_count' => $status['reposts_count'] ?? $videoInfo['reposts_count'] ?? null];
    foreach ($counts as $key => $value) { if (($count = weiboCount($value)) !== null) { $extra['statistics'][$key] = $count; } }
    $tags = [];
    $componentTags = is_array($videoInfo['topics'] ?? null) ? $videoInfo['topics'] : [];
    $statusTags = is_array($status['topic_struct'] ?? null) ? $status['topic_struct'] : [];
    foreach (array_merge($componentTags, $statusTags) as $tag) {
        $name = $tag['content'] ?? $tag['topic_title'] ?? null;
        if (is_string($name) && trim($name) !== '') { $tags[] = trim($name); }
    }
    if ($tags) { $extra['hashtags'] = array_values(array_unique($tags)); }
    $data = ['type' => 'video', 'title' => $title, 'desc' => $status['text_raw'] ?? $title,
        'author' => ['name' => $videoInfo['author'] ?? $user['screen_name'] ?? '',
            'id' => (string)($videoInfo['author_id'] ?? $user['idstr'] ?? $user['id'] ?? ''),
            'avatar' => snapMediaUrl($videoInfo['avatar'] ?? $user['avatar_hd'] ?? $user['profile_image_url'] ?? null)],
        'cover' => snapMediaUrl($videoInfo['cover_image'] ?? $status['page_info']['page_pic'] ?? null),
        'duration' => is_numeric($videoInfo['duration_time'] ?? null) ? (float)$videoInfo['duration_time'] : (float)($media['duration'] ?? 0),
        'video_backup' => $candidates, 'extra' => $extra];
    foreach (['url', 'quality', 'width', 'height', 'bit_rate', 'codec', 'size', 'fps'] as $key) {
        if (isset($candidates[0][$key])) { $data[$key] = $candidates[0][$key]; }
    }
    $timestamp = is_string($status['created_at'] ?? null) ? strtotime($status['created_at']) : false;
    if (!$timestamp) { $timestamp = weiboCount($videoInfo['real_date'] ?? $media['video_publish_time'] ?? null); }
    if ($timestamp && $timestamp > 0) {
        $data['create_time'] = $timestamp;
        $data['publish_time'] = (new DateTimeImmutable('@' . $timestamp))->setTimezone(new DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i:s');
    }
    return ['code' => 200, 'msg' => '解析成功', 'data' => $data];
}

function outputSuccess($data)
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

function outputError($message, $code = 500)
{
    outputSuccess(['code' => $code, 'msg' => $message]);
    exit;
}

if (!defined('DOKITOOL_PARSER_LIBRARY_ONLY')) { main(); }
