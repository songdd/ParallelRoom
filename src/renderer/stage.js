/**
 * 虚拟人舞台（全 CG：程序化角色 + 多机位 + 电影感后处理）
 * ---------------------------------------------------------------------
 * 和 studio.js（真人绿幕合成）是两条路：这里没有摄像头，角色是 3D 模型，
 * "切镜头"就是切场景里的另一台摄像机 —— 这是那些二次元直播间真正的做法。
 *
 * 现在的角色是**占位用的程序化人形**（胶囊 + 卡通材质 + 描边），舞蹈动作是
 * 程序化生成的。以后有 VRM/glTF 模型和舞蹈动画，只要替换 buildCharacter()
 * 和 dancePose() 这两处，多机位 / 后处理 / 灯光这些都不用动。
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/* ------------------------------ 卡通材质 ------------------------------ */

/** 三段式渐变（卡通带）：让 MeshToonMaterial 有几档明暗，而不是全黑全白 */
let gradTex = null
function gradientMap() {
  if (gradTex) return gradTex
  const data = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255])
  gradTex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat)
  gradTex.minFilter = THREE.NearestFilter
  gradTex.magFilter = THREE.NearestFilter
  gradTex.needsUpdate = true
  return gradTex
}

function toon(color) {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() })
}

/* ------------------------------ 角色 ------------------------------ */

/** 一段肢体：原点在关节，沿 -Y 伸出去 */
function limbMesh(len, r, mat, outline) {
  const g = new THREE.Group()
  const geo = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 2), 6, 12)
  const m = new THREE.Mesh(geo, mat)
  m.position.y = -len / 2
  g.add(m)
  if (outline) {
    const o = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x0a0a12, side: THREE.BackSide }))
    o.position.y = -len / 2
    o.scale.setScalar(1.08)
    g.add(o)
  }
  return g
}

function ballMesh(r, mat, outline, scaleY = 1) {
  const g = new THREE.Group()
  const geo = new THREE.SphereGeometry(r, 20, 16)
  const m = new THREE.Mesh(geo, mat)
  m.scale.y = scaleY
  g.add(m)
  if (outline) {
    const o = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x0a0a12, side: THREE.BackSide }))
    o.scale.set(1.08, 1.08 * scaleY, 1.08)
    g.add(o)
  }
  return g
}

/**
 * 程序化人形（占位）：身高约 1.9。
 * 层级是标准的：hips → spine → chest → neck → head，四肢各两节。
 */
function buildCharacter(opts = {}) {
  const skin = toon(opts.skin || 0xffe0cd)
  const cloth = toon(opts.cloth || 0x2b3a63)
  const cloth2 = toon(opts.cloth2 || 0x1b2440)
  const hairMat = toon(opts.hair || 0x4a2b52)
  const out = opts.outline !== false

  const root = new THREE.Group()
  // 关节名字直接用 VRM 人形骨骼名：这样 Mixamo 的动作重定向到这套占位骨架也能动
  const T = Math.PI / 2 // T-pose 静息角度：手臂沿 ±X 伸出去

  const hips = new THREE.Group()
  hips.name = 'hips'
  hips.position.y = 0.95
  root.add(hips)

  // 胯
  const pelvis = ballMesh(0.14, cloth2, out, 0.8)
  pelvis.scale.x = 1.25
  hips.add(pelvis)

  const spine = new THREE.Group()
  spine.name = 'spine'
  spine.position.y = 0.1
  hips.add(spine)
  const torso = limbMesh(0.34, 0.13, cloth, out)
  torso.rotation.x = Math.PI // 往上长
  torso.position.y = 0.34
  torso.scale.x = 1.15
  spine.add(torso)

  const chest = new THREE.Group()
  chest.name = 'chest'
  chest.position.y = 0.34
  spine.add(chest)

  const neck = new THREE.Group()
  neck.name = 'neck'
  neck.position.y = 0.12
  chest.add(neck)
  const neckMesh = limbMesh(0.1, 0.05, skin, false)
  neckMesh.rotation.x = Math.PI
  neck.add(neckMesh)

  const head = new THREE.Group()
  head.name = 'head'
  head.position.y = 0.1
  neck.add(head)
  const skull = ballMesh(0.13, skin, out, 1.12)
  skull.position.y = 0.1
  head.add(skull)
  // 头发（一个略大的半球壳）
  const hairGeo = new THREE.SphereGeometry(0.142, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.62)
  const hairMesh = new THREE.Mesh(hairGeo, hairMat)
  hairMesh.position.y = 0.11
  head.add(hairMesh)
  // 眼睛
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a26 })
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.019, 10, 8), eyeMat)
    eye.position.set(sx * 0.048, 0.105, 0.115)
    head.add(eye)
  }
  // 嘴：按音频/节拍缩放做口型
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), new THREE.MeshBasicMaterial({ color: 0x8a2a3a }))
  mouth.position.set(0, 0.055, 0.118)
  mouth.scale.set(1, 0.5, 0.6)
  head.add(mouth)

  // 手臂
  function arm(side) {
    const shoulder = new THREE.Group()
    shoulder.name = side > 0 ? 'leftUpperArm' : 'rightUpperArm'
    // T-pose 静息：左臂沿 +X、右臂沿 -X
    shoulder.rotation.z = side > 0 ? T : -T
    shoulder.position.set(side * 0.17, 0.28, 0)
    chest.add(shoulder)
    shoulder.add(ballMesh(0.055, cloth, out))
    const upper = limbMesh(0.27, 0.048, skin, out)
    shoulder.add(upper)
    const elbow = new THREE.Group()
    elbow.name = side > 0 ? 'leftLowerArm' : 'rightLowerArm'
    elbow.position.y = -0.27
    upper.add(elbow)
    const fore = limbMesh(0.25, 0.042, skin, out)
    elbow.add(fore)
    const hand = ballMesh(0.05, skin, out, 1.2)
    hand.name = side > 0 ? 'leftHand' : 'rightHand'
    hand.position.y = -0.25
    fore.add(hand)
    return { shoulder, upper, elbow, fore, hand }
  }
  const armL = arm(1)
  const armR = arm(-1)

  // 腿
  function leg(side) {
    const hip = new THREE.Group()
    hip.name = side > 0 ? 'leftUpperLeg' : 'rightUpperLeg'
    hip.position.set(side * 0.085, -0.03, 0)
    hips.add(hip)
    const thigh = limbMesh(0.44, 0.062, cloth2, out)
    hip.add(thigh)
    const knee = new THREE.Group()
    knee.name = side > 0 ? 'leftLowerLeg' : 'rightLowerLeg'
    knee.position.y = -0.44
    thigh.add(knee)
    const shin = limbMesh(0.42, 0.052, cloth2, out)
    knee.add(shin)
    const foot = new THREE.Group()
    foot.name = side > 0 ? 'leftFoot' : 'rightFoot'
    foot.position.y = -0.42
    shin.add(foot)
    const shoe = ballMesh(0.075, toon(0x101522), out, 0.6)
    shoe.scale.z = 1.7
    shoe.position.z = 0.04
    foot.add(shoe)
    return { hip, thigh, knee, shin, foot }
  }
  const legL = leg(1)
  const legR = leg(-1)

  // 裙摆：一圈薄片，转起来有动感
  const skirt = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.3, 16, 1, true),
    new THREE.MeshToonMaterial({ color: opts.cloth || 0x2b3a63, gradientMap: gradientMap(), side: THREE.DoubleSide })
  )
  skirt.position.y = -0.02
  hips.add(skirt)

  return {
    root,
    parts: { hips, spine, chest, neck, head, mouth, armL, armR, legL, legR, skirt }
  }
}

/* ------------------------------ 舞蹈 ------------------------------ */

const DANCES = {
  idle: { label: '待机', speed: 1, amp: 0.35 },
  dance1: { label: '舞蹈 A', speed: 2, amp: 1 },
  dance2: { label: '舞蹈 B', speed: 2.6, amp: 1.25 }
}

/** 每帧摆姿势：全部是程序化正弦叠加，没有骨骼动画文件 */
function dancePose(rig, t, styleName, bpm, audioLevel) {
  const p = rig.parts
  const style = DANCES[styleName] || DANCES.dance1
  const beat = (t * bpm) / 60 // 拍数
  const w = beat * Math.PI * 2 * 0.5 * style.speed // 半拍一循环
  const a = style.amp
  const lvl = Math.max(0, Math.min(1, audioLevel || 0))

  // 重心起伏 + 胯部摆动
  p.hips.position.y = 0.95 + Math.sin(w * 2) * 0.025 * a - lvl * 0.01
  p.hips.rotation.y = Math.sin(w) * 0.22 * a
  p.hips.rotation.z = Math.sin(w * 2 + 0.6) * 0.06 * a
  p.spine.rotation.z = -Math.sin(w * 2 + 0.3) * 0.05 * a
  p.spine.rotation.x = 0.03 + Math.sin(w * 2) * 0.03 * a
  p.chest.rotation.y = -Math.sin(w) * 0.12 * a
  p.neck.rotation.x = Math.sin(w * 2 + 1.1) * 0.05 * a
  p.head.rotation.y = Math.sin(w + 0.8) * 0.16 * a
  p.head.rotation.z = Math.sin(w * 2) * 0.05 * a

  // 手臂：一上一下交替甩
  const swing = Math.sin(w) * 0.9 * a
  // 静息是 T-pose（±90°），减掉 ARM_DOWN 让手臂自然下垂
  const ARM_DOWN = 1.0
  p.armL.shoulder.rotation.z = Math.PI / 2 - ARM_DOWN + swing * 0.5
  p.armR.shoulder.rotation.z = -Math.PI / 2 + ARM_DOWN + swing * 0.5
  p.armL.shoulder.rotation.x = -0.35 + Math.sin(w + 0.4) * 0.5 * a
  p.armR.shoulder.rotation.x = -0.35 + Math.sin(w + Math.PI + 0.4) * 0.5 * a
  p.armL.elbow.rotation.x = -0.5 - Math.abs(Math.sin(w)) * 0.6 * a
  p.armR.elbow.rotation.x = -0.5 - Math.abs(Math.sin(w + Math.PI)) * 0.6 * a

  // 腿：左右交替踏
  p.legL.hip.rotation.x = Math.sin(w) * 0.35 * a
  p.legR.hip.rotation.x = Math.sin(w + Math.PI) * 0.35 * a
  p.legL.knee.rotation.x = -Math.max(0, Math.sin(w)) * 0.5 * a
  p.legR.knee.rotation.x = -Math.max(0, Math.sin(w + Math.PI)) * 0.5 * a
  p.legL.foot.rotation.x = Math.max(0, Math.sin(w)) * 0.25 * a
  p.legR.foot.rotation.x = Math.max(0, Math.sin(w + Math.PI)) * 0.25 * a

  // 裙摆跟着胯转
  p.skirt.rotation.y = Math.sin(w) * 0.25 * a

  // 口型：有音频就跟音量，没有就跟着拍子开合
  const mouthOpen = audioLevel != null ? 0.35 + lvl * 2.2 : 0.4 + Math.abs(Math.sin(w)) * 1.2
  p.mouth.scale.y = 0.5 + mouthOpen * 0.9
}

/* ------------------------------ 贴图加载垫片 ------------------------------ */
/*
 * 这个应用的渲染层是 file:// 页面，实测：
 *   fetch('prmedia://…')        ✅ 能用（自定义协议开了 supportFetchAPI）
 *   <img src="prmedia://…">     ❌ 加载失败
 *   fetch('blob:…') / <img src="blob:…">  ❌ 都被拦
 *   fetch('data:…')             ❌ 被拦
 *   <img src="data:image/png;base64,…">   ✅ 能用
 *
 * 而 three 的 GLTFLoader 解 GLB 里的贴图时，会 createObjectURL(Blob) 再交给 <img>，
 * 正好落在"被拦"的那一档 —— 于是 VRM 模型能加载出来，但**贴图全丢**，渲染成一片白。
 *
 * 所以这里给 <img> 加一层垫片：遇到我们自己创建过的 blob URL，就异步把 Blob 读成
 * data URL 再赋给 src（Blob.arrayBuffer() 不走 fetch，是允许的）。
 */
let blobUrlMap = null
function installBlobImageShim() {
  if (window.__prBlobShim) return
  window.__prBlobShim = true
  blobUrlMap = new Map()
  const origCreate = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (obj) => {
    const u = origCreate(obj)
    try {
      if (obj instanceof Blob) blobUrlMap.set(u, obj)
    } catch (e) {}
    return u
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  if (!desc || !desc.set) return
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return desc.get.call(this)
    },
    set(v) {
      const str = String(v)
      const blob = str.startsWith('blob:') && blobUrlMap ? blobUrlMap.get(str) : null
      if (!blob) {
        desc.set.call(this, str)
        return
      }
      const img = this
      blob
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf)
          let bin = ''
          const CHUNK = 0x8000
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
          }
          const mime = blob.type || 'image/png'
          desc.set.call(img, 'data:' + mime + ';base64,' + btoa(bin))
        })
        .catch(() => desc.set.call(img, str))
    }
  })
}

/* ------------------------------ 动作重定向 ------------------------------ */
/*
 * Mixamo 的动作是"标准人形 T-pose"骨架，three-vrm 的 normalized humanoid 也是标准 T-pose、
 * 以米为单位。所以不需要 IK：把轨道的节点名换成目标骨架的节点名，再把胯部位移从
 * 厘米缩到米，动画就能直接播。
 */
const MIXAMO_TO_VRM = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'chest',
  Spine2: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'leftShoulder',
  LeftArm: 'leftUpperArm',
  LeftForeArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightArm: 'rightUpperArm',
  RightForeArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg',
  LeftLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg',
  RightLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToeBase: 'rightToes'
}

/** 轨道名里的骨骼名 → VRM 人形骨骼名（去掉 mixamorig: 之类前缀） */
function mixamoBoneOf(trackName) {
  const m = /^mixamorig[:_]?(.+?)\.(position|quaternion|scale)$/.exec(trackName)
  if (!m) return null
  const raw = m[1]
  const mapped = MIXAMO_TO_VRM[raw]
  return mapped ? { bone: mapped, prop: m[2] } : null
}

/** VRM 没有动作文件时：给 normalized humanoid 一点呼吸/摇摆，别像木头一样站着 */
function vrmIdlePose(vrm, t) {
  const h = vrm && vrm.humanoid
  if (!h) return
  const set = (bone, x, y, z) => {
    const node = h.getNormalizedBoneNode(bone)
    if (node) node.rotation.set(x, y, z)
  }
  const s = Math.sin(t * 1.1)
  const s2 = Math.sin(t * 0.7 + 1.2)
  set('hips', 0, s * 0.12, 0)
  set('spine', 0.02 + Math.sin(t * 1.6) * 0.02, -s * 0.06, 0)
  set('chest', 0, -s * 0.08, 0)
  set('neck', Math.sin(t * 1.4) * 0.04, 0, 0)
  set('head', Math.sin(t * 1.4 + 0.5) * 0.05, s2 * 0.16, Math.sin(t * 0.9) * 0.04)
  // 手臂从 T-pose 放下来一点
  set('leftUpperArm', 0, 0, -1.1 + s * 0.12)
  set('rightUpperArm', 0, 0, 1.1 - s * 0.12)
  set('leftLowerArm', 0.15, 0, 0)
  set('rightLowerArm', 0.15, 0, 0)
}

/* ------------------------------ 舞台场景 ------------------------------ */

function stageNeon() {
  const g = new THREE.Group()
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(14, 64),
    new THREE.MeshStandardMaterial({ color: 0x0b0f1a, roughness: 0.18, metalness: 0.85 })
  )
  floor.rotation.x = -Math.PI / 2
  g.add(floor)
  // 地台
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 2.1, 0.12, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a2233, roughness: 0.4, metalness: 0.6 })
  )
  disc.position.y = 0.06
  g.add(disc)
  // 背后的 LED 圆弧
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.2 + i * 1.05, 0.05, 8, 96, Math.PI * 1.15),
      new THREE.MeshBasicMaterial({ color: i === 1 ? 0xff4d8d : 0x4d7bff })
    )
    ring.position.set(0, 2.6 + i * 0.5, -3.4)
    ring.rotation.z = Math.PI * 0.075
    g.add(ring)
  }
  // 侧翼灯柱
  for (const x of [-4.2, 4.2]) {
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 5.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x141a26, roughness: 0.5, metalness: 0.7 })
    )
    col.position.set(x, 2.6, -2.4)
    g.add(col)
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 3.6, 0.1),
      new THREE.MeshBasicMaterial({ color: x < 0 ? 0x40e0ff : 0xff4d8d })
    )
    glow.position.set(x, 2.6, -2.32)
    g.add(glow)
  }
  const key = new THREE.SpotLight(0xffffff, 260, 22, Math.PI / 5, 0.5, 1.6)
  key.position.set(2.6, 6.4, 4.2)
  key.target.position.set(0, 1.1, 0)
  const rim = new THREE.SpotLight(0xff4d8d, 200, 20, Math.PI / 4, 0.7, 1.6)
  rim.position.set(-3.4, 3.2, -3.2)
  rim.target.position.set(0, 1.3, 0)
  const fill = new THREE.HemisphereLight(0x8fb2ff, 0x10131c, 1.1)
  g.add(key, key.target, rim, rim.target, fill)
  g.userData.lights = { key, rim }
  return g
}

function stageGarden() {
  const g = new THREE.Group()
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(16, 48),
    new THREE.MeshStandardMaterial({ color: 0x2a3326, roughness: 0.95 })
  )
  ground.rotation.x = -Math.PI / 2
  g.add(ground)
  // 木台
  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.3, 0.14, 8),
    new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.85 })
  )
  deck.position.y = 0.07
  g.add(deck)
  // 简单的鸟居
  const red = new THREE.MeshStandardMaterial({ color: 0xb8402f, roughness: 0.7 })
  for (const x of [-2.2, 2.2]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.6, 12), red)
    pillar.position.set(x, 1.8, -3.2)
    g.add(pillar)
  }
  const beam1 = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.22, 0.3), red)
  beam1.position.set(0, 3.55, -3.2)
  const beam2 = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.18, 0.26), red)
  beam2.position.set(0, 3.05, -3.2)
  g.add(beam1, beam2)
  // 花瓣（点云）
  const petalCount = 900
  const pos = new Float32Array(petalCount * 3)
  for (let i = 0; i < petalCount; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 16
    pos[i * 3 + 1] = Math.random() * 7
    pos[i * 3 + 2] = (Math.random() - 0.5) * 12
  }
  const petalGeo = new THREE.BufferGeometry()
  petalGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const petals = new THREE.Points(
    petalGeo,
    new THREE.PointsMaterial({ color: 0xffc2d8, size: 0.06, transparent: true, opacity: 0.85, depthWrite: false })
  )
  g.add(petals)
  g.userData.petals = petals
  const sun = new THREE.DirectionalLight(0xffe0b8, 2.4)
  sun.position.set(4, 8, 5)
  const amb = new THREE.HemisphereLight(0xffd9e6, 0x2a3326, 1.3)
  g.add(sun, amb)
  g.userData.lights = { key: sun }
  return g
}

function stageCyber() {
  const g = new THREE.Group()
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 0.25, metalness: 0.8 })
  )
  floor.rotation.x = -Math.PI / 2
  g.add(floor)
  const grid = new THREE.GridHelper(40, 40, 0x2a5cff, 0x10203a)
  grid.position.y = 0.01
  g.add(grid)
  // 环形结构
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.6 + i * 0.9, 0.045, 8, 90),
      new THREE.MeshBasicMaterial({ color: i === 1 ? 0x40e0ff : 0x2a5cff })
    )
    ring.position.set(0, 2.2 + i * 0.6, -3)
    ring.rotation.x = Math.PI / 2 - 0.15 * i
    g.add(ring)
  }
  for (const x of [-3.6, 3.6]) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 6, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.4, metalness: 0.8 })
    )
    p.position.set(x, 3, -3.4)
    g.add(p)
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 4.2, 0.08), new THREE.MeshBasicMaterial({ color: 0x40e0ff }))
    strip.position.set(x, 3, -3.12)
    g.add(strip)
  }
  const key = new THREE.SpotLight(0xbfe6ff, 240, 24, Math.PI / 4.5, 0.45, 1.5)
  key.position.set(-2.4, 6, 4)
  key.target.position.set(0, 1.1, 0)
  const rim = new THREE.SpotLight(0x40e0ff, 180, 22, Math.PI / 4, 0.6, 1.6)
  rim.position.set(3, 3.4, -3)
  rim.target.position.set(0, 1.2, 0)
  g.add(key, key.target, rim, rim.target, new THREE.HemisphereLight(0x2a5cff, 0x05070d, 0.9))
  g.userData.lights = { key, rim }
  return g
}

/**
 * 真实感演播室 v2
 * ------------------------------------------------------------
 * 参考真实影棚的构成：**无缝白棚（cyc）+ 地面反光 + 背景打光 + 软边主光**。
 * 上一版被吐槽的两点都改掉了：
 *   · "中间一个灰圆盘" → 去掉实体地台，改成一块带反光的地面（真影棚就是这样）
 *   · "后面三根白条不知道是啥" → 删掉，换成打在背景墙上的一片柔光（背景有光斑才像棚）
 */
function stageReal() {
  const g = new THREE.Group()
  const R = 3.2
  const FLOOR_R = 9.2

  // 无缝背景：地面 → 圆弧 → 竖墙，一整块（白棚的样子）
  const pts = [new THREE.Vector2(0.001, 0), new THREE.Vector2(FLOOR_R, 0)]
  for (let i = 1; i <= 18; i++) {
    const a = (i / 18) * (Math.PI / 2)
    pts.push(new THREE.Vector2(FLOOR_R + Math.sin(a) * R, R - Math.cos(a) * R))
  }
  pts.push(new THREE.Vector2(FLOOR_R + R, 9))

  // DoubleSide：LatheGeometry 法线朝外，从场景内部看会被背面剔除（踩过）
  const cycMat = new THREE.MeshStandardMaterial({
    color: 0x9aa0a9,
    roughness: 0.92,
    metalness: 0.0,
    side: THREE.DoubleSide
  })
  // 地面一点粗糙度噪点，别像塑料板
  try {
    const size = 256
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const cx = cv.getContext('2d')
    cx.fillStyle = '#c8c8c8'
    cx.fillRect(0, 0, size, size)
    for (let i = 0; i < 3000; i++) {
      const v = 170 + Math.random() * 70
      cx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.25)'
      cx.fillRect(Math.random() * size, Math.random() * size, 2, 2)
    }
    const tex = new THREE.CanvasTexture(cv)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(8, 8)
    cycMat.roughnessMap = tex
  } catch (e) {}
  const cyc = new THREE.Mesh(new THREE.LatheGeometry(pts, 72), cycMat)
  cyc.receiveShadow = true
  g.add(cyc)

  /*
   * 接地阴影：一圈径向渐变（黑白 alpha 贴图）铺在人物脚下。
   * 比"实体地台 + 镜面反射"都靠谱 —— 影棚里最真实的就是这团柔和的环境遮蔽。
   */
  try {
    const size = 256
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const cx = cv.getContext('2d')
    const grad = cx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5)
    grad.addColorStop(0, 'rgba(0,0,0,0.55)')
    grad.addColorStop(0.45, 'rgba(0,0,0,0.22)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    cx.fillStyle = grad
    cx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(cv)
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 1 })
    )
    sh.rotation.x = -Math.PI / 2
    sh.position.set(0, 0.012, 0)
    sh.userData.contactShadow = true
    g.add(sh)
    g.userData.contactShadow = sh
  } catch (e) {}

  // 软边主光（暖白）+ 补光（冷）+ 轮廓光：都投在 layer 0（场景），
  // 人物自己的三点光在 StageRuntime.charLightGroup 里（layer 1）
  const key = new THREE.SpotLight(0xfff3e6, 70, 18, Math.PI / 3.4, 0.9, 1.3)
  key.position.set(2.8, 5.0, 3.6)
  key.target.position.set(0, 1.1, 0)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 16
  key.shadow.bias = -0.0009
  key.shadow.radius = 4

  const fill = new THREE.SpotLight(0xdfeaff, 22, 16, Math.PI / 2.4, 1, 1.2)
  fill.position.set(-3.6, 3.0, 3.0)
  fill.target.position.set(0, 1.1, 0)

  const rim = new THREE.SpotLight(0xffffff, 30, 16, Math.PI / 3, 0.9, 1.3)
  rim.position.set(-1.6, 3.4, -3.4)
  rim.target.position.set(0, 1.35, 0)

  /*
   * 背景光斑：从前面高处往背景墙打一片柔光，白棚才有"棚"的感觉
   * （不是三根白条那种莫名其妙的几何体）
   */
  const wash = new THREE.SpotLight(0xffffff, 70, 26, Math.PI / 2.2, 1, 1.1)
  wash.position.set(0, 2.2, 5.5)
  wash.target.position.set(0, 1.9, -8.5)

  g.add(key, key.target, fill, fill.target, rim, rim.target, wash, wash.target)
  g.userData.lights = { key, rim }
  g.userData.realStudio = true
  return g
}

/**
 * 综艺灯棚：深色背景 + LED 背景屏（会动）+ 顶部光束 + 反光地面 + 灯架
 * ---------------------------------------------------------------
 * 这是"打歌舞台/综艺灯棚"那套视觉：亮的是屏和光束，人是靠轮廓光抠出来的。
 * 屏是 Canvas 贴图逐帧重绘（只画 512×256，开销很小），光架有功能性（灯挂在上面）。
 */
function stageVariety() {
  const g = new THREE.Group()

  // 地面：深色、偏镜面，靠 IBL 和灯光出高光条
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(18, 72),
    new THREE.MeshStandardMaterial({ color: 0x0a0c12, roughness: 0.16, metalness: 0.88 })
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  g.add(floor)

  // 小地台（有功能：人物站的位置，边缘有一圈灯带）
  const podium = new THREE.Mesh(
    new THREE.CylinderGeometry(2.1, 2.2, 0.1, 64),
    new THREE.MeshStandardMaterial({ color: 0x11151d, roughness: 0.35, metalness: 0.6 })
  )
  podium.position.y = 0.05
  podium.receiveShadow = true
  g.add(podium)
  const rimStrip = new THREE.Mesh(
    new THREE.TorusGeometry(2.16, 0.025, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x40e0ff })
  )
  rimStrip.rotation.x = -Math.PI / 2
  rimStrip.position.y = 0.105
  g.add(rimStrip)

  // ---- LED 背景屏：Canvas 逐帧重绘 ----
  const W = 512
  const H = 256
  let ledTex = null
  let ledCtx = null
  let ledCanvas = null
  let frame = 0
  try {
    ledCanvas = document.createElement('canvas')
    ledCanvas.width = W
    ledCanvas.height = H
    ledCtx = ledCanvas.getContext('2d')
    ledTex = new THREE.CanvasTexture(ledCanvas)
    ledTex.colorSpace = THREE.SRGBColorSpace
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(13, 6.5),
      new THREE.MeshBasicMaterial({ map: ledTex, toneMapped: false })
    )
    screen.position.set(0, 4.0, -7.4)
    g.add(screen)
    // 屏的外框
    const frameBox = new THREE.Mesh(
      new THREE.BoxGeometry(13.4, 6.9, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x0d1017, roughness: 0.6, metalness: 0.5 })
    )
    frameBox.position.set(0, 4.0, -7.55)
    g.add(frameBox)
  } catch (e) {}

  const drawLed = (t, level) => {
    if (!ledCtx) return
    const x = ledCtx
    // 底色：左右两段渐变
    const bg = x.createLinearGradient(0, 0, W, H)
    bg.addColorStop(0, '#0a0e1a')
    bg.addColorStop(0.5, '#141b2e')
    bg.addColorStop(1, '#0a0e1a')
    x.fillStyle = bg
    x.fillRect(0, 0, W, H)

    // 滚动的竖条（色相随时间转）
    const bars = 14
    for (let i = 0; i < bars; i++) {
      const bh = H * (0.25 + 0.5 * Math.abs(Math.sin(t * 1.3 + i * 0.7 + level * 3)))
      const bx = ((i / bars) * W + t * 40) % W
      const hue = (i * 26 + t * 40) % 360
      x.fillStyle = 'hsla(' + hue + ',90%,60%,0.55)'
      x.fillRect(bx, H - bh, W / bars - 3, bh)
    }
    // 一条横扫的高光
    const sweep = ((t * 90) % (W + 200)) - 100
    const sg = x.createLinearGradient(sweep - 80, 0, sweep + 80, 0)
    sg.addColorStop(0, 'rgba(255,255,255,0)')
    sg.addColorStop(0.5, 'rgba(255,255,255,0.22)')
    sg.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = sg
    x.fillRect(0, 0, W, H)
    // 顶部暗角，避免屏太"平"
    const vg = x.createLinearGradient(0, 0, 0, H)
    vg.addColorStop(0, 'rgba(0,0,0,0.55)')
    vg.addColorStop(0.45, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.35)')
    x.fillStyle = vg
    x.fillRect(0, 0, W, H)
    if (ledTex) ledTex.needsUpdate = true
    frame++
  }
  drawLed(0, 0)

  // ---- 顶部灯架（有功能：光束从这儿打下来）----
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x1a1e27, roughness: 0.5, metalness: 0.7 })
  const truss = new THREE.Mesh(new THREE.BoxGeometry(11, 0.18, 0.18), trussMat)
  truss.position.set(0, 6.4, -4.2)
  g.add(truss)
  for (const x of [-5.2, 0, 5.2]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 6.4, 0.14), trussMat)
    leg.position.set(x, 3.2, -4.2)
    g.add(leg)
  }

  // ---- 光束：加法混合的透明锥（体积光的廉价替身）----
  const beams = []
  const beamSpecs = [
    { x: -4.4, color: 0x3ea8ff, tilt: 0.42 },
    { x: -1.6, color: 0x40e0ff, tilt: 0.2 },
    { x: 1.6, color: 0xff4d8d, tilt: -0.2 },
    { x: 4.4, color: 0xff6ad5, tilt: -0.42 }
  ]
  for (const b of beamSpecs) {
    const geo = new THREE.ConeGeometry(1.5, 6.6, 22, 1, true)
    const mat = new THREE.MeshBasicMaterial({
      color: b.color,
      transparent: true,
      opacity: 0.075,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    })
    const cone = new THREE.Mesh(geo, mat)
    cone.position.set(b.x, 3.6, -3.4)
    cone.rotation.z = b.tilt
    cone.userData.baseOpacity = 0.075
    g.add(cone)
    beams.push(cone)
    // 光束源头的小灯体
    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 0.3, 12),
      new THREE.MeshStandardMaterial({ color: 0x0e1118, roughness: 0.4, metalness: 0.8 })
    )
    head.position.set(b.x, 6.25, -3.4)
    g.add(head)
  }

  // ---- 灯光（都挂 layer 2 = 只照场景）----
  const keyCool = new THREE.SpotLight(0xcfe2ff, 90, 20, Math.PI / 3.6, 0.95, 1.3)
  keyCool.position.set(3.4, 5.6, 4.2)
  keyCool.target.position.set(0, 1.1, 0)
  keyCool.castShadow = true
  keyCool.shadow.mapSize.set(2048, 2048)
  keyCool.shadow.camera.near = 0.5
  keyCool.shadow.camera.far = 18
  keyCool.shadow.bias = -0.0009
  keyCool.shadow.radius = 4

  const rimWarm = new THREE.SpotLight(0xff5a9e, 120, 18, Math.PI / 3.2, 0.9, 1.2)
  rimWarm.position.set(-3.6, 4.2, -4.6)
  rimWarm.target.position.set(0, 1.4, 0)

  const backWash = new THREE.PointLight(0x2a5cff, 26, 20)
  backWash.position.set(0, 2.4, -6)

  g.add(keyCool, keyCool.target, rimWarm, rimWarm.target, backWash)
  g.userData.lights = { key: keyCool, rim: rimWarm }

  // 每帧动一下：屏、光束呼吸
  g.userData.tick = (t, audioLevel) => {
    const lvl = typeof audioLevel === 'number' ? audioLevel : 0
    // 屏 12fps 重绘就够了
    if (frame % 5 === 0) drawLed(t, lvl)
    for (let i = 0; i < beams.length; i++) {
      const c = beams[i]
      const k = 0.6 + 0.4 * Math.abs(Math.sin(t * 0.9 + i * 1.1))
      c.material.opacity = c.userData.baseOpacity * (k + lvl * 1.6)
      c.rotation.z = beamSpecs[i].tilt + Math.sin(t * 0.45 + i) * 0.06
    }
  }

  return g
}

const STAGES = {
  neon: { label: '霓虹舞台', build: stageNeon, bg: 0x05070d, fog: [12, 34] },
  garden: { label: '樱花庭院', build: stageGarden, bg: 0x141a16, fog: [16, 40] },
  cyber: { label: '赛博机房', build: stageCyber, bg: 0x03050a, fog: [10, 30] },
  real: { label: '实景演播室', build: stageReal, bg: 0x1a1c22, fog: [40, 110] },
  variety: { label: '综艺灯棚', build: stageVariety, bg: 0x04060b, fog: [16, 46] }
}

/* ------------------------------ 机位 ------------------------------ */

const CAMERAS = [
  { label: '全景', pos: [0, 1.75, 6.4], look: [0, 1.12, 0], fov: 32 },
  { label: '中景', pos: [0.95, 1.55, 3.5], look: [0, 1.25, 0], fov: 38 },
  { label: '特写', pos: [0.32, 1.62, 1.6], look: [0, 1.52, 0], fov: 40 },
  { label: '侧面', pos: [3, 1.4, 2.1], look: [0, 1.2, 0], fov: 42 },
  { label: '仰拍', pos: [0.25, 0.5, 3.2], look: [0, 1.42, 0], fov: 46 },
  { label: '俯拍', pos: [1.3, 3.3, 3.4], look: [0, 1.0, 0], fov: 40 }
]

/* ------------------------------ 后处理 ------------------------------ */

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.45 },
    smoothness: { value: 0.6 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float smoothness;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.9, smoothness, length(d) * 1.35);
      c.rgb *= mix(1.0 - strength, 1.0, v);
      gl_FragColor = c;
    }
  `
}

/* ------------------------------ 运行时 ------------------------------ */

export class StageRuntime {
  constructor(canvas, opts = {}) {
    this.canvas = canvas
    this.opts = opts
    this.disposed = false
    this.stageName = 'neon'
    this.camIndex = 0
    this.danceName = 'dance1'
    this.audioLevel = null
    this.analyser = null
    this.autoCut = true
    this.autoBeats = 4
    this.shake = true
    this.beatClock = 0
    this.startAt = performance.now()
    this.lastCutBeat = -1
    this.cutShake = 0

    /** 画面风格：cinema=电影感（ACES+泛光+暗角），faithful=像 VRoid Studio（不调色、中性三点光） */
    this.lookMode = 'cinema'
    this.params = {
      bpm: 118,
      lightIntensity: 1,
      lightHue: 0.58,
      bloom: 0.62,
      vignette: 0.45,
      charScale: 1,
      charX: 0,
      charY: 0,
      /** 角色亮度（中性三点光的倍数，只在"像 VRoid"模式下生效） */
      charBright: 1
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    /*
     * 真实感的大头是"环境光"（IBL）：物体表面的漫反射和高光都从环境里取，
     * 这比多加几盏平行光真实得多。RoomEnvironment 是 three 自带的程序化影棚环境，
     * 不需要外部 HDRI 文件。
     */
    try {
      this.pmrem = new THREE.PMREMGenerator(this.renderer)
      this.envRT = this.pmrem.fromScene(new RoomEnvironment(), 0.04)
      this.scene.environment = this.envRT.texture
      this.scene.environmentIntensity = 0.55
    } catch (e) {
      console.warn('[stage] env map failed', e && e.message)
    }
    this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 200)
    this.camera.layers.enable(1)
    this.camera.layers.enable(2)
    this.applyStage('neon', true)

    const built = buildCharacter()
    this.charRoot = built.root
    this.mixerRoot = built.root // 占位人形也能被 Mixamo 动作驱动（它的关节名就是 VRM 人形骨骼名）
    this.rig = built
    this.charRoot.scale.setScalar(this.params.charScale)
    this.scene.add(this.charRoot)
    this.applyCharLayers()

    /*
     * 中性三点光：VRoid Studio 里看到的就是这种干脆的打光。
     * 舞台的 HDR 聚光灯 + ACES + 泛光会把 MToon 的卡通色压灰，
     * 所以"像 VRoid"模式切到这组灯，并且关掉调色。
     */
    this.charLightGroup = new THREE.Group()
    const keyL = new THREE.DirectionalLight(0xffffff, 1.05)
    keyL.position.set(2.2, 3.4, 3.2)
    keyL.castShadow = true
    keyL.shadow.mapSize.set(2048, 2048)
    keyL.shadow.radius = 3
    keyL.shadow.camera.near = 0.5
    keyL.shadow.camera.far = 12
    keyL.shadow.bias = -0.0012
    const fillL = new THREE.DirectionalLight(0xdfe8ff, 0.45)
    fillL.position.set(-2.6, 2.2, 2.4)
    const rimL = new THREE.DirectionalLight(0xffffff, 0.45)
    rimL.position.set(-1.2, 2.6, -3.4)
    const ambL = new THREE.AmbientLight(0xffffff, 0.3)
    this.charLightGroup.add(keyL, fillL, rimL, ambL)
    this.charLightGroup.visible = false
    // 记下基准强度：「角色亮度」滑块在它们基础上乘
    for (const l of this.charLightGroup.children) {
      l.userData.baseIntensity = l.intensity
      // 只照人物（layer 1）。不然白棚背景会被这组灯一起打成一片白。
      l.layers.set(1)
    }
    this.scene.add(this.charLightGroup)
    this.keyLight = keyL

    // 后处理：渲染 → Bloom → 暗角 → Output（ACES + sRGB）
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), this.params.bloom, 0.6, 0.72)
    this.composer.addPass(this.bloom)
    this.vignette = new ShaderPass(VignetteShader)
    this.vignette.uniforms.strength.value = this.params.vignette
    this.composer.addPass(this.vignette)
    this.composer.addPass(new OutputPass())

    this.resize()
    this.applyCamera(0, true)
    this.loop()
  }

  stageList() {
    return Object.entries(STAGES).map(([k, v]) => ({ key: k, label: v.label }))
  }

  cameraList() {
    return CAMERAS.map((c, i) => ({ index: i, label: c.label }))
  }

  danceList() {
    return Object.entries(DANCES).map(([k, v]) => ({ key: k, label: v.label }))
  }

  applyStage(name, initial = false) {
    const def = STAGES[name] || STAGES.neon
    if (this.sceneRoot) this.scene.remove(this.sceneRoot)
    this.stageName = name
    this.sceneRoot = def.build()
    this.scene.add(this.sceneRoot)
    this.scene.background = new THREE.Color(def.bg)
    this.scene.fog = new THREE.Fog(def.bg, def.fog[0], def.fog[1])
    this.stageLights = this.sceneRoot.userData.lights || {}
    // 把舞台里所有灯收集起来（faithful 模式要把它们压下去，不然人物会被打爆）
    this.stageLightSet = []
    this.sceneRoot.traverse((o) => {
      // 舞台几何体：把 layer 2 打开（这样只有"舞台灯"照它）
      if (o.isMesh || o.isPoints) o.layers.enable(2)
      if (o.isLight) {
        o.userData.prBase = o.intensity
        // 舞台灯只照场景（layer 2），不再顺带把人物打白
        o.layers.set(2)
        this.stageLightSet.push(o)
      }
    })
    if (!initial) this.lastCutBeat = -1
  }

  setScene(name) {
    if (!STAGES[name] || name === this.stageName) return
    this.applyStage(name)
  }

  setCamera(i, immediate = false) {
    const idx = Math.max(0, Math.min(CAMERAS.length - 1, i | 0))
    this.camIndex = idx
    this.cutShake = this.shake ? 1 : 0
    this.applyCamera(idx, immediate)
    // 机位变了 → 通知外面更新"机位 N · 全景"角标（自动导播切的时候也要更新）
    if (this.opts.onCamera) {
      try {
        this.opts.onCamera(idx)
      } catch {}
    }
  }

  applyCamera(idx) {
    const c = CAMERAS[idx] || CAMERAS[0]
    const shake = this.cutShake > 0 ? this.cutShake : 0
    const jx = (Math.random() - 0.5) * 0.05 * shake
    const jy = (Math.random() - 0.5) * 0.04 * shake
    this.camera.position.set(c.pos[0] + jx, c.pos[1] + jy, c.pos[2])
    this.camera.fov = c.fov
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(new THREE.Vector3(c.look[0], c.look[1], c.look[2]))
  }

  setDance(name) {
    if (DANCES[name]) this.danceName = name
  }

  setAutoCut(on, beats) {
    this.autoCut = Boolean(on)
    if (beats) this.autoBeats = Math.max(1, beats | 0)
  }

  /**
   * 画面风格
   *  - faithful：像 VRoid Studio。不套 ACES、泛光/暗角压到很低、雾拉远、切中性三点光。
   *  - cinema：舞台默认。ACES + 泛光 + 暗角，氛围强但卡通色会被压灰。
   */
  setLook(mode) {
    this.lookMode = mode === 'faithful' ? 'faithful' : 'cinema'
    const faithful = this.lookMode === 'faithful'
    this.renderer.toneMapping = faithful ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = faithful ? 1 : 1.05
    // 泛光会把亮部"炸开"，卡通材质尤其明显 —— faithful 模式直接不让这两个 pass 跑
    if (this.bloom) {
      this.bloom.strength = faithful ? 0 : Math.max(0, this.params.bloom)
      this.bloom.enabled = !faithful && this.params.bloom > 0.001
    }
    if (this.vignette) {
      this.vignette.uniforms.strength.value = faithful ? 0 : this.params.vignette
      this.vignette.enabled = !faithful && this.params.vignette > 0.001
    }
    if (this.charLightGroup) this.charLightGroup.visible = faithful
    if (this.scene) this.scene.environmentIntensity = faithful ? 0.6 : 0.4
    // 电影感模式下让人物也吃舞台灯（氛围）；像 VRoid 模式下隔离掉，避免打爆
    if (this.charRoot) {
      this.charRoot.traverse((o) => {
        if (!o.layers) return
        if (faithful) o.layers.disable(2)
        else o.layers.enable(2)
      })
    }
    // 雾会把模型染成背景色，faithful 时拉远
    if (this.scene) {
      const def = STAGES[this.stageName] || STAGES.neon
      if (faithful) this.scene.fog = def.fog ? new THREE.Fog(def.bg, def.fog[1] * 2.2, def.fog[1] * 6) : null
      else this.scene.fog = def.fog ? new THREE.Fog(def.bg, def.fog[0], def.fog[1]) : null
    }
    // 通知外面（面板上的按钮要跟着亮）
    if (this.opts.onLook) {
      try {
        this.opts.onLook(this.lookMode)
      } catch (e) {}
    }
    return this.lookMode
  }

  setParams(patch = {}) {
    Object.assign(this.params, patch)
    const p = this.params
    if (this.charLightGroup) {
      const k = Math.max(0.2, Math.min(2.5, Number(p.charBright) || 1))
      for (const l of this.charLightGroup.children) {
        if (l.userData && typeof l.userData.baseIntensity === 'number') l.intensity = l.userData.baseIntensity * k
      }
    }
    const faithful = this.lookMode === 'faithful'
    this.bloom.strength = faithful ? 0 : p.bloom
    this.bloom.enabled = !faithful && p.bloom > 0.001
    this.vignette.uniforms.strength.value = faithful ? 0 : p.vignette
    this.vignette.enabled = !faithful && p.vignette > 0.001
    this.applyCharTransform()
    // 灯光：颜色 + 强度
    const hue = p.lightHue
    const c = new THREE.Color().setHSL(hue, 0.65, 0.62)
    for (const key of ['key', 'rim']) {
      const l = this.stageLights && this.stageLights[key]
      if (!l) continue
      if (key === 'key') {
        l.color.copy(c)
        l.intensity = (l.userData.base = l.userData.base || l.intensity) * p.lightIntensity
      }
    }
  }

  /** 换角色：加载 VRM（VRoid 导出的）或普通 glTF */
  async loadModel(url, label) {
    installBlobImageShim()
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    /*
     * three 默认会用 ImageBitmapLoader 加载贴图，它内部是 fetch(blobUrl) —— file:// 下被拦。
     * 临时把 createImageBitmap 藏起来，让它退回 TextureLoader（<img>），
     * 配合上面的 blob→data 垫片就能把贴图真正读进来。
     */
    const hadCIB = typeof window.createImageBitmap === 'function' ? window.createImageBitmap : null
    if (hadCIB) {
      try {
        window.createImageBitmap = undefined
      } catch (e) {}
    }
    let gltf
    try {
      gltf = await loader.loadAsync(url)
    } finally {
      if (hadCIB) {
        try {
          window.createImageBitmap = hadCIB
        } catch (e) {}
      }
    }
    const vrm = gltf.userData && gltf.userData.vrm
    let root = gltf.scene
    if (vrm) {
      // VRM 0.x 是 -Z 朝前，转到和舞台一致
      try {
        VRMUtils.removeUnnecessaryVertices(vrm.scene)
        VRMUtils.combineSkeletons(vrm.scene)
        VRMUtils.rotateVRM0(vrm)
      } catch {}
      root = vrm.scene
      this.vrm = vrm
      this.baseModelScale = 1
      this.baseModelYOffset = 0
    } else {
      this.vrm = null
      // 没有 VRM 时按高度把模型归一化到 1.75m（存成基准，charScale 在此基础上乘）
      const box = new THREE.Box3().setFromObject(root)
      const h = box.max.y - box.min.y
      // 没骨骼/没几何的模型不按高度归一化，免得被放大成几十米
      if (Number.isFinite(h) && h > 0.02) {
        this.baseModelScale = 1.75 / h
        this.baseModelYOffset = -box.min.y * this.baseModelScale
      } else {
        this.baseModelScale = 1
        this.baseModelYOffset = 0
      }
    }
    root.traverse((o) => {
      o.frustumCulled = false
      if (o.isMesh && !o.material) o.material = new THREE.MeshStandardMaterial({ color: 0xcccccc })
    })

    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = false
      }
    })
    if (this.charRoot) this.scene.remove(this.charRoot)
    this.charRoot = root
    this.modelLabel = label || 'model'
    this.mixerRoot = root
    this.scene.add(root)
    if (this.vrm) root.position.set(0, 0, 0)
    this.applyCharLayers()
    this.applyCharTransform()
    // 换上新模型后：VRM 默认走"像 VRoid Studio"的画面风格（不调色、中性灯）
    if (this.vrm) this.setLook('faithful')
    // 新模型 → 之前绑好的剪辑要重绑
    if (this.motionClip) this.playClip(this.motionClip)
    return { vrm: !!this.vrm, label: this.modelLabel, look: this.lookMode }
  }

  /** 载入动作文件（Mixamo 的 .fbx，或带动画的 .glb）：重定向后循环播放 */
  async loadMotion(url, label) {
    let clip = null
    if (/\.fbx$/i.test(url)) {
      const fbx = await new FBXLoader().loadAsync(url)
      clip = fbx.animations && fbx.animations[0]
      if (!clip) throw new Error('这个 FBX 里没有动画（Mixamo 下载时选 "Animation" 而不是带 skin 的）')
    } else {
      const gltf = await new GLTFLoader().loadAsync(url)
      clip = gltf.animations && gltf.animations[0]
      if (!clip) throw new Error('这个 glb 里没有动画')
    }
    const retargeted = this.retargetClip(clip)
    this.motionClip = retargeted
    this.motionLabel = label || 'motion'
    this.playClip(retargeted)
    return { label: this.motionLabel, tracks: retargeted.tracks.length, duration: Math.round(retargeted.duration * 10) / 10 }
  }

  /** 把 Mixamo 轨道的骨骼名换成目标骨架的节点名 */
  retargetClip(clip) {
    const out = new THREE.AnimationClip(clip.name || 'motion', clip.duration, [])
    const humanoid = this.vrm && this.vrm.humanoid
    const seen = new Set()
    for (const track of clip.tracks) {
      const info = mixamoBoneOf(track.name)
      if (!info) continue
      let targetName = null
      if (humanoid) {
        const node = humanoid.getNormalizedBoneNode(info.bone)
        if (!node) continue
        targetName = node.name
      } else {
        // 没有 VRM：直接对着程序化人形的关节（它们的名字就是骨骼名）
        const node = this.findByName(this.charRoot, info.bone)
        if (!node) continue
        targetName = node.name
      }
      if (seen.has(targetName + '.' + info.prop)) continue
      seen.add(targetName + '.' + info.prop)
      const values = Float32Array.from(track.values)
      if (info.prop === 'position') {
        // Mixamo 用厘米，目标用米
        for (let i = 0; i < values.length; i++) values[i] *= 0.01
      }
      out.tracks.push(new THREE.VectorKeyframeTrack(targetName + '.' + info.prop, Array.from(track.times), values))
    }
    return out
  }

  findByName(root, name) {
    let hit = null
    root.traverse((o) => {
      if (!hit && o.name === name) hit = o
    })
    return hit
  }

  /** 用 mixer 播这个剪辑（循环） */
  playClip(clip) {
    if (!this.mixerRoot) return false
    if (!this.mixer) {
      if (!this.mixerRoot) return false
      this.mixer = new THREE.AnimationMixer(this.mixerRoot)
    }
    this.mixer.stopAllAction()
    const action = this.mixer.clipAction(clip)
    action.reset()
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.play()
    this.usingClip = true
    return true
  }

  /** 回到程序化舞蹈 */
  clearMotion() {
    if (this.mixer) this.mixer.stopAllAction()
    this.mixer = null
    this.motionClip = null
    this.motionLabel = ''
    this.usingClip = false
  }

  /** 角色放到 layer 1（和"只照人物"的灯光配套） */
  applyCharLayers() {
    if (!this.charRoot) return
    this.charRoot.traverse((o) => {
      if (o.layers) o.layers.enable(1)
    })
    if (this.charRoot.layers) this.charRoot.layers.enable(1)
  }

  applyCharTransform() {
    if (!this.charRoot) return
    this.charRoot.scale.setScalar(this.params.charScale * (this.baseModelScale || 1))
    this.charRoot.position.set(this.params.charX, this.params.charY + (this.baseModelYOffset || 0), 0)
    const cs = this.sceneRoot && this.sceneRoot.userData ? this.sceneRoot.userData.contactShadow : null
    if (cs) cs.position.x = this.params.charX
  }

  /** 接一个 AnalyserNode：嘴型和灯光跟着音乐动 */
  setAnalyser(analyser) {
    this.analyser = analyser || null
    if (!this.analyser) this.audioLevel = null
    else {
      this.freq = new Uint8Array(this.analyser.frequencyBinCount)
    }
  }

  resize() {
    const w = Math.max(2, this.canvas.clientWidth || this.canvas.width)
    const h = Math.max(2, this.canvas.clientHeight || this.canvas.height)
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  loop() {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(() => this.loop())
    try {
      const nowMs = performance.now()
      const dt = Math.min(0.1, (nowMs - (this.lastFrameAt || nowMs - 16)) / 1000)
      this.lastFrameAt = nowMs
      const t = (nowMs - this.startAt) / 1000
      const bpm = this.params.bpm || 118
      const beat = (t * bpm) / 60

      // 音量
      if (this.analyser) {
        this.analyser.getByteFrequencyData(this.freq)
        let sum = 0
        for (let i = 0; i < this.freq.length; i++) sum += this.freq[i]
        this.audioLevel = sum / (this.freq.length * 255)
      }

      // 自动导播：每 N 拍切一个机位
      if (this.autoCut && Math.floor(beat / this.autoBeats) !== this.lastCutBeat) {
        this.lastCutBeat = Math.floor(beat / this.autoBeats)
        this.setCamera((this.camIndex + 1 + Math.floor(Math.random() * 2)) % CAMERAS.length)
      }
      if (this.cutShake > 0) this.cutShake = Math.max(0, this.cutShake - 0.08)
      this.applyCamera(this.camIndex)

      // 姿势：有动作文件就播剪辑，否则跑程序化舞蹈
      if (this.mixer) {
        this.mixer.update(dt)
      } else if (this.vrm) {
        vrmIdlePose(this.vrm, t)
      } else if (this.rig && this.rig.parts) {
        dancePose(this.rig, t, this.danceName, bpm, this.audioLevel)
      }

      // three-vrm 必须每帧 update：弹簧骨骼（头发/裙摆）、视线、表情才会动
      if (this.vrm && typeof this.vrm.update === 'function') {
        try {
          this.vrm.update(dt)
        } catch (e) {}
      }

      // 场景自己的每帧动画（LED 屏滚动、光束呼吸…）
      const sceneTick = this.sceneRoot && this.sceneRoot.userData ? this.sceneRoot.userData.tick : null
      if (sceneTick) {
        try {
          sceneTick(t, this.audioLevel)
        } catch (e) {}
      }

      // 口型 / 眨眼（VRM）
      if (this.vrm && this.vrm.expressionManager) {
        const em = this.vrm.expressionManager
        const lvl = this.audioLevel == null ? 0.25 + 0.2 * Math.abs(Math.sin(beat * Math.PI)) : this.audioLevel
        try {
          em.setValue('aa', Math.min(1, lvl * 1.6))
          const blink = (t % 3.6) < 0.12 ? 1 : 0
          em.setValue('blink', blink)
        } catch {}
      }

      // 灯光随拍子闪 + 花瓣飘
      const pulse = 0.75 + 0.25 * Math.abs(Math.sin((beat * Math.PI) / 2))
      /*
       * faithful（像 VRoid）模式下舞台灯光只留 6%：
       * 舞台是 HDR 级聚光灯（intensity 200+），人物站在里面必然被打成一片白 ——
       * 这就是"人物放光/太亮"的真正原因，跟泛光关系没那么大。
       */
      const stageFactor = this.lookMode === 'faithful' ? 0.06 : 1
      if (this.stageLightSet) {
        for (const l of this.stageLightSet) {
          const baseI = typeof l.userData.prBase === 'number' ? l.userData.prBase : l.intensity
          l.intensity = baseI * stageFactor * (this.lookMode === 'faithful' ? 1 : pulse)
        }
      }
      if (this.sceneRoot && this.sceneRoot.userData.petals) {
        const pts = this.sceneRoot.userData.petals
        pts.rotation.y = t * 0.05
        pts.position.y = -((t * 0.25) % 7)
      }

      this.composer.render()
    } catch (err) {
      if (this.opts.onError) this.opts.onError(err)
    }
  }

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
      this.composer.dispose && this.composer.dispose()
    } catch {}
    try {
      this.renderer.dispose()
    } catch {}
    this.scene = null
  }
}

window.PRStage = {
  // 暴露出去方便调试/自动化测试（本地桌面应用，没有安全顾虑）
  THREE,
  StageRuntime,
  stages: () => Object.entries(STAGES).map(([k, v]) => ({ key: k, label: v.label })),
  cameras: () => CAMERAS.map((c, i) => ({ index: i, label: c.label })),
  dances: () => Object.entries(DANCES).map(([k, v]) => ({ key: k, label: v.label }))
}
window.__PR_STAGE_READY = true
window.dispatchEvent(new Event('pr-stage-ready'))
