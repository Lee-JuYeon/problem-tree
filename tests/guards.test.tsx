// (f) guards 26~31 — 아키텍처 불변식.
// 소스 정적검사는 실기기 fs가 테스트 런타임에 없어, 컴파일된 함수 본문(toString)으로 본다.
import { expect, test } from 'claude-code/testing'
import { boot, start, run, call, bash, spawnAgent, stop, turnStart, turnDone, nodeIds, nodeOf, mountPane, FRAME_MS } from './harness'
import { OPTS, peek } from './peek'
import { register } from '../hooks/register'
import * as registerMod from '../hooks/register'
import { readCache } from '../hooks/lib/store'
import * as opsMod from '../hooks/lib/ops'
import * as sessMod from '../hooks/lib/session'
import * as viewMod from '../hooks/lib/view'
import * as storeMod from '../hooks/lib/store'
import * as toolsMod from '../hooks/lib/tools'
import * as commandMod from '../hooks/lib/command'
import * as paneMod from '../hooks/pane'

const srcOf = (mod: Record<string, unknown>) =>
  Object.values(mod).filter(f => typeof f === 'function').map(f => (f as Function).toString()).join('\n')
const addId = async ($: any, store: any, title: string): Promise<string> => {
  const before = new Set(nodeIds(store))
  await call($, 'add_problem', { title })
  return nodeIds(store).find(id => !before.has(id))!
}

// ---------- 26 (가) ----------
// register.tsx의 비export 헬퍼(bgTask 등)까지 toString으로 본다. Function.toString()은 register
// 함수 본문만 주므로 모듈 헬퍼는 __guardInternals로 노출해 함께 검사한다(실기기 fs가 테스트 런타임에
// 없어 파일 전체 텍스트를 못 읽는 데 따른 대안 — register 내부 헬퍼의 $.store.set 주입까지 잡는다).
test('가: $.store.set/delete·nodesAtom은 store.ts 밖에 없다(register 내부 헬퍼 포함)', () => {
  const internals = (registerMod as any).__guardInternals ?? {}
  // ⚠ register.tsx에 비export 헬퍼를 새로 추가하면 반드시 __guardInternals 목록에도 올려라.
  //   목록 밖 헬퍼 본문엔 toString 검사가 닿지 않아 그 안의 $.store.set/delete 주입을 못 잡는다(가 가드 구멍).
  //   이 수 단언이 틀어지면(헬퍼를 추가·삭제했으면) 목록을 맞추고 이 숫자도 함께 고친다.
  expect(Object.keys(internals).length).toBe(5)
  const regInternals = Object.values(internals)
    .map((f: any) => String(f))
    .join('\n')
  // 검사가 헛돌지 않음을 보장: register 내부 헬퍼 본문이 실제로 잡혔다(bgTask가 taskProvisional 호출).
  expect(regInternals.includes('taskProvisional')).toBe(true)
  // store.ts를 뺀 모든 모듈.
  const external = [
    register.toString(), regInternals, srcOf(opsMod), srcOf(sessMod), srcOf(viewMod),
    srcOf(toolsMod), srcOf(commandMod), srcOf(paneMod),
  ].join('\n')
  expect(external.includes('linkCmd') || external.includes('setLink')).toBe(true) // command 본문이 실제로 잡혔다
  expect(external.includes('hiddenSet')).toBe(true) // pane 본문이 실제로 잡혔다
  expect(external.includes('alsoResolves')).toBe(true) // tools(runTool) 본문이 실제로 잡혔다
  for (const token of ['.store.set', '.store.delete', 'nodesAtom']) {
    expect(external.includes(token), `외부에 ${token} 발견`).toBe(false)
  }
  // store.ts에는 있어야(검사가 헛돌지 않음을 보장)
  const inStore = srcOf(storeMod)
  expect(inStore.includes('.store.set')).toBe(true)
  expect(inStore.includes('.store.delete')).toBe(true)
})

// ---------- 27 (나) ----------
// readCache는 복제를 반환하므로(렌더가 그 복제를 만져도) 캐시가 오염되지 않는다.
// 테스트 런타임에서 $를 다른 플러그인 함수에 넘길 수 없어(정적 스캔), 두 갈래로 본다:
//  ① 정적: readCache가 clone을 거쳐 반환한다. ② 행동: 렌더를 반복해도 캐시가 그대로다.
test('나: readCache는 복제를 반환하고, 렌더 반복이 캐시를 오염시키지 않는다', OPTS, async ($, on) => {
  expect(readCache.toString().includes('clone')).toBe(true) // ①
  const b = boot(on)
  await start($)
  await addId($, b.store, 'X')
  const before = JSON.stringify((await peek($)).nodes)
  const ui = await mountPane($)
  for (let i = 0; i < 20; i++) await ui.redraw()
  await ui.unmount()
  expect(JSON.stringify((await peek($)).nodes)).toBe(before) // ②
})

// ---------- 28 (라) ----------
test('라: session.id가 바뀌면 첫 훅에서 4테이블이 비고 옛 pointer로 불이 안 켜진다', OPTS, async ($, on) => {
  const b = boot(on)
  await start($)
  const x = await addId($, b.store, 'X')
  await call($, 'focus_problem', { nodeId: x })
  expect((await peek($)).pointer.node).toBe(x)
  // /clear 모사: 세션 교체
  b.setSid('s2')
  await turnStart($) // 첫 훅 → ensureSession이 리셋
  const s = await peek($)
  expect(s.turn.sid).toBe('s2')
  expect(s.pointer.sid).toBe('s2')
  expect(s.pointer.node).toBeUndefined() // 옛 pointer 사라짐
  // 목록에서도 X가 current로 뜨지 않음
  const text = (await call($, 'list_problems', {})).result as string
  expect(text.includes('[current]')).toBe(false)
})

// ---------- 29 (마) ----------
test('마: 렌더 반복·타이머에서 영속/세션 쓰기 0', OPTS, async ($, on) => {
  const b = boot(on)
  await start($)
  const x = await addId($, b.store, 'X')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: x }) // 메인·애니메이션 타이머 켜짐
  const setsBefore = b.store.sets.length
  const stateBefore = b.store.stateSets
  const ui = await mountPane($)
  for (let i = 0; i < 100; i++) {
    await b.clock.advance(FRAME_MS)
    await ui.redraw()
  }
  await b.clock.advance(3_600_000) // 1시간 주기 invalidate
  await ui.redraw()
  await ui.unmount()
  expect(b.store.sets.length - setsBefore).toBe(0)
  expect(b.store.stateSets - stateBefore).toBe(0)
})

// ---------- 30 (마) ----------
// (c) 동기화표의 전 이벤트가 정확히 명시된 세션 테이블만 건드리는지 검사한다.
test('마: 이벤트별 세션 쓰기 테이블이 (c)와 일치(전 이벤트)', OPTS, async ($, on) => {
  const b = boot(on)
  // 세션 atom 쓰기 + 진단 로그 영속쓰기(store `diag:<sid>` → 'store:diag')를 함께 센다.
  const writesOf = async (fn: () => Promise<unknown>): Promise<string[]> => {
    b.store.stateWrites.length = 0
    const s0 = b.store.sets.length
    await fn()
    const diag = b.store.sets.slice(s0).some(x => x.key.startsWith('diag:')) ? ['store:diag'] : []
    return [...new Set([...b.store.stateWrites, ...diag])].sort()
  }
  const eq = (got: string[], want: string[]) => expect(got).toEqual([...want].sort())

  // session.start(새 sid) → resetAll(turn·pointer·agentBind·runningTasks) + nodes(migrate/gc/loadTree) + 진단(reset·sstart)
  eq(await writesOf(() => start($)), ['agentBind', 'nodes', 'pointer', 'runningTasks', 'store:diag', 'turn'])

  const x = await addId($, b.store, 'X')
  // 메인 turn.start → turn(replace) + nodes(loadTree) + 진단(start)
  eq(await writesOf(() => turnStart($, 'tA')), ['nodes', 'store:diag', 'turn'])
  // focus_problem → pointer + nodes(patch)
  eq(await writesOf(() => call($, 'focus_problem', { nodeId: x })), ['nodes', 'pointer'])
  // add_problem(claude) → nodes만(포인터 안 건드림)
  eq(await writesOf(() => call($, 'add_problem', { title: 'Y' })), ['nodes'])
  // 사용자 add(/ptree add) → pointer(focus 이동) + nodes
  eq(await writesOf(() => run($, 'add 사용자Z')), ['nodes', 'pointer'])
  // 백그라운드 tool.call(Bash) → runningTasks
  eq(await writesOf(() => bash($, { __bg: 'bg1' })), ['runningTasks'])
  // agent.spawn(background) → agentBind + runningTasks
  eq(await writesOf(() => spawnAgent($, { background: true, __id: 'agS' })), ['agentBind', 'runningTasks'])
  // 에이전트 turn.start → 진단(start)만(세션 테이블 불변)
  eq(await writesOf(() => turnStart($, 'agturn', 'agS')), ['store:diag'])
  // 에이전트 turn.complete → runningTasks(taskDrop) + 진단(complete)
  eq(await writesOf(() => turnDone($, 'agturn', 'agS')), ['runningTasks', 'store:diag'])
  // classic.Stop → runningTasks(통째 replace)
  eq(await writesOf(() => stop($, [{ id: 'bg1', type: 'shell', status: 'running', description: 'x' }])), ['runningTasks'])
  // reopen → nodes(patch) + pointer(set)  [먼저 resolve해 둠]
  await call($, 'resolve_problem', { nodeId: x, reason: 'r' })
  eq(await writesOf(() => call($, 'reopen_problem', { nodeId: x, reason: 'again' })), ['nodes', 'pointer'])
  // resolve → nodes(patch) + pointer(부모 없으면 clear)  [w를 focus해 pointer=w로]
  const w = await addId($, b.store, 'W')
  await run($, `focus ${w}`)
  eq(await writesOf(() => call($, 'resolve_problem', { nodeId: w, reason: 'done' })), ['nodes', 'pointer'])
  // rm(대상=pointer) → nodes(patch) + pointer(clear)
  const v = await addId($, b.store, 'V')
  await run($, `focus ${v}`)
  eq(await writesOf(() => run($, `rm ${v}`)), ['nodes', 'pointer'])
  // 메인 turn.complete → turn + 진단(complete)
  eq(await writesOf(() => turnDone($, 'tA')), ['store:diag', 'turn'])
})

// ---------- 탐침4 (버그4): classic.Stop try/catch 구조 ----------
// classic.Stop 핸들러는 내부 예외를 삼키도록 try/catch로 감싼다(옛: try/catch 없어 Stop 블록 위험).
// 목 엔진이 이벤트 payload를 디스패치 때 복제해 payload로 핸들러-내부 예외를 주입할 수 없으므로
// (던지는 getter가 핸들러 전 복제 단계에서 터진다) 구조 검사로 try/catch 존재를 강제한다.
test('탐침4(버그4): classic.Stop 핸들러가 try/catch로 감싸져 있다(Stop 블록 금지)', () => {
  const reg = register.toString()
  const i = reg.indexOf('background_tasks') // classic.Stop 핸들러 내부의 유일 토큰
  expect(i).toBeGreaterThan(0)
  const seg = reg.slice(Math.max(0, i - 200), i + 500)
  expect(/\btry\b/.test(seg)).toBe(true)
  expect(/\bcatch\b/.test(seg)).toBe(true)
  expect(seg.includes('tasksReplace')).toBe(true) // 올바른 핸들러 확인(검사 헛돌지 않음)
  // ensureSession·tasksReplace 호출은 try { 블록 "안"(뒤)에 있어야 한다 — try 밖에서 던지면 Stop을 막을 수 있다.
  const tryPos = seg.search(/\btry\b/)
  const ensurePos = seg.indexOf('ensureSession')
  const replacePos = seg.indexOf('tasksReplace')
  expect(tryPos).toBeGreaterThanOrEqual(0)
  expect(ensurePos).toBeGreaterThan(tryPos) // ensureSession이 try 뒤
  expect(replacePos).toBeGreaterThan(tryPos) // tasksReplace가 try 뒤
})

// ---------- 31 (다) ----------
// 세션 참조(pointer)의 node 해석만 view(resolveNodeRef/resolveParentRef) 경유여야 한다.
// 노드 자체 순회(nodes[id])는 허용 — ops엔 그런 직접색인이 9곳 있고 정당하다.
test('다: 세션 포인터의 node 해석은 view 함수로만(직접 색인 0)', () => {
  const reg = register.toString()
  expect(reg.includes('nodes[')).toBe(false) // register 렌더/훅은 캐시를 직접 색인하지 않음
  expect(reg.includes('resolveNodeRef')).toBe(true) // 참조해석은 view 함수로
  const combined = reg + '\n' + srcOf(opsMod)
  // (1) 세션 포인터를 nodes[...]로 직접 풀지 않는다(노드 자체 색인 nodes[id]는 허용).
  expect(/nodes\s*\[[^\]]*pointer/.test(combined)).toBe(false)
  // (2) 포인터 해석이 실제로 view 해석기 경유로 존재한다(해석이 사라지면 깨짐).
  expect(combined.includes('pointer.node')).toBe(true)
  expect(combined.includes('resolveNodeRef')).toBe(true)
})
