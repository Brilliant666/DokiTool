# 部署与本地验证

此文档与 `ops/examples/` 都是通用示例，不包含生产配置、账号或凭据。仓库提交不会触发线上更新。

## 首页预渲染与 SEO 文件

生产必须使用 `cd frontend && npm ci && npm run build`，不要仅运行 `vite build`。构建会先生成客户端资源，再使用同一套 Vue 组件输出真实首页 HTML，并执行预渲染契约检查。仅发布 `frontend/dist/`；临时 `.ssg/` 不进入发布包，也不需要常驻 Node 渲染服务。

首页固定输出中文，客户端通过 hydration 接管后恢复语言偏好；英文偏好用户会在接管后切换文字。主题在样式加载前读取，输入框允许提前输入，解析及平台按钮在功能就绪前禁用并显示准备状态。粒子保持原视觉，在客户端挂载后启动。

`dist/robots.txt`、`dist/sitemap.xml` 和 `dist/social/dokitool-share-v1.png` 必须随包发布。Caddy 示例的精确文件路由让缺失文件返回 404，不能回退首页；部署维护方应将这些规则局部合入现有站点，校验配置后确认内容类型与实际内容。sitemap 当前仅包含真实首页，canonical、分享元数据和结构化数据使用 `https://snap.dokitool.com/`；部署到其他正式域名时需同步修改。

验收需确认 HTML 响应本身含主要内容、浏览器接管无 hydration 错误、提前输入未丢失、主题/语言偏好可恢复、解析正常。构建测试和本地延后加载脚本的功能验证不等同于真实弱网或 CPU 降速测试。

## 静态资源缓存与首次加载

`ops/examples/snap.caddy` 的前端路由为现存、文件名带 Vite hash 的 `/assets/` 文件设置一年 immutable 缓存；HTML 和其他文件使用 `no-cache` 校验更新。缺失的 `/assets/` 文件必须返回 404，不能返回并缓存 SPA HTML。API、微博签名媒体、认证与访问控制不纳入此缓存规则。已有 gzip 保留；不要对媒体响应添加压缩。

这是待合入生产的示例变更，不代表当前生产已应用。发布时由部署维护方将前端缓存部分合并到现有站点，先执行 Caddy 配置适配/校验，再分别检查首页、实际 hash 文件、缺失 chunk、API 和媒体响应；保留旧版静态文件，避免已打开页面的延迟加载引用失效。不要用仓库示例覆盖整份生产配置。

开发时 `npm run build && npm run check:load-budget` 检查真实产物依赖图：结果区与 ZIP 不进入首屏静态依赖，界面不依赖 webfont，首屏 JS gzip 预算 100 KB、CSS 16 KB、保守总资源预算 240 KB。总预算包含本地图标及 touch icon，即使部分图片由浏览器延迟请求。此检查是体积回归门槛，不是浏览器性能测量。

集中验收必须分别记录冷缓存和热缓存、普通网络和弱网、普通 CPU 和降速 CPU 的条件，以及桌面/手机、首屏视觉完整、可输入解析、布局跳动和首次解析结果显示。图标不应出现方框，字标不应露出半截；普通模式保留 50 颗粒子的颜色、大小与原 60 Hz 运动速度，后台暂停且回到页面不瞬移。低动态效果设置仍被尊重。

如果验收环境无法控制浏览器缓存、网络或 CPU，应分别记录为未验证；正常浏览器回归与构建体积检查不能替代这些条件。iPhone Safari/微信也需要真机复核，不能以桌面浏览器的手机宽度模拟代替。

## 服务结构

使用 Caddy 提供 HTTPS 与 `frontend/dist/` 静态文件。六个精确解析 API 路径交给 `backend/public/index.php`；另有固定的 `/api/media/weibo` 媒体入口，必须交给独立媒体 FPM 池。其他 `/api/*` 返回 JSON 404。不要公开整个源码目录，也不要把原始 `backend/api/` 作为静态根或任意 PHP 执行根。

聚合解析使用 HTTP 自请求到 loopback 内部 listener，再进入 `backend/internal/index.php`。采用独立服务账户和专用 PHP-FPM 实例，三个池分别服务公开解析、内部叶子解析及媒体传输。同一个池即使有多个 worker，也可能在聚合请求占满后互相等待。单进程 `php -S` 仅适合下文的两个独立测试服务，不适合生产。

PHP 使用受支持的 8.x 版本，启用 cURL、OpenSSL、JSON、PCRE/filter/标准流支持，并安装有效 CA 证书。无需 Composer 或数据库。三个池的 worker 数量、内存、超时和日志限制需按机器容量验证，示例数值不代表性能验收。

## 配置示例

先复制示例到自己的配置位置，再替换域名、路径、系统账户、socket 和权限。`snap.example.com` 是保留的示例域名，不代表任何生产站点。

- `ops/examples/snap.caddy`：公开静态站点、精确 API 和仅 loopback 的内部监听。
- `ops/examples/snap-fpm.conf`：公开解析、内部解析和媒体传输三个池。
- `ops/examples/snap-access.caddy.example`：默认返回 503 的关闭入口，选择访问策略后才替换。

访问控制必须覆盖 HTML、静态资源与 API。Caddy 外层 `route` 保证访问门先执行；不要将访问门与 `handle` 并列后依赖书写顺序，因为 Caddy 会重新排序。发布路径使用版本软链时，示例的 `resolve_root_symlink` 可让 FastCGI 使用实际根目录。修改后对实际安装版本执行配置检查，保留局部配置及上一版本以便回退。

| 变量 | 用途 |
| --- | --- |
| `VITE_API_MODE=php` | 前端构建模式；基础 PHP 不实现旧加密会话协议 |
| `VITE_API_BASE_URL=` | 空表示同源 API；若跨域，另行配置明确的跨域策略 |
| `DEV_API_TARGET` | 仅本地 Vite 开发代理的 PHP 网关地址 |
| `SNAP_INTERNAL_ORIGIN=http://127.0.0.1:9081` | 显式 loopback HTTP origin，部署时核对端口 |
| `SNAP_INTERNAL_HOST=snap.example.com` | 必须与内部 Caddy host matcher 一致；显式配置，不依赖源码默认值 |
| `SNAP_MEDIA_SIGNING_KEY` | 公开解析池与媒体池共用的服务端随机密钥，至少 32 字节；内部解析池和前端不接触该值 |

PHP-FPM 保持 `clear_env=yes`，只传必要变量。不要继承生产密码、供应商凭据或其他应用的环境。源文件只读，临时目录独立授权；FastCGI socket 不开放公网。

## 出网与媒体边界

TLS 校验、入口域名检查、连接超时和跳转数量上限都已实施，但上游仍有跟随/手动重定向及 DNS 行为，不能据此认为已具备完整 SSRF 防护。解析服务需要独立出网限制，同时覆盖 IPv4/IPv6、loopback、私网、链路本地、云元数据及保留地址；只例外允许必要 DNS 和受控内部 HTTP 通道。使用网络命名空间或容器时也需验证等价边界。文件访问限制不能代替网络隔离。

除微博外，普通播放/下载直连返回的媒体 URL，仍受 CORS、防盗链、签名时效、Range 和浏览器策略影响。微博采用下述限定来源的签名传输服务，不启用原始 `svproxyurl.php` 开放代理。Cookie 主页、Python/Flask 网易云、其他可选模块不在本仓库维护范围。真实平台的匿名可用性和高级清晰度需单独验证；固定样例通过不是平台成功率证明。

抖音解析会额外探测程序生成的原始播放入口，以识别实际分辨率和视频码率，并返回最终 CDN 地址，避免浏览器必须经过缺少 CORS 头的原始 302 入口。探测由纯 PHP 完成，无需安装 ffprobe；只读取文件头和 MP4 元数据，不缓存或中转整段视频。限制为最多三次跳转、十二次请求、1 MiB 正文，cURL 共享六秒截止预算；系统 DNS 解析仍由操作系统的解析器超时控制。每跳限制 HTTPS 官方媒体域名、校验所有 DNS 地址为公网并固定连接 IP，继承现有部署出网隔离。失败时保留已知可用主源，不阻断整次解析。

## 微博播放与下载

微博 CDN 对部分视频校验微博来源请求头，普通浏览器页面不能代替来源站发送该头。公开解析层对已成功解析的、属于固定 `f.video.weibocdn.com` HTTPS 主源及备用源签发 30 分钟票据；媒体层校验票据后设置固定微博来源，按流传输。没有任意 `url=` 转发入口，不允许重定向或继承系统代理，DNS 结果必须全部为公网地址并固定到本次 cURL 连接，TLS 校验保持开启。现有双栈出网隔离仍须覆盖媒体池账户。

部署此版本前，必须完成以下配置，不能只替换前端：

1. 在仓库和 Web 根之外生成随机服务端密钥（例如 `openssl rand -hex 32` 的结果），以仅管理员可读的服务环境文件提供给专用 FPM 主进程。通过示例中的 `env[...]` 仅向公开解析池和媒体池传递；两池必须一致。不要放入 `VITE_*`、Git、URL、浏览器或日志。缺少有效密钥时，微博公开解析明确返回 503，不伪装为可播放成功。
2. 新增独立 `snap-media` 池，示例最多 2 个 worker、64 MiB 内存、310 秒终止期限；媒体代码单次传输上限 300 秒、单资源 1 GiB。保持解析池的较短超时与独立容量。源文件只读，传输不会缓存完整视频到服务器磁盘或内存。
3. 将精确 `/api/media/weibo` 路由指向该池，保持所有既有访问控制和限流覆盖它。排除压缩和额外响应缓冲，保留准确 `Content-Length`、`Content-Range`、`Accept-Ranges`；示例 100 ms 刷新保留客户端断开时的取消行为。Caddy/FPM 超时需大于代码传输期限。
4. 不在访问日志中记录完整票据查询串；票据是短期下载凭证。响应使用 `no-store`，不要让 CDN 缓存这些地址。密钥轮换会立即使已有票据失效，重新解析即可取得新票据。超过 30 分钟或上游 URL 已过期时，同样需要重新解析。
5. 固定新版本提交后验收真实解析 → 主源播放 → 拖动 → 切换画质 → 完整下载，核对媒体尺寸、大小/哈希及失败反馈；另检查无票据、改票据、过期票据、非法 Range、HEAD、206/416和客户端取消。

Caddy 参数依据：[php_fastcgi](https://caddyserver.com/docs/caddyfile/directives/php_fastcgi)、[reverse_proxy streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)。示例是待部署配置，仓库通过检查不代表生产已经启用。

## 本地 HTTP 验证

`backend/tests/mock-internal.php` 不访问真实媒体平台。使用两个独立的本机终端，保持 loopback 绑定，不将测试 router 部署到公网。

1. 先核对 19186/19187 空闲。
2. 第一个终端启动内部 mock：

```sh
php -S 127.0.0.1:19187 -t backend/tests backend/tests/mock-internal.php
```

3. 单独检查其健康响应：

```sh
curl -H 'Host: snap.dokitool.com' 'http://127.0.0.1:19187/parse/douyin?url=https%3A%2F%2Fv.douyin.com%2Ffixture'
```

4. 第二个终端为公开网关设置测试环境，再启动：

```sh
export SNAP_INTERNAL_ORIGIN=http://127.0.0.1:19187
export SNAP_INTERNAL_HOST=snap.dokitool.com
export SNAP_MEDIA_SIGNING_KEY=local-fixture-only-at-least-32-bytes
php -S 127.0.0.1:19186 -t backend/public backend/public/index.php
```

以上 `export` 是 POSIX shell 语法；PowerShell 分别使用 `$env:SNAP_INTERNAL_ORIGIN='http://127.0.0.1:19187'`、`$env:SNAP_INTERNAL_HOST='snap.dokitool.com'` 和 `$env:SNAP_MEDIA_SIGNING_KEY='local-fixture-only-at-least-32-bytes'`。该 Host 只是固定样例参数，HTTP 流量仍只发送到 loopback，不请求该域名。

5. 单独检查公开入口并运行 `php backend/tests/http-smoke.php http://127.0.0.1:19186`。当前套件含九平台分发、微博票据签发、固定 Host/URL/路径、错误响应/重定向、真实无效输入业务拒绝和封闭路径；示例签名值仅用于假媒体固定样例，不得作为生产密钥。
6. 分别停止两个服务，确认退出。离线 CLI 套件包含连接失败场景，应在这两个服务停止后运行。

这些检查不验证生产 Caddy/FPM、真实平台或出网隔离。本地运行时、测试响应、原始日志与备份不提交到 Git。
