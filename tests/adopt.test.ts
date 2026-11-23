// adopt: 설치 식별자(store 파일)가 바뀌어도 노드가 고아가 되지 않는다.
// 재현: 옛 식별자 store 파일(skills-dir)에 노드가 있고, 새 식별자 store(자기 $.store)는 비어 있다.
import { expect, test } from 'claude-code/testing'
import { boot, start, call, run, nk, nodeOf, nodeIds, ROOT, T0, DAY } from './harness'
import { mergeRows } from '../hooks/lib/store'

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

test('A3: 지문(size·mtime)이 같으면 다시 읽지 않고, 바뀌면 다시 본다 — 내 쪽에 없는 행은 항상 가져온다', async ($, on) => {
  const { store } = boot(on)
  store.files[OLD] = file({ [nk('aaaa')]: row('aaaa', 'A') })
  await start($)
  expect(store.fsReads.length).toBe(1)
  store.map.delete(nk('aaaa')) // (GC가 아닌 이유로) 내 쪽에서 사라짐
  await start($)
  expect(store.fsReads.length).toBe(1) // 파일이 그대로면 안 읽는다
  expect(nodeIds(store)).toEqual([])
  // 옛 파일이 바뀌면 다시 읽고, 워터마크 이하 버전이어도 내 쪽에 없는 행은 가져온다(워터마크는 get 절약용일 뿐).
  store.files[OLD] = file({ [nk('aaaa')]: row('aaaa', 'A'), [nk('dddd')]: row('dddd', 'D') }, 2)
  await start($)
  expect(store.fsReads.length).toBe(2)
  expect(nodeIds(store).sort()).toEqual(['aaaa', 'dddd'])
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

// ---------- GC 부활 방지는 워터마크가 아니라 GC 규칙 자체로 ----------

test('C1: GC 규칙상 지워질 행(30일 넘은 묘비·완료 단위)은 가져오지 않는다 — 형제가 바뀔 때마다 재흡수·재삭제·토스트 없음', async ($, on) => {
  const { store } = boot(on)
  const old = T0 - 31 * DAY
  const rows = {
    [nk('dead')]: row('dead', '묘비', { status: 'removed', removedAt: old }),
    [nk('done')]: row('done', '완료 부모', { status: 'resolved', resolvedAt: old }),
    [nk('dkid')]: row('dkid', '완료 자식', { status: 'resolved', resolvedAt: old, parent: 'done' }),
    [nk('half')]: row('half', '덜 끝난 부모', { status: 'resolved', resolvedAt: old }),
    [nk('hkid')]: row('hkid', '열린 자식', { parent: 'half' }),
    [nk('live')]: row('live', '열림'),
  }
  sibling(store, rows, 1)
  await start($)
  expect(nodeIds(store).sort()).toEqual(['half', 'hkid', 'live'])
  for (let i = 2; i < 5; i++) {
    const before = { sets: store.sets.length, dels: store.deletes.length, toasts: store.toasts.length }
    sibling(store, rows, i) // 형제 파일이 (다른 이유로) 계속 바뀜
    await start($)
    expect(store.sets.slice(before.sets).filter(x => x.key.startsWith('node:'))).toEqual([])
    expect(store.deletes.slice(before.dels).filter(k => k.startsWith('node:'))).toEqual([])
    expect(store.toasts.length).toBe(before.toasts)
  }
})

test('C2: 낡은 바탕의 뒤늦은 조작이 내 해결·삭제를 되돌리지 않는다 — 제목 같은 다른 변경은 받는다', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  const rows = { [nk('aaaa')]: row('aaaa', 'A'), [nk('bbbb')]: row('bbbb', 'B') }
  sibling(store, rows, 1)
  await start($)
  await bt.clock.advance(HOUR)
  await call($, 'resolve_problem', { nodeId: 'aaaa', reason: 'r' })
  await run($, 'rm bbbb')
  // 내 해결/삭제를 아직 못 본 형제 세션이 그 뒤에 focus·rename 했다(더 새 버전, 상태는 옛 open).
  sibling(store, {
    [nk('aaaa')]: row('aaaa', 'A-새제목', { touchedAt: T0 + 2 * HOUR, startedAt: T0 + 2 * HOUR, modAt: T0 + 2 * HOUR }),
    [nk('bbbb')]: row('bbbb', 'B', { touchedAt: T0 + 2 * HOUR, modAt: T0 + 2 * HOUR }),
  }, 2)
  await bt.clock.advance(2 * HOUR)
  await start($)
  expect(nodeOf(store, 'aaaa')).toMatchObject({ status: 'resolved', title: 'A-새제목', resolvedAt: T0 + HOUR })
  expect(nodeOf(store, 'bbbb').status).toBe('removed')
  expect(nodeOf(store, 'bbbb').removedAt).toBe(T0 + HOUR)
})

test('C3: 진짜 재개(reopenCount 증가)는 해결을 이긴다 — 버전이 더 낡은 쪽이어도', async ($, on) => {
  const { store } = boot(on, {
    [nk('aaaa')]: row('aaaa', 'A', { status: 'resolved', resolvedAt: T0 - HOUR, modAt: T0 - HOUR, reopenCount: 0 }),
  })
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A', { reopenCount: 1, modAt: T0 - 60_000, touchedAt: T0 - 60_000 }) }, 1)
  await start($)
  expect(nodeOf(store, 'aaaa')).toMatchObject({ status: 'open', reopenCount: 1 })
  expect('resolvedAt' in nodeOf(store, 'aaaa')).toBe(false)
})

test('C4: 미이관 레거시 tree:는 지문이 이미 있어도 가져오고, 이관된 뒤(그 트리의 node: 행이 있음)엔 안 가져온다', async ($, on) => {
  const { store } = boot(on)
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A') }, 1)
  await start($)
  const legacy = { version: 1, seq: 1, nodes: { n1: { id: 'n1', title: '옛', status: 'open' } } }
  sibling(store, { [nk('aaaa')]: row('aaaa', 'A'), 'tree:/elsewhere': legacy }, 2)
  await start($)
  expect(store.map.get('tree:/elsewhere')).toEqual(legacy)
  // 형제가 tree:와 그 트리의 node: 행을 함께 들고 있으면(이관 중·이관 뒤 잔재) 레거시는 안 가져온다.
  sibling(store, {
    'tree:/third': legacy,
    'node:/third:n1': row('n1', '옛', { status: 'removed', removedAt: T0 - HOUR }),
  }, 3)
  await start($)
  expect(store.map.has('tree:/third')).toBe(false)
  expect((store.map.get('node:/third:n1') as any).status).toBe('removed')
})

test('C5: createdAt이 없는 옛 행과 0으로 찍힌 행은 같은 노드로 본다(충돌 오탐 없음)', async ($, on) => {
  const { store } = boot(on, { [nk('aaaa')]: row('aaaa', 'A', { createdAt: 0 }) })
  const inc: any = row('aaaa', 'A-갱신', { modAt: T0 - 60_000 })
  delete inc.createdAt
  sibling(store, { [nk('aaaa')]: inc }, 1)
  await start($)
  expect(nodeOf(store, 'aaaa').title).toBe('A-갱신')
  expect(store.toasts.some(t => t.includes('같은 id'))).toBe(false)
})

test('C6: 합칠 것이 없으면(같은 내용) 쓰기 0 — 두 식별자가 번갈아 떠도 핑퐁 없음', async ($, on) => {
  const { store } = boot(on)
  const rows = { [nk('aaaa')]: row('aaaa', 'A', { modAt: T0 - HOUR }), [nk('bbbb')]: row('bbbb', 'B') }
  sibling(store, rows, 1)
  await start($)
  const before = store.sets.length
  sibling(store, { ...rows, [nk('aaaa')]: row('aaaa', 'A', { modAt: T0 - 60_000 }) }, 2) // 버전만 오름, 내용 같음
  await start($)
  const wrote = store.sets.slice(before).filter(x => x.key.startsWith('node:')).map(x => x.key)
  expect(wrote).toEqual([nk('aaaa')]) // 버전(modAt)만 맞춘다
  expect(store.toasts.filter(t => t.includes('가져왔습니다')).length).toBe(1) // 처음 2행만 — 버전 맞춤은 알리지 않는다
  const again = store.sets.length
  sibling(store, { ...rows, [nk('aaaa')]: row('aaaa', 'A', { modAt: T0 - 60_000 }) }, 3)
  await start($)
  expect(store.sets.slice(again).filter(x => x.key.startsWith('node:'))).toEqual([])
})

test('C7: 내가 GC로 지운 노드는, 오래 쉬던 형제의 낡은 열린 사본으로 되살아나지 않는다 — 그 뒤 형제가 바꾼 것만 받는다', async ($, on) => {
  const bt = boot(on, {
    [nk('xxxx')]: row('xxxx', '지운 것', { status: 'removed', removedAt: T0 - 31 * DAY }),
    [nk('yyyy')]: row('yyyy', '끝낸 것', { status: 'resolved', resolvedAt: T0 - 31 * DAY }),
    [nk('zzzz')]: row('zzzz', '끝낸 것2', { status: 'resolved', resolvedAt: T0 - 31 * DAY }),
  })
  const { store } = bt
  await start($) // GC가 셋 다 물리 삭제
  expect(nodeIds(store)).toEqual([])
  expect(Object.keys(store.map.get(`gone:${ROOT}`) as object).sort()).toEqual(['xxxx', 'yyyy', 'zzzz'])
  await bt.clock.advance(HOUR)
  // 형제는 그동안 쉬어서 셋 다 옛 열린 사본. zzzz만 내 GC 뒤에 형제에서 실제로 다시 손댔다.
  sibling(store, {
    [nk('xxxx')]: row('xxxx', '지운 것'),
    [nk('yyyy')]: row('yyyy', '끝낸 것'),
    [nk('zzzz')]: row('zzzz', '끝낸 것2', { touchedAt: T0 + 60_000, modAt: T0 + 60_000 }),
  }, 1)
  await start($)
  expect(nodeIds(store)).toEqual(['zzzz'])
})

test('C8: 이관 뒤 전부 GC된 트리의 레거시 tree:는 다시 가져오지 않는다', async ($, on) => {
  const { store } = boot(on, { [nk('k1')]: row('k1', 'K', { status: 'removed', removedAt: T0 - 31 * DAY }) })
  await start($)
  expect(nodeIds(store)).toEqual([])
  sibling(store, { [`tree:${ROOT}`]: { version: 1, seq: 1, nodes: { k1: { id: 'k1', title: 'K', status: 'open' } } } }, 1)
  await start($)
  expect(store.map.has(`tree:${ROOT}`)).toBe(false)
  expect(nodeIds(store)).toEqual([])
})

test('C9: mergeRows는 어느 쪽에서 합쳐도 같은 답(동률 포함) — 두 store가 한 바퀴에 수렴한다', () => {
  const mk = (extra: Record<string, unknown>) => row('aaaa', 'A', { modAt: T0, ...extra }) as any
  const pairs: [any, any][] = [
    [mk({ title: '가' }), mk({ title: '나' })], // 버전 동률·내용 다름
    [mk({ status: 'resolved', resolvedAt: T0 - 5 }), mk({ status: 'resolved', resolvedAt: T0 - 9 })], // 각자 해결
    [mk({ status: 'removed', removedAt: T0 - 5 }), mk({ status: 'removed', removedAt: T0 - 9, modAt: T0 + 1 })], // 각자 삭제
    [mk({ status: 'resolved', resolvedAt: T0 - 5, modAt: T0 - 1 }), mk({ title: '새', modAt: T0 + 5 })], // 낡은 바탕
    [mk({ status: 'resolved', resolvedAt: T0 - 5 }), mk({ reopenCount: 1, modAt: T0 - 50 })], // 진짜 재개
  ]
  for (const [a, b] of pairs) {
    const ab = mergeRows(a, b)
    const ba = mergeRows(b, a)
    expect(ab).toEqual(ba)
    expect(mergeRows(ab, a)).toEqual(ab) // 고정점: 다시 합쳐도 그대로
    expect(mergeRows(ab, b)).toEqual(ab)
  }
})

test('C10: 삭제 기록(gone)도 형제끼리 합쳐진다 — 새 식별자가 "GC한 쪽"과 "오래 쉰 쪽"을 함께 읽어도 지운 노드가 안 살아난다', async ($, on) => {
  const { store } = boot(on) // 새 식별자(빈 store)
  store.files['problem-tree_leejuyeon-1.json'] = file({ 'store:id': 'L', [`gone:${ROOT}`]: { xxxx: T0 - HOUR }, [nk('keep')]: row('keep', 'KEEP') })
  store.files[OLD] = file({ 'store:id': 'S', [nk('xxxx')]: row('xxxx', '지운 것') }) // 파일 순서와 무관해야 한다
  await start($)
  expect(nodeIds(store)).toEqual(['keep'])
  expect(store.map.get(`gone:${ROOT}`)).toEqual({ xxxx: T0 - HOUR })
})

test('C11: 형제가 GC한 노드의 낡은 내 사본은 같이 지워지고, 그 뒤 내가 바꾼 사본은 남는다', async ($, on) => {
  const { store } = boot(on, {
    [nk('old1')]: row('old1', '낡은 사본'),
    [nk('new1')]: row('new1', '그 뒤 손댐', { touchedAt: T0 - 60_000, modAt: T0 - 60_000 }),
  })
  sibling(store, { [`gone:${ROOT}`]: { old1: T0 - HOUR, new1: T0 - HOUR, bad: 'x' } }, 1)
  await start($)
  expect(nodeIds(store)).toEqual(['new1'])
  expect(store.map.get(`gone:${ROOT}`)).toEqual({ old1: T0 - HOUR, new1: T0 - HOUR })
  expect(store.toasts).toContain('문제트리: 다른 설치에서 이미 정리된 노드 1개를 지웠습니다') // 무음 삭제 금지
})

test('C12: store가 가득 차 삭제 기록을 못 써도 GC와 세션 시작은 끝까지 간다', async ($, on) => {
  const { store } = boot(on, { [nk('dead')]: row('dead', '묘비', { status: 'removed', removedAt: T0 - 31 * DAY }) })
  store.onSet = (k: string) => {
    if (k.startsWith('gone:')) throw new Error('store would be over 4 MiB')
  }
  await start($)
  expect(nodeIds(store)).toEqual([]) // GC는 됐다
  expect(store.opens.length).toBe(1) // 패널도 열렸다
  expect((store.map.get('diag:s1') as any[]).some(d => d.ev === 'sstart')).toBe(true) // 끝까지 갔다
})

test('C13: C10을 파일 순서를 뒤집어도 같다(낡은 사본을 먼저 읽고 삭제 기록을 나중에 읽음)', async ($, on) => {
  const { store } = boot(on)
  store.files[OLD] = file({ 'store:id': 'S', [nk('xxxx')]: row('xxxx', '지운 것') })
  store.files['problem-tree_zzz-9.json'] = file({ 'store:id': 'L', [`gone:${ROOT}`]: { xxxx: T0 - HOUR }, [nk('keep')]: row('keep', 'KEEP') })
  await start($)
  expect(nodeIds(store)).toEqual(['keep'])
})

test('C14: 미래 시각이 찍힌 삭제 기록은 버린다 — 살아 있는 내 행을 지우지도, 내 gone에 섞이지도 않는다', async ($, on) => {
  const { store } = boot(on, { [nk('live')]: row('live', '어제 만진 것'), [nk('kid1')]: row('kid1', '자식', { parent: 'live' }) })
  sibling(store, { [`gone:${ROOT}`]: { live: T0 + 365 * DAY }, [nk('late')]: row('late', '형제의 새 행', { createdAt: T0 - HOUR, touchedAt: T0 - HOUR }) }, 1)
  await start($)
  expect(nodeIds(store).sort()).toEqual(['kid1', 'late', 'live'])
  expect(store.map.has(`gone:${ROOT}`)).toBe(false)
  expect(store.toasts.some(t => t.includes('지웠습니다'))).toBe(false)
  const before = store.sets.length
  sibling(store, { [`gone:${ROOT}`]: { live: T0 + 365 * DAY } }, 2)
  await start($)
  expect(store.sets.slice(before).filter(x => x.key.startsWith('gone:'))).toEqual([]) // 매 시작 다시 쓰지 않는다
})
