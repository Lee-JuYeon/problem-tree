// register — 훅 배선만. 무엇을 하는지는 각 모듈에 있다:
//   lib/store(영속 창구) · lib/session(세션 테이블 창구) · lib/view(순수 계산) · lib/ops(노드 조작)
//   lib/tools(MCP 도구 선언표) · lib/command(/ptree 해석) · pane(패널 그리기)
// 여기서는 store/session atom을 직접 건드리지 않는다(가드 가·나).

import type { Register, Timer } from 'claude-code'
import { readCache, loadTree, migrate, gc, diagPush, diagGc, adoptSiblings } from './lib/store'
import {
  ensureSession, tasksReplace, ensureCutoff, turnStart, turnEnd, taskDrop,
  readSession, bindAgent, taskProvisional,
} from './lib/session'
import { TOOLS, runTool, type ToolName } from './lib/tools'
import { ARGUMENT_HINT, runCommand } from './lib/command'
import { PANE_OPEN, renderPane } from './pane'
import * as view from './lib/view'

const STALE_TICK_MS = 3_600_000 // "paused Nd" 일수 갱신용 다시 그리기 주기

// 메인 턴이 돌거나 백그라운드 작업이 있을 때만 켜는 애니메이션 타이머(모듈 변수 → 리로드 시 초기화).
let timer: Timer | undefined
// stale 일수 갱신용 1시간 주기 타이머. 모듈 변수로 1개만 유지 — session.start마다 누적되지 않게.
let staleTimer: Timer | undefined

function ensureTimer($: any, s: view.SessionView) {
  const on = s.turn.mainTurnId !== undefined || Object.keys(s.tasks.map).length > 0
  if (on && !timer) timer = $.clock.every(view.FRAME_MS, () => void $.ui.invalidate('ui.render'))
  else if (!on && timer) {
    timer.cancel()
    timer = undefined
  }
}

async function afterWrite($: any) {
  const s = await readSession($)
  ensureTimer($, s)
}

// 백그라운드 작업(셸/워크플로/모니터) 결과의 task id를 잡아 provisional로 올린다.
async function bgTask($: any, e: any, next: any, kind: 'shell' | 'workflow') {
  const r = await next(e)
  try {
    const res = (r as any)?.result
    const id = res?.backgroundTaskId ?? res?.taskId
    // 반드시 문자열 id만 작업 행으로(숫자 등 비문자열 id가 맵 키·node 참조로 새지 않게).
    if (typeof id === 'string') {
      await ensureSession($)
      const s = await readSession($)
      const nodes = (await readCache($)).nodes
      const node = e.agentId !== undefined ? s.agentBind.map[e.agentId] : view.resolveNodeRef(nodes, s.pointer.node)
      await taskProvisional($, id, { type: kind, node })
      await afterWrite($)
    }
  } catch {
    /* 통과 */
  }
  return r
}

// 다른 설치 식별자(skills-dir ↔ 마켓 설치 등)의 store에 남은 노드를 흡수한다. 실패해도 세션 시작은
// 막지 않되, 못 읽은 store가 있으면 조용히 넘기지 않고 사용자에게 알린다.
async function adoptOrphans($: any) {
  try {
    const r = await adoptSiblings($)
    if (r.adopted > 0) $.ui.toast(`문제트리: 다른 설치의 store에서 ${r.adopted}행을 가져왔습니다 (${r.files.join(', ')})`)
    if (r.skipped.length > 0)
      $.ui.toast(`문제트리: 읽지 못한 옛 store가 있습니다(노드가 안 보일 수 있음): ${r.skipped.join(', ')}`)
    if (r.conflicts.length > 0)
      $.ui.toast(`문제트리: 다른 설치의 store에 같은 id의 다른 노드가 있어 가져오지 않았습니다: ${r.conflicts.join(', ')}`)
  } catch {
    $.ui.toast('문제트리: 다른 설치의 store를 확인하지 못했습니다(노드가 안 보일 수 있음)')
  }
}

// 도구 호출 1건: 세션 가드 → 실행 → 타이머 정리 → 결과 문구.
async function callTool($: any, name: ToolName, input: unknown) {
  await ensureSession($)
  const out = await runTool($, name, input)
  await afterWrite($)
  return { result: out }
}

async function registerSurface($: any) {
  // name은 리터럴로(호스트 정적 스캔이 아래 command.run 훅과 짝짓는다: "answers its own command").
  await $.command.register({ name: 'ptree', description: '문제해결 노드트리 패널', argumentHint: ARGUMENT_HINT })
  for (const t of TOOLS)
    await $.tool.register({ name: t.name, description: t.description, isDeferred: false, inputSchema: t.inputSchema })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerSurface($)
    const sid = await ensureSession($)
    const s0 = await readSession($) // 진단: tasksReplace 전 상태
    await tasksReplace($, {})
    const now = await $.clock.now()
    await ensureCutoff($, now)
    await adoptOrphans($)
    await migrate($)
    await gc($)
    await loadTree($)
    void $.ui.open(PANE_OPEN)
    // stale 일수 갱신용 느린 주기(1시간). 모듈 변수로 1개만 — 재시작마다 타이머가 쌓이지 않게.
    // current 애니메이션 타이머는 ensureTimer가 따로 켠다.
    if (!staleTimer) staleTimer = $.clock.every(STALE_TICK_MS, () => void $.ui.invalidate('ui.render'))
    await afterWrite($)
    await diagGc($, sid)
    await diagPush($, sid, {
      at: now, ev: 'sstart', before: s0.turn.mainTurnId, ptr: s0.pointer.node, tasks: Object.keys(s0.tasks.map).length,
    })
    return next(e)
  })

  // ---------- 메인 턴 ----------
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // 서브에이전트 턴은 무시(동작 불변) — 진단 기록만. 메인 플래그는 안 바뀌므로 before=after.
      try {
        const s = await readSession($)
        await diagPush($, await $.session.id(), {
          at: await $.clock.now(), ev: 'start', turnId: e.turnId, agentId: e.agentId,
          before: s.turn.mainTurnId, after: s.turn.mainTurnId, ptr: s.pointer.node, tasks: Object.keys(s.tasks.map).length,
        })
      } catch {
        /* 진단 실패는 삼킴 */
      }
      return next(e)
    }
    const sid = await ensureSession($)
    const before = (await readSession($)).turn.mainTurnId
    const now = await $.clock.now()
    await turnStart($, e.turnId, now)
    await loadTree($)
    await afterWrite($)
    const s = await readSession($)
    await diagPush($, sid, {
      at: now, ev: 'start', turnId: e.turnId, before, after: s.turn.mainTurnId,
      ptr: s.pointer.node, tasks: Object.keys(s.tasks.map).length,
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const sid = await ensureSession($)
    const before = (await readSession($)).turn.mainTurnId
    if (e.agentId !== undefined) {
      // 에이전트 턴 끝 → 그 작업 행 삭제(없으면 무동작)
      await taskDrop($, e.agentId)
      await afterWrite($)
    } else {
      // 메인 턴 끝: turnId 확인 없이 turnEnd(현 동작 — 진단 로그 match로 어긋남을 기록한다).
      await turnEnd($)
      await afterWrite($)
      void $.ui.invalidate('ui.render')
    }
    const s = await readSession($)
    await diagPush($, sid, {
      at: await $.clock.now(), ev: 'complete', turnId: e.turnId, agentId: e.agentId,
      before, after: s.turn.mainTurnId, match: e.turnId === before, ptr: s.pointer.node,
      tasks: Object.keys(s.tasks.map).length,
      note: String(e.reason) + (e.isAborted && e.reason !== 'aborted' ? ' aborted' : ''),
    })
    return next(e)
  })

  // ---------- spawn: 귀속 노드 바인딩 + 백그라운드 작업 provisional ----------
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r && (r as any).agentId) {
        const agentId = (r as any).agentId as string
        await ensureSession($)
        const s = await readSession($)
        const nodes = (await readCache($)).nodes
        const node =
          e.parentAgentId !== undefined ? s.agentBind.map[e.parentAgentId] : view.resolveNodeRef(nodes, s.pointer.node)
        if (node !== undefined) await bindAgent($, agentId, node)
        if ((e as any).background || (e as any).workflow)
          await taskProvisional($, agentId, { type: (e as any).workflow ? 'workflow' : 'subagent', node })
        await afterWrite($)
      }
    } catch {
      /* 실패해도 스폰은 통과(귀속은 부가기능) */
    }
    return r
  })

  // ---------- 백그라운드 셸/워크플로/모니터 작업 provisional ----------
  on('tool.call', { tool: 'Bash' }, ($, e, next) => bgTask($, e, next, 'shell'))
  on('tool.call', { tool: 'Workflow' }, ($, e, next) => bgTask($, e, next, 'workflow'))
  on('tool.call', { tool: 'Monitor' }, ($, e, next) => bgTask($, e, next, 'shell'))

  // ---------- classic.Stop: 백그라운드 작업 스냅샷으로 통째 교체 ----------
  // 가드: 내부 예외를 삼키고 항상 next(e)로 통과시킨다(Stop을 절대 막지 않는다 — 스펙 "블록 금지").
  on('classic.Stop', async ($, e, next) => {
    try {
      const tasks = (e as any).background_tasks
      if (Array.isArray(tasks)) {
        await ensureSession($)
        const s = await readSession($)
        const old = s.tasks.map
        const bind = s.agentBind.map
        const map: Record<string, { type: string; node?: string; source: 'snapshot' }> = {}
        for (const t of tasks) {
          map[t.id] = { type: t.type, node: old[t.id]?.node ?? bind[t.id], source: 'snapshot' }
        }
        await tasksReplace($, map)
        await afterWrite($)
      }
    } catch {
      /* 삼킴: 백그라운드 스냅샷 반영 실패가 Stop을 막지 않게 한다 */
    }
    return next(e)
  })

  // ---------- slash command ----------
  // ★매처(command·tool·requestId)는 반드시 이 파일에 문자열 리터럴로 쓴다. 호스트가 훅을 정적으로
  //   읽어 색인하므로(`claude plugin validate`의 hooks 줄), 상수·루프로 돌리면 `tool=?`가 되어 못 읽는다.
  on('command.run', { command: 'ptree' }, async ($, e) => {
    await ensureSession($)
    void $.ui.open(PANE_OPEN)
    const out = await runCommand($, e.args ?? '')
    await afterWrite($)
    return { text: out }
  })

  // ---------- registered ptree tools (선언·실행은 lib/tools.ts, 여기는 이름별 배선) ----------
  on('tool.call', { tool: 'mcp__problem-tree__add_problem' }, ($, e) => callTool($, 'add_problem', e))
  on('tool.call', { tool: 'mcp__problem-tree__resolve_problem' }, ($, e) => callTool($, 'resolve_problem', e))
  on('tool.call', { tool: 'mcp__problem-tree__reopen_problem' }, ($, e) => callTool($, 'reopen_problem', e))
  on('tool.call', { tool: 'mcp__problem-tree__focus_problem' }, ($, e) => callTool($, 'focus_problem', e))
  on('tool.call', { tool: 'mcp__problem-tree__rename_problem' }, ($, e) => callTool($, 'rename_problem', e))
  on('tool.call', { tool: 'mcp__problem-tree__move_problem' }, ($, e) => callTool($, 'move_problem', e))
  on('tool.call', { tool: 'mcp__problem-tree__list_problems' }, ($, e) => callTool($, 'list_problems', e))

  // ---------- pane ----------
  on('ui.render', { component: 'Pane', requestId: 'problem-tree' }, ($, e) => renderPane($, e))
}

// 가드 26(가) 정적검사용(비런타임): register.tsx의 비export 헬퍼 소스를 테스트가 들여다볼 수 있게 노출한다.
// 실기기 fs가 테스트 런타임에 없어 파일 전체 텍스트를 못 읽으므로, 이 집합의 toString으로
// register 내부 헬퍼(bgTask 등)에 `$.store.set` 주입이 없음을 검사한다. 런타임 동작엔 영향 없음.
export const __guardInternals = { bgTask, afterWrite, ensureTimer, registerSurface, adoptOrphans, callTool }
