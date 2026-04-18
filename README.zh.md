# IITC Drone 路径规划插件

> [English Documentation](README.md)

一个 [IITC](https://iitc.app/)（Ingress Intel Total Conversion）用户脚本插件，可在 Ingress Intel 地图上自动计算两个 Portal 之间的最优 Drone 跳跃路径。Drone 每次跳跃距离不超过 **500 米**。

---

## 功能特性

- **最优路径** — A\* 搜索算法保证跳跃次数最少
- **自动加载数据** — 当路径超出当前视图范围时，自动平移地图以加载沿途 Portal 数据
- **断点检测** — 当无法到达目标时，以红色虚线 + 500 米覆盖圆标注无法到达的缺口位置
- **地图可视化** — 黄色路径线，每跳附带编号标签
- **侧边栏面板** — 可滚动的 Portal 列表；点击任意 Portal 可平移地图并展示其详细信息
- **一键清除** — 随时重置并重新规划

---

## 安装方法

1. 安装 Firefox 及 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 安装 [IITC](https://iitc.app/)
3. 在 Tampermonkey 中新建脚本，将 `drone-planner.user.js` 的内容粘贴进去并保存
4. 打开 [Ingress Intel](https://intel.ingress.com/) — 插件将随 IITC 自动加载

---

## 使用方法

1. 将地图缩放至 **15 级或以上**（IITC 在此级别加载 Portal 数据）
2. **点击**地图上任意 Portal — 其详细信息将显示在侧边栏
3. 在 Portal 详情面板底部会出现两个链接：
   - `✈ 设为 Drone 起点` — 设为**起始** Portal（地图上标注 **S**）
   - `✈ 设为 Drone 终点` — 设为**目标** Portal（地图上标注 **E**）
4. 两端都设定后，**Drone 路径规划**面板会显示**开始计算**按钮
5. 点击按钮开始搜索：
   - 搜索过程中实时显示状态（显示自动平移次数）
   - 成功时：显示跳数和总距离，并在地图上绘制黄色路径
   - 失败时：以红色标注缺口位置
6. 点击结果列表中任意 Portal 可平移地图并展示其详细信息
7. 点击**清除路径**可重置

---

## 实现原理

### 架构

单文件 IITC 用户脚本，内部分为四个模块：

| 模块 | 职责 |
|------|------|
| `Selection` | 监听 `portalDetailsUpdated` 钩子；向 Portal 详情侧边栏面板注入起点/终点链接 |
| `Graph` | 读取 `window.portals`；计算 Haversine 距离；按需返回 ≤ 500 m 的邻居节点 |
| `Pathfinder` | A\* 主循环；地图平移调度；缺口检测 |
| `Renderer` | Leaflet 图层管理；侧边栏面板；结果展示 |

### A\* 搜索

**启发函数：** `h = ceil(haversine(current, goal) / 500)`

该启发函数是可接受的（永不高估），因此 A\* 保证返回最优解。

**优先队列：** 以 `f = g + h` 排序的二叉最小堆。

**边界节点处理（`frozenSet`）：** 当某节点在当前已加载地图数据中没有邻居时，将其置入 `frozenSet`（而非 `closedSet`），并平移地图向目标方向以加载更多数据。`mapDataRefreshEnd` 触发后，冻结节点重新加入优先队列。

**非阻塞执行：** 每步 A\* 通过 `setTimeout(fn, 0)` 调度，保持浏览器响应。最多自动平移 20 次，之后停止并执行缺口检测。

### IITC 集成

- **Portal 选择** — 使用 `portalDetailsUpdated`（当前 IITC 中的正确钩子；旧版 `portalContextmenu` 钩子已被移除）
- **数据加载** — 监听 `mapDataRefreshEnd`，在地图平移后恢复搜索
- **图层管理** — 通过 `layerChooser.addOverlay` 注册"Drone Path"覆盖图层；可在 IITC 图层选择器中切换显示

### 外部依赖

仅使用 IITC 提供的全局变量 — Leaflet、jQuery、`window.portals`、`window.map`、`window.addHook`、`window.layerChooser`。无第三方库。

---

## 开发

### 环境要求

- Node.js ≥ 18
- Firefox（供 Playwright 使用）

### 安装依赖

```bash
npm install
```

### 单元测试

测试纯函数：Haversine 距离计算及 A\* 核心逻辑（最优路径、缺口检测、平移恢复流程）。

```bash
npm test
```

### 端到端测试

Playwright 驱动 Firefox 中的本地模拟 IITC 页面，覆盖完整用户流程。

```bash
npm run test:e2e
```

端到端测试覆盖：
- 插件加载与侧边栏初始化
- Portal 详情面板注入
- 起点/终点 Portal 选择及 S/E 标记显示
- 2 跳路径（A → B → C）、1 跳路径（A → B）
- 缺口检测（孤立 Portal）
- 清除路径
- 起终点相同的错误处理
- 缩放级别守卫（< 15）

---

## 文件结构

```
drone-planner.user.js       # 插件 — 单文件 IITC 用户脚本
tests/
  haversine.test.js         # Haversine 单元测试
  astar.test.js             # A* 单元测试
  e2e/
    drone-planner.spec.js   # Playwright 端到端测试
playwright.config.js        # Playwright 配置（Firefox，无头模式）
package.json
README.md                   # 英文文档
README.zh.md                # 本文件（中文文档）
```

---

## 许可证

MIT
