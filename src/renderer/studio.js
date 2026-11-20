/**
 * 虚拟演播室（绿幕 + 三维场景）
 * ---------------------------------------------------------------
 * 一个 StudioRuntime 管一块画布：
 *   1) three.js 渲染三维场景（虚拟摄像机，可推拉摇移）
 *   2) 摄像头画面走一遍片元着色器做绿幕抠像（CbCr 色度距离 + 收缩/羽化 + 去绿边 + 光影色调匹配）
 *   3) 抠好的"人"用正交相机画在场景上面，跟着场景的机位变化走位
 *   4) 切场景时把上一帧抓成纹理做交叉淡入（毫秒级，不重建 WebGL 上下文）
 *
 * 只在本机渲染，输出就是这块 <canvas>：现有的"录窗口/屏幕录制"能直接把它录下来。
 */

import * as THREE from 'three'

/* ------------------------------ 片元着色器 ------------------------------ */

const PERSON_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const PERSON_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec3 uKey;          // 键色（绿幕颜色）
uniform float uTol;         // 色度容差
uniform float uSoft;        // 边缘羽化
uniform float uShrink;      // 收缩（吃掉绿边）
uniform float uSpill;       // 去绿边强度
uniform vec3 uTint;         // 场景环境色
uniform float uTintMix;     // 环境色混合比例
uniform float uBright;      // 亮度微调
uniform vec2 uOffset;       // 人在画面里的位置（-1..1）
uniform float uScale;       // 人的缩放
uniform float uMirror;      // 1 = 镜像
varying vec2 vUv;

vec2 cbcr(vec3 c) {
  return vec2(
    -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b,
     0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b
  );
}

void main() {
  vec2 uv = vUv;
  // 人的位置/缩放：围绕画面正中缩放，再平移
  vec2 p = (uv - 0.5);
  p.x *= uMirror > 0.5 ? -1.0 : 1.0;
  p = p / max(uScale, 0.001);
  vec2 t = p + 0.5 + uOffset;
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) discard;

  vec3 c = texture2D(uTex, t).rgb;

  // 色度距离：只比 CbCr，光照强弱（亮度）不影响判断，比直接比 RGB 稳
  float d = distance(cbcr(c), cbcr(uKey));
  // uShrink 让 alpha 更"紧"（把边缘的绿吃进去一点），uSoft 是过渡宽度
  float lo = uTol + uShrink * 0.5;
  float hi = lo + max(uSoft, 0.001);
  float a = smoothstep(lo, hi, d);

  // 去绿边：绿色分量超过红蓝最大值的部分压回去
  float spill = c.g - max(c.r, c.b);
  if (spill > 0.0) c.g -= spill * clamp(uSpill, 0.0, 1.5);

  // 光影匹配：按场景环境色轻微染色，让人不那么"贴上去"
  c = mix(c, c * uTint, clamp(uTintMix, 0.0, 1.0));
  c *= uBright;

  gl_FragColor = vec4(c, a);
}
`

const VEIL_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  gl_FragColor = vec4(c.rgb, c.a * uAlpha);
}
`

/* ------------------------------ 场景 ------------------------------ */

function makeStudioScene() {
  const g = new THREE.Group()
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x12151c, roughness: 0.35, metalness: 0.35 })
  )
  floor.rotation.x = -Math.PI / 2
  g.add(floor)

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.8 })
  const back = new THREE.Mesh(new THREE.BoxGeometry(24, 9, 0.4), wallMat)
  back.position.set(0, 4.5, -8)
  g.add(back)

  // 背后的发光条
  const stripMat = new THREE.MeshBasicMaterial({ color: 0x3a7bff })
  for (let i = -2; i <= 2; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.18, 6.4, 0.18), stripMat)
    s.position.set(i * 2.4, 3.4, -7.7)
    g.add(s)
  }
  // 圆环当装饰
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.2, 0.06, 16, 64),
    new THREE.MeshBasicMaterial({ color: 0x7aa2ff })
  )
  ring.position.set(0, 5.2, -7.2)
  g.add(ring)
  // 地台
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(3.4, 3.6, 0.16, 48),
    new THREE.MeshStandardMaterial({ color: 0x2a3142, roughness: 0.5, metalness: 0.4 })
  )
  disc.position.set(0, 0.08, 0)
  g.add(disc)

  const key = new THREE.DirectionalLight(0xffffff, 1.5)
  key.position.set(4, 9, 6)
  const rim = new THREE.DirectionalLight(0x5f8bff, 1.2)
  rim.position.set(-6, 5, -6)
  g.add(key, rim)
  return g
}

function makeOutdoorScene() {
  const g = new THREE.Group()
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x2f4a35, roughness: 0.95 })
  )
  ground.rotation.x = -Math.PI / 2
  g.add(ground)

  // 远山
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x3d5a45, roughness: 1 })
  for (let i = 0; i < 7; i++) {
    const h = 6 + (i % 3) * 3
    const hill = new THREE.Mesh(new THREE.ConeGeometry(7 + (i % 2) * 3, h, 5), hillMat)
    hill.position.set(-22 + i * 8, h / 2, -26 - (i % 3) * 5)
    g.add(hill)
  }
  // 几棵树（柱子 + 圆锥）
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b3a, roughness: 1 })
  for (const [x, z, s] of [
    [-7, -6, 1],
    [8, -8, 1.2],
    [-11, -12, 0.9]
  ]) {
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.24 * s, 2.4 * s, 8), trunkMat)
    tr.position.set(x, 1.2 * s, z)
    const lf = new THREE.Mesh(new THREE.ConeGeometry(1.4 * s, 3.2 * s, 8), leafMat)
    lf.position.set(x, 3.6 * s, z)
    g.add(tr, lf)
  }
  const sun = new THREE.DirectionalLight(0xfff2d0, 2.2)
  sun.position.set(10, 16, 6)
  const fill = new THREE.HemisphereLight(0xbcd6ff, 0x2f4a35, 0.9)
  g.add(sun, fill)
  return g
}

function makeSciFiScene() {
  const g = new THREE.Group()
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 0.2, metalness: 0.7 })
  )
  floor.rotation.x = -Math.PI / 2
  g.add(floor)

  const grid = new THREE.GridHelper(60, 60, 0x2a5cff, 0x122038)
  grid.position.y = 0.02
  g.add(grid)

  // 旋转的环
  const ringGroup = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(3 + i * 1.1, 0.05, 12, 80),
      new THREE.MeshBasicMaterial({ color: i === 1 ? 0x40e0ff : 0x2a5cff })
    )
    r.rotation.x = Math.PI / 2 + i * 0.28
    ringGroup.add(r)
  }
  ringGroup.position.set(0, 4.4, -7)
  g.add(ringGroup)

  // 发光柱
  const pillarMat = new THREE.MeshBasicMaterial({ color: 0x1b3a7a })
  for (const x of [-8, -5, 5, 8]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), pillarMat)
    p.position.set(x, 3.5, -9)
    g.add(p)
  }
  const point = new THREE.PointLight(0x40e0ff, 40, 30)
  point.position.set(0, 4, -4)
  const amb = new THREE.DirectionalLight(0x8a7bff, 1.2)
  amb.position.set(-4, 8, 4)
  g.add(point, amb)
  return g
}

const SCENES = {
  studio: { label: '演播厅', build: makeStudioScene, tint: new THREE.Color(0xd8e2ff), bg: 0x0b0e14 },
  outdoor: { label: '户外', build: makeOutdoorScene, tint: new THREE.Color(0xfff2d8), bg: 0x9fc4e8 },
  scifi: { label: '科幻', build: makeSciFiScene, tint: new THREE.Color(0x9fd8ff), bg: 0x05070d }
}

/* ------------------------------ 运行时 ------------------------------ */

export class StudioRuntime {
  /**
   * @param {HTMLCanvasElement} canvas 输出画布
   * @param {{onError?:Function}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas
    this.opts = opts
    this.disposed = false
    this.sceneName = 'studio'
    this.scene = null
    this.rafId = 0
    this.stream = null
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.autoplay = true

    this.params = {
      key: '#00b140',
      tol: 0.16,
      soft: 0.1,
      shrink: 0.12,
      spill: 0.75,
      tintMix: 0.32,
      bright: 1.0,
      // 人在画面里的位置/缩放
      scale: 1.0,
      offsetX: 0,
      offsetY: 0,
      mirror: true,
      // 虚拟摄像机
      yaw: 0,
      tilt: 0.03,
      zoom: 38,
      dolly: 6.4,
      height: 1.9
    }

    // preserveDrawingBuffer：这样 toDataURL / drawImage 读到的是真实画面（截图、取帧、排查问题都要用）
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.autoClear = false

    this.camera = new THREE.PerspectiveCamera(this.params.zoom, 16 / 9, 0.1, 200)
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(SCENES.studio.bg)
    this.scene.fog = new THREE.Fog(SCENES.studio.bg, 20, 70)
    this.sceneRoot = SCENES.studio.build()
    this.scene.add(this.sceneRoot)

    // 人：一张正交铺满的四边形，着色器自己决定 alpha
    this.tex = null
    this.personScene = new THREE.Scene()
    this.personCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.personUniforms = {
      uTex: { value: null },
      uKey: { value: this.keyColor() },
      uTol: { value: this.params.tol },
      uSoft: { value: this.params.soft },
      uShrink: { value: this.params.shrink },
      uSpill: { value: this.params.spill },
      uTint: { value: new THREE.Color(SCENES.studio.tint) },
      uTintMix: { value: this.params.tintMix },
      uBright: { value: this.params.bright },
      uOffset: { value: new THREE.Vector2(0, 0) },
      uScale: { value: 1 },
      uMirror: { value: 1 }
    }
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.personUniforms,
        vertexShader: PERSON_VERT,
        fragmentShader: PERSON_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false
      })
    )
    this.personScene.add(quad)

    // 切场景时的交叉淡入（把上一帧抓成纹理）
    this.veil = null
    this.veilTex = null
    this.veilStart = 0

    this.applyCamera()
    this.resize()
    this.loop()
  }

  keyColor() {
    return new THREE.Color(this.params.key)
  }

  /** 接一路 MediaStream（摄像头 / 合成流 / 测试用的 canvas 流都行） */
  setStream(stream) {
    this.stream = stream || null
    const old = this.tex
    this.video.srcObject = this.stream
    if (this.stream) {
      this.video.play().catch(() => {})
      const t = new THREE.VideoTexture(this.video)
      t.minFilter = THREE.LinearFilter
      t.magFilter = THREE.LinearFilter
      t.colorSpace = THREE.SRGBColorSpace
      this.tex = t
      this.personUniforms.uTex.value = t
    } else {
      this.tex = null
      this.personUniforms.uTex.value = null
    }
    if (old && old.dispose) old.dispose()
  }

  /** 改参数（键色、容差、机位……），即时生效 */
  setParams(patch = {}) {
    Object.assign(this.params, patch)
    const p = this.params
    const u = this.personUniforms
    u.uKey.value = this.keyColor()
    u.uTol.value = p.tol
    u.uSoft.value = p.soft
    u.uShrink.value = p.shrink
    u.uSpill.value = p.spill
    u.uTintMix.value = p.tintMix
    u.uBright.value = p.bright
    u.uScale.value = p.scale
    u.uMirror.value = p.mirror ? 1 : 0
    // 人的位置：offsetX/Y 是归一化位移
    u.uOffset.value.set(p.offsetX, p.offsetY)
    this.applyCamera()
  }

  applyCamera() {
    const p = this.params
    // 虚拟摄像机：把 yaw/tilt/dolly/height 换算成位置 + 朝向
    const rad = Math.PI / 180
    const dist = p.dolly
    const x = Math.sin(p.yaw * rad) * dist
    const z = Math.cos(p.yaw * rad) * dist
    this.camera.position.set(x, p.height + p.tilt * dist, z)
    this.camera.fov = p.zoom
    this.camera.updateProjectionMatrix()
    const target = new THREE.Vector3(0, 1.55, -1.5)
    this.camera.lookAt(target)
  }

  resize() {
    const w = Math.max(2, this.canvas.clientWidth || this.canvas.width)
    const h = Math.max(2, this.canvas.clientHeight || this.canvas.height)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** 换场景：抓一帧做交叉淡入，3D 上下文不重建 */
  setScene(name) {
    if (!SCENES[name] || name === this.sceneName) return
    // 抓上一帧
    try {
      this.veilTex = new THREE.CanvasTexture(this.canvas)
      this.veilTex.needsUpdate = true
      if (!this.veil) {
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTex: { value: this.veilTex }, uAlpha: { value: 1 } },
          vertexShader: PERSON_VERT,
          fragmentShader: VEIL_FRAG,
          transparent: true,
          depthTest: false,
          depthWrite: false
        })
        this.veil = { scene: new THREE.Scene(), mat }
        this.veil.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat))
      } else {
        this.veil.mat.uniforms.uTex.value = this.veilTex
      }
      this.veilStart = performance.now()
    } catch {
      this.veil = null
    }

    this.sceneName = name
    const def = SCENES[name]
    this.scene.remove(this.sceneRoot)
    this.sceneRoot = def.build()
    this.scene.add(this.sceneRoot)
    this.scene.background = new THREE.Color(def.bg)
    if (this.scene.fog) this.scene.fog.color = new THREE.Color(def.bg)
    this.personUniforms.uTint.value = new THREE.Color(def.tint)
  }

  sceneList() {
    return Object.entries(SCENES).map(([k, v]) => ({ key: k, label: v.label }))
  }

  loop() {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(() => this.loop())
    try {
      this.renderer.clear()
      this.renderer.render(this.scene, this.camera)
      if (this.personUniforms.uTex.value && this.video.readyState >= 2) {
        this.renderer.render(this.personScene, this.personCam)
      }
      // 交叉淡入：220ms 内把上一帧盖在新场景上逐渐透明
      if (this.veil && this.veilStart) {
        const t = Math.min(1, (performance.now() - this.veilStart) / 220)
        this.veil.mat.uniforms.uAlpha.value = 1 - t
        this.renderer.render(this.veil.scene, this.personCam)
        if (t >= 1) {
          this.veilStart = 0
        }
      }
    } catch (err) {
      if (this.opts.onError) this.opts.onError(err)
    }
  }

  /** 取当前画面（录屏/存图用，也可给"整窗录制"核对） */
  snapshot() {
    try {
      return this.canvas.toDataURL('image/png')
    } catch {
      return ''
    }
  }

  dispose() {
    this.disposed = true
    if (this.rafId) cancelAnimationFrame(this.rafId)
    try {
      if (this.stream) for (const tr of this.stream.getTracks()) tr.stop()
    } catch {}
    try {
      this.video.srcObject = null
    } catch {}
    if (this.tex && this.tex.dispose) this.tex.dispose()
    if (this.veilTex && this.veilTex.dispose) this.veilTex.dispose()
    try {
      this.renderer.dispose()
    } catch {}
    this.scene = null
    this.personScene = null
  }
}

window.PRStudio = {
  StudioRuntime,
  scenes: () => Object.entries(SCENES).map(([k, v]) => ({ key: k, label: v.label }))
}
window.__PR_STUDIO_READY = true
window.dispatchEvent(new Event('pr-studio-ready'))
