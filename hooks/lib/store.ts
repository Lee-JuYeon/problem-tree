// (a) STORE — 영속 DB(store)의 유일한 창구(가드 가·나).
// `$.store.set`/`$.store.delete`는 이 파일에만 있다. nodesAtom은 여기 선언·미export.
// 읽기 캐시(nodesAtom)는 패널 렌더 전용 복제본이며, 권위는 언제나 store다.

import { atom, read, update } from 'claude-code'
import type { PtreeNode, PtreeNodesCache, PtreeDiag } from '../../types'
import { GC_DAYS, DAY, doneUnits } from './view'

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
    await $.store.set(key, node)
    patchSeq++
    await update($, nodesAtom, (c: PtreeNodesCache) => ({ ...c, tree, nodes: { ...c.nodes, [node.id]: node } }))
    return { node }
  })
}

// ---------- GC (session.start에서만) ----------

/** removedAt<now-30일 묘비와, doneAt<now-30일 완료단위 전체를 물리 삭제. */
export async function gc($: Any): Promise<void> {
  const { tree, treeKey } = await treeOf($)
  const now = await $.clock.now()
  const cutoff = now - GC_DAYS * DAY
  const nodes = await loadNodesRaw($)
  const del = new Set<string>()
  for (const n of Object.values(nodes)) {
    if (n.status === 'removed' && (n.removedAt ?? 0) < cutoff) del.add(n.id)
  }
  for (const u of doneUnits(nodes)) {
    if (u.doneAt < cutoff) for (const m of u.members) del.add(m)
  }
  if (del.size === 0) return
  for (const id of del) {
    await $.store.delete(nodeKey(treeKey, id))
    delete nodes[id]
  }
  await writeCache($, tree, nodes)
}

// ---------- link ----------

export async function targetHasLink($: Any, target: string): Promise<boolean> {
  return typeof (await $.store.get(`link:${target}`)) === 'string'
}

export async function setLink($: Any, tree: string): Promise<void> {
  const root = await $.session.root()
  await $.store.set(`link:${root}`, tree)
}
export async function clearLink($: Any): Promise<void> {
  const root = await $.session.root()
  await $.store.delete(`link:${root}`)
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

// ---------- 진단 로그(diag:<sid>, 세션별 최근 50건) ----------
// 불(점등) 동작과 무관한 기록 전용. 절대 throw하지 않고 큐도 오염시키지 않는다.

const DIAG_MAX = 50
const DIAG_GC_MS = 7 * DAY
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

/** 다른 세션의 diag: 키 중 마지막 항목이 7일보다 오래됐거나 형식이 이상한 것을 지운다. */
export async function diagGc($: Any, ownSid: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const own = diagKey(ownSid)
    const keys: string[] = await $.store.keys()
    for (const k of keys) {
      if (!k.startsWith('diag:') || k === own) continue
      const v = await $.store.get(k)
      const last = Array.isArray(v) && v.length > 0 ? v[v.length - 1] : undefined
      const at = last && typeof last.at === 'number' ? last.at : undefined
      if (at === undefined || at < now - DIAG_GC_MS) await $.store.delete(k)
    }
  } catch {
    /* 진단 정리 실패는 삼킴 */
  }
}
