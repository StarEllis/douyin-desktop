# 排查用探针

这些脚本通过 CDP 连到**正在运行**的 app，用来复现和测量，不参与构建：

```bash
npm start -- --remote-debugging-port=9222
node tools/inspect/black-screen-probe.js --port=9222
```

**它们不是测试。** 测试在 `test/`（单元）与 `tools/e2e/`（端到端，自带桩服务器）。
这里的东西只回答"现在到底发生了什么"，所以输出是给人看的 JSON，不是断言。

> 部分探针是为某个已经修好的问题写的一次性工具。保留它们是因为同一个问题复发时，
> 重新写一遍比读一遍贵得多 —— 下面的表说明了各自属于哪一类。

## 页面状态：服务器到底给了什么

| 脚本 | 用途 |
| --- | --- |
| `black-screen-probe.js` | 页面渲染了没有：`readyState`、body 子元素数、脚本数、样式数、错误 backlog |
| `navigation-status-probe.js` | 每次导航的状态码、mime、响应头（判断是否 403/空响应） |
| `response-body-probe.js` | 抓**响应体本身** —— 区分空响应、反爬挑战页（`_$jsvmprt`）、真实页面 |

三个是不同层次（DOM / 网络元数据 / 响应字节），互补而非重复。

## 复现「服务器不给页面」

| 脚本 | 用途 |
| --- | --- |
| `simulate-refused-document.js` | 只拒绝一次然后放开拦截，验证**单次修复**能成功 |
| `simulate-persistent-refusal.js` | 持续拒绝 N 秒，验证**阶梯升级与永不放弃**；是前者的超集，日常优先用它 |

两者都保持独立：前者是最小复现（一次拒绝），后者用来观察整条阶梯（`--hold=20000`）。

## 反爬挑战

| 脚本 | 用途 |
| --- | --- |
| `force-challenge-probe.js` | 删掉 `__ac_*` cookie 强制触发挑战，并对比两种文档的响应头 |

## 会话与存储

| 脚本 | 用途 |
| --- | --- |
| `session-cookie-probe.js` | 列出当前 cookie（名字、域、过期时间） |
| `cookie-transfer-probe.js` | 把一个实例的 cookie 注入另一个，做 A/B |
| `clear-storage-probe.js` | 清站点存储 / 强制重载；`--dry` 只读，`--types=` 指定范围 |

## 弹窗与卡顿（问题已修，工具保留）

| 脚本 | 用途 |
| --- | --- |
| `frozen-dialog-probe.js` | 卡住弹窗的形态：按钮 `pointer-events`、spinner、遮罩 |
| `invoke-dialog-handler.js` | 直接调用按钮的 React `onClick`，同时 hook DOM 移除调用 |
| `capture-dialog-exception.js` | 记录点击前后的异常与 backlog |
| `find-dialog-caller.js` | 在 bundle 里搜调用点（找 endpoint / 事件线） |
| `measure-dialog-close.js` | 测量自动关闭耗时，回归用 |
| `throttle-probe.js` | 计时器频率与 `visibilityState`，用于排除"被节流" |

## 播放器

| 脚本 | 用途 |
| --- | --- |
| `player-probe.js` | 全屏前后的播放器指标：内部分辨率 vs 显示尺寸、`devicePixelRatio`、CSS transform。`--page` 驱动"网页全屏"，`--url=` 直连视频页 |
| `fullscreen-blur-probe.js` | 全屏模糊归因：两个屏蔽开关的选择器**实际命中哪些元素**、其中几个含 `<video>`、谁在画模糊层、以及候选修复选择器的命中情况。`--steps=N` 决定滑几个视频 |
| `video-visibility-guard-probe.js` | 在真实渲染器里验证 `preload/video-visibility-guard.js`：合成同样的结构与规则，断言规则被移除、元素恢复可见。不需要登录 |

## 渲染性能

| 脚本 | 用途 |
| --- | --- |
| `style-cost-probe.js` | 脚本 `:has()` 分支的样式重算代价，同一渲染器会话内 A/B：把 bundle 里真实的 CSS 注入一个推荐页形状的合成页面，量 `RecalcStyleDuration`，跑一遍 `preload/style-cost-guard.js` 再量一次，并验证改写可逆。**不需要登录，也不需要 app 在运行**（自己开一个隐藏窗口）。`--rounds=` 每阶段重算次数，`--elements=` 合成页面的评论行数 |
| `wait-observer-probe.js` | `waitNode` 家族的等待开销归因。结论是**代价全在回调的选择器上，不在观察器配置上**：先给每个选择器单独定价（`querySelectorAll` 单价），再用 {廉价选择器, `:has()` 选择器} × {`childList`, `childList+attributes`} 做 2×2 配对 A/B。顺带把文档扩到 9 倍再定一次价，用来判断单价是否随文档规模增长。还会静态解析 bundle 的 23 处 `waitNode*` 调用点、区分有超时与永久（认得 `WAIT_TIME` 这类具名常量）。**不需要登录**。`--observers=` 并发等待数，`--load-ms=` 每轮负载时长，`--reps=` 每阶段配对数 |

> 两个探针都靠**同一会话内的配对 A/B**，因为跨启动的数字不可比。配对本身也要对称：两侧的
> CDP 往返次数要相同、顺序要交替，否则"重载后第一个跑的那一轮"会固定落在某一侧 ——
> `wait-observer-probe.js` 的第一版就因此给"不装任何观察器"的那一档量出了 +437 ms。

## 窗口状态：被遮挡、最小化之后还剩多少

| 脚本 | 用途 |
| --- | --- |
| `occlusion-probe.js` | 窗口在五种状态下**每秒产出多少帧、定时器还剩多少**：聚焦 / 可见未聚焦 / 遮住 60% / 完全遮住 / 最小化 / 恢复。用来回答"切到别的窗口后画面会不会停住"。`--flag` 关掉 `CalculateNativeWinOcclusion` 做对照，`--throttled` 用 Chromium 默认的 `backgroundThrottling` 做对照。**会短暂用黑窗遮住屏幕。** 结果与三个方法坑见 `AGENTS.md`「遮挡与停帧」 |
| `console-forwarding-probe.js` | 订阅 `console-message` 让渲染进程把每条 console 都转发到主进程，这个探针量**主进程**为此花的 CPU（每千条），并对比"不订阅 / 只计数 / 应用的真实配置"三种。`--messages=`、`--rounds=`、`--level=` |

> `occlusion-probe.js` 必须**逐秒采样**，不能每阶段只读一个总数：原生遮挡检测有传播延迟，
> 2.5 秒的窗口会在状态生效之前就结束，连续两次运行会给出相反的答案（实测 180 fps 与 0 fps）。

## 环境对照：是我们的壳还是环境？

| 脚本 | 用途 |
| --- | --- |
| `plain-electron-probe.js` | 用**纯 Electron**（不带 preload 与用户脚本）打开同一页面。这是排查环境类问题最快的分界实验 |
