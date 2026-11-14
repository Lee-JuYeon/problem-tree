export type PtreeStatus = 'open' | 'resolved'

export type PtreeHistory = {
  at: number
  event: 'add' | 'resolve' | 'reopen' | 'merge' | 'focus' | 'note' | 'rename'
  by: 'user' | 'claude'
  ref?: string
}

export type PtreeNode = {
  id: string
  title: string
  status: PtreeStatus
  createdAt: number
  touchedAt: number
  /** 최초로 current(메인 턴에서 작업)된 시각. 없으면 "계획만", 있으면 "멈춤". */
  startedAt?: number
  resolvedAt?: number
  parent?: string
  resolvedBy?: string
  reopenCount: number
  note?: string
  history: PtreeHistory[]
}

export type PtreeTree = {
  version: 1
  seq: number
  nodes: Record<string, PtreeNode>
  focusId?: string
  rejected: string[]
}

export type PtreeUi = {
  /** 메인 턴이 도는 중인가(영속 안 함). current 애니메이션의 스위치. */
  running: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'problem-tree': {
      tree: PtreeTree
      ui: PtreeUi
    }
  }

  // 자기 도구의 입력 타입을 손으로 선언(생성 claude-code-mcp 스냅샷에 안 기댐).
  // 생성 모양과 동일 shape → 선언 병합 충돌 없음. tool.call 리터럴 매처가 e를 좁힌다.
  interface McpToolInputs {
    'mcp__problem-tree__add_problem': { title: string; parentId?: string }
    'mcp__problem-tree__resolve_problem': { nodeId: string; reason: string; alsoResolves?: string[] }
    'mcp__problem-tree__reopen_problem': { nodeId: string; reason: string }
    'mcp__problem-tree__rename_problem': { nodeId: string; title: string }
    'mcp__problem-tree__focus_problem': { nodeId: string }
    'mcp__problem-tree__list_problems': {}
  }
}
