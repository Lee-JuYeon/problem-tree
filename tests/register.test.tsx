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
  ($ as any).turn.complete({ turnId, reason: 'answer', ...(agentId ? { agentId } : {}) })

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
  expect(await ui.find({ type: 'Text', text: /n1 옛 문제/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /n1 부모/ })).toBeDefined() // 하루 숨김 로직 없음 — 그냥 보임
  expect(await ui.find({ type: 'Text', text: /n2 자식/ })).toBeDefined()
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
    const row = await ui.find({ type: 'Text', text: /^n1 / })
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
  expect(await ui.find({ type: 'Text', text: /^n1 / })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /^n1 / })).toBeDefined()
  await ui.unmount()
  // 다음 메인 턴 시작 → 완료된 단독 루트 삭제
  await turnStart($)
  expect((await tree($)).nodes['n1']).toBeUndefined()
  await turnDone($)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: VP })
  expect(await ui.find({ type: 'Text', text: /^n1 / })).toBeUndefined()
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
