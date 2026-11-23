// (a) OPS — 노드 조작. 슬래시·도구가 같은 함수를 쓴다.
// 각 조작 = loadTree → view 검증 → patchNode/insertNode → 필요 시 session 쓰기.
// 참조해석은 view 함수로만 한다(가드 다: nodes[x] 직접 풀이 금지).

import type { PtreeNode } from '../../types'
import { loadTree, insertNode, patchNode } from './store'
import { readSession, setPointer, clearPointer } from './session'
import * as view from './view'

type Any = any

// ---------- add ----------

export async function add($: Any, args: { title: string; by: 'user' | 'claude'; parentId?: string }): Promise<string> {
  const title = args.title
  if (!title) return '거부: title 비어 있음'
  if (view.tooLong(title)) return `거부: 제목 ${view.TITLE_MAX}자 이내로(지금 ${title.length}자). 더 짧게 다시.`
  const nodes = await loadTree($)
  const dup = view.dupTitle(nodes, title)
  if (dup) return `중복: 이미 ${dup} 로 존재(무시됨)`
  if (view.rejectedTitle(nodes, title)) return `전에 삭제된 제목(무시됨)`
  if (args.parentId !== undefined) {
    const p = nodes[args.parentId]
    if (!p || p.status === 'removed')
      return `없는 부모: ${args.parentId} — 추가 안 됨. list_problems로 확인(루트면 parentId 생략)`
  }
  const s = await readSession($)
  const now = await $.clock.now()
  // 사용자 add는 현재 pointer(focus) 노드 "자신"을 부모로 잇는다(없으면 루트). Claude add는 상속 안 함(parentId만).
  // resolveNodeRef: pointer 노드가 open이면 그 id, 아니면 undefined(루트). pointer의 부모가 아니라 pointer 자신이다.
  const parent =
    args.by === 'user'
      ? (args.parentId ?? view.resolveNodeRef(nodes, s.pointer.node))
      : args.parentId
  const id = view.newId(x => x in nodes)
  const node: PtreeNode = {
    id,
    title,
    status: 'open',
    createdAt: now,
    touchedAt: now,
    reopenCount: 0,
    history: [{ at: now, event: 'add', by: args.by }],
  }
  if (parent !== undefined) node.parent = parent
  // 사용자 add는 pointer를 그 노드로 옮겨 작업을 시작한다 → 턴 밖(/ptree add)이라도 startedAt을 찍는다(mainOn 게이트 없음).
  if (args.by === 'user') node.startedAt = now
  const nn = view.norm(title)
  const r = await insertNode($, node, cur => {
    const d = Object.values(cur).find(n => n.status === 'open' && view.norm(n.title) === nn)
    if (d) return `중복: 이미 ${d.id} 로 존재(무시됨)`
    if (Object.values(cur).some(n => n.status === 'removed' && view.norm(n.title) === nn)) return `전에 삭제된 제목(무시됨)`
    if (parent !== undefined && (!cur[parent] || cur[parent].status === 'removed'))
      return `없는 부모: ${parent} — 추가 안 됨. list_problems로 확인(루트면 parentId 생략)`
    return undefined
  })
  if (r.error) return r.error
  if (args.by === 'user') await setPointer($, id, 'user')
  return args.by === 'user'
    ? `노드 추가: "${title}"`
    : `추가 ${id}(계획만 ○, ${parent !== undefined ? '부모 ' + parent : '루트'}) — focus는 그대로`
}

// ---------- focus ----------

export async function focus($: Any, id: string, by: 'user' | 'claude'): Promise<string> {
  const nodes = await loadTree($)
  const n = nodes[id]
  if (!n || n.status === 'removed') return `없는 노드: ${id}`
  if (n.status !== 'open') return `${id}는 open이 아님(${n.status}) — 작업 대상 불가`
  await setPointer($, id, by)
  // focus는 pointer를 그 노드로 옮기는 조작 → startedAt을 찍는다(스펙: mainOn 게이트 없음).
  // 턴 밖 focus 뒤 그 턴에 작업해도 멈춤(◐)으로 남게, 즉시 startedAt을 세운다.
  await patchNode($, id, (d, now) => {
    d.touchedAt = now
    if (d.startedAt === undefined) d.startedAt = now
    d.history.push({ at: now, event: 'focus', by })
  })
  return by === 'user' ? `포커스: ${id}` : `작업 시작 ${id}(진행중 ●)`
}

// ---------- resolve ----------

/** 노드 행을 해결 상태로. mergedInto가 있으면 "그 노드 해결로 함께 닫힘"(merge)으로 기록한다. */
function markResolved(d: PtreeNode, now: number, by: 'user' | 'claude', mergedInto?: string): void {
  d.status = 'resolved'
  d.resolvedAt = now
  d.touchedAt = now
  if (mergedInto === undefined) d.history.push({ at: now, event: 'resolve', by })
  else {
    d.resolvedBy = mergedInto
    d.history.push({ at: now, event: 'merge', by, ref: mergedInto })
  }
}

export async function resolve(
  $: Any,
  args: { id: string; by: 'user' | 'claude'; also?: string[] },
): Promise<string> {
  const { id, by } = args
  const also = args.also ?? []
  const nodes = await loadTree($)
  const n = nodes[id]
  if (!n || n.status === 'removed') return `없는 노드: ${id}`
  if (n.status !== 'open') return `${id}는 open 상태가 아님(${n.status})`
  const s = await readSession($)
  await patchNode($, id, (d, now) => markResolved(d, now, by))
  for (const other of also) {
    const o = nodes[other]
    if (o && o.status === 'open') await patchNode($, other, (d, now) => markResolved(d, now, by, id))
  }
  // pointer: 손 안 댄 열린 노드를 작업 중이면 그대로, 아니면 부모 open으로(없으면 비움).
  // 참조해석은 resolveNodeRef로만(가드 다).
  const pn = s.pointer.node
  const keep = pn !== undefined && pn !== id && !also.includes(pn) && view.resolveNodeRef(nodes, pn) === pn
  if (!keep) {
    // 방금 alsoResolves로 함께 resolved된 부모에는 pointer·startedAt을 찍지 않는다(스냅샷 nodes엔 아직 open이라 resolveNodeRef가 잘못 id를 돌려줌).
    const parent =
      n.parent !== undefined && also.includes(n.parent)
        ? undefined
        : view.resolveNodeRef(nodes, n.parent)
    if (parent !== undefined) {
      await setPointer($, parent, by)
      // pointer가 부모로 옮겨가 current가 됨 → 부모도 "pointer를 그 노드로 옮기는 조작" 규칙 적용(startedAt·touchedAt 갱신).
      await patchNode($, parent, (d, now) => {
        d.touchedAt = now
        if (d.startedAt === undefined) d.startedAt = now
      })
    } else await clearPointer($)
  }
  return `해결 ${id}${also.length ? ` (+${also.join(',')})` : ''}`
}

// ---------- reopen ----------

export async function reopen($: Any, id: string, by: 'user' | 'claude'): Promise<string> {
  const nodes = await loadTree($)
  const n = nodes[id]
  if (!n || n.status === 'removed')
    return `없는 노드: ${id} — 완료돼 삭제된 문제면 재발 시 add_problem으로 새로 만들어`
  if (n.status !== 'resolved') return `${id}는 resolved 상태가 아님(${n.status})`
  await patchNode($, id, (d, now) => {
    d.status = 'open'
    d.reopenCount = (d.reopenCount ?? 0) + 1
    d.touchedAt = now
    // reopen은 pointer를 그 노드로 옮기는 조작(아래 setPointer) → 재개 즉시 멈춤(◐)으로 남게 startedAt을 세운다.
    if (d.startedAt === undefined) d.startedAt = now
    delete d.resolvedAt
    delete d.resolvedBy
    d.history.push({ at: now, event: 'reopen', by })
  })
  await setPointer($, id, by)
  return `재개 ${id}`
}

// ---------- remove (사용자 /ptree rm) ----------

export async function remove($: Any, id: string): Promise<string> {
  const nodes = await loadTree($)
  const n = nodes[id]
  if (!n || n.status === 'removed') return `없는 노드: ${id}`
  const parent = n.parent
  // 자식부터: 삭제 노드의 부모로 승격(고아 방지).
  for (const c of Object.values(nodes)) {
    if (c.parent === id && c.status !== 'removed') {
      await patchNode($, c.id, d => {
        if (parent !== undefined) d.parent = parent
        else delete d.parent
      })
    }
  }
  await patchNode($, id, (d, now) => {
    d.status = 'removed'
    d.removedAt = now
    d.history.push({ at: now, event: 'remove', by: 'user' })
  })
  const s = await readSession($)
  if (s.pointer.node === id) await clearPointer($)
  return `삭제: ${id}`
}

// ---------- move ----------

export async function move($: Any, id: string, newParent: string | undefined, by: 'user' | 'claude'): Promise<string> {
  const nodes = await loadTree($)
  const err = view.moveError(nodes, id, newParent)
  if (err) return err
  await patchNode($, id, (d, now) => {
    if (newParent !== undefined) d.parent = newParent
    else delete d.parent
    d.history.push({ at: now, event: 'move', by, ref: newParent })
  })
  return `이동 ${id} → ${newParent !== undefined ? '부모 ' + newParent : '루트'}`
}

// ---------- rename ----------

export async function rename($: Any, id: string, title: string, by: 'user' | 'claude'): Promise<string> {
  if (!title) return '거부: title 비어 있음'
  if (view.tooLong(title)) return `거부: 제목 ${view.TITLE_MAX}자 이내로(지금 ${title.length}자). 더 짧게 다시.`
  const nodes = await loadTree($)
  const n = nodes[id]
  if (!n || n.status === 'removed') return `없는 노드: ${id}`
  const dup = view.dupTitle(nodes, title, id)
  if (dup) return `중복 제목(무시됨)`
  await patchNode($, id, (d, now) => {
    d.title = title
    d.touchedAt = now
    d.history.push({ at: now, event: 'rename', by })
  })
  return `이름 변경 ${id}: ${title}`
}

// ---------- note ----------

export async function note($: Any, id: string, text: string, by: 'user' | 'claude'): Promise<string> {
  const nodes = await loadTree($)
  const n = nodes[id]
  if (!n || n.status === 'removed') return `없는 노드: ${id}`
  await patchNode($, id, (d, now) => {
    d.note = text
    d.touchedAt = now
    d.history.push({ at: now, event: 'note', by })
  })
  return `메모 저장: ${id}`
}

// ---------- list ----------

/** 지금 보이는 노드 목록 문구(store에서 새로 읽는다). 도구 list_problems와 `/ptree list`가 같이 쓴다. */
export async function list($: Any): Promise<string> {
  const nodes = await loadTree($)
  const s = await readSession($)
  const now = await $.clock.now()
  return view.listText(nodes, now, view.hiddenSet(nodes, s.turn.cutoffAt), s)
}
