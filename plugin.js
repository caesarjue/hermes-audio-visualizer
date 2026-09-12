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
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.5
  src.connect(analyser)
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

function loop() {
  if (!analyser) return
  const bins = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(bins)

  const raw = []
  for (let i = 0; i < SEGS; i++) {
    const lo = Math.max(1, Math.floor(Math.pow(250, i / SEGS)))
    const hi = Math.max(lo + 1, Math.floor(Math.pow(250, (i + 1) / SEGS)))
    let sum = 0
    for (let k = lo; k < hi; k++) sum += bins[k] || 0
    raw.push(sum / (hi - lo) / 255)
  }
  const curved = raw.map((v) => Math.pow(v, 0.78))
  gainPeak = Math.max(gainPeak * 0.975, Math.max(...curved))
  const gain = 1 / Math.max(gainPeak, 0.12)
  const levels = curved.map((v) => Math.min(1, v * gain))

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
    const bass = Math.min(1, Math.pow(bs / 9 / 255, 0.6) * 2.2)
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
