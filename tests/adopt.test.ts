// adopt: 설치 식별자(store 파일)가 바뀌어도 노드가 고아가 되지 않는다.
// 재현: 옛 식별자 store 파일(skills-dir)에 노드가 있고, 새 식별자 store(자기 $.store)는 비어 있다.
import { expect, test } from 'claude-code/testing'
import { boot, start, call, nk, nodeOf, nodeIds, ROOT, T0, DAY } from './harness'

const OLD = 'problem-tree_skills-dir-a8b1b87c1491.json'
const DIR = '/home/u/.claude/plugins/store'
const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, title, status: 'open', createdAt: T0 - DAY, touchedAt: T0 - DAY, reopenCount: 0, history: [], ...extra,
})
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
    [`link:/x`]: '/y',
  })
  await start($)
  expect(store.fsLists).toEqual([DIR])
  expect(nodeIds(store).sort()).toEqual(['aaaa', 'bbbb'])
  expect(store.map.has('node:/other:cccc')).toBe(true) // 다른 트리 노드도 함께 옮겨진다
  expect(store.map.get('link:/x')).toBe('/y')
  expect(store.map.has('diag:zzz')).toBe(false) // 진단·레거시는 안 옮김
  expect(store.map.has('tree:/legacy')).toBe(false)
  const r = await call($, 'list_problems', {})
  expect(String(r.result)).toContain('옛노드A')
  expect(String(r.result)).toContain('옛노드B')
  expect(store.toasts.some(t => t.includes('3행'))).toBe(false) // 4행(node3+link1)
  expect(store.toasts.some(t => t.includes('4행') && t.includes(OLD))).toBe(true)
})

test('A2: 같은 id는 touchedAt이 더 새 쪽이 이긴다(옛 것이 새 것을 덮지 않음)', async ($, on) => {
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
