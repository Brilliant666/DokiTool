# API 合同

所有公开入口仅接受 GET，查询参数 `url` 是分享 URL 或包含分享 URL 的文本。路径固定，不能用用户输入选择任意 PHP 文件。

| 路径 | 平台/入口 |
| --- | --- |
| `/api/short_videos` | 识别域名后分发到内部单平台入口 |
| `/api/douyin` | 抖音 |
| `/api/ksjx` | 快手 |
| `/api/bilibili` | B 站旧版解析器 `bilibili/bilibili.php` |
| `/api/xhsjx` | 小红书 |
| `/api/toutiao` | 头条 |

聚合入口另支持微博、皮皮虾、皮皮搞笑、最右。只有 `backend/lib/gateway.php` 列出的平台域名可进入对应解析器；`url` 的完整查询参数会保留，包含 B 站 `p=N`。

典型响应：

```json
{"code":200,"msg":"success","data":{"title":"示例作品","url":"https://media.example/video.mp4","images":[],"live_photo":[],"video_backup":[]}}
```

必须同时检查 HTTP 状态与业务 `code`。HTTP 200 可能携带 `code:404/201/-1/0` 等业务失败。未知路由、方法或输入被网关拒绝；HTML、JSON 标量和无业务码响应转成 502；无可用媒体在前端显示错误。

`data` 仍可包含 `images`、`live_photo`、`video_backup`、`music`、`videos`、`extra.pages` 与合集信息。B 站顶层 URL 不一定代表输入的分 P，客户端应根据请求页码和 `videos[].index` 选择，不能给失败分 P 借用其他直链。

内部入口为 `/parse/{platform}`，只用于受控 loopback HTTP，要求固定 Host 与 loopback 来源；它不能再次分发聚合入口。公开层与内部层需使用不同 FPM 池。相关配置见 [部署说明](DEPLOYMENT.md)。

`/api/v1/session`、`/api/v1/parse`、原始 PHP 路径、媒体代理、抖音主页和网易云服务不属于本项目公开 API。
