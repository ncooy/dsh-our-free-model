import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, startForwardServer } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/** 未指定端口时的默认监听端口。 */
const DEFAULT_PORT = 18900

/** 开机时间比对容差（毫秒）：`os.uptime()` 的秒级抖动不该被当成重启。 */
const BOOT_TIME_TOLERANCE_MS = 10_000

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/**
 * 本次开机的时间戳（毫秒），由 `os.uptime()` 反推。
 *
 * ## 为什么锁文件里要记它（真实缺陷，用户 2026-10-24 报障）
 *
 * 原实现用 `service.lock` 的**独占创建**（`wx`）当启动门禁：只要文件还在就
 * 拒绝启动。它在进程被强杀、或**直接重启电脑**时不会被清理，于是下次启动
 * 永远报「数据目录已被服务占用」，必须手动删文件 —— 用户报障的正是这个。
 *
 * 改为「锁里记 PID，启动时看该 PID 是否还活着」后，还剩一个洞：**重启电脑后
 * PID 会被系统从头分配**，残留锁里的 `pid` 很可能正好撞上一个无关的新进程，
 * 于是「PID 存在」把一次正常的启动误判成「旧实例还在跑」。
 *
 * 记下开机时刻即可区分：开机时刻变了 ⇒ 机器重启过 ⇒ 锁必然是上一次开机的
 * 残留，可以安全接管。
 */
function bootTimeMs() {
  return Math.round(Date.now() - os.uptime() * 1000)
}

/** 进程是否仍在运行（`EPERM` 表示存在但属于别的用户，同样算存在）。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 读取已落盘的监听端口（只读，不创建 store）。 */
function readSavedPort(dataDir) {
  try {
    const port = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))?.standalonePort
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * 判定某个端口上答话的是不是**本产品**的服务。
 *
 * 只用于一处：老版本留下的锁没有 `bootTime`，无法区分「旧实例还活着」与
 * 「PID 被系统复用给了别的进程」。`/health` 不需要 Key，且自报 `service` /
 * `product`，正好能给出第二个独立证据。
 */
async function isOwnServiceOnPort(host, port) {
  if (!Number.isInteger(port) || port <= 0) return false
  const authority = host === '::1' ? '[::1]' : host
  try {
    const response = await fetch(`http://${authority}:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body?.service === PRODUCT && body?.product === 'standalone'
  } catch {
    return false
  }
}

/**
 * 读取锁文件记录的持有者；文件缺失/损坏/形状不对都返回 undefined。
 */
function readLockOwner(lockFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    const pid = parsed?.pid
    const bootTime = parsed?.bootTime
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    return {
      pid,
      bootTime: typeof bootTime === 'number' && Number.isFinite(bootTime) ? bootTime : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * 锁文件的持有者是否**仍然是活着的本产品实例**。
 *
 * 有 `bootTime` 时（新版本写的锁）：进程存在，且锁写于**本次开机**。
 * 两条都要满足 —— 只看 PID 会被「重启后 PID 被系统复用」骗到（见 bootTimeMs）。
 *
 * 没有 `bootTime` 时（老版本写的锁）：只能看 PID，再用端口上的 `/health`
 * 做一次佐证，避免把「PID 恰好被别的进程复用」误判成旧实例还在跑。
 *
 * @param dataDir 用来读上次落盘的端口，供 `/health` 佐证。
 */
async function isLockOwnerAlive(owner, host, dataDir) {
  if (!isProcessAlive(owner.pid)) return false
  if (owner.bootTime === undefined) return isOwnServiceOnPort(host, readSavedPort(dataDir))
  return Math.abs(bootTimeMs() - owner.bootTime) <= BOOT_TIME_TOLERANCE_MS
}

/**
 * 取得实例锁：写 `{pid, bootTime, product}` 并返回句柄。
 *
 * 先用 `wx` 建一个**空的**锁文件占住名字，再写内容。不能反过来 —— 先建后写
 * 的间隙里，另一个进程读到的是一份空文档，`readLockOwner` 只能返回 undefined，
 * 它会据此把**正在启动的实例**当成残留锁删掉。空文件在这里是「有人刚拿到锁、
 * 还没来得及写」的信号，见下面的 `owner === undefined` 分支。
 *
 * 只在**确认原持有者已失效**（进程不在，或机器重启过）时才删掉残留锁重试一次。
 *
 * @throws 原持有者仍存活时抛 `EEXIST`（桌面壳据此报 `DATA_DIRECTORY_IN_USE`）。
 */
async function acquireLock(lockFile, host, dataDir) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, bootTime: bootTimeMs(), product: PRODUCT }))
      return fd
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = readLockOwner(lockFile)
      if (owner === undefined) {
        // 读不出持有者：要么另一个实例刚建好文件、内容还没落盘，要么文件损坏。
        // 前者占绝大多数，且再试一次就能看清；不要在这个窗口里删别人的锁。
        await new Promise(resolve => setTimeout(resolve, 120))
        const retry = readLockOwner(lockFile)
        if (retry === undefined) {
          // 等过一轮仍是空的/坏的：当残留锁处理。
          try {
            fs.unlinkSync(lockFile)
          } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') throw unlinkError
          }
          continue
        }
        if (await isLockOwnerAlive(retry, host, dataDir)) {
          const busy = new Error(`another Our Free Model service is already running (pid ${retry.pid})`)
          busy.code = 'EEXIST'
          throw busy
        }
        continue
      }
      if (await isLockOwnerAlive(owner, host, dataDir)) {
        const busy = new Error(`another Our Free Model service is already running (pid ${owner.pid})`)
        busy.code = 'EEXIST'
        throw busy
      }
      // 残留锁：持有者已不在（或本次开机前写的），删掉重试。
      try {
        fs.unlinkSync(lockFile)
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  const busy = new Error('could not acquire the service lock')
  busy.code = 'EEXIST'
  throw busy
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  // ⚠️ 单实例判定：锁里记 PID，启动时看该进程是否还活着（见 acquireLock /
  // isLockOwnerAlive）。上次异常退出或**重启电脑**留下的残留锁不会再拦住启动，
  // 也就不会出现「必须手动删 service.lock 才能起来」。
  const lockFile = path.join(dataDir, 'service.lock')
  const lock = await acquireLock(lockFile, host, dataDir)
  let stores
  let runtime
  let listener
  let management
  let channels
  let eac
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  const releaseLock = () => {
    try {
      fs.closeSync(lock)
      fs.unlinkSync(lockFile)
    } catch {
      // 已经被别的进程清掉，或目录已不可写：不阻断关闭。
    }
  }
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : DEFAULT_PORT)
    const key = typeof settings.get().forwardKey === 'string' && settings.get().forwardKey !== ''
      ? settings.get().forwardKey
      : generateKey()
    settings.update({ forwardKey: key, ...probe === undefined ? {} : { standaloneProbe: probe === true } })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    eac = createStandaloneEac({
      dataDir,
      onSaved: () => { void runtime?.refreshSealedLane().catch(error => logger.warn?.(`EAC 清单刷新失败：${error.message}`)) },
    })
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      sealedCredential: eac.credential,
    })
    channels = await createChannelRuntime({ dataDir, logger, stats: stores.stats })
    const core = runtime
    runtime = {
      ...core,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      get catalog() { return [...core.catalog, ...channels.publicModelRows().map(row => ({ ...row, contextWindow: row.context_window, maxOutput: row.max_tokens }))] },
      state: () => ({ ...core.state(), catalog: [...core.catalog, ...channels.publicModelRows()] }),
      publicModelRows: () => [...core.publicModelRows(), ...channels.publicModelRows()],
      complete: (request, onChunk) => channels.handles(request.model) ? channels.complete(request, onChunk) : core.complete(request, onChunk),
      async refreshCatalog(options) {
        if (stopped) return
        await Promise.all([core.refreshCatalog(options), channels.refresh().catch(error => { if (!stopped) throw error })])
      },
    }
    management = createManagement({
      stores, runtime, channels, eac,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true },
      }),
      onSettingsChanged: () => { if (!refreshInFlight) scheduleRefresh() },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true },
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ probe: settings.get().standaloneProbe === true, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = Promise.all([channels.ready, refresh ? refreshModels(settings.get().standaloneProbe === true) : Promise.resolve()])
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, channels, ready,
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        management.dispose()
        eac.dispose()
        runtime.dispose()
        closing = (async () => {
          try { await Promise.all([listener.close(), channels.close()]) } finally {
            stores.dispose()
            releaseLock()
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    management?.dispose()
    eac?.dispose()
    runtime?.dispose()
    if (listener) await listener.close()
    await channels?.close()
    stores?.dispose()
    releaseLock()
    throw error
  }
}
