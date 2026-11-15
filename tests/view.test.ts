// (f) view 10~14 — 순수함수 단위 테스트($ 없음).
import { expect, test } from 'claude-code/testing'
import {
  resolveNodeRef,
  resolveParentRef,
  hiddenSet,
  layout,
  rejectedTitle,
  dupTitle,
  type Nodes,
} from '../hooks/lib/view'
import type { PtreeNode } from '../types'

const T0 = 1_700_000_000_000
function mk(id: string, over: Partial<PtreeNode> = {}): PtreeNode {
  return {
    id,
    title: over.title ?? id,
    status: over.status ?? 'open',
    createdAt: over.createdAt ?? T0,
    touchedAt: over.touchedAt ?? T0,
    reopenCount: 0,
    history: [],
    ...over,
  }
}
const nodes = (...ns: PtreeNode[]): Nodes => Object.fromEntries(ns.map(n => [n.id, n]))

// ---------- 10 ----------
test('resolveNodeRef: 없음·resolved·removed → undefined, open → id', () => {
  const ns = nodes(mk('a'), mk('b', { status: 'resolved' }), mk('c', { status: 'removed' }))
  expect(resolveNodeRef(ns, undefined)).toBeUndefined()
  expect(resolveNodeRef(ns, 'zzz')).toBeUndefined()
  expect(resolveNodeRef(ns, 'b')).toBeUndefined()
  expect(resolveNodeRef(ns, 'c')).toBeUndefined()
  expect(resolveNodeRef(ns, 'a')).toBe('a')
})

// ---------- 11 ----------
test('resolveParentRef: resolved 부모 유지, removed/없음 부모 → 루트', () => {
  const ns = nodes(
    mk('p', { status: 'resolved' }),
    mk('c', { parent: 'p' }), // 열린 자식, 부모 resolved → 유지
    mk('g', { status: 'removed' }),
    mk('d', { parent: 'g' }), // 부모 removed → 루트
    mk('e', { parent: 'nope' }), // 부모 없음 → 루트
    mk('f'), // 부모 자체 없음
  )
  expect(resolveParentRef(ns, 'c')).toBe('p')
  expect(resolveParentRef(ns, 'd')).toBeUndefined()
  expect(resolveParentRef(ns, 'e')).toBeUndefined()
  expect(resolveParentRef(ns, 'f')).toBeUndefined()
})

// ---------- 12 ----------
test('부모 순환은 결정적으로 끊기고(최소 노드 루트) 입력을 변조하지 않는다(쓰기0)', () => {
  const ns = nodes(
    mk('n2', { parent: 'n1', createdAt: T0 + 10 }),
    mk('n1', { parent: 'n2', createdAt: T0 }), // 순환, n1이 (createdAt) 최소 → 루트
    mk('n3', { parent: 'n1', createdAt: T0 + 20 }),
  )
  const snapshot = JSON.stringify(ns)
  const rows = layout(ns, new Set())
  expect(rows).toHaveLength(3)
  const n1Row = rows.find(r => r.node.id === 'n1')!
  expect(n1Row.depth).toBe(0) // 최소 노드가 루트로
  // 순수함수 — 입력 불변
  expect(JSON.stringify(ns)).toBe(snapshot)
})

// ---------- 13 ----------
test('hiddenSet: cutoff 전후, 열린 조상 밑 완료단위는 꼭대기만 접힘, reopen 복귀', () => {
  const cutoff = T0 + 1000
  // 루트 완료단위(통째 숨김)
  const rootDone = nodes(mk('r', { status: 'resolved', resolvedAt: T0 }))
  expect(hiddenSet(rootDone, cutoff).has('r')).toBe(true)
  // doneAt >= cutoff → 안 숨김
  const fresh = nodes(mk('r', { status: 'resolved', resolvedAt: cutoff + 1 }))
  expect(hiddenSet(fresh, cutoff).has('r')).toBe(false)
  // 열린 조상 밑: top만 남고 자손 숨김
  const under = nodes(
    mk('op'),
    mk('top', { parent: 'op', status: 'resolved', resolvedAt: T0 }),
    mk('kid', { parent: 'top', status: 'resolved', resolvedAt: T0 }),
  )
  const h = hiddenSet(under, cutoff)
  expect(h.has('op')).toBe(false)
  expect(h.has('top')).toBe(false) // 꼭대기 ● 한 줄로 남음
  expect(h.has('kid')).toBe(true) // 자손만 숨김
  // reopen 복귀: top을 open으로 되돌리면 더는 완료단위가 아님
  under['top']!.status = 'open'
  under['top']!.resolvedAt = undefined
  const h2 = hiddenSet(under, cutoff)
  expect(h2.has('kid')).toBe(false)
})

// ---------- 14 ----------
test('removed 제목은 rejectedTitle로 재추가 거부, dupTitle은 removed 무시', () => {
  const ns = nodes(mk('a', { title: '빌드 느림', status: 'removed' }), mk('b', { title: '다른 것' }))
  expect(rejectedTitle(ns, '빌드 느림!')).toBe(true) // 정규화 후 일치
  expect(rejectedTitle(ns, '없던 제목')).toBe(false)
  expect(dupTitle(ns, '빌드 느림')).toBeUndefined() // removed는 중복 아님(재사용 가능)
  expect(dupTitle(ns, '다른 것')).toBe('b')
})
