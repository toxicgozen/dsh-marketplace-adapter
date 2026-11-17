# dsh-marketplace-adapter

在 DeepSeek Harness 里用你的 agent marketplace —— Claude Code / Codex / Cursor 那套
`plugins/<包>/skills/<技能>/SKILL.md` 仓库。

装一次、填一个 `owner/repo`，技能就带着包名前缀出现在 DSH 里，之后跟着上游自动更新。
仓库本身不用改，其它宿主的安装方式也不受影响。

---

## 用

在输入框输入 `/marketplace`：

```
marketplace  gozen  https://github.com/toxicgozen/skills.git@main
revision     8f2c1ab
last sync    2026/11/18 00:52:11
packages     7

  gozen-stack          0.15.41    46 skills
  art-stack            0.9.3      12 skills
```

技能名带包名前缀，所以"跑 code-review"在 DSH 里是 `gozen-stack-code-review`。

左侧栏还有一个 **Marketplace** 入口，点开是一页卡片：每个来源的 repository@ref、revision、
最后同步时间、包与技能数，以及失败原因；右上角可以刷新。添加、移除和同步仍然用命令，
页面只读，两边不各写一套逻辑。

## 添加、移除、同步

```
/marketplace add owner/repo          # 添加一个 marketplace
/marketplace add owner/repo work     # 添加并起名 work
/marketplace remove work             # 移除
/marketplace sync [name]             # 立刻同步
```

命令添加的条目写进 `~/.dsh/marketplace-adapter/marketplaces.json`，立刻生效、重启后仍在。
配置里声明的条目也能被 `remove` 停用：它写一条墓碑，不改你的配置文件；再 `add` 同一个仓库就恢复。

也可以直接改配置（多个仓库并列）：

```yaml
- id: marketplace-adapter
  config:
    marketplaces:
      - name: gozen
        repository: toxicgozen/skills
      - name: work
        repository: https://github.com/example/skills.git
        ref: main
```

私有仓要求本机 `gh auth status` 是登录状态；令牌只在本机解析，不落盘、不进日志。

## 安装（第一次）

```powershell
git clone https://github.com/toxicgozen/dsh-marketplace-adapter.git
```

在 DSH 的 **Settings → Plugins** 里用 Plugin Manager 安装上面这个目录（`install_bundle`，
`target` 传绝对路径）。本地目录是 `link:` 安装，以后 `git pull` 就升级。

---

## 你会得到什么

| 位置 | 内容 |
|---|---|
| 左侧栏 **Marketplace** | 每个来源的 revision、同步状态、包版本与技能数；右上角刷新 |
| `/marketplace` | 每个仓库的 revision、最后同步时间、各包版本与技能数 |
| `/marketplace add <owner/repo> [name]` | 添加并立刻挂载 |
| `/marketplace remove <name>` | 移除命令添加的条目 |
| `/marketplace sync [name]` | 全部同步，或只同步指定 marketplace |
| 技能目录 | `gozen-stack-*`、`art-stack-*` …前缀就是 marketplace 里的包名 |
| 日志 | 同步失败会写原因，并按 15s → 30s → … → 5min 退避重试 |

每 60 分钟自动同步。刷新由插件自己的定时器驱动，不依赖你重开会话。

## 已知限制

- DSH 读不懂的 frontmatter（`paths:`、`globs`、`allowed-tools`、`hooks`…）会被忽略并 warn，
  同一个技能在这里的行为可能和别的宿主不同。
- hooks、斜杠命令、条件激活：DSH 没有对应语义，本插件不模拟。
- 多个 marketplace 里同名技能不会合并：注册表按 `rank` 再按注册顺序取第一个，其余告警丢弃。

---

## 给维护者

以下是机制和取舍，不是使用步骤。

### 它读什么

优先读仓库自带的 marketplace 清单，按顺序取第一个能用的：

| 清单 | 谁在用 |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code |
| `.cursor-plugin/marketplace.json` | Cursor |
| `.agents/plugins/marketplace.json` | Codex |

清单里的 `plugins[].name` 是包名（技能前缀）；`source` 是包目录，相对仓库根，
字符串和 `{ "path": … }` 两种写法都认。读不到清单才退回扫 `plugins/<包>/skills/`。
清单写坏了只 warn 并退回扫目录，不会清空 catalog；指向仓库外的包会被忽略。

### 为什么名字里只能用 `-`

DSH 硬约束，不是本插件的选择：

| 位置 | 正则 | 出处 |
|---|---|---|
| skill 名 | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | `dsh-skill/lib/index.js:17` |
| command 名 | `/^[a-z][a-z0-9_-]*$/u` | `dsh-commands/lib/index.js:78` |

`gozen:code-review`、`gozen/code-review`、`gozen.code-review` 全部非法。而且坏名字不是
"跳过这一个"——`validateCandidate()` 在 `provider.list()` 的 try/catch 之外，一个坏名字会把
整个 provider 的 catalog 打挂，所以本插件自己先校验，坏名只警告、不抛。

命名空间只能用 `-` 编码：

| `namespace` | `plugins/gozen-stack/skills/code-review` 变成 |
|---|---|
| `plugin`（默认） | `gozen-stack-code-review` |
| `collision` | `code-review`；只有重名时才加前缀 |
| `none` | `code-review`（与 Claude/Codex 一致） |

### 结构

```
repo ──git fetch──► mirror ──provider──► ctx.skills ──► 模型 catalog
                                        (name 加前缀，路径不动)
```

- **mirror**：`~/.dsh/skill-mirrors/<owner>-<repo>/`，只读普通 clone；插件启动、定时和
  `/marketplace sync` 时 `fetch` + `reset --hard`，其余时间只读本地文件。断网也能用。
- **provider**：`ctx.skills.registerProvider`，只改 `name`、不动磁盘，所以技能里的相对引用
  （`references/x.md`、`../<兄弟技能>/SKILL.md`、`../../playbooks/x.md`）全部照旧。
- **页面**：`client.js` 在 `sidebar.panellist` 注册 `marketplace` 行、在 `main` 的 `marketplace`
  键注册页面。页面用 `fetch` 读 Host 的 `/api/marketplace-adapter/status`——`describeMarketplaces()`
  的快照，没有 Typert Remote 契约要生成。读取失败时保留上一份快照并给出重试。
- **Host 路由**：`connection.fetch.register` 挂在 Web 端已认证的 `/api` 通道上；没有 Web 载体
  （纯 CLI）时不注册，页面也就无从打开，插件其余部分不受影响。
- **bundle / plugin 行**：本包是 bundle，`cordis.patch.yml` 插一行 `marketplace-adapter`。

### 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里按 id 覆盖（覆盖会替换**整个** `config`，要写全）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `marketplaces` | — | 并列的源列表，每项见下；给了它就不再读顶层 `repository` |
| `repository` | `https://github.com/toxicgozen/skills.git` | 只有一个源时的简写；也接受 `owner/repo` |
| `name` | `<owner>-<repo>` | marketplace 的稳定 id，出现在 `/marketplace`、日志与 provider 名里 |
| `ref` | `main` | 跟踪的分支或 tag |
| `mirrorPath` | `$DSH_HOME/skill-mirrors/<owner>-<repo>` | 本地镜像目录 |
| `storePath` | `$DSH_HOME/marketplace-adapter/marketplaces.json` | `/marketplace add` 写入的列表 |
| `namespace` | `plugin` | `plugin` / `collision` / `none` |
| `descriptionPrefix` | `false` | 描述前加 `[包名]`，让 catalog 可见命名空间 |
| `respectDisableModelInvocation` | `true` | `false` 时强制所有技能可被模型调用 |
| `plugins.include` / `plugins.exclude` | `[]` | 按包名收窄 |
| `syncOnApply` | `true` | 加载时同步；`false` 只读 mirror |
| `syncIntervalMinutes` | `60` | 成功后的刷新间隔；`0` 关闭定时刷新与失败重试 |
| `sslBackend` | `auto` | `auto` / `openssl` / `schannel` |
| `gitPath` | `git` | git 可执行文件 |
| `tokenCommand` | `['gh','auth','token']` | 令牌来源；`"none"` 关闭 |
| `providerName` | marketplace 的 `name` | 注册在 `ctx.skills` 上的 provider 名，必须唯一 |
| `rank` | `300` | 同层重名的优先级 |

`marketplaces` 的每一项接受上表除 `marketplaces` 外的字段；顶层字段作为每一项的默认值，
但 `mirrorPath`、`providerName`、`name` 始终按项取，避免两个源共用同一份工作副本。

### 刷新、重试与多实例

- 刷新由定时器驱动（每 15 秒检查一次）。不能靠 catalog 重新读取来驱动——DSH 注册表会缓存
  provider 的 `list()`，热会话里它不会被再次调用。
- 成功后按 `syncIntervalMinutes` 等下一轮；失败按 15s → 30s → 60s … 最长 5 分钟退避，
  不会一次失败就干等一个整间隔。
- 同一个 mirror 上只有一个实例在同步：另一个窗口拿不到锁就跳过这一轮，保留现有 catalog。
- 令牌只在拿到确定结果时缓存，`gh auth token` 这一轮失败下一轮会重试。

### 认证与 Git 传输

`sslBackend: auto` 先按系统后端跑，只在命中 schannel `SEC_E_NO_CREDENTIALS` 时用
`http.sslBackend=openssl` 重试一次。令牌优先取 `GITHUB_TOKEN` / `GH_TOKEN`，否则执行
`tokenCommand`；经 `GIT_CONFIG_*` 环境变量传给 git，不落在命令行、不写进配置、不打日志。

### 开发

```powershell
pnpm install
node --test test/
```

测试覆盖清单解析与回退、三种命名空间、frontmatter 告警、同步调度与退避、令牌重试、
mirror 锁、`/marketplace` 输出，以及（本地存在 checkout 时）对真实仓库做全量链接校验。

### License

[MIT](LICENSE)
