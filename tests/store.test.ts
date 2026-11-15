// (f) store 1~9.
import { expect, test } from 'claude-code/testing'
import { boot, start, run, call, nk, nodeOf, nodeIds, liveIds, ROOT, T0, DAY } from './harness'
import { treeKeyOf } from '../hooks/lib/store'
import { newId } from '../hooks/lib/view'

const idsWithTitle = (store: any, title: string) =>
  liveIds(store).filter(id => nodeOf(store, id)?.title === title)
async function addId($: any, store: any, title: string): Promise<string> {
  const before = new Set(nodeIds(store))
  await call($, 'add_problem', { title })
  return nodeIds(store).find(id => !before.has(id))!
}

// ---------- 1 ----------
test('patchNode는 대상 키 하나만 set 한다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  const id = await addId($, store, 'A')
  store.sets.length = 0
  await call($, 'rename_problem', { nodeId: id, title: 'B' })
  expect(store.sets.map(s => s.key)).toEqual([nk(id)])
  expect(nodeOf(store, id)?.title).toBe('B')
})

// ---------- 2 ----------
// patchNode가 "대상 키 하나만" 쓰는지를, get과 set 사이에 다른 엔진 쓰기를 끼워 검증한다.
// (목 엔진은 훅 디스패치를 직렬화해 진짜 동시성을 못 만든다 → store.onSet 주입으로 모사.)
test('두 엔진이 다른 노드를 써도(patchNode 대상쓰기) 유실 0', async ($, on) => {
  const { store } = boot(on)
  await start($)
  const a = await addId($, store, 'AA')
  const b = await addId($, store, 'BB')
  // 엔진1이 A를 patchNode(get→set)하는 그 사이에, 엔진2(외부)가 B를 직접 바꾼다.
  let fired = 0
  store.onSet = () => {
    if (fired === 0) {
      fired++
      store.map.set(nk(b), { ...(store.map.get(nk(b)) as any), title: 'B-EXT' })
    }
  }
  await call($, 'rename_problem', { nodeId: a, title: 'A2' })
  store.onSet = undefined
  expect(fired).toBe(1)
  expect(nodeOf(store, a)?.title).toBe('A2') // 엔진1 쓰기 반영
  // patchNode가 A 키만 쓰므로 엔진2의 B 외부쓰기는 유실되지 않는다(전체 덤프였다면 'BB'로 덮임).
  expect(nodeOf(store, b)?.title).toBe('B-EXT')
})

// ---------- 3 ----------
test('cwd가 바뀌어도 노드 키는 root 기준으로 그대로', async ($, on) => {
  const b = boot(on)
  await start($)
  const id = await addId($, b.store, 'A')
  expect(nodeOf(b.store, id)).toBeDefined() // node:/proj:<id>
  b.setCwd('/proj/sub/dir') // 하위 디렉터리로 이동
  const id2 = await addId($, b.store, 'B')
  // 두 노드 모두 같은 트리(root) 아래 — 키 접두 동일
  expect(nk(id).startsWith(`node:${ROOT}:`)).toBe(true)
  expect(nk(id2).startsWith(`node:${ROOT}:`)).toBe(true)
  expect([...b.store.map.keys()].some(k => k.startsWith('node:/proj/sub/dir:'))).toBe(false)
})

// ---------- 4 ----------
test('link: 빈 루트에서만, 대상에 link 있으면 거부', async ($, on) => {
  // (a) 빈 루트 → 허용
  {
    const { store } = boot(on)
    await start($)
    const r = await run($, 'link /other/project')
    expect(r?.text).toContain('link → /other/project')
    expect(store.map.get(`link:${ROOT}`)).toBe('/other/project')
  }
})

test('link: 현재 트리에 노드가 있으면 거부', async ($, on) => {
  const { store } = boot(on)
  await start($)
  await addId($, store, 'A')
  const r = await run($, 'link /other/project')
  expect(r?.text).toContain('노드가 있어')
  expect(store.map.get(`link:${ROOT}`)).toBeUndefined()
})

test('link: 대상에 이미 link가 있으면 거부', async ($, on) => {
  const { store } = boot(on, { 'link:/other/project': '/elsewhere' })
  await start($)
  const r = await run($, 'link /other/project')
  expect(r?.text).toContain('이미 link')
})

// ---------- 5 ----------
test('tree가 180자를 넘으면 해시 키로 접는다', () => {
  const short = '/proj'
  expect(treeKeyOf(short)).toBe(short)
  const long = '/x'.repeat(100) // 200자
  const k = treeKeyOf(long)
  expect(k.startsWith('h:')).toBe(true)
  expect(k.length).toBe(2 + 16) // 'h:' + 16 hex
  expect(treeKeyOf(long)).toBe(k) // 결정적
})

// ---------- 6 ----------
test('newId: n\\d+ 꼴·기존 id(묘비 포함) 회피', () => {
  const ALPH = 'abcdefghjkmnpqrstuvwxyz23456789'
  const existing = new Set(['n234', '23ab']) // n234=레거시꼴 비슷, 23ab=이미 있는 묘비
  const picks = ['n', '2', '3', '4', '2', '3', 'a', 'b', 'a', 'b', 'c', 'd']
  let i = 0
  const rand = () => ALPH.indexOf(picks[i++]!) / ALPH.length
  const id = newId(x => existing.has(x), rand)
  expect(id).toBe('abcd')
  expect(/^n\d+$/.test(id)).toBe(false)
  expect(existing.has(id)).toBe(false)
})

// ---------- 7 ----------
test('migrate: 레거시 tree:<root>를 노드로(id 보존·proposed→open), tree: 삭제·멱등', async ($, on) => {
  const legacy = {
    version: 1,
    seq: 38,
    focusId: 'n1',
    rejected: ['x'],
    nodes: {
      n1: { id: 'n1', title: '옛1', status: 'proposed', createdAt: T0 - DAY, touchedAt: T0 - DAY, reopenCount: 0, proposalReason: 'r', history: [] },
      n38: { id: 'n38', title: '옛38', status: 'open', parent: 'n1', createdAt: T0 - DAY, touchedAt: T0 - DAY, reopenCount: 0, history: [] },
    },
  }
  const { store } = boot(on, { [`tree:${ROOT}`]: legacy })
  await start($)
  expect(nodeOf(store, 'n1')).toMatchObject({ id: 'n1', title: '옛1', status: 'open' }) // proposed→open, id 보존
  expect((nodeOf(store, 'n1') as any).proposalReason).toBeUndefined()
  expect(nodeOf(store, 'n38')?.parent).toBe('n1')
  expect(store.map.get(`tree:${ROOT}`)).toBeUndefined() // 레거시 키 삭제
  expect(store.map.get('schema')).toBe(2)
  // 멱등: 다시 start 해도 노드 그대로, 재삭제 없음
  const delsBefore = store.deletes.length
  await start($)
  expect(nodeIds(store).sort()).toEqual(['n1', 'n38'])
  expect(store.deletes.length).toBe(delsBefore)
})

// ---------- 8 ----------
test('gc: removed 30일 경계와 완료단위 doneAt 30일 경계', async ($, on) => {
  const mkRemoved = (id: string, removedAt: number) => ({
    id, title: id, status: 'removed', createdAt: T0 - 60 * DAY, touchedAt: T0 - 60 * DAY, removedAt, reopenCount: 0, history: [],
  })
  const mkDone = (id: string, resolvedAt: number) => ({
    id, title: id, status: 'resolved', createdAt: T0 - 60 * DAY, touchedAt: resolvedAt, resolvedAt, reopenCount: 0, history: [],
  })
  const { store } = boot(on, {
    [nk('oldRm')]: mkRemoved('oldRm', T0 - 31 * DAY),
    [nk('newRm')]: mkRemoved('newRm', T0 - 29 * DAY),
    [nk('oldDone')]: mkDone('oldDone', T0 - 31 * DAY),
    [nk('newDone')]: mkDone('newDone', T0 - 29 * DAY),
  })
  await start($)
  expect(nodeOf(store, 'oldRm')).toBeUndefined() // 30일 지난 묘비 삭제
  expect(nodeOf(store, 'newRm')).toBeDefined() // 29일 유지
  expect(nodeOf(store, 'oldDone')).toBeUndefined() // 30일 지난 완료단위 삭제
  expect(nodeOf(store, 'newDone')).toBeDefined() // 29일 유지
})

// ---------- 9 ----------
// 병렬 add 직렬화의 핵심 = insertNode의 "쓰기 시점 재검증"(직렬큐 안에서). pre-check(opAdd) 통과 뒤
// 다른 엔진이 같은 제목을 끼워넣어도 insertNode validate가 재읽기로 잡아 중복 삽입을 막는지 본다.
// (목 엔진이 디스패치를 직렬화해 진짜 병렬 insertNode 실행은 불가 → store.onKeys로 끼어들기 모사.)
test('병렬 add 직렬화: insertNode 재검증이 pre-check 이후 끼어든 동명 노드를 잡는다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  // add 한 번의 store.keys: #1=opAdd.loadTree(pre-check), #2=insertNode.validate(쓰기 시점 재읽기).
  let n = 0
  store.onKeys = () => {
    n++
    if (n === 2) {
      // pre-check 통과 뒤, validate 직전에 다른 엔진이 같은 제목을 삽입한 것처럼 끼워넣는다.
      store.map.set(nk('zinj'), { id: 'zinj', title: '동시제목', status: 'open', createdAt: 0, touchedAt: 0, reopenCount: 0, history: [] })
    }
  }
  const r = await call($, 'add_problem', { title: '동시제목' })
  store.onKeys = undefined
  // pre-check는 통과했지만 insertNode validate가 끼어든 동명 노드를 보고 거부한다.
  expect(String(r.result)).toContain('중복')
  // 동명 open 노드는 끼어든 것 하나뿐 — 재검증이 없으면 '추가'되어 둘이 된다(= 이 테스트 실패).
  expect(idsWithTitle(store, '동시제목')).toEqual(['zinj'])
})

// ---------- 9b (직렬큐 동시성 — Promise.all) ----------
// 같은 제목으로 add 3개를 Promise.all로 한꺼번에 던져도, patchNode/insertNode 직렬큐 + 쓰기시점
// 재검증이 사전검사 겹침을 잡아 노드가 하나만 남는다(테스트9가 끼어들기 주입으로 본 것을 실제 동시 호출로).
test('병렬 add(Promise.all) 같은 제목 3개 → 하나만 남는다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  await Promise.all([
    call($, 'add_problem', { title: '동시제목' }),
    call($, 'add_problem', { title: '동시제목' }),
    call($, 'add_problem', { title: '동시제목' }),
  ])
  // 동명 open 노드는 정확히 하나(직렬큐·재검증이 없으면 둘 이상 삽입되어 실패).
  expect(idsWithTitle(store, '동시제목')).toHaveLength(1)
})

// ---------- 탐침2 (버그2 재현) ----------
// migrate가 중간에 죽어 node: 키가 일부만 변환된 상태로 재시작해도, 레거시를 바로 지우지 않고
// 빠진 노드를 이어서 변환한 뒤 삭제한다(미변환 노드 유실 방지).
test('탐침2(버그2): migrate 중단 복구 — node: 일부만 있어도 빠진 노드를 이어 변환(유실0)', async ($, on) => {
  const mk = (id: string, title: string) => ({ id, title, status: 'open', createdAt: T0, touchedAt: T0, reopenCount: 0, history: [] })
  const legacy = { version: 1, nodes: { n1: mk('n1', '일'), n2: mk('n2', '이') } }
  const { store } = boot(on, {
    [`tree:${ROOT}`]: legacy,
    [nk('n1')]: mk('n1', '일'), // 이전 migrate가 n2 변환 전에 죽어 n1만 변환된 상태
  })
  await start($)
  expect(nodeOf(store, 'n1')).toBeDefined() // 기존 변환 유지
  expect(nodeOf(store, 'n2')).toMatchObject({ id: 'n2', title: '이' }) // 빠진 n2 이어서 변환(유실0)
  expect(store.map.get(`tree:${ROOT}`)).toBeUndefined() // 모두 변환됐으니 레거시 삭제
  expect(store.map.get('schema')).toBe(2)
})
