# bw-use

一个基于 Bun 的本地浏览器管理工具，提供以下能力：

- 创建、编辑、删除浏览器实例
- 浏览器分组与批量删除
- 指纹参数配置与随机生成
- 代理配置（支持 `IP:端口:用户名:密码` 自动拆分）
- 代理连通性测试
- 临时浏览器创建与一键关闭
- 本地日志查看

## 版本

当前版本：`0.1.0`

页面头部和底部显示的版本号会从 `package.json` 动态注入。

## 环境要求

- Bun
- macOS + Google Chrome（当前项目里临时浏览器相关逻辑默认按 macOS Chrome 路径处理）

## 安装依赖

```bash
bun install
```

## 启动开发环境

```bash
bun run dev
```

默认访问地址：

```text
http://localhost:20000
```

## 启动生产模式

```bash
bun run start
```

## 常用环境变量

- `BW_USE_PORT`：服务端口，默认 `20000`
- `BW_USE_DATA_DIR`：数据目录，默认 `./data`
- `BW_USE_TEMP_CHROME_DIR`：临时浏览器目录，默认在数据目录下
- `BW_USE_PROXY_TEST_URL`：代理测试目标地址，默认 `https://api.ipify.org?format=json`
- `CHROME_PATH`：Chrome 可执行文件路径

## 数据说明

运行时数据默认写入：

```text
data/
```

该目录已加入 `.gitignore`，不会进入版本库。

## 测试

```bash
bun test
```
