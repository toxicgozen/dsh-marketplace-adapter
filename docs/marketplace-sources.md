# Marketplace 来源与缓存

调查日期：2026-11-18。Claude Code 依据当日官方文档；Codex 依据稳定版 0.169.0，源码固定为 `d32063f96c2dff1dc96af839b3952abb6acfeda4`。OpenAI 文档站直取返回 403，相关结论回查发布版源码。

## 官方产品的做法

Claude Code 区分声明、下载和运行中加载。marketplace 下载位于 `marketplaces/<name>/`，安装版本位于 `cache/<marketplace>/<plugin>/<version>/`。正在运行的会话可以继续读旧版本，更新后再 reload。其 marketplace 可以来自 GitHub、其他 Git 主机或 URL；这不代表所有来源都不使用 clone。

Codex 0.169.0 的 Git 来源确实调用 `git clone`。来源匹配比较 source type、URL、ref 和 sparse paths，并非只比较仓库尾部名称。升级使用 staging，校验后激活。两家仍需要本地完整资源目录，才能运行脚本和读取相对文件。

- [Claude Code：加载阶段、磁盘目录与版本更新](https://code.claude.com/docs/en/plugins/loading)
- [Claude Code：marketplace 格式与来源类型](https://code.claude.com/docs/en/plugins/marketplace-reference)
- [Codex 0.169.0：实际 Git 下载代码](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core-plugins/src/marketplace_add/install.rs)
- [Codex 0.169.0：完整来源身份匹配](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core-plugins/src/marketplace_add/metadata.rs)
- [Codex 0.169.0：升级与激活](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core-plugins/src/marketplace_upgrade.rs)

## 本适配器采用的边界

按本次要求，来源统一为 URL 和可选 token 凭据引用，传输改用 HTTP 归档，不维护 Git 工作副本。保留整个 marketplace 目录树，以支持同包技能、references 和 scripts 的相对引用。完整来源 URL 与 ref 决定缓存身份，归档内容摘要标识快照；来源别名和插件展示版本不参与内容身份判断。

采用“下载到独立暂存目录 → 解包并检查 → 发布不可变快照 → provider 切换”的流程。发布前失败保留最后成功快照，旧快照保留供在途读取使用。这里采用的是官方产品的来源隔离和缓存发布思路，并没有复制它们的 Git 传输或完整插件安装系统。

GitHub 仓库 URL 可以映射官方 tarball API。未指定 ref 时，该 API 使用仓库默认分支。任意 Git 服务的仓库 URL 没有统一归档协议；其他主机需要提供直接归档 URL。

- [GitHub：下载仓库 tar 归档](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar)

## 认证与跳转

token 必须明确属于对应来源，不自动把本机 GitHub 凭据用于任意主机。DSH 配置保存凭据名称，实际值在同步时通过 credentials service 解析；独立 CLI 可以从同名环境变量读取。轮换的 token 在下一次操作生效。

GitHub 归档入口会返回临时重定向。私仓签名下载链接仅短时有效，不应持久化为来源，也不应写入日志。跨 origin 跳转移除 Authorization，与 Fetch/Undici 的行为一致。直接归档 URL 本身也不能含有用于认证的用户名、密码或临时签名。

- [GitHub：REST API 认证](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)
- [GitHub：正确处理重定向](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#follow-redirects)
- [Undici v7.16.0：跨 origin 跳转移除认证头](https://github.com/nodejs/undici/blob/v7.16.0/lib/web/fetch/index.js#L1295)

## 清单与 YAML

Codex 的 `source` 对象使用类型判别：`source: local` 的 path 是 marketplace 内目录，`source: url` 或 `git-subdir` 即使带 path 也不是本地目录。适配器只处理已支持的来源类型，并报告跳过项。

插件元数据通常位于 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`，不能仅依赖根目录的 `plugin.json`。SKILL frontmatter 使用完整 YAML 解析器后再映射到 DSH 字段；能够解析 hooks 或 allowed-tools，不等于 DSH 能执行这些语义。

实际下载的 Anthropic 官方 skills marketplace 有五个插件条目，共用 `source: ./`、`strict: false`，通过各自的 `skills` 数组限定目录。例如 document-skills 只声明 xlsx、docx、pptx、pdf 四项。支持仓库根目录来源时必须同时尊重这种选择，不能给每个插件重复扫描整个 skills 目录。此次公开归档为 4,149,339 字节，SHA-256 为 `852d94b831392175f18f11ed04cd01cb18c47c24640fbee37b5127591e4d0cf5`；这是当次下载样本的摘要。

- [Codex 0.169.0：marketplace source 类型](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core-plugins/src/marketplace.rs)
- [Codex 0.169.0：插件元数据发现](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/utils/plugins/src/plugin_namespace.rs)
- [Codex 0.169.0：YAML frontmatter 解析](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/skills/src/parser.rs)

## 验证范围

调查阶段没有使用私人 token 下载私仓。公开归档、重定向、恶意条目、失败回退、并发持久化和旧资源路径由实现后的隔离验收验证，不能从官方文档推断已经通过。测试命令和迁移说明见[项目用法](../README.md)。
