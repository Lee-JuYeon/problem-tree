import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { PtreeTree } from '../types'

// ---------- harness ----------

const CWD = '/proj'
const KEY = `tree:${CWD}`
const T0 = 1_700_000_000_000
const DAY = 86_400_000
const FRAME_MS = 400

const PANE = {
  plugin: 'problem-tree',
  component: 'Pane',
  requestId: 'problem-tree',
  props: { title: '문제트리', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const VP = { columns: 48, rows: 30 } as const

const PROBE = { plugin: 'ptree-probe', component: 'Pane', requestId: 'probe', props: PANE.props } as const
const OPTS = {
  plugins: [
    {
      name: 'ptree-probe',
      register(on: On) {
        on('ui.render', { component: 'Pane', requestId: 'probe' }, async ($, e) => {
          const { Text } = $.ui.resolve(e)
          const held = await $.state.get({ plugin: 'problem-tree', key: 'tree' } as any)
          return <Text>{JSON.stringify(held.value ?? null)}</Text>
        })
      },
    },
  ],
}

type Store = { map: Map<string, unknown>; sets: { key: string; value: unknown }[] }

function boot(on: On, entries?: Record<string, unknown>) {
  const clock = mock.clock(on, { now: T0 })
  const store: Store = { map: new Map(Object.entries(entries ?? {})), sets: [] }
  on('store.get', (_, e) => ({ value: store.map.get(e.key) }))
  on('store.set', (_, e) => {
    const v = JSON.parse(JSON.stringify(e.value))
    store.map.set(e.key, v)
    store.sets.push({ key: e.key, value: v })
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'ptree' } }))
  on('tool.register', (_, e) => ({ value: { tool: (e as any).name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: (e as any).turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, store }
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
async function tree($: Engine): Promise<PtreeTree> {
  const ui = await $.ui.mount({ ...PROBE, surface: 'terminal' })
  const el = await ui.find({ type: 'Text' })
  await ui.unmount()
  return JSON.parse(el?.text ?? 'null') as PtreeTree
}
const stored = (s: Store): PtreeTree | undefined => s.map.get(KEY) as PtreeTree | undefined
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'ptree', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($ as any).tool.call({ tool: `mcp__problem-tree__${tool}`, ...input }) as Promise<{ result?: unknown }>
const turnStart = ($: Engine, turnId = 't1', agentId?: string) =>
  ($ as any).turn.start({ text: 'x', turnId, ...(agentId ? { agentId } : {}) })
const turnDone = ($: Engine, turnId = 't1', agentId?: string) =>
  ($ as any).turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, ...(agentId ? { agentId } : {}) })

// ---------- 1. add (user) ----------

test('/ptree add makes an open planned node, moves focus and persists', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)

  const out = await run($, 'add 로그인 버그')
  expect(out?.text).toContain('노드 추가')

  const t = await tree($)
  expect(t.seq).toBe(1)
  expect(t.nodes['n1']).toMatchObject({ id: 'n1', title: '로그인 버그', status: 'open', createdAt: T0, touchedAt: T0, reopenCount: 0 })
  expect(t.nodes['n1']?.startedAt).toBeUndefined() // 턴이 안 돌았으니 "계획만"
  expect(t.nodes['n1']?.history).toEqual([{ at: T0, event: 'add', by: 'user' }])
  expect(t.focusId).toBe('n1')

  expect(store.sets.map(s => s.key)).toEqual([KEY])
  expect(stored(store)).toEqual(t)

  await run($, 'add 세션 만료')
  const t2 = await tree($)
  expect(t2.nodes['n2']?.parent).toBe('n1')
  expect(t2.focusId).toBe('n2')
  expect(store.sets).toHaveLength(2)
})

// ---------- 2. add_problem (Claude, 자동) ----------

test('add_problem adds an open planned node and does NOT steal focus', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 기존') // n1, focus n1

  const r = await call($, 'add_problem', { title: '캐시 무효화' })
  expect(r.result).toContain('추가 n2')

  const t = await tree($)
  expect(t.nodes['n2']).toMatchObject({ status: 'open' })
  expect(t.nodes['n2']?.startedAt).toBeUndefined()
  expect(t.focusId).toBe('n1') // Claude 추가는 현재 작업(focus)을 뺏지 않는다
  expect(t.nodes['n2']?.history[0]).toMatchObject({ event: 'add', by: 'claude' })
  // 16자 초과는 거부
  const long = await call($, 'add_problem', { title: '1234567890123456789' })
  expect(long.result).toContain('16자')
})

// ---------- 3. resolve_problem: 즉시 해결 + merge + 부모로 refocus ----------

test('resolve_problem resolves immediately, records merge edge, refocuses sensibly', OPTS, async ($, on) => {
  const { clock, store } = boot(on)
  await start($)

  await run($, 'add A') // n1, focus n1
  await clock.advance(1000)
  await run($, 'add B') // n2 child of n1, focus n2
  await clock.advance(1000)
  await run($, 'add C') // n3 child of n2, focus n3

  const r = await call($, 'resolve_problem', { nodeId: 'n3', reason: '테스트 통과', alsoResolves: ['n2', 'n9'] })
  expect(r.result).toContain('해결 n3')
  expect(r.result).toContain('+n2,n9')

  const t = await tree($)
  const at = clock.now()
  expect(t.nodes['n3']).toMatchObject({ status: 'resolved', resolvedAt: at })
  expect(t.nodes['n2']).toMatchObject({ status: 'resolved', resolvedAt: at, resolvedBy: 'n3' })
  expect(t.nodes['n2']?.history.at(-1)).toMatchObject({ event: 'merge', by: 'claude', ref: 'n3' })
  expect(t.nodes['n1']?.status).toBe('open')
  // n3의 부모 n2도 함께 resolved → focus는 손 안 댄 노드로 튀지 않고 사라진다
  expect(t.focusId).toBeUndefined()
  expect(stored(store)?.nodes['n2']?.resolvedBy).toBe('n3') // merge는 데이터로만 남고 패널엔 표시 안 함

  const r2 = await call($, 'resolve_problem', { nodeId: 'n3', reason: 'x' })
  expect(r2.result).toContain('open 상태가 아님')
})

// ---------- 4. reopen_problem: 즉시 재개 + startedAt 유지 ----------

test('reopen_problem reopens immediately and keeps startedAt', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  await run($, 'add A') // n1, focus
  await turnStart($) // 메인 턴 → focus 노드에 startedAt 기록
  await turnDone($)
  let t = await tree($)
  expect(t.nodes['n1']?.startedAt).toBe(T0)

  await call($, 'resolve_problem', { nodeId: 'n1', reason: 'r' })
  await clock.advance(5000)
  const r = await call($, 'reopen_problem', { nodeId: 'n1', reason: '재현됨' })
  expect(r.result).toContain('재개 n1')

  t = await tree($)
  expect(t.nodes['n1']).toMatchObject({ status: 'open', reopenCount: 1, touchedAt: T0 + 5000 })
  expect(t.nodes['n1']?.resolvedAt).toBeUndefined()
  expect(t.nodes['n1']?.startedAt).toBe(T0) // 재개는 "멈춤"이므로 startedAt 유지
  expect(t.focusId).toBe('n1')
})

// ---------- 5. reopen via command ----------

test('reopen via command works and increments reopenCount', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  await run($, 'add A')
  await run($, 'resolve n1')
  await clock.advance(5000)
  await run($, 'reopen n1')
  const t = await tree($)
  expect(t.nodes['n1']).toMatchObject({ status: 'open', reopenCount: 1, touchedAt: T0 + 5000 })
  expect(t.focusId).toBe('n1')
  expect(t.nodes['n1']?.history.map(h => h.event)).toEqual(['add', 'resolve', 'reopen'])
})

// ---------- 6. duplicate / removed-title ----------

test('duplicate titles refused; a removed title stays refused; too long refused', OPTS, async ($, on) => {
  const { store } = boot(on)
  await start($)
  await run($, 'add 로그인 버그.')

  const dup = await call($, 'add_problem', { title: '  로그인   버그 ' })
  expect(dup.result).toContain('중복')
  expect(dup.result).toContain('n1')
  expect(Object.keys((await tree($)).nodes)).toEqual(['n1'])

  const p = await call($, 'add_problem', { title: '빌드 느림' })
  expect(p.result).toContain('추가 n2')

  await run($, 'rm n2')
  const t = await tree($)
  expect(t.nodes['n2']).toBeUndefined()
  expect(t.rejected).toEqual(['빌드 느림'])
  expect(stored(store)?.rejected).toEqual(['빌드 느림'])

  const again = await call($, 'add_problem', { title: '빌드 느림!' })
  expect(again.result).toContain('삭제된 제목')
  expect(Object.keys((await tree($)).nodes)).toEqual(['n1'])

  const empty = await call($, 'add_problem', { title: '' })
  expect(empty.result).toContain('거부')
})

// ---------- 7. session restart + legacy proposed migration ----------

test('a saved tree seeds the atom; legacy proposed nodes migrate to open', OPTS, async ($, on) => {
  const saved = {
    version: 1,
    seq: 2,
    focusId: 'n2',
    rejected: ['old'],
    nodes: {
      n1: { id: 'n1', title: '옛 문제', status: 'proposed', createdAt: T0 - 3 * DAY, touchedAt: T0 - 3 * DAY, reopenCount: 0, proposalReason: 'x', history: [] },
      n2: { id: 'n2', title: '자식', status: 'open', parent: 'n1', createdAt: T0 - DAY, touchedAt: T0 - DAY, reopenCount: 0, history: [] },
    },
  }
  boot(on, { [KEY]: saved })
  await start($)

  const t = await tree($)
  expect(t.nodes['n1']?.status).toBe('open') // proposed → open
  expect((t.nodes['n1'] as any).proposalReason).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  // n1은 3일 방치 → stale 접두(⚠), 둘 다 계획만 ○
  expect(await ui.find({ type: 'Text', text: /⚠○/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^옛 문제$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /├─|└─/ })).toBeDefined()
  await ui.unmount()

  await run($, 'add 새 문제')
  expect((await tree($)).nodes['n3']).toBeDefined()
})

test('a store value of another version is ignored', OPTS, async ($, on) => {
  boot(on, { [KEY]: { version: 2, seq: 9, nodes: {}, rejected: [] } })
  await start($)
  expect(await tree($)).toBeNull()
  await run($, 'add A')
  expect((await tree($)).seq).toBe(1)
})

// ---------- 8. 열린 자식이 있으면 완료된 부모 나무도 안 지워진다 ----------

test('a resolved parent with an open child survives (tree not fully done)', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 부모') // n1, focus n1
  await run($, 'add 자식') // n2 under n1, focus n2
  await run($, 'resolve n1') // n1 완료, n2는 아직 open
  await turnStart($) // 프루닝 시점(B) 지나도
  await turnDone($)
  const t = await tree($)
  expect(t.nodes['n1']?.status).toBe('resolved') // 부모는 완료됐지만
  expect(t.nodes['n2']?.status).toBe('open') // 열린 자식이 있어 나무가 안 지워짐(부모 자동완료 안 함)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^부모$/ })).toBeDefined() // 하루 숨김 로직 없음 — 그냥 보임
  expect(await ui.find({ type: 'Text', text: /^자식$/ })).toBeDefined()
  await ui.unmount()
})

// ---------- 9. list ----------

test('list_problems and /ptree list describe planned/paused/resolved', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  expect((await call($, 'list_problems', {})).result).toBe('(문제 노드 없음)')
  await run($, 'add A')
  await run($, 'add B')
  await clock.advance(2 * DAY + 1)
  await call($, 'resolve_problem', { nodeId: 'n2', reason: 'r' })
  const text = (await call($, 'list_problems', {})).result as string
  expect(text).toContain('n1 [planned] A')
  expect(text).toContain('n2 [resolved] B')
  expect((await run($, 'list'))?.text).toBe(text)
})

// ---------- 10. narrow width ----------

test('the pane still draws at a narrow width and truncates titles', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 아주아주아주아주아주 긴제목') // 16자로 잘림
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 20, rows: 10 } })
    const row = await ui.find({ type: 'Text', text: /^아주/ })
    expect(row).toBeDefined()
    expect(row?.text.length).toBe(10) // titleW = max(10, 20-16)
    await ui.unmount()
  }
})

// ---------- 11. pane is read-only (no control buttons) ----------

test('the pane is read-only: no add/toggle/resolve/focus buttons', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add A')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  // 노드는 보이되, 어떤 조작 버튼/입력도 없어야 한다(관리는 커맨드·AI가)
  expect(await ui.find({ type: 'Text', text: /^A$/ })).toBeDefined()
  expect(await ui.find({ key: 'add' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect(await ui.find({ key: 'resolve:n1' })).toBeUndefined()
  expect(await ui.find({ key: 'focus:n1' })).toBeUndefined()
  expect(await ui.find({ key: 'new-title' })).toBeUndefined()
  // 어떤 Button/Input 요소도 패널에 없어야 한다(읽기 전용)
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()
})

// ---------- 12. 완료된 나무는 다음 턴 시작 때 삭제(B), 그 전엔 ●로 남음 ----------

test('a fully-resolved tree is pruned at the next turn start, not immediately', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add A') // n1 단독 루트
  await call($, 'resolve_problem', { nodeId: 'n1', reason: 'done' })
  // B: resolve 즉시 삭제 안 함 — 이 턴 동안 ●로 남아 reopen 여지
  expect((await tree($)).nodes['n1']?.status).toBe('resolved')
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^A$/ })).toBeDefined()
  await ui.unmount()
  // 다음 메인 턴 시작 → 완료된 단독 루트 삭제
  await turnStart($)
  expect((await tree($)).nodes['n1']).toBeUndefined()
  await turnDone($)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^A$/ })).toBeUndefined()
  await ui.unmount()
})

// ---------- 13. current animation ----------

test('focus node animates ○→◐→● while the main turn runs, freezes to ◐ after', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  await run($, 'add A') // n1 focus, planned (startedAt 없음)

  // 메인 턴 시작 → startedAt 기록 + current 애니메이션
  await turnStart($)
  expect((await tree($)).nodes['n1']?.startedAt).toBe(T0)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  // n1은 루트라 커넥터 없이 마커만 → 마커 Text를 정확히(^마커$) 집는다
  // T0/400 % 4 == 0 → 첫 프레임 ○
  expect(await ui.find({ type: 'Text', text: /^○$/ })).toBeDefined()
  await clock.advance(FRAME_MS)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^◐$/ })).toBeDefined()
  await clock.advance(FRAME_MS)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^●$/ })).toBeDefined()
  await ui.unmount()

  // 턴 종료 → ◐ 로 고정, 더는 안 움직임(● 프레임 안 나옴)
  await turnDone($)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^◐$/ })).toBeDefined()
  await clock.advance(FRAME_MS * 2)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^●$/ }), 'frozen node must not animate').toBeUndefined()
  await ui.unmount()
})

test('a subagent turn neither starts nor freezes the animation', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add A')
  await turnStart($, 'sub1', 'agent-7') // 서브에이전트 턴
  expect((await tree($)).nodes['n1']?.startedAt).toBeUndefined() // 메인 턴 아님 → 영향 없음
})

// ---------- 14. rename ----------

test('rename_problem changes the title; too-long refused', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add A')
  const r = await call($, 'rename_problem', { nodeId: 'n1', title: '로그인 수정' })
  expect(r.result).toContain('이름 변경 n1')
  let t = await tree($)
  expect(t.nodes['n1']?.title).toBe('로그인 수정')
  expect(t.nodes['n1']?.history.at(-1)?.event).toBe('rename')

  const long = await call($, 'rename_problem', { nodeId: 'n1', title: '12345678901234567' })
  expect(long.result).toContain('16자')
  t = await tree($)
  expect(t.nodes['n1']?.title).toBe('로그인 수정') // 안 바뀜
})

// ---------- 15. rm promotes children ----------

test('/ptree rm removes a node and promotes its children to its parent', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 조부') // n1
  await run($, 'add 부모') // n2 under n1
  await run($, 'add 자식') // n3 under n2
  await run($, 'rm n2')
  const t = await tree($)
  expect(t.nodes['n2']).toBeUndefined()
  expect(t.nodes['n3']?.parent).toBe('n1')
  expect(t.rejected).toContain('부모')
})

// ---------- 16. 프루닝: 완료 삭제·rejected 불변·alsoResolves·rm·루트 커넥터 ----------

test('pruning does not block re-adding the same title (rejected untouched)', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 반복문제')
  await call($, 'resolve_problem', { nodeId: 'n1', reason: 'done' })
  await turnStart($) // 프루닝 → n1 삭제
  await turnDone($)
  expect((await tree($)).nodes['n1']).toBeUndefined()
  expect((await tree($)).rejected).not.toContain('반복문제') // 삭제가 rejected 안 건드림
  const r = await call($, 'add_problem', { title: '반복문제' }) // 재발 → 재추가 가능
  expect(r.result as string).toContain('추가')
  expect(Object.values((await tree($)).nodes).some(n => n.title === '반복문제')).toBe(true)
})

test('alsoResolves completing a whole tree → pruned at next turn start', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 부모') // n1 루트, focus n1
  await call($, 'add_problem', { title: '자식', parentId: 'n1' }) // n2 자식(focus 유지)
  await call($, 'resolve_problem', { nodeId: 'n1', reason: 'done', alsoResolves: ['n2'] })
  await turnStart($)
  await turnDone($)
  const t = await tree($)
  expect(t.nodes['n1']).toBeUndefined()
  expect(t.nodes['n2']).toBeUndefined()
})

test('removing the last open node lets its resolved tree prune', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 부모') // n1 루트
  await call($, 'add_problem', { title: '자식', parentId: 'n1' }) // n2 자식 open
  await call($, 'resolve_problem', { nodeId: 'n1', reason: 'done' }) // n1 완료, n2 open → 나무 생존
  await turnStart($)
  await turnDone($)
  expect((await tree($)).nodes['n1']).toBeDefined()
  await run($, 'rm n2') // 마지막 open 제거 → 남은 n1은 완전 완료
  await turnStart($)
  await turnDone($)
  const t = await tree($)
  expect(t.nodes['n2']).toBeUndefined()
  expect(t.nodes['n1']).toBeUndefined() // 완료된 단독 루트 → 프루닝
})

test('a root row has no connector; children use ├─/└─', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 루트') // n1 루트
  await call($, 'add_problem', { title: '자식', parentId: 'n1' }) // n2 자식
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^○$/ })).toBeDefined() // 루트 n1: 커넥터 없는 마커만
  expect(await ui.find({ type: 'Text', text: /└─○/ })).toBeDefined() // 자식 n2: └─ 커넥터
  await ui.unmount()
})

// ---------- 17. focus_problem: Claude가 스스로 진행중으로 전환 ----------

test('focus_problem lets a Claude-added node become current in a running turn', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await turnStart($)
  // Claude가 턴 도중 추가 → focus 안 뺏김 → 계획만(planned)
  expect(((await call($, 'add_problem', { title: '토큰 누수' })).result as string)).toContain('계획만')
  expect((await tree($)).nodes['n1']?.startedAt).toBeUndefined()
  // Claude가 "지금 이거 작업" 선언 → focus 이동 → 진행중(startedAt 기록)
  expect(((await call($, 'focus_problem', { nodeId: 'n1' })).result as string)).toContain('작업 시작')
  const t = await tree($)
  expect(t.focusId).toBe('n1')
  expect(t.nodes['n1']?.startedAt).toBe(T0)
  expect(t.nodes['n1']?.history.at(-1)?.event).toBe('focus')
  await turnDone($)
})

// ---------- 18. ● 충돌: current ●와 resolved ●는 색/굵기로 구분 ----------

test('current ● and resolved ● differ by color and dim (무색 터미널 대비)', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  await run($, 'add 작업중') // n1 focus
  await turnStart($)
  await clock.advance(FRAME_MS * 2) // 애니 정점 프레임 = ●
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  await ui.redraw()
  const cur = await ui.find({ type: 'Text', text: /^●$/ })
  expect(cur?.props?.color).toBe('claude') // current = 강조색
  expect(cur?.props?.dimColor).toBeFalsy()
  await ui.unmount()
  await turnDone($)
  await run($, 'resolve n1') // 완료 ●
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  const res = await ui.find({ type: 'Text', text: /^●$/ })
  expect(res?.props?.color).toBe('subtle') // resolved = 흐린색
  expect(res?.props?.dimColor).toBe(true)
  await ui.unmount()
})

// ---------- 19. 작업 중인 노드는 날짜가 지나도 ⚠방치로 안 뜸 ----------

test('a node worked across turns keeps a fresh touchedAt (not stale)', OPTS, async ($, on) => {
  const { clock } = boot(on)
  await start($)
  await run($, 'add 긴작업') // n1 focus
  await turnStart($) // 첫 작업 → startedAt + touchedAt = T0
  await turnDone($)
  expect((await tree($)).nodes['n1']?.startedAt).toBe(T0)
  await clock.advance(DAY * 3) // 3일 경과
  await turnStart($) // 다시 작업 → touchedAt 갱신돼야(옛 버그: startedAt 있으면 갱신 안 됨)
  expect((await tree($)).nodes['n1']?.touchedAt).toBe(T0 + DAY * 3)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeUndefined() // 방치 경고 없음
  await ui.unmount()
  await turnDone($)
})


// ---------- 20. add_problem 자리: 생략=루트, 명시=자식, 없는 부모=거부 ----------

test('add_problem without parentId is a root even when a node is focused', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await call($, 'add_problem', { title: 'A' }) // n1
  await call($, 'focus_problem', { nodeId: 'n1' })
  const r = await call($, 'add_problem', { title: 'B' })
  expect(r.result).toContain('추가 n2')
  expect(r.result).toContain('루트')
  const t = await tree($)
  expect(t.nodes['n2']?.parent).toBeUndefined() // focus(n1)를 상속하지 않는다
  expect(t.focusId).toBe('n1')
})

test('add_problem with parentId attaches there; an unknown parentId is refused', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await call($, 'add_problem', { title: 'A' }) // n1
  const ok = await call($, 'add_problem', { title: 'B', parentId: 'n1' })
  expect(ok.result).toContain('추가 n2')
  expect(ok.result).toContain('부모 n1')
  expect((await tree($)).nodes['n2']?.parent).toBe('n1')

  for (const bad of ['n99', 'root']) {
    const r = await call($, 'add_problem', { title: 'C', parentId: bad })
    expect(r.result).toContain('없는 부모')
  }
  const t = await tree($)
  expect(Object.keys(t.nodes)).toEqual(['n1', 'n2']) // 조용히 루트로 만들지 않는다
  expect(t.seq).toBe(2) // id 낭비 없음
})

// ---------- 21. move_problem ----------

test('move_problem moves a subtree; focus and touchedAt stay; persisted', OPTS, async ($, on) => {
  const { clock, store } = boot(on)
  await start($)
  await run($, 'add 조부') // n1
  await run($, 'add 부모') // n2 under n1
  await run($, 'add 자식') // n3 under n2, focus n3
  await clock.advance(5000)

  const r = await call($, 'move_problem', { nodeId: 'n2' }) // 생략 = 루트
  expect(r.result).toContain('이동 n2')
  expect(r.result).toContain('루트')
  let t = await tree($)
  expect(t.nodes['n2']?.parent).toBeUndefined()
  expect(t.nodes['n3']?.parent).toBe('n2') // 하위는 따라온다
  expect(t.focusId).toBe('n3')
  expect(t.nodes['n2']?.touchedAt).toBe(T0) // 구조 편집은 방치 시계를 안 건드림
  expect(t.nodes['n2']?.history.at(-1)).toMatchObject({ event: 'move', by: 'claude' })
  expect(stored(store)?.nodes['n2']?.parent).toBeUndefined()

  const r2 = await call($, 'move_problem', { nodeId: 'n1', newParentId: 'n3' }) // 조부를 손자 밑으로(이제 순환 아님)
  expect(r2.result).toContain('부모 n3')
  t = await tree($)
  expect(t.nodes['n1']?.parent).toBe('n3')
  expect(t.nodes['n1']?.history.at(-1)).toMatchObject({ event: 'move', ref: 'n3' })
})

test('move_problem refuses self, descendants, unknown ids and no-ops; tree unchanged', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add A') // n1
  await run($, 'add B') // n2 under n1
  await run($, 'add C') // n3 under n2
  const before = await tree($)

  expect((await call($, 'move_problem', { nodeId: 'n9' })).result).toContain('없는 노드')
  expect((await call($, 'move_problem', { nodeId: 'n3', newParentId: 'n9' })).result).toContain('없는 부모')
  expect((await call($, 'move_problem', { nodeId: 'n2', newParentId: 'n2' })).result).toContain('자기 자신')
  expect((await call($, 'move_problem', { nodeId: 'n1', newParentId: 'n3' })).result).toContain('순환')
  expect((await call($, 'move_problem', { nodeId: 'n1', newParentId: 'n2' })).result).toContain('순환')
  expect((await call($, 'move_problem', { nodeId: 'n3', newParentId: 'n2' })).result).toContain('변화 없음')
  expect((await call($, 'move_problem', { nodeId: 'n1' })).result).toContain('변화 없음')

  expect(await tree($)).toEqual(before)
})

test('move_problem works on resolved nodes; a moved done tree prunes at the next turn', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add 부모') // n1
  await run($, 'add 자식') // n2 under n1
  await call($, 'add_problem', { title: '다른일' }) // n3 root
  await run($, 'resolve n2')
  // 열린 노드를 완료된 노드 밑으로 — 허용(완료 부모 + 열린 자식은 원래 있는 모양)
  expect((await call($, 'move_problem', { nodeId: 'n3', newParentId: 'n2' })).result).toContain('부모 n2')
  await turnStart($)
  await turnDone($)
  let t = await tree($)
  expect(t.nodes['n2']?.status).toBe('resolved') // 열린 자식이 있어 안 접힘
  expect(t.nodes['n3']?.parent).toBe('n2')
  // 완료 노드를 루트로 — 다음 턴 시작 때 완료된 나무로 정리된다
  await call($, 'move_problem', { nodeId: 'n3' })
  const r = await call($, 'move_problem', { nodeId: 'n2' })
  expect(r.result).toContain('다음 턴')
  await turnStart($)
  await turnDone($)
  t = await tree($)
  expect(t.nodes['n2']).toBeUndefined()
  expect(Object.keys(t.nodes).sort()).toEqual(['n1', 'n3'])
})

test('/ptree move reparents and roots; refusals are reported', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await run($, 'add A') // n1
  await run($, 'add B') // n2 under n1
  expect((await run($, 'move n2'))?.text).toContain('루트')
  expect((await tree($)).nodes['n2']?.parent).toBeUndefined()
  expect((await run($, 'move n1 n2'))?.text).toContain('부모 n2')
  const t = await tree($)
  expect(t.nodes['n1']?.parent).toBe('n2')
  expect(t.nodes['n1']?.history.at(-1)).toMatchObject({ event: 'move', by: 'user', ref: 'n2' })
  expect((await run($, 'move n2 n1'))?.text).toContain('순환')
  expect((await run($, 'move n7'))?.text).toContain('없는 노드')
})

// ---------- 22. 저장 트리의 순환: 끊고 살아남는다 ----------

test('a saved tree with a parent cycle is repaired at load (no hook skip, nodes visible)', OPTS, async ($, on) => {
  const mk = (id: string, parent: string | undefined, status: string) => ({ id, title: id, status, parent, createdAt: T0, touchedAt: T0, reopenCount: 0, history: [] })
  const { store } = boot(on, {
    [KEY]: {
      version: 1,
      seq: 5,
      rejected: [],
      nodes: {
        n1: mk('n1', 'n2', 'open'),
        n2: mk('n2', 'n1', 'open'),
        n3: mk('n3', 'n1', 'open'), // 순환에 매달린 노드 — 부모 유지
        n4: mk('n4', 'n5', 'resolved'),
        n5: mk('n5', 'n4', 'resolved'), // 완료 순환 — 예전엔 스택 초과
      },
    },
  })
  await start($)
  const t = await tree($)
  expect(t).not.toBeNull() // session.start 훅이 skip되지 않았다
  expect(t.nodes['n1']?.parent).toBeUndefined() // 순환이 끊김
  expect(t.nodes['n2']?.parent).toBe('n1')
  expect(t.nodes['n3']?.parent).toBe('n1')
  expect(t.nodes['n4']).toBeUndefined() // 끊긴 뒤 완료 나무로 정리
  expect(t.nodes['n5']).toBeUndefined()
  expect(stored(store)?.nodes['n1']?.parent).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  for (const id of ['n1', 'n2', 'n3']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${id}$`) })).toBeDefined()
  await ui.unmount()
  await turnStart($) // 매 턴 프루닝도 안 터진다
  await turnDone($)
  expect(Object.keys((await tree($)).nodes).sort()).toEqual(['n1', 'n2', 'n3'])
})

// ---------- 23. 실시간 반영: 상태 쓰기만으로 열린 패널이 다시 그려진다 ----------

test('an open pane redraws on a tool write with no explicit redraw (main, subagent, narrow)', OPTS, async ($, on) => {
  boot(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 20, rows: 10 } })
  expect(await ui.find({ type: 'Text', text: /없습니다/ })).toBeDefined()
  await call($, 'add_problem', { title: '턴밖' })
  expect(await ui.find({ type: 'Text', text: /^턴밖$/ })).toBeDefined()
  await turnStart($)
  await call($, 'add_problem', { title: '턴중' })
  expect(await ui.find({ type: 'Text', text: /^턴중$/ })).toBeDefined()
  await call($, 'add_problem', { title: '서브', agentId: 'agent-7' }) // 서브에이전트 루프의 호출
  expect(await ui.find({ type: 'Text', text: /^서브$/ })).toBeDefined()
  await call($, 'move_problem', { nodeId: 'n3', newParentId: 'n1' })
  expect(await ui.find({ type: 'Text', text: /└─○/ })).toBeDefined()
  await call($, 'rename_problem', { nodeId: 'n2', title: '바뀜' })
  expect(await ui.find({ type: 'Text', text: /^바뀜$/ })).toBeDefined()
  await turnDone($)
  await ui.unmount()
})

// ---------- 24. 병렬 상충 move: 한쪽만 적용, 문구는 실제 결과 ----------

test('conflicting parallel moves: one applies, the other reports its real refusal', OPTS, async ($, on) => {
  boot(on)
  await start($)
  await call($, 'add_problem', { title: 'A' }) // n1 root
  await call($, 'add_problem', { title: 'B' }) // n2 root
  const [r1, r2] = await Promise.all([
    call($, 'move_problem', { nodeId: 'n1', newParentId: 'n2' }),
    call($, 'move_problem', { nodeId: 'n2', newParentId: 'n1' }),
  ])
  const t = await tree($)
  const p1 = t.nodes['n1']?.parent
  const p2 = t.nodes['n2']?.parent
  expect(p1 === 'n2' && p2 === 'n1', 'no cycle may form').toBe(false)
  expect([p1, p2].filter(p => p !== undefined)).toHaveLength(1) // 정확히 한쪽만 반영
  const ok = [r1, r2].filter(r => String(r.result).startsWith('이동 '))
  const refused = [r1, r2].filter(r => /순환|변화 없음/.test(String(r.result)))
  expect(ok).toHaveLength(1) // 둘 다 "이동"이면 거짓 성공
  expect(refused).toHaveLength(1)
  // 성공 문구가 가리키는 쪽이 실제로 반영된 쪽
  expect(String(ok[0]?.result)).toContain(p1 === 'n2' ? '이동 n1' : '이동 n2')
  // 같은 이동 두 번 병렬 → 두 번째는 "변화 없음"
  const [a, b] = await Promise.all([call($, 'move_problem', { nodeId: p1 ? 'n1' : 'n2' }), call($, 'move_problem', { nodeId: p1 ? 'n1' : 'n2' })])
  expect([a, b].filter(r => String(r.result).startsWith('이동 '))).toHaveLength(1)
  expect([a, b].filter(r => String(r.result).includes('변화 없음'))).toHaveLength(1)
})

// ---------- 25. 없는 부모를 가리키는 저장 노드: 루트로 정리 ----------

test('a saved node whose parent does not exist is repaired to a root at load', OPTS, async ($, on) => {
  const mk = (id: string, parent: string | undefined) => ({ id, title: id, status: 'open', parent, createdAt: T0, touchedAt: T0, reopenCount: 0, history: [] })
  const { store } = boot(on, { [KEY]: { version: 1, seq: 7, rejected: [], nodes: { n6: mk('n6', 'n77'), n7: mk('n7', 'n6') } } })
  await start($)
  const t = await tree($)
  expect(t).not.toBeNull() // 훅 skip 없음
  expect(t.nodes['n6']?.parent).toBeUndefined() // 끊긴 부모 정리
  expect('parent' in (t.nodes['n6'] ?? {})).toBe(false)
  expect(t.nodes['n7']?.parent).toBe('n6') // 정상 링크는 그대로
  expect(stored(store)?.nodes['n6']?.parent).toBeUndefined() // 저장본도 고쳐짐
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^n6$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^n7$/ })).toBeDefined()
  await ui.unmount()
  expect((await call($, 'move_problem', { nodeId: 'n6' })).result).toContain('변화 없음') // 이제 진짜 루트
  await turnStart($)
  await turnDone($)
  expect((await tree($)).nodes['n6']?.parent).toBeUndefined()
})

// ---------- 26. 병렬 같은 제목 add: 하나만 추가, 다른 하나는 중복 ----------

test('conflicting parallel same-title adds: one adds, the other reports 중복', OPTS, async ($, on) => {
  boot(on)
  await start($)
  const [a, b] = await Promise.all([
    call($, 'add_problem', { title: '동시제목' }),
    call($, 'add_problem', { title: '동시제목' }),
  ])
  const added = [a, b].filter(r => String(r.result).startsWith('추가 '))
  const dup = [a, b].filter(r => String(r.result).includes('중복'))
  expect(added, '둘 다 추가면 쓰기시점 재검사 없음').toHaveLength(1)
  expect(dup).toHaveLength(1)
  const t = await tree($)
  expect(Object.values(t.nodes).filter(n => n.title === '동시제목')).toHaveLength(1) // 노드는 하나만
})

