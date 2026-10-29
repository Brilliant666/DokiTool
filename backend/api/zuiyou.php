<?php
require_once __DIR__ . '/../lib/runtime.php';
/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/3/31 上午11:25
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 最右解析
 */
header("Access-Control-Allow-Origin: *");
header('Content-Type: application/json; charset=utf-8');

/**
 * 构建统一格式的响应数组
 * @param int $code 状态码
 * @param string $msg 消息描述
 * @param array $data 附加数据
 * @return array 响应数组
 */
function outputJson(int $code, string $msg, array $data = []): array
{
    return [
        'code' => $code,
        'msg' => $msg,
        'data' => $data
    ];
}

/**
 * 从URL中提取指定参数
 * @param string $url 原始URL
 * @param string $param 要提取的参数名
 * @return string|null 参数值或null
 */
function getParamFromUrl(string $url, string $param): ?string
{
    $parsedUrl = parse_url($url);
    if (!isset($parsedUrl['query'])) {
        return null;
    }

    parse_str($parsedUrl['query'], $queryParams);
    return is_string($queryParams[$param] ?? null) ? $queryParams[$param] : null;
}

/**
 * 获取URL重定向后的最终地址
 * @param string $url 原始URL
 * @return string|null 重定向后的URL或null
 */
function getRedirectUrl(string $url): ?string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HEADER => true,
        CURLOPT_NOBODY => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_NOSIGNAL => 1,
        CURLOPT_LOW_SPEED_LIMIT => 256,
        CURLOPT_LOW_SPEED_TIME => 6,
        CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    ]);

    $response = snapCurlExec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // 处理3xx重定向状态码
    if ($httpCode >= 300 && $httpCode < 400) {
        if (preg_match('/Location: (.*?)\r\n/', $response, $matches)) {
            $redirectUrl = trim($matches[1]);
            // 处理相对路径
            if (strpos($redirectUrl, 'http') !== 0) {
                $parsedOriginal = parse_url($url);
                $redirectUrl = $parsedOriginal['scheme'] . '://' . $parsedOriginal['host'] . $redirectUrl;
            }
            return $redirectUrl;
        }
    }

    // 无重定向或获取失败，返回原URL
    return $url;
}

/**
 * 从URL或其重定向地址中提取指定参数
 * @param string $url 原始URL
 * @param string $param 要提取的参数名
 * @return string|null 提取到的参数值或null
 */
function getParamFromUrlWithRedirect(string $url, string $param): ?string
{
    // 先尝试从原始URL提取参数
    $value = getParamFromUrl($url, $param);
    if (!empty($value)) {
        return $value;
    }

    // 原始URL无参数，获取重定向后的URL再尝试提取
    $redirectUrl = getRedirectUrl($url);
    if ($redirectUrl && $redirectUrl !== $url) {
        $value = getParamFromUrl($redirectUrl, $param);
        if (!empty($value)) {
            return $value;
        }
    }

    return null;
}

/**
 * curl请求处理函数
 * @param string $url 请求URL
 * @param array|null $headers 请求头
 * @param mixed|null $data POST数据
 * @return string|false 响应结果或false
 */
function curlRequest(string $url, ?array $headers = null, $data = null)
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HEADER => false,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_AUTOREFERER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_NOSIGNAL => 1,
        CURLOPT_LOW_SPEED_LIMIT => 256,
        CURLOPT_LOW_SPEED_TIME => 8,
        CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    ]);

    if (isset($headers)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    }

    if (isset($data)) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
    }

    $result = snapCurlExec($ch);

    if ($result === false) {
        $error = curl_error($ch);
        curl_close($ch);
        trigger_error("cURL error: $error", E_USER_WARNING);
        return false;
    }

    curl_close($ch);
    return $result;
}

function zuiyouResponse(array $data): array
{
    $post = $data['data']['post'] ?? null;
    if (!is_array($post) || !$post) { return outputJson(404, '作品不存在或暂时不可用'); }
    $member = is_array($post['member'] ?? null) ? $post['member'] : [];
    $images = is_array($post['imgs'] ?? null) ? $post['imgs'] : [];
    $videos = is_array($post['videos'] ?? null) ? $post['videos'] : [];
    $first = $images[0] ?? [];
    $id = $first['id'] ?? null;
    $video = $id !== null ? ($videos[$id] ?? null) : null;
    if (!is_array($video)) { $video = $videos ? reset($videos) : []; }
    $url = snapMediaUrl(is_array($video) ? ($video['url'] ?? null) : null);
    $pictures = [];
    foreach ($images as $image) {
        $urls = is_array($image['urls'] ?? null) ? $image['urls'] : [];
        $best = $urls['origin'] ?? $urls['large'] ?? ($urls ? reset($urls) : []);
        $picture = snapMediaUrl($best['urls'][0] ?? null);
        if ($picture !== '') { $pictures[] = $picture; }
    }
    // Missing video IDs must not be overwritten by a successful empty response.
    if ($url === '' && ($videos || !$pictures)) { return outputJson(404, '作品没有可用的媒体地址'); }
    $result = [
        'type' => $url !== '' ? 'video' : 'image', 'author' => $member['name'] ?? '',
        'avatar' => snapMediaUrl($member['avatar_urls']['origin']['urls'][0] ?? null),
        'title' => $post['content'] ?? '',
        'cover' => snapMediaUrl($first['urls']['540_webp']['urls'][0] ?? ($pictures[0] ?? null)),
        'url' => $url !== '' ? $url : null,
    ];
    if ($url === '') { $result['images'] = $pictures; }
    return outputJson(200, '解析成功', $result);
}

function parseZuiyou(string $url): array
{
    if (!filter_var($url, FILTER_VALIDATE_URL)) { return outputJson(400, '请输入有效的URL'); }
    $pid = getParamFromUrl($url, 'pid');
    if (!$pid && preg_match('~/detail/([0-9]+)~', (string)parse_url($url, PHP_URL_PATH), $match)) { $pid = $match[1]; }
    if (!$pid) { $pid = getParamFromUrlWithRedirect($url, 'pid'); }
    if (!is_string($pid) || !preg_match('/^[1-9][0-9]{0,18}$/D', $pid)) {
        return outputJson(400, '找不到有效的pid参数');
    }
    $body = curlRequest('https://share.xiaochuankeji.cn/planck/share/post/detail_h5',
        ['Content-Type: application/json', 'Accept: application/json'],
        json_encode(['pid' => (int)$pid, 'h_av' => '5.2.13.011']));
    if ($body === false) { return outputJson(502, 'API请求失败'); }
    $data = json_decode($body, true);
    return is_array($data) ? zuiyouResponse($data) : outputJson(502, 'API响应解析失败');
}

if (!defined('DOKITOOL_PARSER_LIBRARY_ONLY')) {
    $input = $_GET['url'] ?? '';
    echo json_encode(is_string($input) && $input !== '' ? parseZuiyou($input) : outputJson(400, '请输入url'), 480);
}
