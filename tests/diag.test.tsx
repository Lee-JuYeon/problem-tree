// 진단 로그(diag:<sid>) — 불 동작 불변, 기록만 검증.
import { expect, test } from 'claude-code/testing'
import { boot, start, call, turnStart, turnDone, nodeIds, nodeOf, T0, DAY } from './harness'
import { OPTS, peek } from './peek'

const diag = (store: any, sid = 's1'): any[] => (store.map.get(`diag:${sid}`) as any[]) ?? []
const addId = async ($: any, store: any, title: string): Promise<string> => {
  const before = new Set(nodeIds(store))
  await call($, 'add_problem', { title })
  return nodeIds(store).find(id => !before.has(id))!
}
const evs = (store: any, ev: string, sid = 's1') => diag(store, sid).filter(d => d.ev === ev)

// ---------- D1 ----------
test('D1: 메인 turn.start→complete는 항목 2건(before/after/match)', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  const base = diag(store).length // sstart 1건
  const setsBefore = store.sets.length
  await turnStart($, 't1')
  // 메인 turn.start 1회당 추가 저장소 쓰기 정확히 1건(diag)
  expect(store.sets.slice(setsBefore).map((x: any) => x.key)).toEqual(['diag:s1'])
  const mid = store.sets.length
  await turnDone($, 't1')
  expect(store.sets.slice(mid).map((x: any) => x.key)).toEqual(['diag:s1'])
  const d = diag(store).slice(base)
  expect(d.length).toBe(2)
  expect(d[0]).toMatchObject({ ev: 'start', turnId: 't1', after: 't1' })
  expect('before' in d[0]).toBe(false)
  expect(d[1]).toMatchObject({ ev: 'complete', turnId: 't1', before: 't1', match: true, note: 'answer' })
  expect('after' in d[1]).toBe(false)
  expect(d[0].at).toBe(T0)
})

// ---------- D2 ----------
test('D2: 51턴 돌리면 길이 50, 가장 오래된 것이 빠진다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  expect(diag(store).map(d => d.ev)).toEqual(['reset', 'sstart'])
  for (let i = 0; i < 51; i++) await turnStart($, `t${i}`)
  const d = diag(store)
  expect(d.length).toBe(50)
  expect(d[0]).toMatchObject({ ev: 'start', turnId: 't1' }) // reset·sstart·t0 빠짐
  expect(d[49]).toMatchObject({ ev: 'start', turnId: 't50' })
})

// ---------- D3 ----------
test('D3: 에이전트 turn.start/complete도 기록되고 메인 플래그는 불변(before===after)', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  await turnStart($, 'tM')
  const base = diag(store).length
  await turnStart($, 'ag-t', 'agX')
  await turnDone($, 'ag-t', 'agX')
  const d = diag(store).slice(base)
  expect(d.length).toBe(2)
  expect(d[0]).toMatchObject({ ev: 'start', turnId: 'ag-t', agentId: 'agX', before: 'tM', after: 'tM' })
  expect(d[1]).toMatchObject({ ev: 'complete', turnId: 'ag-t', agentId: 'agX', before: 'tM', after: 'tM', match: false })
  expect((await peek($)).turn.mainTurnId).toBe('tM')
})

// ---------- D4 ----------
test('D4(현 동작 문서화): 어긋난 메인 complete(t1)가 진행 중인 t2의 mainTurnId를 지운다 — match:false로 기록', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  await turnStart($, 't2')
  const base = diag(store).length
  await turnDone($, 't1')
  const d = diag(store).slice(base)
  expect(d.length).toBe(1)
  expect(d[0]).toMatchObject({ ev: 'complete', turnId: 't1', before: 't2', match: false })
  expect('after' in d[0]).toBe(false)
  expect((await peek($)).turn.mainTurnId).toBeUndefined() // 결함①: 실제로 지워짐
})

// ---------- D5 ----------
// 목 엔진은 같은 훅 안에서 다른 훅을 끼우지 못하므로(onKeys 안에서 쏜 호출은 그 훅이 끝난 뒤 돈다),
// 하네스 store.keysGate(비동기 게이트)로 list_problems의 loadNodesRaw(keys)를 붙잡아 두고,
// Promise.all로 병렬 실행한 focus_problem의 patchNode가 노드 행을 쓴 뒤에야 풀어 준다.
// → loadTree의 읽기 시작(g0) 후·writeCache 전에 patchSeq가 바뀌는 실제 덮어쓰기 조건.
test('D5: loadTree 읽기 도중 patchNode가 끼면 clobber 1건', async ($, on) => {
  const { store } = boot(on)
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  await start($)
  const x = await addId($, store, 'X')
  expect(evs(store, 'clobber').length).toBe(0)
  store.onSet = (k: string) => {
    if (k.startsWith('node:')) release()
  }
  store.keysGate = () => {
    store.keysGate = undefined // 첫 keys(list의 loadTree)만 붙잡는다
    return gate
  }
  await Promise.all([call($, 'list_problems', {}), call($, 'focus_problem', { nodeId: x })])
  store.onSet = undefined
  const c = evs(store, 'clobber')
  expect(c.length).toBe(1)
  expect(c[0].note).toMatch(/^seq \d+→\d+$/)
})

// ---------- D6 ----------
test('D6: diag 쓰기가 throw해도 훅은 정상, 다음 patchNode도 동작(큐 오염 없음)', OPTS, async ($, on) => {
  const b = boot(on)
  const { store } = b
  await start($)
  const x = await addId($, store, 'X')
  store.onSet = (key: string) => {
    if (key.startsWith('diag:')) throw new Error('diag boom')
  }
  expect(await turnStart($, 't1')).toEqual({ turnId: 't1' })
  expect((await peek($)).turn.mainTurnId).toBe('t1')
  const r = await call($, 'focus_problem', { nodeId: x })
  expect(String(r.result)).not.toMatch(/없는 노드|오류|error/i)
  expect((await peek($)).pointer.node).toBe(x)
  await turnDone($, 't1')
  expect((await peek($)).turn.mainTurnId).toBeUndefined()
  await call($, 'rename_problem', { nodeId: x, title: 'Y' })
  expect(nodeOf(store, x).title).toBe('Y')
  // ensureSession 리셋 진단(호출부가 그 뒤 본 처리를 계속하는 지점)이 실패해도 turnStart가 이어진다.
  // (목 엔진은 핸들러 예외를 삼켜 결과로는 안 보이므로, 예외 뒤의 본 처리 유무로 확인한다.)
  b.setSid('s2')
  await turnStart($, 't2')
  const s = await peek($)
  expect(s.turn.sid).toBe('s2')
  expect(s.turn.mainTurnId).toBe('t2')
  expect(store.map.has('diag:s2')).toBe(false) // 실제로 diag 쓰기가 실패했음
})

// ---------- D7 ----------
test('D7: sid 교체 뒤 첫 훅은 diag:s2에 reset, start 재호출은 sstart', async ($, on) => {
  const b = boot(on)
  await start($)
  expect(evs(b.store, 'sstart').length).toBe(1)
  b.setSid('s2')
  await turnStart($, 't9')
  const r = evs(b.store, 'reset', 's2')
  expect(r.length).toBe(1)
  expect(r[0].note).toBe('s1→s2')
  await start($)
  const ss = evs(b.store, 'sstart', 's2')
  expect(ss.length).toBe(1)
  expect(ss[0].before).toBe('t9')
})

// ---------- D8 ----------
test('D8: diagGc — 8일 전 diag:old 삭제, 1일 전 유지, 자기 키 유지', async ($, on) => {
  const { store } = boot(on, {
    'diag:old': [{ at: T0 - 8 * DAY, ev: 'start' }],
    'diag:recent': [{ at: T0 - 1 * DAY, ev: 'start' }],
    'diag:s1': [{ at: T0 - 30 * DAY, ev: 'start' }],
    'diag:bad': 'x',
  })
  await start($)
  expect(store.map.has('diag:old')).toBe(false)
  expect(store.map.has('diag:bad')).toBe(false)
  expect(store.map.has('diag:recent')).toBe(true)
  expect(store.map.has('diag:s1')).toBe(true)
  expect(diag(store).map(d => d.ev)).toEqual(['start', 'reset', 'sstart']) // 옛 1건 + reset + sstart
})
