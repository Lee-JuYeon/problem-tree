// (b) TOOLS — Claude가 부르는 MCP 도구. 선언표(TOOLS: 이름·설명·입력 스키마)와 실행(runTool)을 한 자리에 둔다.
// register는 표를 돌며 등록(`$.tool.register`)과 호출 배선(`tool.call` → runTool)을 한다.
// (플랫폼 규칙상 `$`는 표에 담긴 클로저로 넘길 수 없어, 실행은 이름으로 가르는 switch다.)
// 입력은 모델이 준 값이라 신뢰하지 않는다 — str/strArr로 형만 걸러 ops에 넘기고, 검증은 ops가 한다.

import { add, resolve, reopen, focus, rename, move, list } from './ops'

type Any = any

export const TOOL_PREFIX = 'mcp__problem-tree__'

export type ToolName =
  | 'add_problem' | 'resolve_problem' | 'reopen_problem' | 'rename_problem'
  | 'focus_problem' | 'list_problems' | 'move_problem'

export type ToolDef = { name: ToolName; description: string; inputSchema: Record<string, unknown> }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'add_problem',
    description:
      '대화에서 새 문제·버그·미결 질문·"나중에 할 일"이 나왔고 지금 작업과 별개 단위면 노드를 추가한다(바로 "계획만" 상태로 들어감, focus는 안 뺏음). ★자리: parentId 생략 = 루트(독립 문제). 지금 작업 중인 노드에서 갈라진 하위 문제면 parentId를 반드시 준다(자동으로 안 붙음). 지금 바로 고치는 한 줄 수정은 넣지 말 것. ★제목 철칙: 쉬운 말로 요약, 되도록 10자·최대 16자, 직관적이고 가독성 높게(16자 넘으면 거부됨).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '문제를 한 줄로(16자 이내, 짧고 명확)' },
        parentId: { type: 'string', description: '부모 노드 id. 생략하면 루트. 없는 id면 거부됨' },
      },
      required: ['title'],
    },
  },
  {
    name: 'resolve_problem',
    description: '테스트 통과·오류 재현 불가 등 근거가 확실할 때 노드를 바로 해결 처리한다. 같이 풀린 다른 open 노드는 alsoResolves에.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        reason: { type: 'string' },
        alsoResolves: { type: 'array', items: { type: 'string' } },
      },
      required: ['nodeId', 'reason'],
    },
  },
  {
    name: 'reopen_problem',
    description: '해결 처리한 문제가 다시 재현됐을 때 바로 재개한다.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, reason: { type: 'string' } }, required: ['nodeId', 'reason'] },
  },
  {
    name: 'rename_problem',
    description: '노드 제목을 더 짧고 쉽게 바꾼다. ★되도록 10자·최대 16자, 쉬운 말 요약, 직관적으로(16자 넘으면 거부).',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, title: { type: 'string' } }, required: ['nodeId', 'title'] },
  },
  {
    name: 'focus_problem',
    description:
      '지금부터 이 노드를 작업한다고 선언한다 → 진행중(current, 애니메이션 ●). 사용자 승인 불필요, Claude가 작업 대상을 바꿀 때마다 자동으로 호출한다. 메인 턴이 도는 동안 pointer가 가리키는 open 노드가 current, 턴이 끝나면 멈춤(◐)으로 남는다.',
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] },
  },
  {
    name: 'list_problems',
    description: '현재 문제 노드 목록(id·상태·방치일수·부모)을 반환한다. 다른 도구를 쓰기 전에 nodeId를 알려면 먼저 호출한다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'move_problem',
    description:
      '노드를 다른 부모 밑으로(또는 루트로) 옮긴다. 하위 노드는 함께 따라간다. 잘못 붙은 노드는 resolve+재생성하지 말고 이걸로 고친다. newParentId 생략 = 루트. 자기 자신·자기 하위 노드 밑으로는 못 옮긴다.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '옮길 노드 id' },
        newParentId: { type: 'string', description: '새 부모 id. 생략하면 루트로. 없는 id면 거부됨' },
      },
      required: ['nodeId'],
    },
  },
]

/** 도구 하나를 실행하고 결과 문구를 돌려준다. 입력 `i`는 모델이 준 값(비신뢰). */
export async function runTool($: Any, name: ToolName, i: Any): Promise<string> {
  switch (name) {
    case 'add_problem':
      return add($, { title: str(i.title), by: 'claude', parentId: str(i.parentId) || undefined })
    case 'resolve_problem':
      return resolve($, { id: str(i.nodeId), by: 'claude', also: strArr(i.alsoResolves) })
    case 'reopen_problem':
      return reopen($, str(i.nodeId), 'claude')
    case 'rename_problem':
      return rename($, str(i.nodeId), str(i.title), 'claude')
    case 'focus_problem':
      return focus($, str(i.nodeId), 'claude')
    case 'list_problems':
      return list($)
    case 'move_problem':
      return move($, str(i.nodeId), str(i.newParentId) || undefined, 'claude')
  }
}
