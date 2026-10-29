# 上游每日更新检查

GitHub Actions 的 **Watch upstream updates** 在 GitHub 托管的 runner 上运行，无需维护者的电脑保持开机。计划为每天北京时间 **09:00**（UTC 01:00），也可以在仓库 Actions 页面手动执行。

检查两个上游的默认分支提交、公开 Release 和标签：

- [jiuhunwl/short_videos](https://github.com/jiuhunwl/short_videos)
- [jiuhunwl/shortvideo-html](https://github.com/jiuhunwl/shortvideo-html)

新增提交、默认分支变化、Release 新增/编辑/删除、标签新增/移动/删除都会被检查。脚本只读取 GitHub 元数据和文件差异，不下载执行上游代码。`UPSTREAM.json` 继续代表已经采用的版本；检查结果不会自动改写它。

## 通知与去重

首次成功运行会创建一个名为 **DokiTool 上游更新检查** 的 Issue，指派给仓库所有者 Brilliant666，用于确认通知通道和保存观察状态。即使没有更新，也会明确标记这一次初始化；之后无变化不发评论。

发现新变化时，在同一个 Issue 下发布一条包含差异、比较链接和已采用文件影响的评论。通知及其对应状态在同一条评论中保存，后续检查读取最近的有效机器人记录，避免已报告变化反复通知。人工评论不作为检查状态；Issue 被关闭后仍会被找到，有新变化时可重新打开。请保留机器人管理的状态标记；删除 Issue 或修改状态记录会影响去重。

Issue 通知通过 GitHub 送达，邮件、网页或手机推送取决于个人 GitHub 通知设置。保持订阅该 Issue 即可接收后续评论。仓库 Actions 页面手动执行时可选择 `verify_notification`，发送明确标注为测试的通知；它不代表上游更新，也不推进观察状态。

检查失败会使 Actions 运行失败并保留最后成功状态，不把失败记作“没有更新”。失败提醒使用 GitHub Actions 通知，请在自己的 GitHub 通知设置中启用所需渠道。文件差异比较有截断或历史分叉时，报告会明确说明，需要人工继续审查。

## 权限和运行范围

工作流只授予 `contents: read` 和 `issues: write`，只在 Brilliant666/DokiTool 的 main 分支运行；使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需添加个人令牌或服务器密钥。它不会修改源码、创建合并请求、合并、推送、部署或连接生产服务。任务之间串行执行，避免并发写入重复通知。

`.github/upstream-watch-baseline.json` 是启用前已经观察到的公开状态，避免首次运行把既有版本当成新发现。运行期间的新状态保存在 GitHub Issue 内，不依赖本地文件、Actions 缓存或定期提交。采用上游改动仍按 [上游维护流程](UPSTREAM-MAINTENANCE.md) 人工审查、移植和验证。

## 调度限制与维护

GitHub 的定时工作流可能排队延迟，因此 09:00 是计划时间，并非精确到分钟的送达承诺。公开仓库连续 60 天没有仓库活动时，GitHub 可能自动停用定时工作流；发现停用后可在 Actions 中重新启用。这里不通过无意义提交维持活跃。[GitHub 官方调度说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

修改脚本后运行 `python -B -m unittest discover -s scripts/tests -v`，按公开清单规则暂存；发布到 main 后手动运行工作流，核对真实 GitHub API 和 Issue 写入，再检查一次无变化时不会追加通知。暂停此检查可在 Actions 页面禁用 **Watch upstream updates**，不影响网站运行。
