# IITC Drone Path Planner

一个 [IITC](https://iitc.app/)（Ingress Intel Total Conversion）用户脚本插件，用于在 Ingress Intel 地图上自动计算两个 Portal 之间的 Drone 最短跳跃路径。

---

## 背景

Ingress 的 Drone 每次只能跳跃到 **500 米范围内**的另一个 Portal。手动规划跨越数公里的路径需要反复查看地图、计算距离，效率很低。

这个插件将路径规划自动化：选定起点和终点 Portal，插件自动运行 A\* 搜索算法，找出最少跳数的路径，并在地图上可视化显示。

---

## 功能

- **最短跳数路径**：A\* 算法保证找到跳数最少的路径
- **自动加载地图数据**：路径超出当前视野时，自动平移地图加载沿途 Portal 数据
- **断点检测**：无法到达时，高亮显示最近可达点与目标之间的缺口
- **地图可视化**：黄色折线 + 跳点编号标签
- **侧边栏面板**：显示 Portal 列表，点击可跳转到对应位置
- **路径清除**：一键清除路径，重新选择

---

## 安装

1. 安装 Firefox + [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 安装 [IITC](https://iitc.app/) 用户脚本
3. 在 Tampermonkey 中新建脚本，将 `drone-planner.user.js` 的内容粘贴进去，保存
4. 打开 [Ingress Intel](https://intel.ingress.com/)，IITC 加载后插件自动生效

---

## 使用方法

1. 将地图缩放到 **15 级或以上**（IITC 在此级别加载 Portal 数据）
2. **点击**地图上任意 Portal，右侧侧边栏出现 Portal 详情
3. 详情面板底部出现两个链接：
   - `✈ 设为 Drone 起点` — 设为路径起点（地图上显示 **S** 标记）
   - `✈ 设为 Drone 终点` — 设为路径终点（地图上显示 **E** 标记）
4. 起点和终点都选好后，侧边栏 **Drone Path Planner** 面板出现 **开始计算** 按钮
5. 点击按钮，插件开始搜索：
   - 搜索过程中实时显示进度（平移次数）
   - 找到路径后显示总跳数和距离，地图上画出黄色路径线
   - 若无法到达，显示断点位置（红色虚线 + 500m 范围圆）
6. 点击侧边栏路径列表中的 Portal 名称可将地图定位到该 Portal
7. 点击 **清除路径** 重置

---

## 实现方案

### 架构

单文件 IITC 用户脚本，内部分为四个模块：

| 模块 | 职责 |
|------|------|
| `Selection` | 监听 `portalDetailsUpdated` 钩子，在 Portal 详情面板注入起/终点选择链接 |
| `Graph` | 读取 `window.portals`，用 Haversine 公式计算距离，返回 ≤500m 的邻居节点 |
| `Pathfinder` | A\* 主循环、地图平移调度、断点检测 |
| `Renderer` | Leaflet 图层管理、侧边栏面板、结果展示 |

### A\* 搜索

**启发函数**：`h = ceil(haversine(current, goal) / 500)`

该启发函数是可接受的（不高估实际跳数），因此 A\* 保证返回最优解。

**数据结构**：二叉最小堆（`MinHeap`）作为优先队列，按 `f = g + h` 排序。

**边界节点处理**（`frozenSet`）：当某节点在已加载数据范围内没有邻居时，该节点被加入 `frozenSet`（而非 `closedSet`），触发地图平移加载新数据。数据加载完成后，冻结节点重新放回优先队列参与搜索。

```
┌─────────────────────────────────────────────────┐
│  A* 主循环                                       │
│                                                   │
│  pop(openSet) → 检查邻居                         │
│      ├─ 有邻居 → 加入 openSet，继续              │
│      └─ 无邻居 → 加入 frozenSet                  │
│              └─ 平移地图 → 等待 mapDataRefreshEnd │
│                      └─ resumeAfterPan()          │
│                              └─ frozenSet → openSet│
└─────────────────────────────────────────────────┘
```

**非阻塞执行**：每次 A\* 步骤通过 `setTimeout(fn, 0)` 调度，避免长时间占用主线程冻结浏览器。

**最大平移次数**：20 次。超出后停止搜索并执行断点检测。

### IITC 集成

- **Portal 选择**：使用 `portalDetailsUpdated` 钩子（当前 IITC 版本的正确 API），在点击 Portal 后的详情面板中注入操作链接
- **地图数据加载**：监听 `mapDataRefreshEnd` 钩子，在新 Portal 数据就绪后恢复搜索
- **图层管理**：通过 `layerChooser.addOverlay` 注册"Drone Path"图层，可在 IITC 图层选择器中切换显示

### 外部依赖

仅使用 IITC 提供的全局变量（Leaflet、jQuery、`window.portals`、`window.map`、`window.addHook` 等），无第三方库。

---

## 开发与测试

### 环境要求

- Node.js ≥ 18
- 已安装 Firefox（供 Playwright 使用）

### 安装依赖

```bash
npm install
```

### 单元测试

测试纯函数：Haversine 距离计算、A\* 核心逻辑（已知最优路径、断点、平移恢复）。

```bash
npm test
```

### E2E 测试

使用 Playwright + Firefox 驱动一个模拟 IITC 环境的本地页面，覆盖完整用户操作流程。

```bash
npm run test:e2e
```

测试覆盖：
- 插件加载与侧边栏初始化
- Portal 详情面板注入起/终点链接
- 起点/终点选择与 S/E 标记显示
- 2 跳路径（A→B→C）、1 跳路径（A→B）
- 断点检测（孤立 Portal）
- 清除路径
- 起终点相同的错误处理
- 地图缩放级别不足的错误处理

---

## 文件结构

```
drone-planner.user.js     # 插件主文件（单文件 IITC 用户脚本）
tests/
  haversine.test.js       # Haversine 距离单元测试
  astar.test.js           # A* 算法单元测试
  e2e/
    drone-planner.spec.js # Playwright E2E 测试
playwright.config.js      # Playwright 配置（Firefox）
package.json
```

---

## License

MIT
