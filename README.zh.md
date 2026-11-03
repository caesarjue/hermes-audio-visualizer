# Hermes Audio Visualizer（音频律动）

[English](README.md) | **简体中文**

为 **Hermes Desktop** 状态栏打造的「系统音频驱动」彩虹频谱——48 根频谱条跟着 Mac 正在播放的一切舞动，外加一圈随低音起伏的窗口边缘光晕。

完全本地：音频只在内存中分析（`AnalyserNode` 做 FFT），不录制、不上传。

```
 ▁▃▅█▅▃▁▂▄▆█▆▄▂  ← 48 段彩虹频谱芯片（状态栏右侧）
 + 窗口边缘光晕（安静时冷蓝 → 重低音时暖橙红）
```

## 功能

- **48 段彩虹频谱**——色相随频率变化（低频红 → 高频紫），明度跟随振幅
- **窗口边缘光晕**——环绕整个窗口的内发光，由真实低音区间（约 47–234 Hz）驱动
- **自适应灵敏度**——缓慢衰减的增益跟踪，安静曲目也能撑满频谱条；配合对比曲线，重拍鼓点有明显的冲击感
- **真正的频段分离**——2048 点 FFT + 混合分频（40–500 Hz 线性、500–11 kHz 对数）。低频每根柱子对应独立 bin，不再共用一个 bin 而「一起僵着动」
- **给 Crest 留空间**——入 analyser 前 −9 dB 衰减 + 动态扩展 + 8% 顶部留白：曲线在 25%~100% 之间起伏，而不是钉死在天花板
- **一键开关**——点击状态栏芯片，或 ⌘K →「音频律动」
- **零遥测**——`getDisplayMedia` → `AnalyserNode` → canvas，什么都不离开进程

> **2026-11 更新**——本版修掉三个让「振幅看着太小」的问题：① `getByteFrequencyData` 的 8bit 映射（默认 −100/−30 dB）把整片低频饱和成 255，每帧都有柱子顶到 100%、曲线看起来是平的；② 48 kHz 下 512 点 FFT 只有 93.75 Hz/bin，对数分频时前约 14 段全落在同一个 bin；③ `raw**0.78` + 峰值归一化把剩下的动态也压平了。现在：预衰减 −9 dB、2048 点 FFT、混合线性/对分数频、`raw**1.10`、下切 0.05、顶部留白 8%。

## 环境要求

> ⚠️ **本插件需要主进程补丁。** 桌面插件运行在渲染进程里，无法注册 Chromium 回环音频链路所需的 `setDisplayMediaRequestHandler`。补丁在 [`patches/`](patches/) 目录——打一次，之后插件就像普通插件一样工作。

| 组件 | 版本 |
|---|---|
| Hermes Desktop | 0.17.2（Electron 40.10.2） |
| macOS | 13.2+（开发环境：macOS 26.6） |

## 安装

### 1. 安装插件

一键安装（需要 Hermes Desktop 正在运行）：

**`hermes://plugin/install?repo=caesarjue/hermes-audio-visualizer`**

或者在 **设置 → 插件 → 从 Git 安装** 里填 `caesarjue/hermes-audio-visualizer`，或手动：

```bash
mkdir -p ~/.hermes/desktop-plugins/audio-visualizer
cp plugin.js ~/.hermes/desktop-plugins/audio-visualizer/plugin.js
```

### 2. 应用主进程补丁

```bash
# 1) 把本仓库 clone 到任意位置
git clone https://github.com/caesarjue/hermes-audio-visualizer.git /tmp/hav

# 2) 把补丁应用到你的 Hermes 源码树
cd ~/.hermes/hermes-agent
git apply /tmp/hav/patches/hermes-desktop-audio-loopback.patch

# 3) 重新构建并安装桌面应用
cd apps/desktop
npm run build && npm run builder -- --dir --publish never --arm64
# 退出 Hermes（⌘Q），然后在终端执行：
ditto release/mac-arm64/Hermes.app /Applications/Hermes.app
```

验证补丁已生效（应输出 `1`）：

```bash
rg -c "MacCatapLoopbackAudioForScreenShare" ~/.hermes/hermes-agent/apps/desktop/electron/main.ts
```

### 3. 启用

1. 打开 Hermes Desktop → **⌘K →「Reload desktop plugins」**
2. 状态栏右侧出现频谱芯片（在 context-usage 芯片左边）
3. **点它**——小圆点亮起，频谱条开始跳动 🎵

## 使用

| 操作 | 效果 |
|---|---|
| 点击芯片 | 开 / 关 |
| ⌘K →「音频律动」 | 从命令面板开关 |
| 播放任何声音（音乐、视频、通话） | 频谱跟随系统输出混音 |
| 关闭 | 音频流立即释放，光晕消失 |

## 疑难排查

| 症状 | 解决 |
|---|---|
| 芯片是灰的 / 没反应 | 点击芯片启动 |
| 更新后插件不见了 | ⌘K → **Reload desktop plugins**（完整重载优于反复热重载） |
| `Error starting capture` | 主进程补丁没打（或者打完没重新构建/安装应用） |
| `Video was requested, but no video stream was provided` | 插件版本旧——更新到最新 `plugin.js` |
| macOS 权限弹窗 | 首次使用时允许 Hermes 的「屏幕与系统音频录制」 |

诊断：插件把状态写入 `localStorage['av.diag']`：

```bash
strings ~/Library/Application\ Support/Hermes/Local\ Storage/leveldb/* | rg 'av\.diag'
# {"t":...,"state":"drawing","cv":true,"max":87}  → 健康
```

## 兼容性说明（致未来的 Hermes/Electron 版本）

- Electron 40 上回环特性的开关名是 **`MacCatapLoopbackAudioForScreenShare`**。这个家族改过名（`MacSck*` → `MacCatap*`）。Hermes 更新后如果插件失效：

  ```bash
  strings "/Applications/Hermes.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" | rg -i 'loopback' | sort -u
  ```

  用返回的名字替换补丁里的 `MacCatapLoopbackAudioForScreenShare`。
- `session.defaultSession` 只能在 `app.whenReady()` 之后碰——补丁已经是这么做的。
- 纯音频的 `getDisplayMedia` 在这套 Chromium 栈上是坏的（[electron#49607](https://github.com/electron/electron/issues/49607)）；变通方案（一个微小的占位视频轨 + handler 里给真实屏幕源）已经内置在补丁和插件里。

## 卸载

```bash
rm -rf ~/.hermes/desktop-plugins/audio-visualizer
# 如需还原源码补丁：
cd ~/.hermes/hermes-agent && git apply --reverse <patch>
```

## 许可

MIT——见 [LICENSE](LICENSE)。
