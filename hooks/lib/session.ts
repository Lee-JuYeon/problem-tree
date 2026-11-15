// (a) SESSION — 세션 테이블 4개(turn/pointer/agentBind/runningTasks)의 유일한 창구(가드 라).
// atom은 비공개. 전부 `sid`를 들고 있어 /clear(세션 교체)를 첫 훅에서 가드한다.
// 읽기는 readSession 하나, 쓰기는 이름 붙은 함수만.

import { atom, read, update } from 'claude-code'
import type { PtreeTurn, PtreePointer, PtreeAgentBind, PtreeRunningTasks, PtreeTask } from '../../types'
import { loadTree } from './store'
import type { SessionView } from './view'

type Any = any

const EMPTY_TURN: PtreeTurn = { sid: '', cutoffAt: 0 }
const EMPTY_POINTER: PtreePointer = { sid: '' }
const EMPTY_BIND: PtreeAgentBind = { sid: '', map: {} }
const EMPTY_TASKS: PtreeRunningTasks = { sid: '', map: {} }

const turnAtom = atom({ plugin: 'problem-tree', key: 'turn' } as const, EMPTY_TURN)
const pointerAtom = atom({ plugin: 'problem-tree', key: 'pointer' } as const, EMPTY_POINTER)
const agentBindAtom = atom({ plugin: 'problem-tree', key: 'agentBind' } as const, EMPTY_BIND)
const tasksAtom = atom({ plugin: 'problem-tree', key: 'runningTasks' } as const, EMPTY_TASKS)

// ---------- 읽기 ----------

/**
 * 4테이블을 읽어 세션 뷰로. 기준 sid = turn.sid. 다른 테이블이 그와 안 맞으면 빈 값으로
 * (렌더는 session.id를 안 부르므로 이 교차검사로 옛 세션 잔재가 불을 켜지 않게 한다).
 */
export async function readSession($: Any): Promise<SessionView> {
  const turn = (await read($, turnAtom)) as PtreeTurn
  const p = (await read($, pointerAtom)) as PtreePointer
  const a = (await read($, agentBindAtom)) as PtreeAgentBind
  const t = (await read($, tasksAtom)) as PtreeRunningTasks
  const sid = turn.sid
  return {
    turn,
    pointer: p.sid === sid ? p : { sid },
    agentBind: a.sid === sid ? a : { sid, map: {} },
    tasks: t.sid === sid ? t : { sid, map: {} },
  }
}

// ---------- 세션 교체 가드 ----------

async function resetAll($: Any, sid: string, now: number): Promise<void> {
  await update($, turnAtom, () => ({ sid, cutoffAt: now }))
  await update($, pointerAtom, () => ({ sid }))
  await update($, agentBindAtom, () => ({ sid, map: {} }))
  await update($, tasksAtom, () => ({ sid, map: {} }))
}

/**
 * 쓰기 훅 진입 시 호출. session.id가 turn.sid와 다르면(=/clear·새 세션) 4테이블을 전부
 * 비우고 loadTree. 같으면 아무것도 안 한다. 반환 = 현재 sid.
 */
export async function ensureSession($: Any): Promise<string> {
  const cur = await $.session.id()
  const turn = (await read($, turnAtom)) as PtreeTurn
  if (turn.sid !== cur) {
    const now = await $.clock.now()
    await resetAll($, cur, now)
    await loadTree($)
  }
  return cur
}

// ---------- turn ----------

/** 메인 턴 시작: mainTurnId·cutoffAt을 교체. */
export async function turnStart($: Any, turnId: string, now: number): Promise<void> {
  await update($, turnAtom, (t: PtreeTurn) => ({ sid: t.sid, mainTurnId: turnId, cutoffAt: now }))
}
/** 메인 턴 끝: mainTurnId 제거(cutoffAt 유지). */
export async function turnEnd($: Any): Promise<void> {
  await update($, turnAtom, (t: PtreeTurn) => ({ sid: t.sid, cutoffAt: t.cutoffAt }))
}
/** session.start: cutoffAt이 비었으면 now로 초기화. */
export async function ensureCutoff($: Any, now: number): Promise<void> {
  await update($, turnAtom, (t: PtreeTurn) => (t.cutoffAt ? t : { ...t, cutoffAt: now }))
}

// ---------- pointer ----------

export async function setPointer($: Any, node: string, by: 'user' | 'claude'): Promise<void> {
  await update($, pointerAtom, (p: PtreePointer) => ({ sid: p.sid, node, by }))
}
export async function clearPointer($: Any): Promise<void> {
  await update($, pointerAtom, (p: PtreePointer) => ({ sid: p.sid }))
}

// ---------- agentBind ----------

export async function bindAgent($: Any, agentId: string, nodeId: string): Promise<void> {
  await update($, agentBindAtom, (a: PtreeAgentBind) => ({ sid: a.sid, map: { ...a.map, [agentId]: nodeId } }))
}

// ---------- runningTasks ----------

/** 백그라운드 작업 upsert(기존 node 유지). source는 처음 provisional. */
export async function taskProvisional($: Any, taskId: string, task: { type: string; node?: string }): Promise<void> {
  await update($, tasksAtom, (t: PtreeRunningTasks) => {
    const prev = t.map[taskId]
    const row: PtreeTask = {
      type: task.type,
      node: prev?.node ?? task.node,
      source: (prev?.source as PtreeTask['source']) ?? 'provisional',
    }
    return { sid: t.sid, map: { ...t.map, [taskId]: row } }
  })
}
export async function taskDrop($: Any, taskId: string): Promise<void> {
  await update($, tasksAtom, (t: PtreeRunningTasks) => {
    if (!(taskId in t.map)) return t
    const map = { ...t.map }
    delete map[taskId]
    return { sid: t.sid, map }
  })
}
/** classic.Stop 스냅샷: 통째 교체. */
export async function tasksReplace($: Any, map: Record<string, PtreeTask>): Promise<void> {
  await update($, tasksAtom, (t: PtreeRunningTasks) => ({ sid: t.sid, map }))
}
