# 移动端导航与新建形变实验

这是实验分支的交付说明，尚不是可分发的正式安装包。

## 开发隔离

- 目录：/Users/kiro/AI-Agent/Project/Cindy-mobile-nav-demo
- 分支：experiment/mobile-bottom-navigation
- 基线：c2dd5e0c5669420a785c1dfe2edd6bcc660afb9c
- 创建日期：2026-09-27。
- 独立 worktree 与 node_modules；未复制原工作区的未提交改动、凭证、用户数据或授权文件。
- 只在此 worktree 编辑。不切换原目录的分支，不停止原目录的 Metro，不向 main 推送。

## 试用构建隔离

从本目录运行只读检查：

    node scripts/mobile-navigation-demo.mjs inspect --region=cn
    node scripts/mobile-navigation-demo.mjs inspect --region=global

本地检查 JavaScript 打包（输出到系统临时目录，不安装、不上传）：

    node scripts/mobile-navigation-demo.mjs export --region=cn --platform=ios

在指定的已启动 iOS 模拟器上构建、安装并打开独立试用版：

    DEVELOPER_DIR=/Users/kiro/Downloads/Xcode.app/Contents/Developer node scripts/mobile-navigation-demo.mjs simulator --region=cn --udid=<模拟器 UUID>

该入口复用仓内的有界 Pods 安装与原生指纹检查，生成自带 JS 的 Release 模拟器包，
保留模拟器正常的本地代码签名与钥匙串能力；不需要团队分发签名、不使用 Metro 开发服务。
构建只包含所选模拟器当前使用的架构（ONLY_ACTIVE_ARCH=YES）。
必须使用 Xcode 27.1+：入口检查工具链版本、产物 SDK 与 Scene manifest；只在 27.1
模拟器中运行一个 27.0 SDK 包不足以启用现有 Duo reserved-region 适配代码。
ExpoModulesJSI 的接口清理脚本只识别旧编译器的 __ObjC. 写法，27.1 改为 __ObjC::。
试用入口在此 worktree 的依赖副本里兼容两种写法，以原子替换断开 pnpm 硬链接，
不改动共享 store、其他 worktree 或依赖版本；依赖脚本结构变化时停止并要求重新核对。
只安装并重启独立试用应用，不卸载其他应用，不复制已有登录态。每次代码修改后重新运行
会增量构建并更新随包 JS。打开窗口仍使用仓库的 sim-open 入口。

入口只接受本实验分支和显式区域，不启动 Metro 开发服务、不争用 8081、不读其他目录的 .env。
首次导出时若缺少被静态引用的 endpoint.dev.json，仅从仓内公开 example 初始化此 worktree 的忽略文件。

| 区域 | iOS / Android 应用标识 | 应用自身链接 scheme |
| --- | --- | --- |
| Global | com.xd.cindy.navdemo | cindynavdemo |
| 中国大陆 | com.xd.cindycn.navdemo | cindycnnavdemo |

只设置 EXPO_PUBLIC_CINDY_NAV_DEMO 不足以识别为试用版：同时核验原生安装身份与 Expo 配置标记。
试用构建禁用 OTA，不使用现有 EAS / self-host 项目和发布配置。首轮通过整包更新试用版本。
普通构建未启用该变量时继续返回原配置。试用配置必然产生新原生指纹，需要独立出包；
不能把试用包的 bundle 投给正式装机。本分支不能未经拆分就合入主干或正式发布线。

## 定案（2026-09-29）

- 不采用底部标签栏；回到侧边栏抽屉导航（左上菜单：任务/伙伴切换、搜索、设备管理、加入共享任务、
  设置、切换账号、退出登录）。底栏相关代码、开关与文案已全部删除。
- 保留首页悬浮新建按钮，按方案 A 坐在输入框静止底线上：右缘 = 输入框右内边距 16pt，
  下缘 = 安全区 + 8pt，按钮与药丸同为 55pt（`composerGeometry.pillHeight`）。
- 已合并「移动端账号信息优化」：侧栏账号区大号姓名 + 默认字母头像 + 公司小图标、不显示 ID；
  侧栏右侧圆角与柔和阴影（DESIGN.md 已登记局部例外），滑出/关闭/拖动共用同一进度。

## 当前交互（iOS）

- 新建：原生 `CindyComposerMorphSource` 接管按钮触摸，按下即横向拉长成等高药丸（不播系统按压），
  iOS 式利落弹簧（响应约 0.36s、刚度 305、阻尼比 0.67，单次过冲约 14pt 后停稳）；抬手进入新建页，滑出松开弹回、不导航。页面挂载前由替身玻璃生长，
  就绪后真实玻璃带速度接力；进入时不播推入动画，进入后恢复普通返回动画。只有首页开启形变。
- 输入框：新建、已有任务、伙伴聊天统一为 55pt 药丸，下沿同一条线；不自动聚焦。手动点药丸先向上
  拉开成完整卡片（原生），约 0.05s 后原生聚焦，键盘随后升起；输入框逐帧跟随键盘
  （均在 `ComposerDockKeyboardFollow.tsx`：新建页 `DockKeyboardBottomSpacer`，已有任务 `DockKeyboardLift` / `DockKeyboardViewportSpacer`）。
- 减弱动态效果：不播形变与拉开，直接到位。
- 伙伴对话：左上角为返回（回到伙伴列表）；Duo 系统栏已有返回时保留侧栏按钮，不出现两个返回。
- 设置等整页滚动的二级页：顶栏透明、系统柔和边缘，内容滚到顶栏和底部指示条下面，无硬分界（设置、语音词典、账号注销、伙伴私聊、共享任务管理、资源列表）；设备详情只去掉底部色带。

## 已知未完成

- 已有任务页键盘升起过程中，消息列表内容不随动，停稳后跳到底（自研历史列表滚动锚定）。
- 卡片收回药丸仍为直接切换；禁用的新建按钮点击无说明。
- 深色全量实走、Duo 各姿态、真机帧率未做。
- `devices.json` 同一对象里 `failed` 键重复（基线即如此，前者文案永不生效），未处理。
- 设备详情页列表上方有固定的搜索条，列表顶端仍是硬切。

- 已合入 main 000337155f（2026-09-29）：首页标题宽度改用 main 的对称算法，比试用版更早截断。

## 合入前待办（效果全部确认后统一处理）

2026-09-29 用户决定：试用阶段优先看效果，守护与登记类修正等所有效果确认后最后一次性处理；
在此之前本分支不提交、不提 PR（CI 会拦）。

- [ ] `designTokenDiscipline.test.ts` 失败：ALLOWLIST 里 `ComposerFrame.ios.tsx :: borderRadius: 30`
      已过期（圆角移到 `composerGeometry.cornerRadius` 常量），同时让守护覆盖这类常量写法。
- [ ] 圆钮入场弹簧（刚度 305、阻尼比 0.67，单次过冲约 14pt）和药丸拉开弹簧登记到 DESIGN.md §14.4 动效例外。
- [ ] 形变与聚焦相关的散落时长（0.05 / 0.18 / 0.22 秒、320 / 400ms）改用 token 或登记原因。
- [ ] 原生模块 `modules/cindy-tab-bar` 已不含标签栏，只剩新建形变与药丸拉开：合入前改名（如 cindy-composer-morph，需 pod install），
      并拆掉试用身份（`src/config/navigationDemo.ts`、`app.config.js`、`scripts/*navigation-demo*`、env 中的 IS_NAVIGATION_DEMO）；
      原生改动触发冷更，合并前须指定把关人确认。
- [ ] `envBundleTransform.test.ts`：`src/config/env.ts` 引入试用配置 `./navigationDemo` 后测试桩缺条目，补
      `if (id === './navigationDemo') return { IS_NAVIGATION_DEMO: false, NAVIGATION_DEMO_SCHEME: 'cindynavdemo' };`。

## 验证记录

完整试验过程（含已放弃的底栏方案）不再保留在仓库；最近一次验证：iPhone 浅色实走首页 / 侧栏 /
新建形变 / 药丸对齐 / 点开弹键盘；Mobile 类型检查 0 错误；全量测试除合入前待办 3 项外通过。
