// session.ts 세션 테이블 창구 단위 테스트(훅 경유 + peek probe).
import { expect, test } from 'claude-code/testing'
import { boot, start, call, bash, turnStart, turnDone, run, nodeIds } from './harness'
import { OPTS, peek } from './peek'

const addId = async ($: any, store: any, title: string): Promise<string> => {
  const before = new Set(nodeIds(store))
  await call($, 'add_problem', { title })
  return nodeIds(store).find(id => !before.has(id))!
}

// ---------- S1 ----------
test('ensureSession: 새 세션에서 turn.sid가 서고 4테이블이 빈다', OPTS, async ($, on) => {
  boot(on)
  await start($)
  const s = await peek($)
  expect(s.turn.sid).toBe('s1')
  expect(s.turn.mainTurnId).toBeUndefined()
  expect(s.pointer.node).toBeUndefined()
  expect(s.agentBind.map).toEqual({})
  expect(s.runningTasks.map).toEqual({})
})

// ---------- S2 ----------
test('taskProvisional: 같은 작업 id 재upsert는 기존 node를 유지한다', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const x = await addId($, store, 'X')
  const y = await addId($, store, 'Y')
  await turnStart($)
  await call($, 'focus_problem', { nodeId: x })
  await bash($, { __bg: 'btX' }) // btX → node X
  expect((await peek($)).runningTasks.map['btX'].node).toBe(x)
  await call($, 'focus_problem', { nodeId: y }) // 포인터 Y로
  await bash($, { __bg: 'btX' }) // 같은 id 재등장 → 기존 node(X) 유지
  expect((await peek($)).runningTasks.map['btX'].node).toBe(x)
})

// ---------- S3 ----------
test('clearPointer: pointer 노드를 rm 하면 pointer가 비워진다', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const x = await addId($, store, 'X')
  await call($, 'focus_problem', { nodeId: x })
  expect((await peek($)).pointer.node).toBe(x)
  await run($, `rm ${x}`)
  expect((await peek($)).pointer.node).toBeUndefined()
})

// ---------- S4 ----------
test('turnStart/turnEnd: mainTurnId는 서고/지워지고 cutoffAt은 유지된다', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  await clock.advance(1000)
  await turnStart($, 'tA')
  let s = await peek($)
  expect(s.turn.mainTurnId).toBe('tA')
  const cutoff = s.turn.cutoffAt
  await turnDone($, 'tA')
  s = await peek($)
  expect(s.turn.mainTurnId).toBeUndefined() // 턴 끝 → 비움
  expect(s.turn.cutoffAt).toBe(cutoff) // cutoff 유지
})
