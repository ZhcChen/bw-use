# 临时 Camoufox 浏览器设计

**目标**

在页面右上角新增两个操作：

- `创建临时浏览器`
- `一键关闭临时浏览器`

这些临时浏览器使用 Camoufox 启动，不进入现有浏览器列表；每次创建都使用新的独立 profile 数据目录；一键关闭时只处理本项目创建的临时 Camoufox，并清理对应 profile、cache 与派生临时数据。

## 背景与约束

- 当前项目已有一套持久浏览器管理链路，核心围绕 `browsers` 表、Chrome 启动参数和现有列表 UI。
- 新需求明确要求临时 Camoufox **不进入现有列表**，因此不能直接复用当前 `BrowserInstance` 模型。
- 临时 Camoufox 的生命周期必须与项目自身绑定，不能按系统全局进程名粗暴关闭。
- 测试和手动验证不能碰当前仓库已有 `data/`。

## Camoufox 行为依据

根据 Camoufox 官方文档：

- 默认会生成并使用随机 BrowserForge fingerprint。
- 若使用 `persistent_context=True` 且指定 `user_data_dir`，cookies、cache、storage 等会持久化到该目录。

基于此，本设计采用以下约束：

- 每次创建临时浏览器都分配一个新的 `user_data_dir`。
- 不传固定 fingerprint/preset，由 Camoufox 使用其默认随机 fingerprint 行为。

说明：

- 官方文档表达的是“默认随机 fingerprint”。
- “每次启动都应拿到新的随机指纹”是本功能基于该默认行为的实现预期，不是逐字保证。

参考：

- <https://camoufox.com/python/browserforge>
- <https://camoufox.com/python/usage>
- <https://github.com/daijro/camoufox>

## 范围

### 包含

- 右上角新增临时 Camoufox 创建/关闭入口。
- 新增后端临时实例注册与生命周期管理。
- 使用 Python 启动器集成 Camoufox。
- 新增本项目私有的“一键关闭并清理全部临时 Camoufox”能力。
- 服务启动时执行临时实例残留回收。

### 不包含

- 不把临时 Camoufox 显示到现有浏览器列表中。
- 不改造现有 Chrome 浏览器启动链路。
- 不关闭系统中非本项目创建的 Camoufox。
- 不做单个临时 Camoufox 明细面板或第二套列表 UI。

## 运行模型

临时 Camoufox 采用独立于现有浏览器列表的运行通道：

1. 前端点击 `创建临时浏览器`
2. Bun 后端生成 `tempId`
3. 后端创建实例根目录：
   - `data/temp-camoufox/<tempId>/`
4. 后端在该实例根目录下创建 profile 目录：
   - `data/temp-camoufox/<tempId>/profile`
5. 后端调用 Python 启动器，以新的 `user_data_dir` 启动 Camoufox
6. 后端将实例写入临时实例注册表
7. 前端仅刷新“临时浏览器数量”状态，不进入现有列表

## 清理边界

`一键关闭临时浏览器` 仅处理 **本项目创建并登记过** 的临时 Camoufox。

清理内容包括：

- 关闭对应 Camoufox 进程
- 删除对应 `user_data_dir`
- 删除实例根目录下的其他派生缓存或临时文件
- 删除注册表记录

不会触碰：

- 现有 Chrome 实例
- 现有 `browsers` 表里的业务数据
- 本机其他来源启动的 Camoufox

## 数据模型

新增一张 SQLite 表：`temp_browsers`

建议字段：

- `id TEXT PRIMARY KEY`
- `launcher_pid INTEGER`
- `profile_dir TEXT NOT NULL`
- `instance_dir TEXT NOT NULL`
- `created_at TEXT NOT NULL`

说明：

- `launcher_pid` 记录 Python 启动器进程或受管主进程 pid，用于定向关闭。
- `profile_dir` 与 `instance_dir` 分开存储，便于路径校验与递归清理。

## 后端接口

新增独立接口，不复用 `/api/browsers`：

### `POST /api/temp-browsers`

职责：

- 创建一个新的临时 Camoufox 实例

行为：

- 生成 `tempId`
- 创建实例目录与 profile 目录
- 调用 Python 启动器
- 启动成功后写入注册表
- 启动失败则回滚目录与记录

返回：

- `id`
- `createdAt`
- `running`

### `GET /api/temp-browsers`

职责：

- 返回当前受管临时实例摘要

返回：

- `count`
- `items`

`items` 至少包含：

- `id`
- `createdAt`
- `launcherPid`

### `DELETE /api/temp-browsers`

职责：

- 一键关闭并清理当前项目创建的全部临时 Camoufox

行为：

- 读取注册表
- 逐个关闭对应实例
- 清理 profile / instance 目录
- 汇总成功与失败结果

返回：

- `closedCount`
- `failedIds`

## Python 启动器

新增脚本：

- `scripts/camoufox_launcher.py`

职责：

- 接收 `tempId`、`user_data_dir` 等参数
- 用 Camoufox 启动一个持久上下文
- 保持进程存活，直到浏览器关闭或被后端终止

建议参数：

- `--temp-id`
- `--user-data-dir`
- `--headless`

设计原则：

- 启动器只负责启动和持有 Camoufox 生命周期
- 业务注册、清理和结果汇总全部由 Bun 后端负责

## 前端交互

右上角新增：

- `创建临时浏览器`
- `一键关闭临时浏览器`
- 状态文案：`临时浏览器：N 个`

### 创建临时浏览器

- 点击后按钮进入 `创建中...`
- 调 `POST /api/temp-browsers`
- 成功后刷新数量并提示成功
- 失败后恢复按钮并提示错误

### 一键关闭临时浏览器

- 当 `N = 0` 时按钮禁用
- 点击后弹确认框
- 确认后进入 `关闭中...`
- 调 `DELETE /api/temp-browsers`
- 成功时提示关闭数量
- 部分失败时提示成功/失败数量，并刷新剩余数量

## 错误处理

- 单个实例关闭失败不能阻断其他实例清理。
- 创建失败必须回滚：
  - 删除刚创建的临时目录
  - 不保留脏注册记录
- 所有错误都应写入现有 logs。

## 安全清理约束

### 1. 只删受管目录

所有临时实例目录统一位于固定根目录下：

- `data/temp-camoufox/`

删除前必须校验目标路径位于该根目录内，否则拒绝删除。

### 2. 只关受管实例

一键关闭只遍历 `temp_browsers` 表中的实例，不按系统全局名称扫描所有 Camoufox。

### 3. 允许部分失败

若某些实例关闭或删除失败：

- 其余实例继续处理
- 返回失败 id 列表
- 前端展示部分失败结果

## 启动恢复清理

服务启动时执行一次轻量恢复逻辑：

- 读取 `temp_browsers`
- 检查这些实例的受管进程是否仍然存在
- 对已失效但残留的实例目录执行回收
- 删除失效记录

目标是防止上次异常退出后遗留脏 profile 或过期注册表记录。

## 测试策略

### 自动化测试

所有自动化测试必须通过环境变量切换到临时数据目录，不能碰现有 `data/`。

重点覆盖：

- 临时实例目录路径生成
- 注册表写入与删除
- 启动失败回滚
- 一键关闭结果汇总
- 只清理本项目受管实例
- 路径保护逻辑

### 启动器集成测试

不依赖真实 Camoufox 全链路，而是允许用假的 launcher 模拟：

- 生成 pid
- 占用 profile 目录
- 模拟成功/失败/退出

### 手动验证

真实 Camoufox 手动验证这些点：

- 右上角能创建临时浏览器
- 连续创建多次时，每次都使用新目录
- 一键关闭后目录被清空
- 不影响现有 Chrome 列表与已有数据

## 影响文件（预期）

- `public/index.html`
- `src/index.ts`
- `src/store.ts`
- `src/browser-manager.ts` 或新增专用 temp manager 模块
- `scripts/camoufox_launcher.py`
- 新增测试文件

## 推荐实现原则

- 临时 Camoufox 与现有 Chrome 管理逻辑分层，不要强行塞进 `BrowserInstance`。
- 优先新增独立 temp manager 模块，而不是让现有 `browser-manager.ts` 同时承担 Chrome 与 Camoufox 两套职责。
- 清理逻辑以“注册表 + 固定目录根 + 精确 pid”三者结合为准，不依赖模糊进程名匹配。
