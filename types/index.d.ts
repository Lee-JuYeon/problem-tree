// problem-tree 영속 스키마와 세션 테이블의 타입.
// - 영속(store): 노드 행 1개 = PtreeNode, 키 `node:<treeKey>:<id>`.
// - 세션(atom): turn/pointer/agentBind/runningTasks + nodes 캐시.
// 정리(완료 접힘·숨김)는 파생이며 물리 삭제는 30일 GC(removedAt/doneAt)뿐이다.

export type PtreeStatus = 'open' | 'resolved' | 'removed'

export type PtreeHistory = {
  at: number
  event: 'add' | 'resolve' | 'reopen' | 'merge' | 'focus' | 'note' | 'rename' | 'move' | 'remove'
  by: 'user' | 'claude'
  ref?: string
}

export type PtreeNode = {
  id: string
  title: string
  status: PtreeStatus
  parent?: string
  createdAt: number
  touchedAt: number
  /** 최초로 "작업이 시작된"(pointer가 그 위에서 메인 턴이 돈) 시각. 없으면 계획만, 있으면 멈춤. */
  startedAt?: number
  resolvedAt?: number
  resolvedBy?: string
  /** 정리는 파생이므로 삭제는 묘비(removed)로만 — 물리 제거는 30일 GC. */
  removedAt?: number
  reopenCount: number
  note?: string
  history: PtreeHistory[]
}

/** 영속 store를 복제해 세션에 들고 있는 읽기 캐시(소유: store.ts). */
export type PtreeNodesCache = {
  tree: string
  nodes: Record<string, PtreeNode>
  syncedAt: number
}

/** 세션 테이블 4개 — 전부 `sid`를 들고 있어 /clear(세션 교체)를 가드한다. */
export type PtreeTurn = { sid: string; mainTurnId?: string; cutoffAt: number }
export type PtreePointer = { sid: string; node?: string; by?: 'user' | 'claude' }
export type PtreeAgentBind = { sid: string; map: Record<string, string> }
export type PtreeTaskSource = 'snapshot' | 'provisional'
export type PtreeTask = { type: string; node?: string; source: PtreeTaskSource }
export type PtreeRunningTasks = { sid: string; map: Record<string, PtreeTask> }

declare module 'claude-code' {
  interface PluginState {
    'problem-tree': {
      nodes: PtreeNodesCache
      turn: PtreeTurn
      pointer: PtreePointer
      agentBind: PtreeAgentBind
      runningTasks: PtreeRunningTasks
    }
  }

  // 자기 도구의 입력 타입을 손으로 선언(생성 claude-code-mcp 스냅샷에 안 기댐).
  interface McpToolInputs {
    'mcp__problem-tree__add_problem': { title: string; parentId?: string }
    'mcp__problem-tree__resolve_problem': { nodeId: string; reason: string; alsoResolves?: string[] }
    'mcp__problem-tree__reopen_problem': { nodeId: string; reason: string }
    'mcp__problem-tree__rename_problem': { nodeId: string; title: string }
    'mcp__problem-tree__focus_problem': { nodeId: string }
    'mcp__problem-tree__list_problems': {}
    'mcp__problem-tree__move_problem': { nodeId: string; newParentId?: string }
  }
}
