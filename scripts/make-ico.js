// 把 256×256 的 PNG 包成一个标准 Windows .ico（单条目、PNG 压缩，Vista+ 支持）
const fs = require('fs')

const src = process.argv[2]
const dst = process.argv[3]
if (!src || !dst) {
  console.error('用法: node make-ico.js <icon.png> <icon.ico>')
  process.exit(1)
}
const png = fs.readFileSync(src)
if (png.length < 100 || png.readUInt32BE(0) !== 0x89504e47) {
  console.error('不是 PNG')
  process.exit(1)
}
// PNG IHDR 里的宽高
const w = png.readUInt32BE(16)
const h = png.readUInt32BE(20)
const dir = Buffer.alloc(6)
dir.writeUInt16LE(0, 0) // reserved
dir.writeUInt16LE(1, 2) // type = icon
dir.writeUInt16LE(1, 4) // 1 image
const entry = Buffer.alloc(16)
entry[0] = w >= 256 ? 0 : w // 0 表示 256
entry[1] = h >= 256 ? 0 : h
entry[2] = 0 // 调色板色数
entry[3] = 0 // reserved
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12) // 数据偏移 = 6 + 16
fs.writeFileSync(dst, Buffer.concat([dir, entry, png]))
console.log(`已生成 ${dst}（${w}×${h}，${(dir.length + entry.length + png.length)} 字节）`)
