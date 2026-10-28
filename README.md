# DokiTool

DokiTool 是整合 Vue 3 前端与 PHP 解析接口的短视频工具，支持视频、图片、实况照片、备用媒体地址及 B 站分 P 的展示和下载交互。

本项目在两个指定上游快照上独立维护，采用选择性适配，并非 GitHub Fork 或上游仓库的完整镜像：

| 组件 | 上游 | 采用版本 |
| --- | --- | --- |
| PHP 解析器 | [jiuhunwl/short_videos](https://github.com/jiuhunwl/short_videos) | `72e5b6e72ab21e695d510e1c4c45213ce9a25f0f` |
| Vue 前端 | [jiuhunwl/shortvideo-html](https://github.com/jiuhunwl/shortvideo-html) | `cd16011960fe90b53dd87f57714d1a096e986e5a`，包版本 `4.1.0` |

原作者的许可证与版权声明保留在 [backend/LICENSE](backend/LICENSE)、[frontend/LICENSE](frontend/LICENSE) 和源码注释中；新增适配代码采用 [MIT](LICENSE)。依赖许可见 [NOTICE](NOTICE) 及 [frontend/public/licenses](frontend/public/licenses)。详细来源记录在 [UPSTREAM.json](UPSTREAM.json)，人工引入更新的方法见 [上游维护说明](docs/UPSTREAM-MAINTENANCE.md)。

## 目录

- `frontend/`：Vue 3、TypeScript、Vite 界面与契约测试。
- `backend/`：PHP 控制器、明确启用的平台解析器及离线测试。
- `ops/examples/`：脱敏的 Caddy/PHP-FPM 配置示例。
- `docs/`：[API 合同](docs/API.md)、[部署说明](docs/DEPLOYMENT.md)和上游维护说明。
- `scripts/`：依赖许可整理与公开文件清单检查工具。

`public-files.json` 明确列出公开文件，`.gitignore` 默认忽略未列出的本地资料。新增源码时先审查并加入清单，再运行 `python scripts/check-public-files.py --write-ignore`；提交前用 `python scripts/check-public-files.py --staged` 核对暂存内容。本地备份、凭据、运行日志、生产配置和构建产物不进入仓库。

## 本地构建

准备 Node.js（Vite 5 要求 Node 18+，建议使用受支持的 LTS）、npm，以及 Python 3.10+。生产环境只需前端静态文件和 PHP-FPM，不需要常驻 Vite 开发服务器。

```sh
cd frontend
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm run build
cd ..
python scripts/third-party-notices.py
```

构建产物在 `frontend/dist/`，不会提交到 Git。锁文件固定依赖版本和完整性信息；部分上游锁定下载地址使用 npm 镜像，命令行 registry 不会替换所有锁定地址。

默认 `VITE_API_MODE=php`、`VITE_API_BASE_URL` 为空，浏览器请求同源 `/api/*`。可参考 `frontend/.env.example`。设置 API origin 不会自动启用加密协议；仅显式 `secure` 模式使用另行实现的 `/api/v1` 协议，基础 PHP 后端不提供该协议。

## 本地检查

PHP 8.0+，启用 cURL、OpenSSL、JSON 和标准扩展；本地已验证 PHP 8.4。用已安装的 PHP 可执行文件运行：

```sh
php backend/tests/contract.php
python backend/tests/validate.py --php /path/to/php --output .local/backend-validation.json
python scripts/check-public-files.py
```

Windows 的 `--php` 可使用 PHP 可执行文件的完整路径。`validate.py` 只运行离线契约、语法和 CLI 场景，不启动服务，也不请求真实媒体平台。两进程 HTTP 夹具的使用方式见 [部署说明中的本地 HTTP 验证](docs/DEPLOYMENT.md#本地-http-验证)。

本地适配验证曾通过 8 组前端契约、70 项 PHP 契约、9 项 CLI 场景及 18 项公开 PHP 到本地 mock 的 HTTP 检查。它们证明的是固定样例下的行为，不能证明真实平台当前成功率或媒体 CDN 可下载性。仓库发布与线上服务发布分别进行，本仓库不会自动部署或定时覆盖上游。

## 适配与边界

默认 API 由本站 PHP 提供；修复了 HTTP 200 业务失败误判、B 站失败分 P 借用其他视频地址、选 P 定位与重复懒解析等问题。字体与轮播资源本地打包；部分平台展示图标仍来自外站。

播放和下载直接使用解析结果的媒体地址，仍受媒体站点的 CORS、防盗链、地区限制和链接时效影响。当前公开入口不包含开放媒体代理、需要 Cookie 的抖音主页、网易云 Python 服务或其他可选上游脚本。

部署前必须选择访问控制、使用独立 PHP-FPM 池并限制解析服务出网。现有 TLS、域名和超时检查不构成完整的重定向/DNS 隔离；请完整阅读 [部署边界](docs/DEPLOYMENT.md)。
