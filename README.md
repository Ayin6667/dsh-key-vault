# DSH 凭据保险库（dsh-key-vault）

给 DeepSeek Harness 的 Agent 用的本地加密凭据插件。对应四条要求：

| 要求 | 实现 |
| --- | --- |
| 跨对话记忆凭据 | 凭据存在磁盘上的加密保险库，重启、换对话、换工作区都还在 |
| 加密存储在本地 | 每个密钥用 AES-256-GCM 单独封装，用户名与备注同样加密；文件里只有密文 |
| 管理 Agent 在当前对话可用的凭据 | 输入框左侧的钥匙按钮打开「本对话可用凭据」，逐条开关；授权只在内存里，应用重启即失效 |
| 查看 Agent 使用的凭据 | 设置页「凭据 > Agent 读取记录」按时间列出每一次读取（凭据名、对话、用途） |

## 文件

```
.
  package.json          bundle 清单（dsh.bundle.patch + dsh.client）
  cordis.patch.yml      插入一行 id: keymanager
  main.js               宿主半：会话授权、三个工具、POST /keymanager/rpc
  core.js               保险库：AES-256-GCM 封装、原子写盘、审计
  client.js             浏览器半：钥匙药丸 + 浮层面板 + 设置页
  locale/en.json        插件卡片标题与描述（英文）
  locale/zh.json        同上（中文）
  icon.svg              插件图标
  README.md             本文件
  test/
    vault-probe.mjs     保险库加密 / 持久化 / 错误路径
    host-probe.mjs      宿主半：三个工具 + HTTP 端点 + 鉴权门 + 输出 schema 校验
    client-probe.mjs    浏览器半：模块加载、槽位注册、样式与中英文渲染
```

## 安装与卸载

这是一个 DSH **bundle 插件**：宿主侧是一个 Loader 行，浏览器侧由 `dsh.client` 声明，运行时依赖宿主的 `tools`、`webServer`、`connection` 三个服务（缺一个就整体不激活）。

1. 把本目录放到任意位置（例如 `~/plugins/dsh-key-vault`）。
2. 用 plugin manager 把它装进某个 profile，`target` 传**目录路径**：

```
plugin_manager install_bundle   target = <放插件的目录>/dsh-key-vault
```

它会做三件事：在 profile 的 `package.json` 里加一条 `link:` 依赖、把插件加进 `dsh.profile.bundles`、在 `cordis.patch.yml` 里插入 `- id: keymanager`（行配置可写 `dataDir` / `keyEnv`）。

卸载（不动保险库数据）：

```
plugin_manager remove_bundle    target = dsh-key-vault
```

> 本地改代码后**必须重启 DSH**：Node 按模块 URL 缓存 ESM，同一进程内重装同名包不会加载新代码（开发期可换一个新包名重装来立即生效）。浏览器半改完只需刷新页面。

## 客户端通道

浏览器半调用宿主半只有一条路：`POST /keymanager/rpc`，请求体 `{ method, args }`，应答 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。

这条路由是宿主 `webServer` 上的一个 **exact 路由**，处理函数第一件事是 `ctx.connection.admit({ headers })`：Host/Origin 围栏与浏览器会话 cookie 都由宿主 connection 服务判定，插件不自建鉴权。被拒时按 401/403 原样返回。

> 早期版本用 `ctx.connection.rpc.handle('/keymanager', …)` 注册前缀通道，实测请求根本匹配不到该通道、落到 SPA 静态兜底并返回 **405**（`dsh-host-frontend-static` 对非 GET/HEAD 一律 405）。改成 exact 路由 + `admit()` 后 `POST /keymanager/rpc` 正常。

排查用日志：`<dataDir>/rpc.log`，只记时间、方法名、结果码与错误文本，**不记参数值、不记密钥**；超过 256 KiB 自动清空。

## 语言

界面文案、工具描述、参数说明、工具返回文本与报错全部为中文；英文只作为回退：

- 浏览器半的词典在 `client.js` 的 `DICT`（`en` / `zh`），**只在本 bundle 内解析**：读 Client locale 服务的 `getSnapshot().active`，并用 `subscribe` 跟随切换；服务缺失时退回 `navigator.language`，最后退回英文。缺失键回退英文，再回退键名。
- 不把词典注册进 locale 服务的共享命名空间。曾被这个问题坑过一次：热更新时旧 bundle 代次仍占着同一个命名空间，新代次的 `register` 抛错被吞掉，于是所有标签退化成原始 key（例如直接显示 `panel.title`）；改为本地取词后不会再受代次影响。
- 宿主半的中文直接写在 `main.js` 与 `core.js`（工具描述、`render` 文本、`VaultError` 消息），因为模型侧文案不走浏览器 locale。
- 资源标识保持不变：工具名仍是 `credential_list / credential_reveal / credential_save`，kind 枚举仍是 `login / token / api-key / ssh / note`，只在展示层翻译。

界面文案刷新页面即可生效；**工具描述与报错属于宿主模块，改动后需重启 DSH Desktop 才生效**（Node 按模块 URL 缓存 ESM，原因见「已知限制」）。

## 使用

### 1. 存入凭据

「设置 > 凭据」底部表单：名称（Agent 以后用它称呼这条凭据，例如 `example.com`）、类型、用户名、密钥、备注、标签。列表里可编辑；删除需要二次确认。

也可以直接让 Agent 记：`credential_save` 不需要任何授权（它不读旧值），覆盖同名条目必须显式 `overwrite=true`。存完的那条会**自动对当前对话开放**，因为内容本来就在这段对话里出现过。

### 2. 让本对话可用

两种方式，效果相同：

**你自己开**：对话输入框左侧的工具行有一个钥匙按钮，显示 `已开放/总数`。点开：

- 每条凭据一个开关。打开后 Agent 才能在本对话里读到它的密钥；
- `- 自动` 表示该条「所有对话都可读取」；
- 面板底部列出本对话最近 5 次读取。

**Agent 申请、你批准**：Agent 调 `credential_reveal` 读取一条尚未开放的凭据时，对话里会弹出确认卡片「允许本对话读取凭据「x」吗？」并附上 Agent 说明的用途。

- 选**允许本对话使用** → 立即开放该条并把密钥返回给 Agent；这条授权在本对话内继续有效，后续读取不再重复询问；
- 选**拒绝** → Agent 收到 `ACCESS_DENIED`，拿不到密钥；
- 120 秒内无人作答 → Agent 收到 `ACCESS_TIMEOUT`，并提示你去钥匙面板手动打开；
- 宿主没有 `userQuestions` 服务（例如某些纯 CLI 组合）→ 直接回落到「请用户去开开关」的提示。

授权是**每个对话**的，只存在宿主内存里：应用重启、插件重载都会清空。新对话默认看不到任何凭据——这是刻意的默认值。Agent 的申请只负责发起，批准永远是用户自己的动作。

### 3. Agent 侧工具

| 工具 | 作用 |
| --- | --- |
| `credential_list` | 列出**全部**凭据的元数据（名称/类型/用户名/备注/标签/使用次数）与「本对话是否可读」，**永不返回密钥** |
| `credential_reveal` | 读取某条凭据的密钥；未开放时向用户弹出授权申请，用户同意才返回；每次读取都写入审计 |
| `credential_save` | 新建/覆盖凭据；不读回旧值 |

`credential_reveal` 返回的密钥会进入当前对话的会话记录（这是把密钥交给模型的代价）。工具描述要求 Agent 直接把它用掉、不要在回复里复述。

## 安全模型

### 加密

- AES-256-GCM，每条目独立 12 字节 IV，AAD 绑定条目 id（密文不能在条目之间调换）。
- 主密钥 32 字节随机数。两种来源：环境变量（`keyEnv`，默认 `DSH_KEYMANAGER_KEY`，值为 64 位十六进制或 32 字节 base64），或保险库旁的 `vault.key`（`0600` 尽力而为）。
- 写盘走「临时文件 + rename」原子替换，`vault.json` 只含密文、IV、认证标签与非敏感元数据（名称、类型、标签、时间、使用次数、审计）。

### 数据位置

默认 `<DSH_HOME>/keymanager/`（Windows 上就是 `%USERPROFILE%\.dsh\keymanager\`）。行配置可改：

```yaml
- id: keymanager
  config:
    dataDir: 'D:\somewhere\keymanager'
    keyEnv: 'DSH_KEYMANAGER_KEY'
    keyFile: never          # 可选：env-only，禁止把主密钥写到磁盘
```

### 边界（如实理解，这决定了它适合什么场景）

**真实边界是「同一 Windows 用户」，不是「同一对话」。** 授权面板与钥匙开关在威胁模型里只约束「模型老实走工具」，对同用户进程无效：

- 主密钥与密文默认同目录、同 ACL。任何以你的身份运行的进程（首当其冲是 Agent 自己的 shell 工具）读走这两个文件即可离线解密全部凭据，授权表对它完全不起作用。
- 想真正隔离，把主密钥放进系统密钥库（Windows Credential Manager / DPAPI 保护的文件均可），用启动环境注入，并设 `keyFile: never`——此时插件拒绝在磁盘上生成主密钥，没有环境变量就直接报 `NO_KEY`，宁可不工作也不降级。
- 工具输出不回传任何文件路径（只剩算法名）；路径只在设置页给你看。
- `credential_reveal` 的卡片文本改为掩码，但**完整密钥仍在工具结果里**，并随会话记录、记忆日志（明文 JSONL）落盘，事后不可撤回——这是「把密钥交给模型」的固有代价，不是插件能消除的。
- 覆盖同一条目要用户二次确认（`autoGrant` 已从工具参数移除，只有设置页能开「所有对话可读」）。
- 授权对话框里，用途文本先清洗控制字符与双向覆盖字符、截到 120 字，并以凭据自身备注为主、模型自述为辅。
- 同一对话对同一凭据的申请有 60 秒退避；同源页面写授权的频率也有限制，每一次授权写入都记进 `rpc.log`（权限 `0600` 尽力而为）。
- 「同源即操作员」是宿主自己的边界：任何同源客户端脚本都能替会话写授权，这是平台性质，插件只做限流与留痕。
- Windows 下 POSIX 权限位无效，`0600` 是尽力而为；实际保护来自用户目录 ACL。
- 授权是「对话级」而非「每次调用」，且在应用重启前不过期。
- 明文元数据与审计：`vault.json` 里的名称、类型、标签、时间、`purpose`、会话 id 未加密——没有主密钥也能读出「有哪些凭据、什么时候被用过、做了什么」，这是我们选择的可审计性，不是加密承诺的一部分。
- 审计与密文同文件，属于防篡改（改文件会破坏 GCM 校验），不是防删除。
- 子 Agent（被父会话拥有的 child）是独立会话 id，读不到父会话的授权；这是 fail-closed，不是漏洞。
- 宿主半把 `webServer` 与 `connection` 声明为硬依赖：没有它们的 profile（例如纯 CLI）里整个插件不激活，工具也不会出现。

### 审查结论与处置（2026-10-17）

| 级别 | 问题 | 处置 |
| --- | --- | --- |
| 高 | 主密钥与密文同目录、同用户可读 | 未改默认（兼容已有库），新增 `keyFile: never` 与文档边界；推荐 env + 系统密钥库 |
| 高 | `credential_list` 把主密钥路径交给模型 | 已修：工具输出只留算法名，`render` 去掉路径行 |
| 中高 | `reveal` 明文被持久化到会话/记忆日志 | 已缓解：卡片文本掩码；完整值仍随工具结果落盘（文档写明） |
| 中高 | `autoGrant` / `overwrite` 由模型自选 | 已修：`autoGrant` 移出工具参数；`overwrite` 走二次确认 |
| 中 | 授权对话框内容与长度由模型控制 | 已修：控制字符与 bidi 清洗、120 字上限、备注优先 |
| 中 | 同源脚本可无手势写授权；同意无频率限制 | 已缓解：60 秒退避、授权写入限流、审计留痕（同源=操作员属平台边界） |
| 低 | 明文元数据/审计、`rpc.log` 权限、错误回显名册 | 已修：`rpc.log` 用 `0600` 创建；`locate` 不再枚举名称；明文元数据已在文档写明 |
| 低 | 授权无过期、审计写入绕开队列、密钥不 zeroize、子 Agent 无授权 | 保留并在上文写明（fail-closed 行为） |

### 密钥丢失 / 更换

`vault.key` 丢失后条目无法解密：列表里标记 `locked`，读取返回 `DECRYPT_FAILED`。把原 `vault.key` 放回即可恢复；没有备份只能删库重录。更换主密钥目前需要备份 `vault.json` 后删库重建。

## 验收记录

在本机（DSH Desktop，Harness 0.2.0-rc.2，profile `desktop`）完成：

1. **保险库**（`test/vault-probe.mjs`）：创建/列表/读取/轮换/同进程重开/删除全部通过；磁盘文件不含明文密钥、用户名、备注；用另一把主密钥读取返回 `DECRYPT_FAILED`；同名（大小写不敏感）返回 `NAME_TAKEN`。
2. **宿主半**（`test/host-probe.mjs`）：三个工具注册成功，每个工具返回值都按自身 `output.schema` 校验通过；保存后本对话可读、另一对话不可读；RPC 的 `list / grant / create / update / remove / usage` 全部 `ok:true`；未知方法、未知凭据名给出明确错误；审计计数正确。
3. **实机工具链**（真实宿主 + 独立子会话）：`credential_list → credential_save → credential_list → credential_reveal` 全链路成功，密钥精确匹配；另一个独立会话调用 `credential_reveal` 被拒绝（`is not enabled for this conversation`）。
4. **客户端通道**：`rpc.log` 记录到 `apply` → `route /keymanager/rpc` → `ok list`，即页面里的钥匙按钮确实通过新路由取到了数据；实时槽位里 `conversation.input.left#keymanager-pill` 与 `settings.section#keymanager` 均为 active。
5. **浏览器半**（`test/client-probe.mjs`）：模块加载、三个槽位注册、空状态渲染不抛错；`PROBE_LOCALE=zh-CN` 与 `en` 两种语言下分别断言设置页与打开后的面板显示对应语言、且不含原始 key（`i18n-settings`、`panel-open` 的 `i18n` / `no-raw-keys` 全为 true）。
6. **汉化**：宿主探针断言工具描述、参数说明与 `render` 文本为中文（`description-zh`、`render-zh-empty`、`render-zh-save` 全为 true），报错同样为中文（`未对本对话开放`、`找不到名为…`）；界面侧 `locked` 徽标、网络与协议错误也走中文词典。`locale-probe.mjs` 静态核对在用的 63 个文案键在 en / zh 两份词典（各 67 键）中均存在且键集一致。
7. **对话内授权**（`test/host-probe.mjs`，伪 `userQuestions`）：拒绝 → `ACCESS_DENIED`（确认卡片的问题文本含凭据名、超时值大于 0）；批准 → 返回正确密钥，且同一对话第二次读取不再弹窗（`asked` 计数不变）；无人作答 → `ACCESS_TIMEOUT`；无该服务 → 回落 `NOT_AVAILABLE`。
8. **安装**：`install_bundle` 返回 `application: applied`、无 warning。
9. **安全加固**（`test/host-probe.mjs`、`test/vault-probe.mjs`）：`reveal-masked`（卡片不含明文、含「已掩码」）、`list-hides-paths`（输出无 `keyPath` / `vaultPath`，只剩 `algorithm`）、`save-no-autogrant`（工具参数已无 `autoGrant`）、`overwrite-denied` / `overwrite-confirmed` / `overwrite-applied`（拒绝则原值不变、同意才替换）、`approval-cooldown`（60 秒内重复申请不再弹窗）、`grant-rate-limit`（第 31 次授权写入返回 `TOO_MANY_REQUESTS`）、`sanitize-name` / `purpose-clamped`（bidi 与控制字符被剥离、用途截到 120 字）、`no-key-file`（`keyFile: never` + 无环境变量 → `NO_KEY` 且不写 `vault.key`）、`unknown-name`（错误不再枚举名称）。

## 已知限制

- 授权表在宿主内存里，插件重载 / 应用重启清空（保险库不受影响）。
- 没有「每次读取都弹确认」模式：一次批准在本对话内持续有效，直到重启或你在面板里关掉。需要逐次确认的凭据只能靠不打开开关。
- 子 Agent（被父会话拥有的 child）没有人工应答者，它的读取申请会回落成「请用户去开开关」，不会弹卡片；需要授权时请在主对话里操作。
- 审计最多保留最近 500 条。
- 只有「读密钥」一种消费方式；把密钥注入子进程环境而不让模型看到（`credential_exec`）是后续可加的能力。
- **升级插件后要重启应用**：Node 按模块 URL 缓存 ESM，同一进程内重装同名包不会加载新代码。改完代码请重启 DSH Desktop；开发期用新包名重装可以立刻生效（本插件就是这样迭代的）。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。本插件为原创实现、无第三方依赖；DSH 宿主与装载器同样以 MIT 发布，本插件不改变其许可。