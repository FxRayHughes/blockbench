# Blockbench

Blockbench 是一款免费开源的低多边形模型编辑器，支持像素风贴图。
模型可以导出为标准格式，方便分享、渲染、3D 打印，或用于游戏引擎。此外还提供多种针对 Minecraft Java 版和基岩版的专用格式，包含特定平台的功能支持。

Blockbench 拥有现代化且对新手友好的界面，同时为资深 3D 美术师提供了丰富的自定义选项和高级功能。通过插件还可以进一步扩展程序功能。

官网与下载：[blockbench.net](https://www.blockbench.net)

![Interface](https://web.blockbench.net/content/front_page_app.png)

## 关于本分支

本仓库是 [JannisX11/blockbench](https://github.com/JannisX11/blockbench) 的维护分支，由 **FxRayHughes** 进行日常维护，会持续同步上游正式版的更新。

本分支的发布版本号格式为 `<上游版本号>-r<修订号>`（例如 `5.1.4-r1`），其中 `r` 代表本分支在该上游版本基础上的自定义修订序号，用于区分本分支专属的修复与改动。

如果你觉得这个分支对你有帮助，欢迎小额赞助支持维护，赞助入口：

[![Sponsor](https://img.shields.io/badge/💖-赞助支持-ea4aaa.svg)](https://www.ifdian.net/a/FxRayHughes)

**说明：** 本项目基于 GPLv3 协议开源，接受的赞助属于自愿性质的支持，**不代表本软件是付费软件**，也不会因赞助与否而产生功能差异或访问限制。所有源代码依然完全开放、免费获取，赞助仅用于维护成本的支持。

## 贡献

[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.0-4baaaa.svg)](CODE_OF_CONDUCT.MD)

请查看[贡献指南](CONTRIBUTING.md)。

## 启动 Blockbench

如果想从源码启动 Blockbench，可以克隆本仓库，切换到正确的分支，然后按照下面的说明以开发模式启动程序。
如果你只是想使用最新版本，请直接从官网下载应用程序。

### 配置仓库
* 安装 [NodeJS](https://nodejs.org/en/)。
* 安装所有依赖：
`npm install`

### 以 Electron 方式运行
使用以下命令，或按下 Ctrl + Shift + B，即可在 Electron 中启动 Blockbench：

`npm run dev`

如需在 VS Code 中启用调试，切换到 **Run & Debug** 面板，选择 **"Debug Renderer"** 配置，点击绿色箭头按钮启动。
之后即可在 VS Code 中设置断点进行调试。

### 运行网页版
使用以下命令在本地启动网页版：

`npm run serve`

启动后可以在浏览器中访问 http://localhost:3000 打开网页版。

## 插件

Blockbench 支持基于 JavaScript 的插件。了解更多插件开发相关内容，请访问 [https://www.blockbench.net/wiki/docs/plugin](https://www.blockbench.net/wiki/docs/plugin)。

## 许可协议

* Blockbench 源代码基于 GPL version 3 协议开源，详见 `LICENSE.MD`。
* 对源代码的修改必须遵循该协议的条款。
* Blockbench 的插件（外部脚本）与主题文件（用于自定义界面外观）通过 Blockbench API 与主程序交互，属于例外情况：插件和主题可以以开源、专有或付费软件的形式创建和/或发布。
* 使用 Blockbench 创建的所有素材（模型、贴图、动画、截图等）版权归你自己所有！
