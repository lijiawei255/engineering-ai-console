import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLogic } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const main = async () => {
  await buildLogic()
  const result = spawnSync(process.execPath, [path.join(root, 'tests/.selftest/logic.js')], {
    stdio: 'inherit',
    cwd: root,
  })
  process.exit(result.status ?? 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
