/**
 * Raccoon 图片能力判定的离线回归。
 *
 * 只做一件事：把 `raccoon-product.ts` 里那段判定逻辑抽出来跑，锁住
 * 「带快照后缀的 id 也要命中白名单」这条 —— 2026-10-24 用户报障
 * `raccoon: 模型 "sn-deepseek-v4-1-flash-1017" 不支持图片输入`，
 * 根因是远端 `model_catalog` 改发带日期后缀的 id，而白名单按精确 id 匹配。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = fs.readFileSync(path.join(root, 'vendor/channel-pack/src/raccoon-product.ts'), 'utf8')

function slice(start, end) {
  const from = source.indexOf(start)
  if (from < 0) throw new Error(`raccoon-product.ts 中找不到 ${start}`)
  const to = source.indexOf(end, from)
  if (to < 0) throw new Error(`raccoon-product.ts 中找不到 ${end}`)
  return source.slice(from, to + end.length)
}

const code = [
  slice('export const RACCOON_IMAGE_CAPABILITY_OVERRIDES', ')'),
  slice('export function raccoonBaseModelId', '\n}'),
  slice('export function raccoonSupportsImage', '\n}'),
]
  .join('\n')
  .replace(/: ReadonlySet<string>/g, '')
  .replace(/: string/g, '')
  .replace(/: readonly string\[\]/g, '')
  .replace(/: boolean/g, '')
  .replace(/export /g, '')

const { raccoonSupportsImage, raccoonBaseModelId } = new Function(
  `${code}\nreturn { raccoonSupportsImage, raccoonBaseModelId }`,
)()

let checks = 0
function check(name, run) {
  run()
  console.log(`ok ${++checks} ${name}`)
}

check('快照后缀被剥掉，其余 id 原样保留', () => {
  assert.equal(raccoonBaseModelId('sn-deepseek-v4-1-flash-1017'), 'sn-deepseek-v4-1-flash')
  assert.equal(raccoonBaseModelId('sn-glm-5-3-flash-0921'), 'sn-glm-5-3-flash')
  // 不带连字符的数字结尾不是日期后缀（`k3` / `6-8` 都在中间或末尾但无 `-NNNN` 形态）
  assert.equal(raccoonBaseModelId('sn-kimi-k3'), 'sn-kimi-k3')
  assert.equal(raccoonBaseModelId('sn-sensenova-6-8-flash'), 'sn-sensenova-6-8-flash')
  assert.equal(raccoonBaseModelId('short'), 'short')
})

check('白名单里的模型无论有没有快照后缀都支持图片', () => {
  assert.equal(raccoonSupportsImage('sn-deepseek-v4-1-flash', []), true)
  assert.equal(raccoonSupportsImage('sn-deepseek-v4-1-flash-1017', []), true, '这就是用户报障的 id')
  assert.equal(raccoonSupportsImage('sn-deepseek-v4-1-flash-0921', []), true)
  assert.equal(raccoonSupportsImage('sn-glm-5-3-flash', []), true)
  assert.equal(raccoonSupportsImage('sn-glm-5-3-flash-1017', []), true)
})

check('白名单之外仍以远端 tags 为准', () => {
  assert.equal(raccoonSupportsImage('sn-kimi-k3', ['vision']), true)
  assert.equal(raccoonSupportsImage('sn-kimi-k3-1017', ['image']), true)
  assert.equal(raccoonSupportsImage('sn-kimi-k3', []), false)
  // ⚠️ 不能放宽成「该家恒支持」：纯文本模型必须继续播报 text
  assert.equal(raccoonSupportsImage('some-text-only-model', ['general', 'code']), false)
})

console.log(`\nraccoon image capability: ${checks}/${checks} checks passed`)
