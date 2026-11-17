# dsh-marketplace-adapter

把 agent marketplace 仓库（Claude Code / Codex / Cursor 那套 `plugins/<包>/skills/<技能>/SKILL.md`）
转成 DeepSeek Harness 的技能来源。仓库本身 **一个字节都不用改**，其它宿主的安装方式也不受影响。

本仓库是公开的适配器；被适配的 marketplace 可以是私有仓，令牌只在本机解析，不随本包分发。
使用者的路径是「装一个插件、填一次 `owner/repo`」，不需要以开发者身份 clone 技能仓库。

---

## 它读什么

优先读仓库自带的 marketplace 清单，按顺序取第一个能用的：

| 清单 | 谁在用 |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code |
| `.cursor-plugin/marketplace.json` | Cursor |
| `.agents/plugins/marketplace.json` | Codex |

清单里的 `plugins[].name` 是包名，也就是技能前缀；`source` 是包目录（相对仓库根，
字符串和 `{ "path": … }` 两种写法都认）。读不到清单时才退回扫 `plugins/<包>/skills/`。

清单写坏了只 warn 并退回扫目录，不会把 catalog 清空；指向仓库外的包会被忽略。

---

## 安装

本包是一个 bundle（`package.json` 里声明了 `dsh.bundle.patch`），把它装进 profile 即可：

```powershell
git clone https://github.com/toxicgozen/dsh-marketplace-adapter.git
```

然后在 DSH 里用 `plugin_manager` 的 `install_bundle`，`target` 传这个目录的绝对路径。
本地目录安装是 `link:` 语义，改动即时生效。

装好后默认从 `https://github.com/toxicgozen/skills.git` 拉技能；换成自己的仓库只需在
profile 的 `cordis.patch.yml` 里覆盖 `repository` / `tokenCommand`（见下文「配置」）。

---

## 先搞清四个词

### 1. mirror（镜像 / 本地副本）

这里的 mirror 不是 `git clone --mirror` 那种裸仓库，而是**一份只读的普通 clone**：

```
~/.dsh/skill-mirrors/toxicgozen-skills/     ← 由本插件维护，你不需要手动动它
├── .git/
└── plugins/
    ├── gozen-stack/
    ├── art-stack/
    └── ...
```

它解决的是「插件运行时不能每次去 GitHub 拉」的问题。插件启动时 `git fetch` + `reset --hard` 把它对齐到远端 `main`，其余时间只读本地文件。

三个特点：

- **只读缓存**：你不在里面改东西、不 commit、不 push；上游才是唯一真相。
- **独立于你的开发 checkout**：`C:\Users\10202\Projects\skills` 是你的开发区，mirror 是插件的运行区，互不干扰。
- **放在 `~/.dsh/` 下面**：只有 DSH 读它。Claude 读 `~/.claude/`，Codex 读自己的，Cursor、Pi 各读各的。

### 2. bundle（包）

**bundle 是一个 npm 包，它的 `package.json` 里声明了 `dsh.bundle.patch`。**

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

DSH 的 profile（这里是 `desktop`）由若干 bundle 叠加而成。`install_bundle` 做三件事：

1. 把包装进 `~/.dsh/profiles/desktop/`（本地目录用 `link:`，所以改动即时生效）；
2. 把包名加进 `package.json` 的 `dsh.profile.bundles` 列表；
3. 让它的 `cordis.patch.yml` 插进一行插件。

本包的 patch 就三行：

```yaml
- insert:
    - id: marketplace-adapter
      name: 'dsh-marketplace-adapter'
```

### 3. plugin（插件行）

bundle 装的是"包"，**plugin 是 loader 树里的一行**，也就是一个导出 `apply(ctx, config)` 的模块。一个 bundle 可以插多行；本包插一行。

```js
export const inject = ['skills'];
export function apply(ctx, config) { /* 注册 provider */ }
```

上游技能仓库里 `plugins/<name>/` 是另一个"plugin"概念——那是技能仓库自己的包目录。
本插件只把目录名当作命名空间前缀，不加载、不执行它。

### 4. provider（技能来源）

DSH 的技能是「注册表 + 来源」结构。`ctx.skills` 是注册表，provider 是来源。内置的 `dsh-skill-filesystem` 是"从固定几个目录读"；本插件是"从 mirror 里读，并且能改名字"。

```
repo ──git fetch──► mirror ──provider──► ctx.skills ──► 模型 catalog
                                        (name 加前缀，路径不动)
```

**关键点**：provider 只改 `name`，不动磁盘。所以 skill 里的相对引用
（`references/x.md`、`../<兄弟技能>/SKILL.md`、`../../playbooks/x.md`）
全部照旧能解析 —— 这是本方案和"平铺投影到 `~/.dsh/skills`"最重要的区别。

---

## 为什么不能用 `:`

DSH 硬约束，不是本插件的选择：

| 位置 | 正则 | 出处 |
|---|---|---|
| skill 名 | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | `dsh-skill/lib/index.js:17` |
| command 名 | `/^[a-z][a-z0-9_-]*$/u` | `dsh-commands/lib/index.js:78` |

`gozen:code-review`、`gozen/code-review`、`gozen.code-review` 全部非法。
而且非法名不是"跳过这一个"——`validateCandidate()` 在 `provider.list()` 的 try/catch **之外**，
一个坏名字会把整个 provider 的 catalog 打挂。所以本插件自己先校验，坏名只警告、不抛。

命名空间只能用 `-` 编码，三种模式：

| `namespace` | `plugins/gozen-stack/skills/code-review` 变成 |
|---|---|
| `plugin`（默认） | `gozen-stack-code-review` |
| `collision` | `code-review`；只有重名时才加前缀 |
| `none` | `code-review`（与 Claude/Codex 完全一致） |

再加 `descriptionPrefix: true` 可以让 catalog 里读成
`` - `code-review`: [gozen-stack] Review code… ``，得到"可见但不可调用"的命名空间。

---

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里按 id 覆盖（覆盖会替换**整个** `config`，要写全）：

```yaml
- id: marketplace-adapter
  name: 'dsh-marketplace-adapter'
  config:
    repository: toxicgozen/skills
    ref: main
    namespace: plugin
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `repository` | `https://github.com/toxicgozen/skills.git` | 源仓库；也接受 `owner/repo` 简写 |
| `ref` | `main` | 跟踪的分支或 tag |
| `mirrorPath` | `$DSH_HOME/skill-mirrors/<owner>-<repo>` | 本地镜像目录 |
| `namespace` | `plugin` | `plugin` / `collision` / `none` |
| `descriptionPrefix` | `false` | 在描述前加 `[plugin]`，让 catalog 可见命名空间 |
| `respectDisableModelInvocation` | `true` | `false` 时强制所有技能都可被模型调用 |
| `plugins.include` / `plugins.exclude` | `[]` | 按 plugin 目录名收窄 |
| `syncOnApply` | `true` | 插件加载时同步；`false` 则只读 mirror |
| `syncIntervalMinutes` | `60` | 成功后的刷新间隔；`0` 关闭定时刷新与失败重试 |
| `sslBackend` | `auto` | `auto` / `openssl` / `schannel` |
| `gitPath` | `git` | git 可执行文件 |
| `tokenCommand` | `['gh','auth','token']` | 私有库令牌来源；`"none"` 关闭 |
| `cloneTimeoutMs` / `fetchTimeoutMs` | `300000` / `180000` | 超时 |
| `providerName` | `toxicgozen` | 注册在 `ctx.skills` 上的 provider 名 |
| `rank` | `300` | 同层重名的优先级 |

### 刷新、重试与多实例

- 刷新由插件自己的定时器驱动：每 15 秒检查一次是否到期。不能靠 catalog 重新读取来
  驱动——DSH 注册表会缓存 provider 的 `list()`，热会话里它不会被再次调用。
- 成功后按 `syncIntervalMinutes` 等下一轮；失败后按 15s → 30s → 60s … 最长 5 分钟
  退避重试，不会一次失败就干等一个整间隔。
- 同一个 mirror 上只有一个实例在同步：另一个窗口拿不到锁就跳过这一轮，保留现有 catalog。
- 令牌只在拿到确定结果时缓存。`gh auth token` 这一轮失败，下一轮会重试——启动时
  gh 还没登录，不会导致整个进程都没有技能。

---

## 认证与 Git 传输

**更正**：早先的版本说"本机 git 的 HTTPS 坏了"，这是错的。当时的证据全部来自 DSH 的
`pwsh` 工具，而它跑在**沙箱**里；对照实验（普通宿主环境 vs 只读沙箱）显示：

| 检查 | 普通宿主环境 | DSH 只读沙箱 |
|---|---|---|
| Git + Schannel | 成功 | `SEC_E_NO_CREDENTIALS` |
| Git + OpenSSL | 成功 | 成功 |
| 启动 `sh.exe` | 成功 | `couldn't create signal pipe` |

所以这是**沙箱受限令牌**的产物，不是机器级故障。本插件运行在 **Host 进程**（非沙箱），
正常情况下系统 TLS 后端就够用；`sslBackend: openssl` 只是沙箱内验证时留下的错误默认值，
现已改回 `auto`。

本插件的处理：

1. `sslBackend: auto` 时先按系统后端跑，只在命中 schannel 报错时用 `http.sslBackend=openssl` 重试一次；
2. 令牌优先取 `GITHUB_TOKEN` / `GH_TOKEN`，否则执行 `gh auth token`；
3. 令牌经 `GIT_CONFIG_*` **环境变量**传给 git，不落在命令行、不写进配置文件、不打日志。

所以前提只有一个：`gh auth status` 是登录状态。

---

## 不写什么

安装与运行**只**会碰这些位置：

- `~/.dsh/skill-mirrors/<owner>-<repo>/` —— 镜像
- `~/.dsh/profiles/desktop/package.json` / `pnpm-lock.yaml` / `node_modules/` —— 包安装
- `~/.dsh/profiles/desktop/cordis.patch.yml` —— 只有你手动改配置时才动

不碰：`~/.claude`、`~/.codex`、`~/.cursor`、`~/.pi`，以及你的 `skills` 仓库。

---

## 已知限制

- 只接 **skills**。仓库里的 `hooks/`、`rules/`、`playbooks/` 作为技能资源可被读取，
  但 DSH 没有对应的自动触发机制。
- `agents/openai.yaml`、`.claude-plugin/`、`.cursor-plugin/` 是其它宿主的元数据，本插件忽略。
- DSH 不读的 frontmatter 字段（`paths`、`globs`、`allowed-tools`、`argument-hint`、`hooks`
  以及旧式的 `disableModelInvocation` 等）会逐条 warn 一次；技能仍会加载，但行为与
  其它宿主不同。
- 技能正文不做分片或缓存，每次加载重读文件。
- mirror 只 `fetch` 当前 `ref`，不保留历史。

---

## 开发

```powershell
node --test test/
```

测试覆盖 frontmatter 解析、目录发现、三种命名空间模式，
以及（本地存在 checkout 时）对真实仓库做全量链接完整性校验。

## License

[MIT](LICENSE)
