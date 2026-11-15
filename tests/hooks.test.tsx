// (f) hooks 15~25 — 훅 배선. 세션 atom은 peek probe로, 머리줄·마커는 패널 렌더로 본다.
import { expect, test } from 'claude-code/testing'
import {
  boot, start, run, call, bash, spawnAgent, stop, turnStart, turnDone,
  nodeIds, nodeOf, mountPane,
} from './harness'
import { OPTS, peek } from './peek'

const addId = async ($: any, store: any, title: string): Promise<string> => {
  const before = new Set(nodeIds(store))
  await call($, 'add_problem', { title })
  return nodeIds(store).find(id => !before.has(id))!
}
const tagOf = async ($: any, id: string): Promise<string> => {
  const text = (await call($, 'list_problems', {})).result as string
  const line = text.split('\n').find(l => l.startsWith(id + ' ')) ?? ''
  const m = line.match(/\[([^\]]+)\]/)
  return m?.[1] ?? ''
}

// ---------- 15 ----------
test('메인 turn.start만으로 머리줄이 켜진다(focus 없이)', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await turnStart($)
  const s = await peek($)
  expect(s.turn.mainTurnId).toBeDefined()
  expect(s.pointer.node).toBeUndefined()
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /작업 중/ })).toBeDefined()
  await ui.unmount()
})

// ---------- 16 ----------
test('focus한 노드가 current가 되고 턴을 넘겨 pointer가 유지된다', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const id = await addId($, store, 'A')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: id })
  expect((await peek($)).pointer.node).toBe(id)
  expect(await tagOf($, id)).toBe('current')
  await turnDone($)
  // pointer는 턴을 넘어 유지, 메인 꺼져 멈춤(paused)
  expect((await peek($)).pointer.node).toBe(id)
  expect(await tagOf($, id)).toMatch(/paused/)
  await turnStart($, 't2')
  expect(await tagOf($, id)).toBe('current') // 다시 current
})

// ---------- 17 ----------
test('Bash 백그라운드 결과로 provisional이 생기고 턴이 끝나도 bg가 켜진다', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const id = await addId($, store, 'A')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: id })
  await bash($)
  const tasks = (await peek($)).runningTasks.map
  const vals = Object.values(tasks) as any[]
  expect(vals).toHaveLength(1)
  expect(vals[0]).toMatchObject({ type: 'shell', node: id, source: 'provisional' })
  await turnDone($)
  expect(Object.keys((await peek($)).runningTasks.map)).toHaveLength(1) // 유지
  expect(await tagOf($, id)).toBe('bg')
})

// ---------- 18 ----------
test('classic.Stop 스냅샷에서 빠진 작업은 꺼진다', OPTS, async ($, on) => {
  const b = boot(on)
  await start($)
  await turnStart($)
  await bash($) // bt1 (focus 없음 → 미지정)
  const id1 = b.bgId()
  await bash($) // bt2
  const id2 = b.bgId()
  expect(Object.keys((await peek($)).runningTasks.map).sort()).toEqual([id1, id2].sort())
  await stop($, [{ id: id1, type: 'shell', status: 'running', description: 'x' }])
  expect(Object.keys((await peek($)).runningTasks.map)).toEqual([id1]) // bt2 꺼짐
  expect((await peek($)).runningTasks.map[id1].source).toBe('snapshot')
})

// ---------- 19 ----------
test('인터럽트 턴(Stop 없음)에서도 provisional은 유지된다', OPTS, async ($, on) => {
  const b = boot(on)
  await start($)
  await turnStart($)
  await bash($)
  const id = b.bgId()
  await ($ as any).turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 0, isAborted: true })
  expect(Object.keys((await peek($)).runningTasks.map)).toEqual([id]) // 그대로
})

// ---------- 20 ----------
test('spawn 귀속: 메인=pointer, 중첩=부모 bind(포인터가 아님)', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const x = await addId($, store, 'X')
  const y = await addId($, store, 'Y')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: x })
  const r1 = await spawnAgent($, { background: true })
  const ag1 = r1.agentId
  let s = await peek($)
  expect(s.agentBind.map[ag1]).toBe(x)
  expect(s.runningTasks.map[ag1]).toMatchObject({ type: 'subagent', node: x })
  // 포인터를 Y로 옮긴 뒤 중첩 spawn → 부모(ag1=X) bind를 상속해야(현재 포인터 Y 아님)
  await call($, 'focus_problem', { nodeId: y })
  const r2 = await spawnAgent($, { background: true, parentAgentId: ag1 })
  const ag2 = r2.agentId
  s = await peek($)
  expect(s.agentBind.map[ag2]).toBe(x)
  expect(s.runningTasks.map[ag2]).toMatchObject({ node: x })
})

// ---------- 21 ----------
test('에이전트 turn.complete로 그 작업 행이 삭제된다', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await turnStart($)
  const r = await spawnAgent($, { background: true })
  const ag = r.agentId
  expect((await peek($)).runningTasks.map[ag]).toBeDefined()
  await turnDone($, 'agent-turn', ag) // 에이전트 턴 종료
  expect((await peek($)).runningTasks.map[ag]).toBeUndefined()
})

// ---------- 22 ----------
test('귀속 노드가 resolved되면 미지정 백그라운드 머리줄로 강등된다', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const x = await addId($, store, 'X')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: x })
  await bash($) // X에 귀속
  await call($, 'resolve_problem', { nodeId: x, reason: 'done' })
  // X가 resolved → 작업 node 참조해석 undefined → 미지정
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /백그라운드 1/ })).toBeDefined()
  await ui.unmount()
})

// ---------- 23 ----------
test('메인·bg가 같은 노드면 메인 마커 + 제목 뒤 +N', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const x = await addId($, store, '작업X')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: x })
  await bash($) // X에 귀속 → 메인+bg 공존
  expect(await tagOf($, x)).toBe('current') // 목록은 current(메인 우선)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined() // 패널엔 +1
  await ui.unmount()
})

// ---------- 24 ----------
test('background_tasks가 undefined면 작업 목록은 그대로다', OPTS, async ($, on) => {
  const b = boot(on)
  await start($)
  await turnStart($)
  await bash($)
  const id = b.bgId()
  await ($ as any).classic.Stop({
    hook_event_name: 'Stop', stop_hook_active: false, session_id: 's1', transcript_path: '/t', cwd: '/proj',
  })
  expect(Object.keys((await peek($)).runningTasks.map)).toEqual([id]) // 무변화
})

// ---------- 25 ----------
test('session.start가 작업 목록을 비운다', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await turnStart($)
  await bash($)
  expect(Object.keys((await peek($)).runningTasks.map).length).toBeGreaterThan(0)
  await start($) // 같은 세션 재시작
  expect(Object.keys((await peek($)).runningTasks.map)).toHaveLength(0)
})

// ---------- 탐침1 (버그1 재현) ----------
// 사용자 /ptree add는 pointer(focus) 노드 "자신"을 부모로 붙인다(옛 버그: pointer의 부모에 붙음).
test('탐침1(버그1): 사용자 add는 pointer 노드 자신 밑에 붙는다(부모 아님)', async ($, on) => {
  const { store } = boot(on)
  await start($)
  const g = await addId($, store, 'G') // 루트
  await call($, 'add_problem', { title: 'P', parentId: g }) // P는 G의 자식
  const p = nodeIds(store).find(id => nodeOf(store, id)?.title === 'P')!
  await run($, `focus ${p}`) // pointer = P
  const before = new Set(nodeIds(store))
  await run($, 'add 자식C') // 사용자 add
  const c = nodeIds(store).find(id => !before.has(id))!
  // 새 노드는 pointer 노드 P의 자식이어야 한다(옛 버그였다면 P의 부모 G에 붙음).
  expect(nodeOf(store, c)?.parent).toBe(p)
})

// ---------- 탐침3a (버그3 재현) ----------
// 턴 밖에서 focus해도 startedAt을 찍는다(옛 버그: mainOn 게이트로 안 찍혀 planned로 남음).
test('탐침3a(버그3): 턴 밖 focus도 startedAt을 찍는다(멈춤으로 표시)', async ($, on) => {
  const { store } = boot(on)
  await start($)
  const id = await addId($, store, 'A')
  // 메인 턴을 시작하지 않은 상태(턴 밖)에서 focus.
  await run($, `focus ${id}`)
  expect(nodeOf(store, id)?.startedAt).toBeDefined()
  // pointer=id, 메인 꺼짐 → 목록 태그는 planned가 아니라 paused.
  expect(await tagOf($, id)).toMatch(/paused/)
})

// ---------- 탐침3b (버그3 재현) ----------
// resolve로 pointer가 부모로 옮겨가 current가 되면 부모 행의 startedAt/touchedAt도 갱신된다.
test('탐침3b(버그3): resolve로 부모가 current 되면 부모 행 startedAt/touchedAt 갱신', OPTS, async ($, on) => {
  const b = boot(on)
  await start($)
  const p = await addId($, b.store, 'P') // claude add → 루트, startedAt 없음
  await call($, 'add_problem', { title: 'C', parentId: p })
  const c = nodeIds(b.store).find(id => nodeOf(b.store, id)?.title === 'C')!
  await turnStart($)
  await call($, 'focus_problem', { nodeId: c }) // pointer = c
  expect(nodeOf(b.store, p)?.startedAt).toBeUndefined() // P는 아직 작업 전
  const tP = nodeOf(b.store, p)?.touchedAt
  await b.clock.advance(1000)
  await call($, 'resolve_problem', { nodeId: c, reason: 'done' }) // c resolved → pointer가 부모 P로
  expect((await peek($)).pointer.node).toBe(p) // 부모로 이동
  expect(nodeOf(b.store, p)?.startedAt).toBeDefined() // 부모 행 startedAt 갱신
  expect(nodeOf(b.store, p)?.touchedAt).toBeGreaterThan(tP) // 부모 행 touchedAt 갱신
})

// ---------- 탐침5 (버그5 재현) ----------
// 비문자열 task id는 작업 행으로 들어가지 않는다(옛: if(id)라 숫자 id가 맵에 들어감).
test('탐침5(버그5): 비문자열 task id는 작업 행이 되지 않는다', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await turnStart($)
  await bash($, { __bg: 123 as any }) // backgroundTaskId=123(숫자)
  expect(Object.keys((await peek($)).runningTasks.map)).toHaveLength(0)
})

// ---------- 탐침6a (잔여결함1 재현) ----------
// 턴 밖 사용자 add도 startedAt을 찍는다(옛 버그: add의 mainOn 게이트로 안 찍혀 planned로 남음).
test('탐침6a: 턴 밖 /ptree add도 startedAt을 찍는다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  // 메인 턴을 시작하지 않은 상태(턴 밖)에서 사용자 add.
  const before = new Set(nodeIds(store))
  await run($, 'add 사용자A')
  const id = nodeIds(store).find(x => !before.has(x))!
  expect(nodeOf(store, id)?.startedAt).toBeDefined()
})

// ---------- 탐침6b (잔여결함1 재현) ----------
// reopen은 pointer를 그 노드로 옮기므로 startedAt을 세운다(재발 즉시 멈춤 ◐으로 표시).
test('탐침6b: reopen 뒤 startedAt이 존재한다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  // claude add → 루트, startedAt 없음. resolve로 치웠다가 reopen.
  await call($, 'add_problem', { title: 'R' })
  const id = nodeIds(store).find(x => nodeOf(store, x)?.title === 'R')!
  expect(nodeOf(store, id)?.startedAt).toBeUndefined() // 아직 작업 전
  await call($, 'resolve_problem', { nodeId: id, reason: 'done' })
  await call($, 'reopen_problem', { nodeId: id, reason: 'again' })
  expect(nodeOf(store, id)?.startedAt).toBeDefined() // reopen이 startedAt을 세움
})

// ---------- 탐침7 (잔여결함2 재현) ----------
// 자식 resolve + alsoResolves에 부모 → 방금 함께 resolved된 부모에는 pointer·startedAt을 찍지 않는다
// (옛 버그: 스냅샷 nodes엔 부모가 아직 open이라 resolveNodeRef가 부모 id를 돌려줘 부모가 ◐가 됨).
test('탐침7: 자식 resolve+also에 부모면 부모가 ◐가 되지 않는다', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const p = await addId($, store, 'P') // claude add → 루트, startedAt 없음
  await call($, 'add_problem', { title: 'C', parentId: p })
  const c = nodeIds(store).find(x => nodeOf(store, x)?.title === 'C')!
  expect(nodeOf(store, p)?.startedAt).toBeUndefined()
  await call($, 'resolve_problem', { nodeId: c, reason: 'done', alsoResolves: [p] })
  // 부모 P도 resolved여야 하고, startedAt은 찍히지 않아야 한다(◐ 아님).
  expect(nodeOf(store, p)?.status).toBe('resolved')
  expect(nodeOf(store, p)?.startedAt).toBeUndefined()
  // pointer는 부모로 이동하지 않고 비워진다(부모가 open이 아니므로).
  expect((await peek($)).pointer.node).toBeUndefined()
})
