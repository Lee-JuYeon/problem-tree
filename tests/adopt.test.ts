// adopt: 설치 식별자(store 파일)가 바뀌어도 노드가 고아가 되지 않는다.
// 재현: 옛 식별자 store 파일(skills-dir)에 노드가 있고, 새 식별자 store(자기 $.store)는 비어 있다.
import { expect, test } from 'claude-code/testing'
import { boot, start, call, run, nk, nodeOf, nodeIds, ROOT, T0, DAY } from './harness'

const OLD = 'problem-tree_skills-dir-a8b1b87c1491.json'
const DIR = '/home/u/.claude/plugins/store'
const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, status: 'open', createdAt: T0 - 10 * DAY, touchedAt: T0 - DAY, reopenCount: 0, history: [], ...extra,
})
const HOUR = 3_600_000
const file = (obj: Record<string, unknown>, mtimeMs = 1) => ({ text: JSON.stringify(obj), mtimeMs })

test('A1(재현): 빈 새 store로 떠도 옛 식별자 store의 노드가 보인다', async ($, on) => {
  const { store } = boot(on)
  store.files[OLD] = file({
    schema: 2,
    [nk('aaaa')]: row('aaaa', '옛노드A'),
    [nk('bbbb')]: row('bbbb', '옛노드B', { parent: 'aaaa' }),
    [`node:/other:cccc`]: row('cccc', '다른트리'),
    'diag:zzz': [{ at: 1, ev: 'start' }],
    'tree:/legacy': { version: 1, nodes: {} },
    'tree:/junk': 'not-v1',
    [`link:/x`]: '/y',
  })
  await start($)
  expect(store.fsLists).toEqual([DIR])
  expect(nodeIds(store).sort()).toEqual(['aaaa', 'bbbb'])
  expect(store.map.has('node:/other:cccc')).toBe(true) // 다른 트리 노드도 함께 옮겨진다
  expect(store.map.get('link:/x')).toBe('/y')
  expect(store.map.has('diag:zzz')).toBe(false) // 진단은 안 옮김
  expect(store.map.has('tree:/legacy')).toBe(true) // 미이관 레거시 트리는 통째로(그 root에서 열리면 migrate가 변환)
  expect(store.map.has('tree:/junk')).toBe(false)
  const r = await call($, 'list_problems', {})
  expect(String(r.result)).toContain('옛노드A')
  expect(String(r.result)).toContain('옛노드B')
  expect(store.toasts.filter(t => t.includes('가져왔습니다'))).toEqual([
    `문제트리: 다른 설치의 store에서 5행을 가져왔습니다 (${OLD})`, // node 3 + link 1 + 레거시 tree 1
  ])
})

test('A2: 같은 id는 행 버전이 더 새 쪽이 이긴다(옛 것이 새 것을 덮지 않음)', async ($, on) => {
  const { store } = boot(on, {
    [nk('aaaa')]: row('aaaa', '내것-최신', { touchedAt: T0 }),
    [nk('bbbb')]: row('bbbb', '내것-낡음', { touchedAt: T0 - 5 * DAY }),
  })
  store.files[OLD] = file({
    [nk('aaaa')]: row('aaaa', '옛것', { touchedAt: T0 - DAY }),
    [nk('bbbb')]: row('bbbb', '형제가-더새것', { touchedAt: T0 - DAY, status: 'resolved', resolvedAt: T0 - DAY }),
  })
  await start($)
  expect(nodeOf(store, 'aaaa').title).toBe('내것-최신')
  expect(nodeOf(store, 'bbbb').title).toBe('형제가-더새것')
  expect(nodeOf(store, 'bbbb').status).toBe('resolved')
})

test('A3: 지문(size·mtime)이 같으면 다시 읽지 않고, 바뀌면 다시 흡수한다', async ($, on) => {
  const { store } = boot(on)
  store.files[OLD] = file({ [nk('aaaa')]: row('aaaa', 'A') })
  await start($)
  expect(store.fsReads.length).toBe(1)
  // GC 등으로 자기 store에서 지워진 행이, 안 바뀐 옛 파일에서 부활하지 않는다.
  store.map.delete(nk('aaaa'))
  await start($)
  expect(store.fsReads.length).toBe(1)
  expect(nodeIds(store)).toEqual([])
  // 옛 파일이 바뀌면(다른 프로세스가 거기에 씀) 다시 읽는다.
  store.files[OLD] = file({ [nk('aaaa')]: row('aaaa', 'A'), [nk('dddd')]: row('dddd', 'D', { createdAt: T0 - HOUR, touchedAt: T0 - HOUR }) }, 2)
  await start($)
  expect(store.fsReads.length).toBe(2)
  // 새로 생긴 행(dddd)만 온다. 내가 지운 aaaa는 지난번에 이미 본 행이라, 옛 파일이 바뀌어도 부활하지 않는다.
  expect(nodeIds(store)).toEqual(['dddd'])
})

test('A4: 못 읽는 store(깨진 JSON·4MiB 초과)는 조용히 넘기지 않고 알린다 — 세션 시작은 계속', async ($, on) => {
  const { store } = boot(on)
  store.files['problem-tree_inline-1.json'] = { text: '{broken' }
  store.files['problem-tree_big-2.json'] = { text: '{}', size: 5 * 1024 * 1024 }
  store.files[OLD] = file({ [nk('aaaa')]: row('aaaa', 'A') })
  await start($)
  expect(nodeIds(store)).toEqual(['aaaa'])
  const warn = store.toasts.find(t => t.includes('읽지 못한'))!
  expect(warn).toContain('problem-tree_inline-1.json')
  expect(warn).toContain('problem-tree_big-2.json')
  expect(store.fsReads.some(p => p.includes('big-2'))).toBe(false) // 큰 파일은 읽기 시도조차 안 함
})

test('A5(신뢰경계): 이름이 store 패턴이 아닌 파일·형식이 틀린 행은 무시한다', async ($, on) => {
  const { store } = boot(on)
  store.files['problem-tree_x.json.bak_1'] = file({ [nk('bak1')]: row('bak1', 'BAK') })
  store.files['other-plugin_a-1.json'] = file({ [nk('oth1')]: row('oth1', 'OTHER') })
  store.files['problem-tree_..%2F..%2Fetc.json.tmp.1'] = file({ [nk('tmp1')]: row('tmp1', 'TMP') })
  store.files[OLD] = file({
    [nk('nohi')]: { id: 'nohi', title: 'x', status: 'open' }, // history 없음
    [nk('bads')]: row('bads', 'x', { status: 'weird' }),
    [nk('misk')]: row('other-id', 'x'), // 키와 id 불일치
    [nk('strv')]: 'string',
    [`link:/n`]: 42,
    [nk('good')]: row('good', 'GOOD'), // 틀린 행들 뒤에 있어도 흡수된다(앞 행이 흡수를 중단시키지 않음)
  })
  await start($)
  expect(nodeIds(store)).toEqual(['good'])
  expect(store.map.has('link:/n')).toBe(false)
  expect(store.fsReads.length).toBe(1)
})

test('A6: 형제 store가 없거나 fs가 막혀도 세션 시작·기존 노드는 그대로', async ($, on) => {
  const { store } = boot(on, { [nk('mine')]: row('mine', 'MINE') })
  store.fsFail = true
  await start($)
  expect(nodeIds(store)).toEqual(['mine'])
  const r = await call($, 'list_problems', {})
  expect(String(r.result)).toContain('MINE')
})

test('A7: 자기 store 파일(store:id 같음)은 흡수 대상이 아니다 — 쓰기 0', async ($, on) => {
  const { store } = boot(on, { 'store:id': 'me', [nk('mine')]: row('mine', 'MINE') })
  // 디스크의 자기 파일이 메모리보다 살짝 낡은 사본이어도(더 새 touchedAt 행 포함) 건드리지 않는다.
  store.files['problem-tree_leejuyeon-1.json'] = file({ 'store:id': 'me', [nk('mine')]: row('mine', 'DISK', { touchedAt: T0 }) })
  await start($)
  expect(nodeOf(store, 'mine').title).toBe('MINE')
  expect(store.sets.some(x => x.key.startsWith('node:') || x.key.startsWith('adopt:'))).toBe(false)
  expect(store.map.get('store:id')).toBe('me')
})

test('A8: store:id가 없으면 한 번 만들고, 다음 시작에서 그대로 쓴다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  const id = store.map.get('store:id')
  expect(typeof id).toBe('string')
  await start($)
  expect(store.map.get('store:id')).toBe(id)
})

test('A9: 지난번에 본 행은 다시 견주지 않는다 — 옛 파일이 바뀌면 새로 바뀐 행만 get', async ($, on) => {
  const { store } = boot(on)
  const rows: Record<string, unknown> = {}
  for (let i = 0; i < 30; i++) rows[nk(`r${i}`)] = row(`r${i}`, `R${i}`)
  store.files[OLD] = file(rows)
  await start($)
  expect(nodeIds(store).length).toBe(30)
  store.files[OLD] = file({ ...rows, [nk('r3')]: row('r3', 'R3-새제목', { touchedAt: T0 - 10 }), [nk('new1')]: row('new1', 'NEW', { createdAt: T0 - 5, touchedAt: T0 - 5 }) }, 2)
  const before = store.sets.length
  store.gets.length = 0
  await start($)
  // 흡수는 session.start의 첫 단계: 바뀐 기존 행(r3) 1개만 견주고, 그 다음 get은 gc/loadTree의 전체 읽기(r0부터)다.
  expect(store.gets.filter(k => k.startsWith('node:')).slice(0, 2)).toEqual([nk('r3'), nk('r0')])
  const adoptSets = store.sets.slice(before).filter(x => x.key.startsWith('node:')).map(x => x.key).sort()
  expect(adoptSets).toEqual([nk('new1'), nk('r3')])
  expect(nodeOf(store, 'r3').title).toBe('R3-새제목')
  expect(store.map.get(`adopt:${OLD}`)).toMatchObject({ ver: T0 - 5 })
})

// ---------- 형제 store가 계속 바뀌는 상황(두 식별자가 번갈아 뜸)에서의 병합 ----------
// 전제: touchedAt은 "행의 버전"이 아니다(rm·move·자식 승격은 안 올린다). 병합은 행 버전(modAt 등)으로 한다.

const sibling = (store: any, rows: Record<string, unknown>, mtimeMs: number) => {
  store.files[OLD] = file(rows, mtimeMs)
}

test('B1: 내가 지운(rm) 노드는 형제의 더 이른 수정으로 부활하지 않는다', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A') }, 1)
  await start($)
  await bt.clock.advance(HOUR)
  await run($, 'rm aaaa')
  expect(nodeOf(store, 'aaaa').status).toBe('removed')
  expect(nodeOf(store, 'aaaa').touchedAt).toBe(T0 - DAY) // rm은 touchedAt을 안 올린다(= 버전으로 못 쓴다)
  // 형제에서는 그 사이(내 rm보다 이른 시각)에 focus만 했다 — touchedAt은 내 것보다 새롭다.
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A', { touchedAt: T0 + 60_000, startedAt: T0 + 60_000, modAt: T0 + 60_000 }) }, 2)
  await start($)
  expect(nodeOf(store, 'aaaa').status).toBe('removed')
})

test('B2: 형제에서 지운 노드(묘비)는 내 쪽에도 전파된다 — modAt 없는 옛 행도(history·removedAt로 판정)', async ($, on) => {
  const { store } = boot(on, { [nk('aaaa')]: row('aaaa', 'A'), [nk('bbbb')]: row('bbbb', 'B') })
  sibling(store, {
    [nk('aaaa')]: row('aaaa', 'A', { status: 'removed', removedAt: T0 - HOUR, modAt: T0 - HOUR }),
    [nk('bbbb')]: row('bbbb', 'B', { status: 'removed', removedAt: T0 - HOUR, history: [{ at: T0 - HOUR, event: 'remove', by: 'user' }] }),
  }, 1)
  await start($)
  expect(nodeOf(store, 'aaaa').status).toBe('removed')
  expect(nodeOf(store, 'bbbb').status).toBe('removed')
})

test('B3: 내가 옮긴(move) 노드는 형제의 옛 부모로 되돌아가지 않고, 형제의 이동은 전파된다', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  const rows = { [nk('pppp')]: row('pppp', 'P'), [nk('qqqq')]: row('qqqq', 'Q'), [nk('cccc')]: row('cccc', 'C', { parent: 'pppp' }), [nk('dddd')]: row('dddd', 'D', { parent: 'pppp' }) }
  sibling(store, rows, 1)
  await start($)
  await bt.clock.advance(HOUR)
  await call($, 'move_problem', { nodeId: 'cccc' }) // 루트로
  expect(nodeOf(store, 'cccc').parent).toBeUndefined()
  sibling(store, {
    ...rows,
    [nk('cccc')]: row('cccc', 'C', { parent: 'pppp', touchedAt: T0 + 60_000, modAt: T0 + 60_000 }), // 내 이동보다 이른 수정
    [nk('dddd')]: row('dddd', 'D', { parent: 'qqqq', modAt: T0 + 2 * HOUR - 1 }), // 형제에서 옮김(touchedAt 그대로)
  }, 2)
  await bt.clock.advance(HOUR)
  await start($)
  expect(nodeOf(store, 'cccc').parent).toBeUndefined()
  expect(nodeOf(store, 'dddd').parent).toBe('qqqq')
})

test('B4: unlink한 연결은 형제 파일이 바뀌어도 되살아나지 않는다(묘비)', async ($, on) => {
  const { store } = boot(on)
  sibling(store, { [`link:${ROOT}`]: '/shared' }, 1)
  await start($)
  expect(store.map.get(`link:${ROOT}`)).toBe('/shared')
  expect(String(((await run($, 'unlink')) as any).text)).toBe('unlink')
  expect(store.map.get(`link:${ROOT}`)).toBe(false)
  sibling(store, { [`link:${ROOT}`]: '/shared', [nk('zzzz')]: row('zzzz', 'Z') }, 2)
  await start($)
  expect(store.map.get(`link:${ROOT}`)).toBe(false)
  // 묘비는 "연결 없음"과 같다: 다시 link 할 수 있다(트리가 비어 있을 때).
  store.map.delete(nk('zzzz'))
  expect(String(((await run($, 'link /other')) as any).text)).toBe('link → /other')
})

test('B5: 지운 적 없는 root의 unlink는 아무것도 안 쓴다', async ($, on) => {
  const { store } = boot(on)
  await start($)
  const before = store.sets.length
  await run($, 'unlink')
  expect(store.sets.slice(before).filter(x => x.key.startsWith('link:'))).toEqual([])
  expect(store.map.has(`link:${ROOT}`)).toBe(false)
})

test('B6: 같은 id의 다른 노드(따로 만들어짐)는 덮지 않고 알린다', async ($, on) => {
  const { store } = boot(on, { [nk('aaaa')]: row('aaaa', '내 새 노드', { createdAt: T0 - HOUR, touchedAt: T0 - HOUR }) })
  sibling(store, { [nk('aaaa')]: row('aaaa', '형제의 다른 노드', { createdAt: T0 - 2 * HOUR, touchedAt: T0 - 60_000, modAt: T0 - 60_000 }) }, 1)
  await start($)
  expect(nodeOf(store, 'aaaa').title).toBe('내 새 노드')
  expect(store.toasts.some(t => t.includes('같은 id의 다른 노드') && t.includes('aaaa'))).toBe(true)
})

test('B7: 흡수 도중 쓰기가 거부되면(4 MiB 상한) 조용히 멈추지 않고 알리며, 지문을 안 남겨 다음에 다시 한다', async ($, on) => {
  const { store } = boot(on)
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A'), [nk('bbbb')]: row('bbbb', 'B') }, 1)
  store.onSet = (k: string) => {
    if (k === nk('bbbb')) throw new Error('store would be over 4 MiB')
  }
  await start($)
  expect(store.toasts.some(t => t.includes('읽지 못한') && t.includes(OLD))).toBe(true)
  expect(store.map.has(`adopt:${OLD}`)).toBe(false)
  store.onSet = undefined
  await start($)
  expect(nodeIds(store).sort()).toEqual(['aaaa', 'bbbb'])
  expect(store.map.has(`adopt:${OLD}`)).toBe(true)
})

test('B8: 미래 시각이 찍힌 행 하나가 워터마크를 망가뜨리지 않는다 — 이후 형제의 정상 수정이 반영된다', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A'), [nk('ffff')]: row('ffff', 'F', { touchedAt: T0 + 365 * DAY }) }, 1)
  await start($)
  await bt.clock.advance(HOUR)
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A-수정', { touchedAt: T0 + 60_000, modAt: T0 + 60_000 }), [nk('ffff')]: row('ffff', 'F', { touchedAt: T0 + 365 * DAY }) }, 2)
  await start($)
  expect(nodeOf(store, 'aaaa').title).toBe('A-수정')
})

test('B9: 모든 쓰기가 행 버전(modAt)을 올린다 — rm·move·자식 승격 포함', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  await start($)
  await call($, 'add_problem', { title: '부모' })
  const p = nodeIds(store)[0]!
  await call($, 'add_problem', { title: '자식', parentId: p })
  const c = nodeIds(store).find(id => id !== p)!
  expect(nodeOf(store, p).modAt).toBe(T0)
  const ver = () => [nodeOf(store, p).modAt, nodeOf(store, c).modAt]
  let [vp, vc] = ver()
  await call($, 'move_problem', { nodeId: c }) // 같은 시각이어도 +1
  expect(nodeOf(store, c).modAt).toBeGreaterThan(vc)
  await call($, 'move_problem', { nodeId: c, newParentId: p })
  ;[vp, vc] = ver()
  await bt.clock.advance(1000)
  await run($, `rm ${p}`) // 부모 삭제 + 자식 승격
  expect(nodeOf(store, p).modAt).toBeGreaterThan(vp)
  expect(nodeOf(store, c).modAt).toBeGreaterThan(vc)
  expect(nodeOf(store, c).parent).toBeUndefined()
})

test('B10: modAt 없는 옛 행의 이동은 history 시각으로 판정된다(touchedAt·removedAt 변화 없음)', async ($, on) => {
  const { store } = boot(on, { [nk('pppp')]: row('pppp', 'P'), [nk('cccc')]: row('cccc', 'C', { parent: 'pppp' }) })
  sibling(store, {
    [nk('pppp')]: row('pppp', 'P'),
    [nk('cccc')]: row('cccc', 'C', { history: [{ at: T0 - HOUR, event: 'move', by: 'user' }] }), // 루트로 옮겨짐
  }, 1)
  await start($)
  expect(nodeOf(store, 'cccc').parent).toBeUndefined()
})
