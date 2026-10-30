<?php
require_once __DIR__ . '/../../lib/runtime.php';
/**
 * @Author: JH-Ahua
 * @CreateTime: 2025/12/29 下午6:52
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: bilibili解析-旧版
 */
/** Resolve just the requested part; other parts remain available for lazy parsing. */
function parseBilibili(string $source): array
{
    $deadline = microtime(true) + 35;
    $url = cleanUrlParameters($source);
    $parts = parse_url($url);
    if (!$parts || !isset($parts['host'])) {
        return ['code' => -1, 'msg' => '视频链接不正确'];
    }
    if (strtolower($parts['host']) === 'b23.tv') {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_NOBODY => true, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 10]);
        $ok = snapCurlExec($ch);
        $target = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);
        if ($ok === false || $target === '') {
            return ['code' => 502, 'msg' => 'B站短链接解析失败，请重试或使用完整视频链接'];
        }
        $url = bilibiliRedirectTarget($url, $target);
        $parts = parse_url($url);
    }
    if (!in_array(strtolower($parts['host'] ?? ''), ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'], true)
        || !str_starts_with($parts['path'] ?? '', '/video/')) {
        return ['code' => -1, 'msg' => '好像不是视频链接'];
    }
    parse_str($parts['query'] ?? '', $query);
    if (isset($query['p']) && (!is_string($query['p']) || !preg_match('/^[1-9][0-9]{0,5}$/D', $query['p']))) {
        return ['code' => 400, 'msg' => '分P序号无效'];
    }
    $requested = (int)($query['p'] ?? 1);
    preg_match('~/video/(BV[a-zA-Z0-9]{10})(?:/|$)~', $parts['path'], $match);
    $bvid = $match[1] ?? extractBilibiliBVId(getFinalHtmlContent($url, max(1, min(10, (int)floor($deadline - microtime(true))))));
    if (!$bvid) {
        return ['code' => 404, 'msg' => '获取视频ID失败'];
    }
    // Use an ordinary server request. Spoofed browser headers triggered HTTP 412
    // on the deployment host; neither a personal Cookie nor a proxy is required.
    $view = bilibiliApiRequest('https://api.bilibili.com/x/web-interface/view?bvid=' . $bvid, $deadline);
    if (!is_array($view) || ($view['code'] ?? null) !== 0 || !is_array($view['data'] ?? null)) {
        return bilibiliFailure($view, '视频信息');
    }
    return buildBilibiliResponse($view['data'], $bvid, $requested, static function ($cid) use ($bvid, $deadline) {
        $api = 'https://api.bilibili.com/x/player/playurl?' . http_build_query([
            'otype' => 'json', 'fnver' => 0, 'fnval' => 3, 'player' => 3, 'qn' => 112,
            'bvid' => $bvid, 'cid' => $cid, 'platform' => 'html5', 'high_quality' => 1,
        ]);
        return bilibiliApiRequest($api, $deadline);
    });
}

function bilibiliRedirectTarget(string $source, string $target): string
{
    parse_str((string)parse_url($source, PHP_URL_QUERY), $originalQuery);
    $target = cleanUrlParameters($target);
    if (array_key_exists('p', $originalQuery)) {
        $parts = parse_url($target);
        parse_str($parts['query'] ?? '', $query);
        $query['p'] = $originalQuery['p'];
        $target = preg_replace('/[?#].*$/', '', $target) . '?' . http_build_query($query);
    }
    return $target;
}

function buildBilibiliResponse(array $detail, string $bvid, int $requested, callable $fetchPlay): array
{
    $pages = is_array($detail['pages'] ?? null) ? $detail['pages'] : [];
    $selected = null;
    foreach ($pages as $i => $page) {
        if (is_array($page) && (int)($page['page'] ?? $i + 1) === $requested) { $selected = $page; break; }
    }
    if (!$selected || empty($selected['cid'])) {
        return ['code' => 404, 'msg' => '请求的分P不存在'];
    }
    $play = $fetchPlay($selected['cid']);
    $stream = is_array($play) ? ($play['data']['durl'][0] ?? []) : [];
    $url = snapMediaUrl($stream['url'] ?? null);
    $playError = null;
    if (($play['code'] ?? null) !== 0 || ($url === '' && empty($play['data']['dash']['video']))) {
        $playError = bilibiliFailure(is_array($play) ? $play : [], '当前分P播放源');
    }
    $pageUrl = 'https://www.bilibili.com/video/' . rawurlencode($bvid) . '/';
    $videos = [];
    foreach ($pages as $i => $page) {
        if (!is_array($page)) { continue; }
        $number = (int)($page['page'] ?? $i + 1);
        $duration = max(0, (int)($page['duration'] ?? 0));
        $videos[] = [
            'title' => (string)($page['part'] ?? 'P' . $number), 'duration' => $duration,
            'durationFormat' => gmdate('H:i:s', $duration), 'index' => $number, 'page' => $number,
            'cid' => (string)($page['cid'] ?? ''), 'url' => $number === $requested ? $url : '',
            'pageUrl' => $pageUrl . '?p=' . $number, 'lazyResolve' => $number !== $requested,
        ];
    }
    $backups = [];
    foreach (is_array($stream['backup_url'] ?? null) ? $stream['backup_url'] : [] as $backup) {
        if (snapMediaUrl($backup) && $backup !== $url) { $backups[] = ['url' => snapMediaUrl($backup), 'label' => '备用线路']; }
    }
    $quality = bilibiliQuality($play['data'] ?? []);
    foreach ($backups as &$backup) { $backup['quality'] = $quality; }
    unset($backup);
    $data = [
        'type' => 'video', 'title' => $detail['title'] ?? '', 'cover' => $detail['pic'] ?? '',
        'description' => $detail['desc'] ?? '', 'url' => $url, 'pageUrl' => $pageUrl . '?p=' . $requested,
        'user' => ['name' => $detail['owner']['name'] ?? '', 'avatar' => $detail['owner']['face'] ?? ''],
        'video_backup' => $backups, 'duration' => $selected['duration'] ?? null, 'quality' => $quality,
        'extra' => ['pages' => $pages, 'current_page' => $requested, 'bvid' => $bvid],
        'private_play' => is_array($play['data'] ?? null) ? $play['data'] : [],
    ];
    if ($playError) $data['private_error'] = $playError;
    if (is_array($detail['ugc_season'] ?? null)) $data['private_collection'] = $detail['ugc_season'];
    // View dimensions describe the uploaded original, not necessarily the
    // anonymously available playback stream. Never label a 720p URL as 4K.
    if (is_array($selected['dimension'] ?? null)) { $data['extra']['source_dimension'] = $selected['dimension']; }
    if (isset($detail['pubdate']) && is_numeric($detail['pubdate'])) { $data['create_time'] = (int)$detail['pubdate']; }
    foreach (['view' => 'play_count', 'reply' => 'comment_count', 'favorite' => 'collect_count', 'share' => 'share_count', 'like' => 'digg_count'] as $key => $normalized) {
        if (isset($detail['stat'][$key]) && is_numeric($detail['stat'][$key])) { $data['extra']['statistics'][$normalized] = $detail['stat'][$key]; }
    }
    if (count($videos) > 1) { $data['videos'] = $videos; $data['totalVideos'] = count($videos); }
    return ['code' => 200, 'msg' => '解析成功', 'data' => $data];
}

if (!defined('DOKITOOL_PARSER_LIBRARY_ONLY')) {
    header('Content-Type: application/json; charset=utf-8');
    $input = $_GET['url'] ?? '';
    $result = is_string($input) && $input !== '' ? parseBilibili($input) : ['code' => 201, 'msg' => '链接不能为空'];
    echo json_encode($result, 480);
}

/**
 * 获取网页代码，自动跟随重定向直到最终页面
 *
 * @param string $url 目标网页URL
 * @param int $timeout 超时时间（秒），默认30秒
 * @param int $maxRedirects 最大重定向次数，默认10次
 * @return string|false 成功返回HTML代码，失败返回false
 */
function getFinalHtmlContent($url, $timeout = 30, $maxRedirects = 10)
{
// 验证URL格式
    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        trigger_error('无效的URL地址', E_USER_WARNING);
        return false;
    }

// 初始化curl
    $ch = curl_init();
    if (!$ch) {
        trigger_error('curl初始化失败', E_USER_WARNING);
        return false;
    }

// 设置curl选项
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,                      // 请求的URL
        CURLOPT_RETURNTRANSFER => true,           // 将响应内容以字符串返回，而不是直接输出
        CURLOPT_FOLLOWLOCATION => true,           // 启用跟随重定向
        CURLOPT_MAXREDIRS => $maxRedirects,       // 最大重定向次数
        CURLOPT_TIMEOUT => $timeout,              // 请求超时时间
        CURLOPT_CONNECTTIMEOUT => $timeout,       // 连接超时时间
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', // 模拟浏览器UA
        CURLOPT_SSL_VERIFYPEER => true,          // 校验 HTTPS 证书
        CURLOPT_SSL_VERIFYHOST => 2,          // 校验 HTTPS 主机名
        CURLOPT_HEADER => false,                  // 不返回响应头
        CURLOPT_ENCODING => '',                   // 支持所有编码格式
    ]);

// 执行请求并获取响应内容
    $htmlContent = snapCurlExec($ch);

// 检查是否有错误发生
    if (curl_errno($ch)) {
        trigger_error('curl请求错误: ' . curl_error($ch), E_USER_WARNING);
        $htmlContent = false;
    }

// 获取最终的URL（确认是否重定向）
    $finalUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    if ($finalUrl !== $url) {
// 可选：输出重定向信息，方便调试
// echo "原URL: $url -> 最终URL: $finalUrl\n";
    }

// 关闭curl资源
    curl_close($ch);

    return $htmlContent;
}

/**
 * 从B站视频页面的meta标签中提取BV号
 *
 * @param string $html 包含目标meta标签的HTML字符串
 * @return string|null 提取到的BV号，匹配失败返回null
 */
function extractBilibiliBVId($html)
{
    // 空值检查
    if (empty($html)) {
        return null;
    }

    // 正则表达式匹配规则：
    // 1. 匹配包含 itemprop="url" 的meta标签
    // 2. 捕获 content 属性中 https://www.bilibili.com/video/ 后的BV号
    // 3. BV号格式：以BV开头，后跟10位字母/数字组合（B站BV号固定12位：BV + 10位字符）
    $pattern = '/<meta\s+[^>]*itemprop="url"\s+[^>]*content="https:\/\/www\.bilibili\.com\/video\/(BV[a-zA-Z0-9]{10})\/?"[^>]*>/i';

    // 执行正则匹配
    $matchResult = preg_match($pattern, $html, $matches);

    // 检查匹配结果
    if ($matchResult === 1 && isset($matches[1])) {
        return $matches[1]; // 返回提取到的BV号
    } elseif ($matchResult === 0) {
        return null;
    } else {
        return null;
    }
}

function bilibiliApiRequest(string $url, ?float $deadline = null): array
{
    $timeout = $deadline === null ? 20 : min(20, (int)floor($deadline - microtime(true)));
    if ($timeout < 1) { return bilibiliDecodeResponse(false, 0, CURLE_OPERATION_TIMEDOUT); }
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_ENCODING, '');
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    $output = snapCurlExec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $errno = curl_errno($ch);
    curl_close($ch);
    return bilibiliDecodeResponse($output, $status, $errno);
}

function bilibiliDecodeResponse($body, int $status, int $errno): array
{
    $json = is_string($body) ? json_decode($body, true) : null;
    $result = is_array($json) ? $json : [];
    $result['_http_status'] = $status;
    $result['_transport_errno'] = $errno;
    if (($errno !== 0 || $status !== 200) && ($result['code'] ?? 0) === 0) { $result['code'] = -1; }
    return $result;
}

function bilibiliFailure(array $response, string $stage): array
{
    $http = (int)($response['_http_status'] ?? 200);
    $upstream = $response['code'] ?? null;
    if (in_array($http, [401, 403, 412, 429], true) || in_array($upstream, [-352, -412, -401, -403, -101], true)) {
        return ['code' => 503, 'msg' => 'B站暂时限制当前服务器访问（' . $stage . '），请稍后重试'];
    }
    if (in_array($upstream, [-400, -404, 62002, 62004], true) || $http === 404) {
        return ['code' => 404, 'msg' => 'B站作品不存在、已删除或当前不可见'];
    }
    if (($response['_transport_errno'] ?? 0) !== 0 || $http !== 200 || $upstream === null) {
        return ['code' => 502, 'msg' => 'B站上游连接或响应异常（' . $stage . '），请稍后重试'];
    }
    return ['code' => 404, 'msg' => '请求的分P暂时无法获取视频链接'];
}

function bilibiliQuality(array $play): string
{
    return [6 => '240p', 16 => '360p', 32 => '480p', 64 => '720p', 74 => '720p60',
        80 => '1080p', 112 => '1080p+', 116 => '1080p60', 120 => '4K', 125 => 'HDR',
        126 => 'Dolby Vision', 127 => '8K'][(int)($play['quality'] ?? 0)] ?? 'unknown';
}

function cleanUrlParameters($url)
{
    // Tracking parameters are harmless; preserving p is required for exact-part selection.
    return is_string($url) ? preg_replace('/#.*$/', '', trim($url)) : '';
}
