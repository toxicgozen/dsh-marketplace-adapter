# dsh-marketplace-adapter

把 GitHub 上或 HTTPS tar.gz 归档中的 agent marketplace 接入 DeepSeek Harness。技能保留完整资源目录，名称默认加包名前缀，例如 `gozen-stack-code-review`。

## 配置来源

在插件配置中填写 URL。GitHub 来源也接受 `owner/repo`：

```yaml
marketplaces:
  - name: public
    url: anthropics/skills
  - name: work
    url: https://github.com/example/private-skills
    ref: release
    tokenEnv: WORK_SKILLS_TOKEN
  - name: archive
    url: https://example.com/releases/skills.tar.gz
```

`tokenEnv` 是环境变量名，不是令牌内容。DSH 存在 credentials service 时，每次同步调用 `credentials.resolve(tokenEnv)`；没有该 service 时读取 `process.env[tokenEnv]`。已配置引用却无法解析时，同步失败并保留旧快照。插件不自动读取 `GITHUB_TOKEN`、`GH_TOKEN`、Git 凭据或 `gh` 登录状态。

URL 不得包含用户名、密码、fragment 或秘密查询参数。公开归档选择器的非秘密 query 会保留，并参与来源身份计算。需要认证时使用 `tokenEnv`，不要使用临时签名 URL。

## 添加、移除和同步

```text
/marketplace add anthropics/skills
/marketplace add https://example.com/releases/skills.tar.gz work
/marketplace remove work
/marketplace sync [name]
/marketplace
```

命令写入 `$DSH_HOME/marketplace-adapter/marketplaces.json`，默认 DSH home 为 `~/.dsh`。`add` 仅保存名称和 URL，其余选项继承共享配置。私有来源可在配置中声明 `tokenEnv`，没有新增秘密输入界面。

`remove` 精确匹配最终显示的名称。移除配置声明的来源会写入停用记录，不改配置文件；用同名 `add` 恢复。损坏的 Store 可被读取阶段跳过并记录警告，后续写入会拒绝覆盖，需先修复原文件。

左侧栏 **Marketplace** 页面显示来源、快照摘要、同步状态和包列表。页面上的刷新重新读取状态；立即同步使用 `/marketplace sync`。手动同步失败时命令返回错误。

## 同步与缓存

GitHub 仓库映射到官方 `/repos/{owner}/{repo}/tarball` API。`ref: HEAD` 表示使用远端默认分支，请求省略 ref；指定分支、tag 或提交时附加该选择器。其他 host 必须提供直接 `.tar.gz` 或 `.tgz` URL，插件不会猜测任意 Git 服务的归档接口。

每次同步下载到独立 staging，校验后发布不可变目录，再用临时文件加 rename 替换 `current.json`。provider 最后切换 root。失败保留上一份完整快照；重启读取 last-good。旧 candidate 仍指向原目录，已加载技能的相对资源路径继续有效。

缓存按完整规范 URL 和 ref 的 SHA-256 来源键隔离。`revision` 的格式是 `sha256:<归档内容摘要>`，它是快照摘要，不是 Git commit SHA。归档字节改变会产生新 revision，即使解压内容相同。缓存不会自动清理，避免删除正在被会话读取的资源；停用来源也不删除快照。

| 配置 | 默认 | 含义 |
|---|---|---|
| `marketplaces` | `[]` | 多来源；空时使用顶层单来源配置 |
| `url` | `https://github.com/toxicgozen/skills` | GitHub 仓库或直接 HTTPS 归档 URL；默认来源可能需要凭据 |
| `repository` | — | `url` 的兼容别名，二者同时给出时 `url` 优先 |
| `name` | 从 URL 推导 | 来源稳定名称 |
| `ref` | `HEAD` | 共享默认值在逐项配置合并后生效；直接归档由 URL 决定下载内容，ref 仅参与缓存隔离 |
| `tokenEnv` | — | POSIX 环境变量名，逐次解析 |
| `cachePath` | `$DSH_HOME/marketplace-adapter/snapshots` | 缓存根；可在顶层安全共享，内部按来源键隔离 |
| `mirrorPath` | — | 仅显式指定时，作为首次同步前的只读兼容目录；已有当前来源快照时优先读快照 |
| `storePath` | `$DSH_HOME/marketplace-adapter/marketplaces.json` | 命令拥有的来源列表 |
| `syncOnApply` | `true` | `false` 时不自动同步，仅提供已有快照或显式指定的旧目录 |
| `syncIntervalMinutes` | `60` | `0` 时启动最多同步一次，失败也不自动重试；仍可手动同步 |
| `fetchTimeoutMs` | `180000` | 一次 HTTP 下载的超时，最小 1000 ms |
| `namespace` | `plugin` | `plugin` 全加包前缀；`collision` 仅重名加前缀；`none` 使用原名 |
| `descriptionPrefix` | `false` | 描述前添加 `[包名]` |
| `respectDisableModelInvocation` | `true` | 遵循技能的模型调用开关 |
| `plugins.include`、`plugins.exclude` | `[]` | 按包名筛选 |
| `providerName` | 来源名称 | DSH provider 名称，不能为 `runtime` |
| `rank` | `300` | 重名技能优先级 |

顶层字段为每项默认值；`name`、`providerName` 和旧 `mirrorPath` 按项指定。常规失败按 15 秒、30 秒、60 秒逐步退避，最多 5 分钟。同一 provider 的同步单飞；跨进程发布相同摘要不会改动现有资源。Store 使用 `proper-lockfile` 保护整个读改写事务。

Claude Code、Codex 的来源身份与缓存方式，以及本实现的取舍，见[官方来源调查](docs/marketplace-sources.md)。

## 从 0.1.x 迁移

0.2.0 完全移除 marketplace 的 Git clone、fetch 和 reset。`gitPath`、`sslBackend`、`tokenCommand` 被忽略；SSH Git URL 和非 GitHub 的普通 Git URL不再支持。改填 GitHub HTTPS URL 或直接 HTTPS 归档，并用 `tokenEnv` 显式引用凭据。

旧 `repository` 仍可读取。插件默认不读取旧 clone，也不搬动、重置或删除它；当前 URL 和 ref 没有快照时，技能目录显示为尚未就绪。需要只读过渡时，显式指定 `mirrorPath`；此目录由用户选择，插件不推断它属于哪个 ref。已有当前来源快照时优先读快照，首次 HTTP 同步成功后也会切换到快照。如果指定 `mirrorPath` 且没有 `cachePath`，新缓存放在相邻的 `<mirrorPath>.archives`，避免写入旧 clone。建议新配置直接使用 `cachePath`。新缓存目录不会被当成旧 clone 扫描。

默认 ref 从 `main` 改为 `HEAD`，因此遵循仓库默认分支。若仍需固定 `main`，显式填写 `ref: main`。v1 Store 保持兼容，只写支持的非秘密字段。

## 发现规则与边界

按顺序读取 `.claude-plugin/marketplace.json`、`.cursor-plugin/marketplace.json`、`.agents/plugins/marketplace.json`，没有清单时扫描 `plugins/<包>/skills/<技能>/SKILL.md`。本地包 source 可为字符串、`{ source: local, path: ... }`，或无 discriminator 的 `{ path: ... }`。包可指向仓库根 `./`；显式 `skills` 目录列表只选择该包列出的技能。`url`、`git-subdir` 等远程组件 source 会警告并跳过。

新归档发布前校验目录与本地包声明；目录缺失、越界或损坏清单不能替换 last-good。合法空清单允许发布。插件元数据依次读取 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`，最后兼容根 `plugin.json`。

frontmatter 使用 `yaml.parseDocument`，支持标准 YAML 结构、引号、注释和多行文本；语法错误带诊断。发现技能时，缺省 `name` 可用技能目录名补齐。DSH 名称只允许小写字母、数字和连字符。保留 `disable-model-invocation`、`user-invocable` 的 DSH 调用语义；不支持的宿主字段会警告。hooks、条件激活和完整安装市场不在本插件范围内。

下载限制为 32 MiB，解压后的 tar 为 128 MiB，最多 20000 个条目。绝对路径、`..`、Windows 驱动路径、symlink、hardlink 和特殊文件会被拒绝。HTTP 仅允许 loopback 测试来源，生产来源必须 HTTPS。重定向手动跟随，最多 5 次；跨 origin 永久移除 Authorization，拒绝 HTTPS 降级。失败仅报告状态和诊断，不记录响应 body 或临时重定向 URL。

## CLI 与开发

```powershell
pnpm install --frozen-lockfile
npm test
node bin/sync.mjs --url anthropics/skills --cachePath D:\cache\marketplaces
node bin/sync.mjs --url example/private-skills --ref release --tokenEnv WORK_SKILLS_TOKEN
```

CLI 使用相同 HTTP 缓存，输出快照 root、完整摘要、来源键和技能数。`--help` 列出支持的参数。

测试使用隔离的 DSH home、真实 loopback HTTP 和临时归档；不读取真实 Store，也不更新本机 profile。跨进程 Store 测试使用独立 Node 进程。可选的真实仓库只读链接检查需显式设置 `SKILL_ADAPTER_REPO`。CI 在 Windows 和 Linux 上先冻结安装依赖再执行 `npm test`。

[MIT](LICENSE)
