// 테스트 공용 하네스. store는 손수 만들어 map·sets·deletes를 들여다본다.
// 세션 테이블은 atom이라 훅 안에서만 살아있어, 노드 상태는 store.map으로 읽고
// 세션 파생(불·머리줄)은 패널 렌더를 마운트해 Text를 집는다.

import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const ROOT = '/proj'
export const SID = 's1'
export const T0 = 1_700_000_000_000
export const DAY = 86_400_000
export const FRAME_MS = 400

export const nk = (id: string) => `node:${ROOT}:${id}`
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

export type Store = {
  map: Map<string, unknown>
  sets: { key: string; value: unknown }[]
  deletes: string[]
  gets: string[] // store.get된 키(전수 조회 금지 검증용)
  stateSets: number
  stateDeletes: number
  stateWrites: string[] // state.set된 atom 키(이벤트별 쓰기표 검증용)
  // 형제 store 파일 목(파일명 → 내용). adoptSiblings가 fs.list/fs.read로 본다.
  files: Record<string, { text: string; size?: number; mtimeMs?: number }>
  fsLists: string[]
  fsFail?: boolean // true면 fs.list가 throw(권한 없음 모사)
  fsReads: string[]
  toasts: string[]
  // 표면 등록 기록(특성화 테스트용)
  commands: any[]
  tools: any[]
  opens: any[]
  // 테스트 주입 훅(기본 미설정 → 무동작). 다른 엔진의 동시쓰기·인터리브를 모사한다.
  onKeys?: () => void // store.keys 호출마다(get/validate 재읽기 직전 끼어들기용)
  onSet?: (key: string) => void // 각 key의 실제 store.set 직전(get과 set 사이 외부쓰기용)
  keysGate?: () => Promise<void> | void // store.keys 응답을 붙잡아 다른 훅을 끼우는 비동기 게이트(진단 D5용)
}

export type Boot = {
  clock: ReturnType<typeof mock.clock>
  store: Store
  setSid: (s: string) => void
  setCwd: (s: string) => void
  bgId: () => string
}

export const PANE_PROPS = {
  title: '문제트리',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const
export const PANE = { plugin: 'problem-tree', component: 'Pane', requestId: 'problem-tree', props: PANE_PROPS } as const
export const VP = { columns: 48, rows: 30 } as const

export function boot(on: On, entries?: Record<string, unknown>): Boot {
  const clock = mock.clock(on, { now: T0 })
  const store: Store = { map: new Map(Object.entries(entries ?? {})), sets: [], deletes: [], gets: [], stateSets: 0, stateDeletes: 0, stateWrites: [], files: {}, fsLists: [], fsReads: [], toasts: [], commands: [], tools: [], opens: [] }
  let sid = SID
  let cwd = ROOT
  let agentSeq = 0
  let bgSeq = 0
  let lastBg = ''

  on('store.get', (_, e) => {
    store.gets.push(e.key)
    return { value: store.map.has(e.key) ? clone(store.map.get(e.key)) : undefined }
  })
  on('store.set', (_, e) => {
    store.onSet?.(e.key)
    const v = clone((e as any).value)
    store.map.set(e.key, v)
    store.sets.push({ key: e.key, value: v })
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.map.delete(e.key)
    store.deletes.push(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => {
    store.onKeys?.()
    if (store.keysGate) await store.keysGate()
    return { value: [...store.map.keys()] }
  })
  on('state.set', ((_: any, e: any, next: any) => {
    store.stateSets++
    store.stateWrites.push((e as any).ref?.key ?? (e as any).key ?? '?')
    return next(e)
  }) as any)

  // 형제 store 흡수(adoptSiblings)용 fs/env 기본 목: 실제 디스크를 절대 안 읽게 빈 디렉터리로 답한다.
  on('env.get', ((_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : undefined })) as any)
  on('fs.list', ((_: any, e: any) => {
    store.fsLists.push(e.path)
    if (store.fsFail) throw new Error('EACCES')
    return { value: Object.entries(store.files).map(([name, f]) => ({ name, kind: 'file', isLink: false, size: f.size ?? f.text.length, mtimeMs: f.mtimeMs ?? 1 })) }
  }) as any)
  on('fs.read', ((_: any, e: any) => {
    const name = String(e.path).split('/').pop()!
    store.fsReads.push(e.path)
    const f = store.files[name]
    if (!f) throw new Error('ENOENT')
    return { value: f.text }
  }) as any)
  on('ui.toast', ((_: any, e: any) => {
    store.toasts.push(String(e.text))
    return { value: undefined }
  }) as any)

  on('command.register', (_, e) => {
    store.commands.push(clone(e))
    return { value: { command: 'ptree' } }
  })
  on('tool.register', (_, e) => {
    store.tools.push(clone(e))
    return { value: { tool: (e as any).name } }
  })
  on('ui.open', (_, e) => {
    store.opens.push(clone(e))
    return { value: { isPlaced: true } }
  })
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: sid }))
  on('session.start', (_, e) => ({ cwd: (e as any).cwd }))
  on('turn.start', (_, e) => ({ turnId: (e as any).turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: (e as any).__id ?? `ag${++agentSeq}` }))
  const bgBase = (_: any, e: any) => {
    const id = (e as any).__bg ?? `bt${++bgSeq}`
    lastBg = id
    return { result: { backgroundTaskId: id } }
  }
  on('tool.call', { tool: 'Bash' }, bgBase as any)
  on('tool.call', { tool: 'Workflow' }, bgBase as any)
  on('tool.call', { tool: 'Monitor' }, bgBase as any)

  return {
    clock,
    store,
    setSid: (s: string) => {
      sid = s
    },
    setCwd: (s: string) => {
      cwd = s
    },
    bgId: () => lastBg,
  }
}

// ---------- drivers ----------

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as any)

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'ptree', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)

export const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($ as any).tool.call({ tool: `mcp__problem-tree__${tool}`, ...input }) as Promise<{ result?: unknown }>

export const bash = ($: Engine, input?: Record<string, unknown>) =>
  ($ as any).tool.call({ tool: 'Bash', command: 'sleep 1', ...(input ?? {}) }) as Promise<any>

export const workflowCall = ($: Engine, input?: Record<string, unknown>) =>
  ($ as any).tool.call({ tool: 'Workflow', ...(input ?? {}) }) as Promise<any>

export const spawnAgent = ($: Engine, input?: Record<string, unknown>) =>
  ($ as any).agent.spawn({ prompt: 'x', subagentType: 'general-purpose', background: false, ...(input ?? {}) }) as Promise<any>

export const stop = ($: Engine, background_tasks: any[]) =>
  ($ as any).classic.Stop({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: SID,
    transcript_path: '/t',
    cwd: ROOT,
    background_tasks,
  }) as Promise<any>

export const turnStart = ($: Engine, turnId = 't1', agentId?: string) =>
  ($ as any).turn.start({ text: 'x', turnId, ...(agentId ? { agentId } : {}) })

export const turnDone = ($: Engine, turnId = 't1', agentId?: string) =>
  ($ as any).turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, ...(agentId ? { agentId } : {}) })

// ---------- store inspection ----------

export const nodeOf = (store: Store, id: string): any => store.map.get(nk(id))
export const nodeIds = (store: Store): string[] =>
  [...store.map.keys()].filter(k => k.startsWith(`node:${ROOT}:`)).map(k => k.slice(`node:${ROOT}:`.length))
export const liveIds = (store: Store): string[] => nodeIds(store).filter(id => nodeOf(store, id)?.status !== 'removed')

export const mountPane = async ($: Engine, viewport: { columns: number; rows: number } = VP) =>
  $.ui.mount({ ...PANE, surface: 'terminal', viewport } as any)
