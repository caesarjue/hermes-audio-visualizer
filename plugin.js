/**
 * audio-visualizer — Hermes Desktop 音频律动（最简可靠版）
 *
 * 设计原则（2026-09-12 重构）：每次加载 = 完全重建，不做任何跨热重载的
 * 状态复用（旧版的"保流复用"正是错位故障源）。canvas 通过 DOM 直查定位，
 * 不依赖 React 引用时序。自诊断写 localStorage('av.diag')，可远程排查。
 *
 * 数据通路：主进程 Catap loopback 补丁 → getDisplayMedia（占位视频轨）
 *   → AnalyserNode 纯内存 FFT → canvas 32 根彩虹条 + 整窗边缘光晕。
 * 音频不落盘不上传。回滚：删除本目录 + git apply --reverse 主进程补丁。
 */
import { PALETTE_AREA, haptic, host, useValue, atom } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useRef, useEffect } from 'react'

const ID = 'audio-visualizer'
const enabledAtom = atom(false)

// ── 模块级状态（每次加载全新；不跨热重载复用任何东西）────────────
let stream = null
let audioCtx = null
let analyser = null
let rafId = 0
let gainPeak = 0.15
let overlay = null

function diag(data) {
  try { localStorage.setItem('av.diag', JSON.stringify({ t: Date.now(), ...data })) } catch {}
}

function hardStop() {
  cancelAnimationFrame(rafId)
  rafId = 0
  try { stream?.getTracks().forEach((t) => t.stop()) } catch {}
  stream = null
  try { audioCtx?.close() } catch {}
  audioCtx = null
  analyser = null
  try { overlay?.remove() } catch {}
  overlay = null
  enabledAtom.set(false)
}

async function start() {
  hardStop()
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: 4 }, height: { ideal: 4 }, frameRate: { ideal: 1 } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  })
  s.getVideoTracks().forEach((t) => { try { t.stop() } catch {} s.removeTrack(t) })
  if (!s.getAudioTracks().length) {
    s.getTracks().forEach((t) => { try { t.stop() } catch {} })
    throw new Error('no audio track in loopback stream')
  }
  stream = s
  s.getAudioTracks()[0].addEventListener('ended', () => { hardStop(); diag({ state: 'track-ended' }) })
  audioCtx = new AudioContext()
  const src = audioCtx.createMediaStreamSource(s)
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = 0.4
  bandEdges = buildBandEdges(audioCtx.sampleRate, analyser.frequencyBinCount)
  // 入 analyser 前衰减，避免 8bit 映射把低频整片钉死在 255
  const preGain = audioCtx.createGain()
  preGain.gain.value = PRE_GAIN
  src.connect(preGain)
  preGain.connect(analyser)
  overlay = document.createElement('div')
  overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483000;opacity:0;transition:opacity 120ms linear;'
  document.body.appendChild(overlay)
  gainPeak = 0.15
  enabledAtom.set(true)
  diag({ state: 'started' })
  loop()
}

const SEGS = 48
const W = 118
const H = 24

// ── 频谱幅度调校（2026-11-03）──────────────────────────────────────
// 三个叠加问题会让频谱「看着没起伏」，这里一并修掉：
//  1) loopback 电平很高，AnalyserNode 的 8bit 映射（minDecibels -100 /
//     maxDecibels -30）会把整片低频钉死在 255 → 入 analyser 前先衰减 -12dB；
//  2) 512 点 FFT @48kHz = 93.75Hz/bin，对数分频时前十几段全落在 bin 1，
//     数值完全相同（看着像一整块）→ 改用 2048 点 FFT + 混合分频；
//  3) raw**0.78 压缩动态范围、gain 又把峰值钉死 1.0（每帧必有一段满格）→
//     改用更陡的幂次 + 动态扩展 + 顶部留白。
const PRE_GAIN = 0.35            // -9 dB（118×24 小画布用 -9dB；200×32 版用 -12dB）
const FFT_SIZE = 2048
const LEVEL_POWER = 1.10
const LEVEL_FLOOR = 0.05
const LEVEL_HEADROOM = 0.92
const BAND_LOW_HZ = 40
const BAND_MID_HZ = 500
const BAND_TOP_HZ = 11000
const LOW_SEGS = 15              // 40-500Hz 线性段数（每段 ≈1 个 bin，互不重叠）
let bandEdges = null

// 低段线性（各段独立跳动）、高段对数（贴合听感）
function buildBandEdges(sampleRate, binCount) {
  const binHz = sampleRate / FFT_SIZE
  const nb = Math.min(binCount, FFT_SIZE / 2)
  const f2b = (f) => Math.max(1, Math.min(nb - 1, Math.round(f / binHz)))
  const out = []
  for (let i = 0; i < SEGS; i++) {
    let f0, f1
    if (i < LOW_SEGS) {
      f0 = BAND_LOW_HZ + (BAND_MID_HZ - BAND_LOW_HZ) * (i / LOW_SEGS)
      f1 = BAND_LOW_HZ + (BAND_MID_HZ - BAND_LOW_HZ) * ((i + 1) / LOW_SEGS)
    } else {
      const t0 = (i - LOW_SEGS) / (SEGS - LOW_SEGS)
      const t1 = (i - LOW_SEGS + 1) / (SEGS - LOW_SEGS)
      f0 = BAND_MID_HZ * Math.pow(BAND_TOP_HZ / BAND_MID_HZ, t0)
      f1 = BAND_MID_HZ * Math.pow(BAND_TOP_HZ / BAND_MID_HZ, t1)
    }
    let lo = f2b(f0)
    let hi = f2b(f1)
    if (hi <= lo) hi = lo + 1
    out.push([lo, hi])
  }
  return out
}

function loop() {
  if (!analyser) return
  const bins = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(bins)

  const raw = []
  const edges = bandEdges || []
  for (let i = 0; i < SEGS; i++) {
    const e = edges[i] || [1, 2]
    const lo = e[0]
    const hi = Math.min(e[1], bins.length)
    let sum = 0
    for (let k = lo; k < hi; k++) sum += bins[k] || 0
    raw.push(sum / Math.max(1, hi - lo) / 255)
  }
  const curved = raw.map((v) => Math.pow(v, LEVEL_POWER))
  gainPeak = Math.max(gainPeak * 0.975, Math.max(...curved))
  const gain = 1 / Math.max(gainPeak, 0.12)
  // 动态扩展（下切）+ 顶部留白：让起伏明显，不再每帧削顶
  const levels = curved.map((v) => {
    const g = Math.min(1, v * gain)
    const e = Math.max(0, (g - LEVEL_FLOOR) / (1 - LEVEL_FLOOR))
    return Math.min(LEVEL_HEADROOM, e)
  })

  // canvas：DOM 直查（唯一真相源，与 React 生命周期完全解耦）
  const cv = document.querySelector('canvas[data-av-spectrum]')
  if (cv) {
    const ctx2d = cv.getContext('2d')
    const dpr = window.devicePixelRatio || 2
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr
      cv.height = H * dpr
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx2d.clearRect(0, 0, W, H)
    const bw = W / SEGS
    for (let i = 0; i < SEGS; i++) {
      const h = Math.max(1.5, levels[i] * (H - 2))
      ctx2d.fillStyle = `hsl(${Math.round((i / (SEGS - 1)) * 300)} 90% ${46 + levels[i] * 30}%)`
      ctx2d.globalAlpha = 0.5 + levels[i] * 0.5
      ctx2d.fillRect(i * bw, H - h, Math.max(1.2, bw - 0.7), h)
    }
    ctx2d.globalAlpha = 1
    diag({ state: 'drawing', cv: true, max: Math.round(Math.max(...levels) * 100) })
  } else {
    diag({ state: 'drawing', cv: false })
  }

  // 边缘光晕（低音驱动 bin 2..10 ≈ 47–234Hz）
  if (overlay) {
    let bs = 0
    for (let k = 2; k <= 10; k++) bs += bins[k] || 0
    // 除以 PRE_GAIN 抵消入 analyser 前的衰减，辉光灵敏度保持不变
    const bass = Math.min(1, Math.pow(bs / 9 / 255 / PRE_GAIN, 0.6) * 2.2)
    overlay.style.opacity = '1'
    overlay.style.boxShadow = `inset 0 0 ${10 + bass * 46}px hsla(${Math.round(210 - bass * 190)} 88% 62% / ${(0.06 + bass * 0.5).toFixed(3)})`
  }
  rafId = requestAnimationFrame(loop)
}

async function toggle(ctx) {
  if (enabledAtom.get() || stream) {
    hardStop()
    diag({ state: 'stopped-by-toggle' })
  } else {
    try {
      await start()
      ctx.storage.set('enabled', true)
    } catch (err) {
      hardStop()
      diag({ state: 'start-failed', err: String(err?.message || err) })
      try {
        host.notify({ kind: 'warning', message: `音频律动启动失败：${err?.message || err}` })
      } catch {}
    }
  }
  try { haptic('tap') } catch {}
}

function Chip() {
  const enabled = useValue(enabledAtom)
  useEffect(() => { diag({ state: 'chip-mounted' }) }, [])

  return jsx('button', {
    type: 'button',
    title: enabled ? '音频律动：开启中 — 点击关闭' : '音频律动：已关闭 — 点击开启',
    onClick: () => toggle(globalThis.__avCtx),
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      height: '100%', padding: '0 5px',
      background: 'transparent', border: 'none', cursor: 'pointer',
    },
    children: [
      jsx('canvas', {
        key: 'spec',
        'data-av-spectrum': '1',
        style: { width: W + 'px', height: H + 'px', display: 'block' },
      }),
      jsx('span', {
        key: 'dot',
        style: {
          width: '5px', height: '5px', borderRadius: '50%',
          background: enabled ? 'var(--ui-accent, currentColor)' : 'var(--ui-text-quaternary, currentColor)',
          opacity: enabled ? 0.9 : 0.45,
        },
      }),
    ],
  })
}

export default {
  id: ID,
  name: '音频律动 (Audio Visualizer)',
  defaultEnabled: true,
  register(ctx) {
    globalThis.__avCtx = ctx
    const wasOn = enabledAtom.get() || !!stream
    // 完全重建：停掉一切旧状态（消除多轮热重载积累的错位）
    hardStop()
    diag({ state: 'register', wasOn })
    if (wasOn) {
      // 尽量无感恢复；失败则静默等用户点击（灰状态）
      start().catch((err) => diag({ state: 'auto-restart-failed', err: String(err?.message || err) }))
    }

    ctx.register({ id: 'chip', area: 'statusBar.right', order: 5, render: () => jsx(Chip, {}) })

    ctx.register({
      id: 'toggle',
      area: PALETTE_AREA,
      data: {
        id: 'audio-visualizer.toggle',
        label: '音频律动：开启/关闭（跟随系统声音）',
        keywords: ['audio', 'visualizer', '律动', '频谱'],
        run: () => toggle(ctx),
      },
    })
  },
}
