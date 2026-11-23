// (a) STORE — 영속 DB(store)의 유일한 창구(가드 가·나).
// `$.store.set`/`$.store.delete`는 이 파일에만 있다. nodesAtom은 여기 선언·미export.
// 읽기 캐시(nodesAtom)는 패널 렌더 전용 복제본이며, 권위는 언제나 store다.
//
// store 키(전부 이 파일이 소유):
//   node:<treeKey>:<id>  노드 1행(PtreeNode) — 영구 데이터의 전부. modAt = 행 버전(쓰기마다 증가)
//   link:<root>          이 root가 다른 tree를 보게 하는 연결(문자열). false = unlink 묘비
//   schema               노드행 스키마 버전(2)
//   store:id             이 store 파일의 표식(형제 파일 중 자기 파일 식별)
//   gone:<treeKey>       GC로 물리 삭제한 노드 {id: 시각} — 형제 store의 낡은 사본이 되살리지 못하게(1년 보관).
//                        형제끼리 id별 최댓값으로 합쳐진다(행과 마찬가지로 복제 상태의 일부)
//   adopt:<파일명>        형제 store 파일을 마지막으로 흡수한 지문 {size,mtimeMs,ver}
//   diag:<세션id>         진단 로그 최근 50건 — 턴 시작 항목은 ptree-watch.py가 박동으로 읽는다
//   tree:<root>          레거시 v1(통째 트리). migrate가 node: 행으로 바꾸고 지운다
// 휘발 사실(도는 중·포인터·백그라운드 작업)은 여기 없다 — session.ts의 세션 atom에만 있다.

import { atom, read, update } from 'claude-code'
import type { PtreeNode, PtreeNodesCache, PtreeDiag } from '../../types'
import { DAY, gcIds } from './view'

const EMPTY_CACHE: PtreeNodesCache = { tree: '', nodes: {}, syncedAt: 0 }

// 비공개 캐시 atom(가드 가: 이 문자열은 store.ts 밖에 없어야 한다).
const nodesAtom = atom({ plugin: 'problem-tree', key: 'nodes' } as const, EMPTY_CACHE)

type Any = any // 플랫폼 $는 런타임 바인딩(테스트·엔진 공용). 타입은 claude-code가 좁힌다.

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

// ---------- tree / key ----------

// FNV-1a 32비트(시드 주입). 아주 긴 경로를 짧은 키로 접을 때만 쓴다.
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0')

export function treeKeyOf(tree: string): string {
  if (tree.length <= 180) return tree
  return 'h:' + hex8(fnv1a(tree, 0x811c9dc5)) + hex8(fnv1a(tree, 0x7a3c59b1))
}

/** 현재 tree 정하기: `link:<root>` 값이 문자열이면 그 값, 아니면 session.root. */
export async function treeOf($: Any): Promise<{ root: string; tree: string; treeKey: string }> {
  const root = await $.session.root()
  const link = await $.store.get(`link:${root}`)
  const tree = typeof link === 'string' ? link : root
  return { root, tree, treeKey: treeKeyOf(tree) }
}

const nodeKey = (treeKey: string, id: string) => `node:${treeKey}:${id}`
const nodePrefix = (treeKey: string) => `node:${treeKey}:`

// store에서 현재 tree의 노드 전부를 생으로 읽는다(캐시 안 거침).
async function loadNodesRaw($: Any): Promise<Record<string, PtreeNode>> {
  const { treeKey } = await treeOf($)
  const pre = nodePrefix(treeKey)
  const keys: string[] = await $.store.keys()
  const nodes: Record<string, PtreeNode> = {}
  for (const k of keys) {
    if (!k.startsWith(pre)) continue
    const row = (await $.store.get(k)) as PtreeNode | undefined
    if (row && typeof row.id === 'string') nodes[row.id] = row
  }
  return nodes
}

async function writeCache($: Any, tree: string, nodes: Record<string, PtreeNode>): Promise<void> {
  const at = await $.clock.now()
  await update($, nodesAtom, () => ({ tree, nodes, syncedAt: at }))
}

// ---------- 공개 읽기 ----------

/** store → 캐시 통째 교체. 반환 = 방금 읽은 노드 맵(조작이 바로 쓴다). */
export async function loadTree($: Any): Promise<Record<string, PtreeNode>> {
  const { tree } = await treeOf($)
  const g0 = patchSeq // 진단: 읽는 도중 patch/insert가 캐시 행을 갱신했는지(덮어쓰기 후보) 탐지용
  const nodes = await loadNodesRaw($)
  if (patchSeq !== g0) {
    // 진단 전용(동작 불변: 아래에서 그대로 덮어쓴다). sid는 이 분기에서만 읽는다.
    try {
      const sid = await $.session.id()
      await diagPush($, sid, { at: await $.clock.now(), ev: 'clobber', note: `seq ${g0}→${patchSeq}` })
    } catch {
      /* 진단 실패는 삼킴 */
    }
  }
  await writeCache($, tree, nodes)
  return nodes
}

/** 렌더용 캐시 복제본(가드 나: 반환을 변조해도 다음 읽기에 영향 없음). */
export async function readCache($: Any): Promise<PtreeNodesCache> {
  const c = (await read($, nodesAtom)) as PtreeNodesCache
  return clone(c)
}

// ---------- 직렬화 쓰기 큐 ----------
// 프로세스 내 모듈 promise 체인. patchNode(다행)와 insertNode(유일성)가 공유한다.
let queue: Promise<unknown> = Promise.resolve()
// 진단: patchNode·insertNode가 캐시 행을 갱신할 때마다 +1(loadTree의 덮어쓰기 탐지용).
let patchSeq = 0
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p
}

export type PatchResult = { node?: PtreeNode; error?: string }

/**
 * 한 노드를 읽어 fn으로 고치고 다시 쓴다. fn이 문자열을 반환하면 거부(쓰기 0).
 * 순서: store.get → 없으면 {error} → fn(복제본,at) → set → 캐시 그 행만 교체.
 */
export function patchNode($: Any, id: string, fn: (n: PtreeNode, at: number) => void | string): Promise<PatchResult> {
  return enqueue(async () => {
    const { tree, treeKey } = await treeOf($)
    const key = nodeKey(treeKey, id)
    const cur = (await $.store.get(key)) as PtreeNode | undefined
    if (!cur) return { error: `없는 노드: ${id}` }
    const draft = clone(cur)
    const at = await $.clock.now()
    const rej = fn(draft, at)
    if (typeof rej === 'string') return { error: rej }
    if (draft.history.length > 20) draft.history = draft.history.slice(-20)
    draft.modAt = Math.max(at, rowVersion(cur) + 1) // 모든 변경이 행 버전을 올린다(형제 store 병합 기준)
    await $.store.set(key, draft)
    patchSeq++
    await update($, nodesAtom, (c: PtreeNodesCache) => ({ ...c, tree, nodes: { ...c.nodes, [id]: draft } }))
    return { node: draft }
  })
}

export type InsertResult = { node?: PtreeNode; error?: string }

/**
 * 새 노드를 쓴다. validate(쓰기 시점 트리)가 문자열을 주면 거부(쓰기 0) —
 * 병렬 같은-제목 add를 직렬큐에서 하나만 통과시킨다.
 */
export function insertNode(
  $: Any,
  node: PtreeNode,
  validate?: (nodes: Record<string, PtreeNode>) => string | undefined,
): Promise<InsertResult> {
  return enqueue(async () => {
    const { tree, treeKey } = await treeOf($)
    const key = nodeKey(treeKey, node.id)
    // 기존 키 덮어쓰기 방지(묘비 포함 중복 id). newId가 캐시로 피하지만 store가 최종 권위다.
    if (await $.store.get(key)) return { error: `이미 있는 id: ${node.id}` }
    if (validate) {
      const nodes = await loadNodesRaw($)
      const err = validate(nodes)
      if (err) return { error: err }
    }
    const row: PtreeNode = { ...node, modAt: await $.clock.now() }
    await $.store.set(key, row)
    patchSeq++
    await update($, nodesAtom, (c: PtreeNodesCache) => ({ ...c, tree, nodes: { ...c.nodes, [row.id]: row } }))
    return { node: row }
  })
}

// ---------- GC (session.start에서만) ----------

/** removedAt<now-30일 묘비와, doneAt<now-30일 완료단위 전체를 물리 삭제. */
export async function gc($: Any): Promise<void> {
  const { tree, treeKey } = await treeOf($)
  const nodes = await loadNodesRaw($)
  const now = await $.clock.now()
  const del = gcIds(nodes, now)
  if (del.size === 0) return
  // 지운 id를 먼저 기록한다(기록 뒤 삭제: 중간에 죽어도 "지웠는데 기록 없음"이 안 생긴다).
  const gone = await readGone($, treeKey)
  for (const id of del) gone[id] = now
  for (const [id, at] of Object.entries(gone)) if (at < now - GONE_KEEP_MS) delete gone[id]
  try {
    await $.store.set(goneKey(treeKey), gone)
  } catch {
    /* 기록 실패(store 가득 참 등)가 GC와 세션 시작을 끊지 않게 — 삭제가 오히려 공간을 비운다 */
  }
  for (const id of del) {
    await $.store.delete(nodeKey(treeKey, id))
    delete nodes[id]
  }
  await writeCache($, tree, nodes)
}

// GC로 물리 삭제한 노드 id와 그 시각. 30일 묘비가 사라진 뒤에도 "내가 지웠다"를 기억해,
// 오래 쉬던 형제 store의 낡은 사본이 그 노드를 되살리지 못하게 한다(adoptFile이 본다).
const GONE_KEEP_MS = 365 * DAY
const goneKey = (treeKey: string) => `gone:${treeKey}`
async function readGone($: Any, treeKey: string): Promise<Record<string, number>> {
  const v = await $.store.get(goneKey(treeKey))
  const out: Record<string, number> = {}
  if (v && typeof v === 'object' && !Array.isArray(v))
    for (const [id, at] of Object.entries(v)) if (typeof at === 'number') out[id] = at
  return out
}

// ---------- link ----------

export async function targetHasLink($: Any, target: string): Promise<boolean> {
  return typeof (await $.store.get(`link:${target}`)) === 'string'
}

export async function setLink($: Any, tree: string): Promise<void> {
  const root = await $.session.root()
  await $.store.set(`link:${root}`, tree)
}
/** 연결 해제. 키를 지우지 않고 묘비(false)를 남긴다 — 지우면 형제 store 흡수가 옛 연결을 되살린다. */
export async function clearLink($: Any): Promise<void> {
  const root = await $.session.root()
  if (typeof (await $.store.get(`link:${root}`)) === 'string') await $.store.set(`link:${root}`, false)
}

// ---------- migrate (session.start마다, 스캔 없음, 최대 1키 변환) ----------

/** 레거시 v1 노드 1행 → 현행 PtreeNode(id 보존, proposed→open, pending/proposalReason 제거). */
function convertLegacyNode(raw: any): PtreeNode | undefined {
  if (!raw || typeof raw.id !== 'string') return undefined
  const n: PtreeNode = {
    id: raw.id,
    title: String(raw.title ?? raw.id),
    status: raw.status === 'resolved' ? 'resolved' : 'open', // proposed/removed/그 외 → open(기존 동작)
    createdAt: Number(raw.createdAt ?? 0),
    touchedAt: Number(raw.touchedAt ?? raw.createdAt ?? 0),
    reopenCount: Number(raw.reopenCount ?? 0),
    history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
  }
  if (raw.parent !== undefined) n.parent = raw.parent
  if (raw.startedAt !== undefined) n.startedAt = Number(raw.startedAt)
  if (raw.resolvedAt !== undefined) n.resolvedAt = Number(raw.resolvedAt)
  if (raw.resolvedBy !== undefined) n.resolvedBy = raw.resolvedBy
  if (raw.note !== undefined) n.note = raw.note
  return n
}

/**
 * `tree:<root>`(version 1)가 있으면 각 노드를 node: 키로 변환한다.
 * ★중단 복구: 레거시 삭제는 **모든 레거시 노드가 node: 키로 존재할 때만**. 중간에 죽어
 * node:가 일부만 있어도 **빠진 노드만 이어서 변환**한 뒤 레거시를 지운다(미변환 유실 방지).
 * 레거시가 유효 v1이 아니면(잔재) 읽지 말고 삭제.
 */
export async function migrate($: Any): Promise<void> {
  const { tree, treeKey } = await treeOf($)
  const legacyKey = `tree:${await $.session.root()}`
  const legacy = (await $.store.get(legacyKey)) as any
  if (!legacy) return
  if (legacy.version !== 1 || !legacy.nodes) {
    await $.store.delete(legacyKey) // 구버전 잔재(v1 아님) → 삭제만
    return
  }
  const keys: string[] = await $.store.keys()
  const pre = nodePrefix(treeKey)
  const present = new Set(keys.filter(k => k.startsWith(pre)))
  for (const raw of Object.values(legacy.nodes) as any[]) {
    const n = convertLegacyNode(raw)
    if (!n) continue
    if (!present.has(nodeKey(treeKey, n.id))) await $.store.set(nodeKey(treeKey, n.id), n) // 빠진 것만
  }
  // 이제 모든 레거시 노드가 node: 키로 존재 → 레거시 제거·schema 기록.
  await $.store.delete(legacyKey)
  await $.store.set('schema', 2)
  await writeCache($, tree, await loadNodesRaw($))
}

// ---------- adopt (session.start마다: 다른 설치 식별자의 store에 고아가 된 노드 흡수) ----------
// 전제: `$.store` 파일은 Claude Code가 고르는 **로드 식별자**(`problem-tree_<source>-<hash>.json` —
// skills-dir 자동로드 / 마켓 설치 / --plugin-dir)마다 따로다. 식별자는 재설치·소스 이동으로 바뀌는
// 휘발 사실인데 노드는 영구 데이터 → 식별자가 바뀌면 옛 파일의 노드가 "안 보이는 고아"가 된다.
// 그래서 같은 플러그인의 형제 store 파일을 읽어 node:/link: 행을 자기 store로 흡수한다(행 단위,
// 없으면 복사·있으면 mergeRows — 삭제 묘비·이동·해결이 그대로 전파된다).
// diag:/schema는 옮기지 않는다. 물리 삭제(GC)된 행은 같은 GC 규칙으로 걸러, unlink는 묘비로 부활을 막는다.

const STORE_FILE_RE = /^problem-tree_[A-Za-z0-9._-]+\.json$/ // 경로 구분자 불가 → 디렉터리 탈출 없음
const ADOPT_MAX_BYTES = 4 * 1024 * 1024 // $.fs.read 상한(4 MiB)
const adoptKey = (name: string) => `adopt:${name}`
const STORE_ID_KEY = 'store:id' // 이 store 파일의 표식(형제 목록에서 자기 파일을 알아보는 용도)

export type AdoptResult = { adopted: number; files: string[]; skipped: string[]; conflicts: string[] }

/** store 디렉터리(절대경로). CLAUDE_CONFIG_DIR 우선, 없으면 $HOME/.claude. 못 구하면 undefined. */
async function storeDir($: Any): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return `${cfg}/plugins/store`
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/plugins/store` : undefined
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 행의 버전 = 그 행이 마지막으로 바뀐 시각. patchNode/insertNode(유일한 쓰기 창구)가 `modAt`에 찍는다.
 * ★`touchedAt`은 버전이 아니다 — "작업이 닿은 시각"이라 rm·move·자식 승격은 올리지 않는다.
 * modAt을 안 찍는 옛 행·옛 쓰기 주체도 있으므로, 행 안의 모든 시각 중 최댓값으로 본다.
 */
export function rowVersion(n: PtreeNode): number {
  let v = Math.max(num(n.modAt), num(n.createdAt), num(n.touchedAt), num(n.resolvedAt), num(n.removedAt))
  if (Array.isArray(n.history)) for (const h of n.history) v = Math.max(v, num(h?.at))
  return v
}

const isNodeRow = (v: any): v is PtreeNode =>
  !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.title === 'string' &&
  (v.status === 'open' || v.status === 'resolved' || v.status === 'removed') && Array.isArray(v.history)

/**
 * 형제 store 파일들의 node:/link: 행을 자기 store로 흡수한다.
 * - 파일별 `adopt:<파일명>`={size,mtimeMs,ver} 지문이 같으면 다시 읽지 않는다.
 * - 자기 파일도 목록에 섞여 있다(자기 파일명은 알 길이 없다). `store:id` 표식이 같으면 자기 파일 → 건너뛴다.
 * - 못 읽은 파일(4 MiB 초과·깨진 JSON·쓰기 거부)은 skipped, 같은 id의 다른 노드는 conflicts로 돌려
 *   호출부가 사용자에게 알린다(조용한 고아·조용한 덮어쓰기 금지).
 */
export function adoptSiblings($: Any): Promise<AdoptResult> {
  return enqueue(async () => {
    const out: AdoptResult = { adopted: 0, files: [], skipped: [], conflicts: [] }
    const dir = await storeDir($)
    if (!dir) return out
    let entries: any[]
    try {
      entries = await $.fs.list(dir)
    } catch {
      return out // fs 접근 불가(권한·환경) — 볼 수 있는 형제가 없다
    }
    const own = new Set<string>(await $.store.keys())
    let selfId = await $.store.get(STORE_ID_KEY)
    if (typeof selfId !== 'string') {
      selfId = `${(await $.clock.now()).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      await $.store.set(STORE_ID_KEY, selfId)
    }
    const now: number = await $.clock.now()
    for (const e of entries) {
      if (!e || e.kind !== 'file' || e.isLink || !STORE_FILE_RE.test(String(e.name))) continue
      const mark = (await $.store.get(adoptKey(e.name))) as any
      if (mark && mark.size === e.size && mark.mtimeMs === e.mtimeMs) continue
      try {
        if (e.size > ADOPT_MAX_BYTES) throw new Error('too large')
        const data = JSON.parse(await $.fs.read(`${dir}/${e.name}`))
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
        if (data[STORE_ID_KEY] === selfId) continue // 자기 파일
        const n = await adoptFile($, data, own, mark, now, out)
        // 지문은 파일 하나를 끝까지 흡수한 뒤에만 남긴다(중간 실패 = 다음 시작에 처음부터 다시).
        await $.store.set(adoptKey(e.name), { size: e.size, mtimeMs: e.mtimeMs, ...n.mark })
        if (n.count > 0) {
          out.adopted += n.count
          out.files.push(e.name)
          patchSeq++
        }
      } catch {
        out.skipped.push(e.name) // 못 읽음·깨짐·쓰기 거부(4 MiB) — 호출부가 사용자에게 알린다
      }
    }
    return out
  })
}

// 상태의 앞섬 순위: 삭제는 끝(되돌림 없음). 그 밖은 재개 횟수가 큰 쪽, 같으면 해결 > 열림.
// (재개는 reopenCount를 올리므로 "해결 뒤 다시 연 것"과 "해결을 아직 못 본 낡은 바탕"이 갈린다.)
const statusRank = (n: PtreeNode): number =>
  n.status === 'removed' ? Infinity : num(n.reopenCount) * 2 + (n.status === 'resolved' ? 1 : 0)

/**
 * 같은 노드의 두 사본을 합친다. 바탕은 행 버전이 새 쪽(제목·부모·메모·이력…), 상태 묶음
 * (status·resolvedAt·resolvedBy·removedAt·reopenCount)만은 상태가 앞선 쪽 것을 쓴다 —
 * 형제 세션이 내 해결/삭제를 모른 채(낡은 바탕) 뒤늦게 focus·rename 해도 해결/삭제가 안 되돌아간다.
 */
export function mergeRows(cur: PtreeNode, inc: PtreeNode): PtreeNode {
  // 동률은 내용의 글자순으로 가른다 — 어느 쪽에서 합쳐도 같은 답이 나와야 두 store가 수렴한다.
  const vc = rowVersion(cur)
  const vi = rowVersion(inc)
  const base = vi > vc || (vi === vc && JSON.stringify(inc) > JSON.stringify(cur)) ? inc : cur
  const rc = statusRank(cur)
  const ri = statusRank(inc)
  const st = ri > rc ? inc : rc > ri ? cur : base
  const out: PtreeNode = { ...base, status: st.status, reopenCount: st.reopenCount }
  for (const f of ['resolvedAt', 'resolvedBy', 'removedAt'] as const) {
    if (st[f] !== undefined) (out as any)[f] = st[f]
    else delete out[f]
  }
  out.modAt = Math.max(rowVersion(cur), rowVersion(inc))
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 형제 store 한 파일의 행을 흡수한다. 반환 = 흡수한 행 수와 새 워터마크.
 * - 내 쪽에 없는 행은 **항상** 본다. 단 GC 규칙상 곧 지워질 행(gcIds)과, 내가 GC로 지운 뒤 안 바뀐 행
 *   (gone:<tree> 기록)은 안 가져온다.
 * - 내 쪽에 있는 행은 mergeRows로 합친다. 워터마크(ver = 지난번에 그 파일에서 본 가장 새 행 버전)는
 *   get 절약용일 뿐이다: 그 이하 버전이고 내 쪽에 있는 행은 지난번에 이미 합쳤으므로 건너뛴다.
 */
async function adoptFile(
  $: Any, data: Record<string, unknown>, own: Set<string>, mark: any, now: number, out: AdoptResult,
): Promise<{ count: number; mark: { ver?: number } }> {
  // 옛 지문의 touched(touchedAt 최댓값)도 워터마크로 받는다 — rowVersion ≥ touchedAt이라 안전한 하한.
  const seen: number = typeof mark?.ver === 'number' ? mark.ver : typeof mark?.touched === 'number' ? mark.touched : -Infinity
  let ver = seen
  let count = 0

  // 형제의 노드 행을 트리별로 모아 GC 대상을 미리 계산한다(완료 단위는 트리 전체를 봐야 안다).
  const byTree = new Map<string, Record<string, PtreeNode>>()
  const rows: { k: string; v: PtreeNode; pre: string }[] = []
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('node:') || !isNodeRow(v) || !k.endsWith(`:${v.id}`)) continue
    const pre = k.slice(0, k.length - v.id.length)
    if (!byTree.has(pre)) byTree.set(pre, {})
    byTree.get(pre)![v.id] = v
    rows.push({ k, v, pre })
  }
  // 삭제 기록(gone)도 복제 상태의 일부다: 형제의 기록을 id별 최댓값으로 합쳐 내 것으로 삼는다.
  // 합치지 않으면 제3의 식별자가 "GC한 쪽(행 없음)"과 "오래 쉰 쪽(낡은 사본)"을 함께 읽고 지운 노드를 되살린다.
  const gone = new Map<string, Record<string, number>>()
  const goneOf = async (pre: string) => {
    if (!gone.has(pre)) gone.set(pre, await readGone($, pre.slice('node:'.length, -1)))
    return gone.get(pre)!
  }
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('gone:') || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const treeKey = k.slice('gone:'.length)
    const pre = nodePrefix(treeKey)
    const mine = await goneOf(pre)
    let changed = false
    for (const [id, at] of Object.entries(v as Record<string, unknown>)) {
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      const t = Math.min(at, now)
      if (mine[id] !== undefined && mine[id]! >= t) continue
      mine[id] = t
      changed = true
      // 형제가 지운 노드의, 그 뒤로 안 바뀐 내 사본은 같이 지운다(안 그러면 한쪽에만 남는 좀비).
      const key = pre + id
      if (!own.has(key)) continue
      const cur = (await $.store.get(key)) as PtreeNode | undefined
      if (cur && rowVersion(cur) <= t) {
        await $.store.delete(key)
        own.delete(key)
      }
    }
    if (changed) {
      await $.store.set(goneKey(treeKey), mine)
      own.add(goneKey(treeKey))
    }
  }
  const doomed = new Map<string, Set<string>>()
  for (const [pre, nodes] of byTree) {
    doomed.set(pre, gcIds(nodes, now))
    await goneOf(pre)
  }

  for (const { k, v, pre } of rows) {
    const rv = Math.min(rowVersion(v), now) // 미래 시각 행이 워터마크를 망가뜨리지 않게
    if (rv > ver) ver = rv
    if (!own.has(k)) {
      if (doomed.get(pre)!.has(v.id)) continue
      // 내가 GC로 지운 노드: 형제의 사본이 그 뒤에 바뀐 것(재개 등)일 때만 다시 받는다.
      const goneAt = gone.get(pre)![v.id]
      if (goneAt !== undefined && !(rv > goneAt)) continue
      own.add(k)
      await $.store.set(k, { ...v, history: v.history.slice(-20) })
      count++
      continue
    }
    if (rv <= seen) continue
    const cur = (await $.store.get(k)) as PtreeNode | undefined
    if (!cur) continue
    if (num(cur.createdAt) !== num(v.createdAt)) {
      out.conflicts.push(v.id) // 같은 id의 다른 노드(따로 만들어진 것) — 덮지 않고 알린다
      continue
    }
    const merged = mergeRows(cur, v)
    merged.history = merged.history.slice(-20)
    if (same(merged, cur)) continue
    await $.store.set(k, merged)
    // 버전 표기(modAt)만 맞춘 것은 "가져온 행"으로 세지 않는다(알릴 내용이 없다).
    if (!same({ ...merged, modAt: 0 }, { ...cur, modAt: 0 })) count++
  }

  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('link:')) {
      // 내 쪽에 키가 있으면(연결이든 unlink 묘비든) 건드리지 않는다.
      if (typeof v !== 'string' || own.has(k)) continue
      own.add(k)
      await $.store.set(k, v)
      count++
    } else if (k.startsWith('tree:') && !own.has(k)) {
      // 레거시 v1 트리(그 root를 아직 안 열어 미이관). 그 트리의 node: 행이 내 쪽에도 형제 쪽에도 하나도
      // 없을 때만(=아직 아무도 이관 안 함) 통째로 가져온다 — 그 root에서 세션이 열리면 migrate가 바꾼다.
      // 이관된 뒤의 레거시를 가져오면 migrate가 지워진 노드를 되살린다.
      const pre = nodePrefix(treeKeyOf(k.slice('tree:'.length)))
      const legacy = v as any
      if (!legacy || legacy.version !== 1 || !legacy.nodes) continue
      if (byTree.has(pre) || [...own].some(x => x.startsWith(pre))) continue
      if (own.has(goneKey(pre.slice('node:'.length, -1)))) continue // 이관했고 그 뒤 전부 GC된 트리
      own.add(k)
      await $.store.set(k, v)
      count++
    }
  }
  return { count, mark: ver > -Infinity ? { ver } : {} }
}

// ---------- 진단 로그(diag:<sid>, 세션별 최근 50건) ----------
// 불(점등) 동작과 무관한 기록 전용. 절대 throw하지 않고 큐도 오염시키지 않는다.

const DIAG_MAX = 50
const DIAG_GC_MS = 7 * DAY
// 세션 수 상한: `claude -p` 배치처럼 세션이 수천 개면 7일 TTL만으로는 store가 4 MiB 상한
// (넘으면 모든 $.store.set 거부 = 노드 쓰기 불능)에 닿는다. 최근 것만 남긴다.
const DIAG_KEEP = 100
// 한 번의 session.start가 들여다보는(get) 키 수 상한. store 연산 비용은 store 크기에 비례하므로
// (실측: diag 5,925키·4MB에서 키마다 get 하던 옛 GC가 세션 시작에 CPU 1분+) 전수 조사하지 않는다.
const DIAG_GC_BATCH = 100
// 상한 안쪽이어도 TTL 만료를 확인해 볼 "가장 오래된" 키 수.
const DIAG_TTL_PROBE = 20
// 상한을 넘어도 지우지 않는 "아직 도는 세션" 기준(마지막 항목이 이 안쪽). ptree-watch.py가 박동으로
// 읽으므로, 도는 세션의 키를 지우면 "패널 꺼짐" 오탐이 난다 → 넉넉히 하루.
const DIAG_ACTIVE_MS = DAY
const diagKey = (sid: string) => `diag:${sid}`

/** 항목 1건을 diag:<sid> 끝에 붙이고 최근 50건만 남긴다(직렬 큐 경유, 실패는 삼킴). */
export function diagPush($: Any, sid: string, entry: PtreeDiag): Promise<void> {
  try {
    return enqueue(async () => {
      try {
        const row: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(entry)) if (v !== undefined) row[k] = v
        const key = diagKey(sid)
        const cur = await $.store.get(key)
        const arr: unknown[] = Array.isArray(cur) ? cur : []
        arr.push(row)
        await $.store.set(key, arr.slice(-DIAG_MAX))
      } catch {
        /* 진단 실패는 삼킴 */
      }
    })
  } catch {
    return Promise.resolve()
  }
}

/**
 * 다른 세션의 diag: 키를 정리한다. `$.store.keys()`는 삽입순(=세션이 처음 기록한 순)이라
 * 앞쪽이 가장 오래된 세션이다. 앞에서부터 최대 DIAG_GC_BATCH개만 읽어 본다(전수 get 금지):
 * - 형식이 이상하거나 마지막 항목이 7일보다 오래됨 → 삭제
 * - 세션 수가 DIAG_KEEP을 넘는 만큼의 앞쪽 키 → 삭제(단, 최근 하루 안에 기록한 세션은 남김)
 * 남은 초과분은 다음 session.start들이 이어서 지운다.
 */
export async function diagGc($: Any, ownSid: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const own = diagKey(ownSid)
    const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith('diag:') && k !== own)
    const over = Math.max(0, keys.length - DIAG_KEEP)
    const probe = Math.min(keys.length, DIAG_GC_BATCH, Math.max(over, DIAG_TTL_PROBE))
    for (let i = 0; i < probe; i++) {
      const k = keys[i]!
      const v = await $.store.get(k)
      const last = Array.isArray(v) && v.length > 0 ? v[v.length - 1] : undefined
      const at = last && typeof last.at === 'number' ? last.at : undefined
      if (at === undefined || at < now - DIAG_GC_MS || (i < over && at < now - DIAG_ACTIVE_MS)) await $.store.delete(k)
    }
  } catch {
    /* 진단 정리 실패는 삼킴 */
  }
}
