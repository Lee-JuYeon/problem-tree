// (a) VIEW — 순수함수만. `$` 없음(가드 다). 노드 맵과 세션 스냅샷을 받아
// 참조해석·숨김·레이아웃·불(마커)·목록·검증·id발급을 계산한다. 쓰기는 하지 않는다.

import type { PtreeNode } from '../../types'

export const TITLE_MAX = 16
export const DAY = 86_400_000
export const GC_DAYS = 30
export const FRAME_MS = 400
export const MAIN_FRAMES = ['○', '◐', '●', '●'] as const
export const BG_FRAMES = ['◇', '◈', '◆', '◆'] as const
// id 발급: 헷갈리는 글자(i,l,o,0,1) 제외. n+숫자 꼴은 레거시 n1~n38과 충돌하므로 재발급.
export const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export type Nodes = Record<string, PtreeNode>

export type SessionView = {
  turn: { sid: string; mainTurnId?: string; cutoffAt: number }
  pointer: { sid: string; node?: string; by?: 'user' | 'claude' }
  agentBind: { sid: string; map: Record<string, string> }
  tasks: { sid: string; map: Record<string, { type: string; node?: string; source: string }> }
}

export const norm = (s: string) => s.toLowerCase().replace(/[.,!?;:·]/g, '').replace(/\s+/g, ' ').trim()

// ---------- 참조해석 (가드 다: 호출자는 nodes[x]로 직접 풀지 말고 이걸 쓴다) ----------

/** 노드가 있고 open이면 그 id, 아니면 undefined. pointer·agentBind·task의 node에 쓴다. */
export const resolveNodeRef = (nodes: Nodes, id?: string): string | undefined =>
  id !== undefined && nodes[id] && nodes[id].status === 'open' ? id : undefined

/** 노드의 유효 부모 id(없는/removed 부모는 루트). resolved 부모는 유지. */
export const resolveParentRef = (nodes: Nodes, id: string): string | undefined => {
  const p = nodes[id]?.parent
  return p !== undefined && nodes[p] && nodes[p].status !== 'removed' ? p : undefined
}

const cmpNode = (nodes: Nodes, a: string, b: string): number => {
  const na = nodes[a]
  const nb = nodes[b]
  const ca = na?.createdAt ?? 0
  const cb = nb?.createdAt ?? 0
  return ca !== cb ? ca - cb : a < b ? -1 : a > b ? 1 : 0
}

// 비-removed 노드의 유효 부모 맵. 순환은 결정적으로 끊는다(그 순환 안 (createdAt,id) 최소 노드를 루트로).
function cleanParents(nodes: Nodes): Record<string, string | undefined> {
  const living = Object.values(nodes).filter(n => n.status !== 'removed')
  const eff: Record<string, string | undefined> = {}
  for (const n of living) eff[n.id] = resolveParentRef(nodes, n.id)
  for (;;) {
    let cycle: string[] | undefined
    for (const start of Object.keys(eff)) {
      const seen = new Set<string>()
      let cur: string | undefined = start
      while (cur !== undefined && eff[cur] !== undefined && !seen.has(cur)) {
        seen.add(cur)
        cur = eff[cur]
      }
      if (cur !== undefined && seen.has(cur)) {
        const members: string[] = []
        let c: string | undefined = cur
        do {
          members.push(c)
          c = eff[c]
        } while (c !== undefined && c !== cur)
        cycle = members
        break
      }
    }
    if (!cycle) break
    const min = cycle.reduce((a, b) => (cmpNode(nodes, a, b) <= 0 ? a : b))
    eff[min] = undefined
  }
  return eff
}

// ---------- 완료 단위 / 숨김 ----------

export type DoneUnit = { top: string; members: string[]; doneAt: number }

/**
 * "완료 단위" = 그 노드와 살아있는 자손이 전부 resolved인 최상위 노드.
 * members = top + 살아있는 자손. doneAt = members 안 resolvedAt의 최댓값.
 */
export function doneUnits(nodes: Nodes): DoneUnit[] {
  const eff = cleanParents(nodes)
  const ids = Object.keys(eff)
  const childrenOf = (id: string) => ids.filter(x => eff[x] === id)
  const memo = new Map<string, boolean>()
  const fully = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id)!
    const n = nodes[id]
    const ok = !!n && n.status === 'resolved' && childrenOf(id).every(fully)
    memo.set(id, ok)
    return ok
  }
  const descendants = (id: string, acc: string[] = []): string[] => {
    for (const c of childrenOf(id)) {
      acc.push(c)
      descendants(c, acc)
    }
    return acc
  }
  const units: DoneUnit[] = []
  for (const id of ids) {
    if (!fully(id)) continue
    const parent = eff[id]
    if (parent !== undefined && fully(parent)) continue // 꼭대기만(위에서 흡수)
    const members = [id, ...descendants(id)]
    const doneAt = members.reduce((m, x) => Math.max(m, nodes[x]?.resolvedAt ?? 0), 0)
    units.push({ top: id, members, doneAt })
  }
  return units
}

/**
 * 숨김 집합. removed는 항상 숨긴다. 완료 단위는 doneAt<cutoffAt일 때만 숨긴다:
 * 단위 꼭대기가 루트면 통째로, 열린 조상 밑이면 꼭대기만 ● 한 줄로 남기고 자손만 숨긴다.
 */
export function hiddenSet(nodes: Nodes, cutoffAt: number): Set<string> {
  const eff = cleanParents(nodes)
  const hidden = new Set<string>()
  for (const n of Object.values(nodes)) if (n.status === 'removed') hidden.add(n.id)
  for (const u of doneUnits(nodes)) {
    if (u.doneAt >= cutoffAt) continue
    const isRoot = eff[u.top] === undefined
    for (const m of u.members) if (m !== u.top) hidden.add(m)
    if (isRoot) hidden.add(u.top)
  }
  return hidden
}

// ---------- 레이아웃 ----------

export type Row = { node: PtreeNode; prefix: string; last: boolean; depth: number }

/** 숨김 뺀 노드로 트리 행을 만든다(루트는 커넥터 없음, 자식은 ├─/└─). createdAt 순. */
export function layout(nodes: Nodes, hidden: Set<string>): Row[] {
  const eff = cleanParents(nodes)
  const visible = Object.values(nodes).filter(n => n.status !== 'removed' && !hidden.has(n.id))
  const byAge = (a: PtreeNode, b: PtreeNode) => cmpNode(nodes, a.id, b.id)
  const kids: Record<string, PtreeNode[]> = {}
  const roots: PtreeNode[] = []
  for (const n of visible) {
    const p = eff[n.id]
    if (p !== undefined && nodes[p] && !hidden.has(p) && nodes[p].status !== 'removed') (kids[p] ||= []).push(n)
    else roots.push(n)
  }
  roots.sort(byAge)
  Object.values(kids).forEach(list => list.sort(byAge))
  const rows: Row[] = []
  const walk = (list: PtreeNode[], prefix: string, depth: number) => {
    list.forEach((n, i) => {
      const last = i === list.length - 1
      rows.push({ node: n, prefix, last, depth })
      const childPrefix = depth === 0 ? '' : prefix + (last ? '  ' : '│ ')
      const ks = kids[n.id]
      if (ks) walk(ks, childPrefix, depth + 1)
    })
  }
  walk(roots, '', 0)
  return rows
}

// ---------- 불(마커) 계산 (d) ----------

export type Lights = {
  P?: string
  mainOn: boolean
  headMain: boolean
  headBg: number
  bgOf: Record<string, number>
}

export function lights(nodes: Nodes, hidden: Set<string>, s: SessionView): Lights {
  const P = resolveNodeRef(nodes, s.pointer.node)
  const mainOn = s.turn.mainTurnId !== undefined
  const bgOf: Record<string, number> = {}
  let headBg = 0
  for (const t of Object.values(s.tasks.map)) {
    const n = resolveNodeRef(nodes, t.node)
    if (n !== undefined && !hidden.has(n)) bgOf[n] = (bgOf[n] ?? 0) + 1
    else headBg++
  }
  const headMain = mainOn && P === undefined
  return { P, mainOn, headMain, headBg, bgOf }
}

export const staleDays = (n: PtreeNode, now: number) => Math.floor((now - n.touchedAt) / DAY)

// ---------- 목록 ----------

export function listText(nodes: Nodes, now: number, hidden: Set<string>, s: SessionView): string {
  const L = lights(nodes, hidden, s)
  const visible = Object.values(nodes)
    .filter(n => n.status !== 'removed' && !hidden.has(n.id))
    .sort((a, b) => cmpNode(nodes, a.id, b.id))
  if (visible.length === 0) return '(문제 노드 없음)'
  return visible
    .map(n => {
      const tag =
        n.status === 'resolved'
          ? 'resolved'
          : L.mainOn && L.P === n.id
            ? 'current'
            : (L.bgOf[n.id] ?? 0) > 0
              ? 'bg'
              : n.startedAt === undefined
                ? 'planned'
                : `paused ${staleDays(n, now)}d`
      const par = resolveParentRef(nodes, n.id)
      const parTxt = par ? ` ←${par}` : ''
      const nt = n.note ? ` 📝${n.note}` : ''
      return `${n.id} [${tag}] ${n.title}${parTxt}${nt}`
    })
    .join('\n')
}

// ---------- 검증기 ----------

export function wouldCycle(nodes: Nodes, id: string, newParent?: string): boolean {
  const seen = new Set<string>()
  let cur = newParent
  while (cur !== undefined) {
    const node = nodes[cur]
    if (!node || node.status === 'removed') break
    if (cur === id || seen.has(cur)) return true
    seen.add(cur)
    cur = node.parent
  }
  return false
}

export function moveError(nodes: Nodes, id: string, newParent?: string): string | undefined {
  const n = nodes[id]
  if (!n || n.status === 'removed') return `없는 노드: ${id}`
  if (newParent !== undefined && (!nodes[newParent] || nodes[newParent].status === 'removed'))
    return `없는 부모: ${newParent} — 목록으로 확인(루트로 보내려면 부모 id를 생략)`
  if (newParent === id) return `거부: ${id}를 자기 자신 밑으로 옮길 수 없음`
  if (wouldCycle(nodes, id, newParent)) return `거부: ${newParent}는 ${id}의 하위 노드 — 순환이 됨`
  if (n.parent === newParent) return `변화 없음: ${id}는 이미 ${newParent ? '부모 ' + newParent : '루트'}`
  return undefined
}

/** 같은 제목의 open 노드가 있으면 그 id(중복). resolved·removed는 재사용 가능. */
export function dupTitle(nodes: Nodes, title: string, exceptId?: string): string | undefined {
  const nn = norm(title)
  const hit = Object.values(nodes).find(n => n.status === 'open' && n.id !== exceptId && norm(n.title) === nn)
  return hit?.id
}

/** 전에 삭제된(묘비) 제목인가 — removed 행 제목으로 파생. */
export function rejectedTitle(nodes: Nodes, title: string): boolean {
  const nn = norm(title)
  return Object.values(nodes).some(n => n.status === 'removed' && norm(n.title) === nn)
}

const defaultRand = () => Math.random()

/** 4자 무작위 id. n\d+ 꼴·이미 있는 키(묘비 포함)는 피한다. rand 주입 가능(테스트). */
export function newId(exists: (id: string) => boolean, rand: () => number = defaultRand): string {
  for (let i = 0; i < 1000; i++) {
    let s = ''
    for (let j = 0; j < 4; j++) s += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length) % ID_ALPHABET.length]
    if (/^n\d+$/.test(s)) continue
    if (exists(s)) continue
    return s
  }
  // 이론상 도달 불가(공간 ~700k). 최후의 보루.
  let s = 'z'
  for (let j = 0; j < 5; j++) s += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length) % ID_ALPHABET.length]
  return s
}

export const tooLong = (s: string) => s.length > TITLE_MAX
