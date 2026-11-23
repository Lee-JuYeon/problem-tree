// register — 훅 배선과 렌더만. store/session atom은 직접 안 건드린다(가드 가·나).
// 모든 변경은 ops.*(→ store/session), 모든 세션 읽기·쓰기는 *, 영속은 *.

import type { Register, Timer } from 'claude-code'
import {
  readCache, loadTree, migrate, gc, treeOf, setLink, clearLink, targetHasLink, diagPush, diagGc, adoptSiblings,
} from './lib/store'
import {
  ensureSession, tasksReplace, ensureCutoff, turnStart, turnEnd, taskDrop,
  readSession, bindAgent, taskProvisional,
} from './lib/session'
import {
  add as opAdd, resolve as opResolve, reopen as opReopen, focus as opFocus,
  rename as opRename, move as opMove, remove as opRemove, note as opNote,
} from './lib/ops'
import * as view from './lib/view'

const PANE = 'problem-tree'

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

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

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
  } catch {
    /* fs 접근 불가(권한·환경) — 자기 store만으로 계속 */
  }
}

async function registerSurface($: any) {
  await $.command.register({
    name: 'ptree',
    description: '문제해결 노드트리 패널',
    argumentHint:
      '[add <제목> | resolve <id> | reopen <id> | focus <id> | rename <id> <제목> | rm <id> | move <id> [부모id] | note <id> <글> | link <경로> | unlink | list]',
  })
  await $.tool.register({
    name: 'add_problem',
    description:
      '대화에서 새 문제·버그·미결 질문·"나중에 할 일"이 나왔고 지금 작업과 별개 단위면 노드를 추가한다(바로 "계획만" 상태로 들어감, focus는 안 뺏음). ★자리: parentId 생략 = 루트(독립 문제). 지금 작업 중인 노드에서 갈라진 하위 문제면 parentId를 반드시 준다(자동으로 안 붙음). 지금 바로 고치는 한 줄 수정은 넣지 말 것. ★제목 철칙: 쉬운 말로 요약, 되도록 10자·최대 16자, 직관적이고 가독성 높게(16자 넘으면 거부됨).',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '문제를 한 줄로(16자 이내, 짧고 명확)' },
        parentId: { type: 'string', description: '부모 노드 id. 생략하면 루트. 없는 id면 거부됨' },
      },
      required: ['title'],
    },
  })
  await $.tool.register({
    name: 'resolve_problem',
    description: '테스트 통과·오류 재현 불가 등 근거가 확실할 때 노드를 바로 해결 처리한다. 같이 풀린 다른 open 노드는 alsoResolves에.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        reason: { type: 'string' },
        alsoResolves: { type: 'array', items: { type: 'string' } },
      },
      required: ['nodeId', 'reason'],
    },
  })
  await $.tool.register({
    name: 'reopen_problem',
    description: '해결 처리한 문제가 다시 재현됐을 때 바로 재개한다.',
    isDeferred: false,
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, reason: { type: 'string' } }, required: ['nodeId', 'reason'] },
  })
  await $.tool.register({
    name: 'rename_problem',
    description: '노드 제목을 더 짧고 쉽게 바꾼다. ★되도록 10자·최대 16자, 쉬운 말 요약, 직관적으로(16자 넘으면 거부).',
    isDeferred: false,
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, title: { type: 'string' } }, required: ['nodeId', 'title'] },
  })
  await $.tool.register({
    name: 'focus_problem',
    description:
      '지금부터 이 노드를 작업한다고 선언한다 → 진행중(current, 애니메이션 ●). 사용자 승인 불필요, Claude가 작업 대상을 바꿀 때마다 자동으로 호출한다. 메인 턴이 도는 동안 pointer가 가리키는 open 노드가 current, 턴이 끝나면 멈춤(◐)으로 남는다.',
    isDeferred: false,
    inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] },
  })
  await $.tool.register({
    name: 'list_problems',
    description: '현재 문제 노드 목록(id·상태·방치일수·부모)을 반환한다. 다른 도구를 쓰기 전에 nodeId를 알려면 먼저 호출한다.',
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'move_problem',
    description:
      '노드를 다른 부모 밑으로(또는 루트로) 옮긴다. 하위 노드는 함께 따라간다. 잘못 붙은 노드는 resolve+재생성하지 말고 이걸로 고친다. newParentId 생략 = 루트. 자기 자신·자기 하위 노드 밑으로는 못 옮긴다.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '옮길 노드 id' },
        newParentId: { type: 'string', description: '새 부모 id. 생략하면 루트로. 없는 id면 거부됨' },
      },
      required: ['nodeId'],
    },
  })
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
    void $.ui.open({ id: PANE, title: '문제트리', columns: 48 })
    // stale 일수 갱신용 느린 주기(1시간). 모듈 변수로 1개만 — 재시작마다 타이머가 쌓이지 않게.
    // current 애니메이션 타이머는 ensureTimer가 따로 켠다.
    if (!staleTimer) staleTimer = $.clock.every(3_600_000, () => void $.ui.invalidate('ui.render'))
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
  on('command.run', { command: 'ptree' }, async ($, e) => {
    await ensureSession($)
    const raw = (e.args ?? '').trim()
    const sp = raw.indexOf(' ')
    const sub = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase()
    const rest = sp === -1 ? '' : raw.slice(sp + 1).trim()
    void $.ui.open({ id: PANE, title: '문제트리', columns: 48 })

    const text = async (): Promise<string> => {
      if (sub === 'add' && rest) return opAdd($, { title: rest.slice(0, view.TITLE_MAX), by: 'user' })
      if (sub === 'resolve' && rest) return opResolve($, { id: rest, by: 'user' })
      if (sub === 'reopen' && rest) return opReopen($, rest, 'user')
      if (sub === 'focus' && rest) return opFocus($, rest, 'user')
      if (sub === 'rename' && rest) {
        const s2 = rest.indexOf(' ')
        const id = s2 === -1 ? rest : rest.slice(0, s2)
        const title = (s2 === -1 ? '' : rest.slice(s2 + 1).trim()).slice(0, view.TITLE_MAX)
        if (!title) return `사용법: /ptree rename <id> <새 제목>`
        return opRename($, id, title, 'user')
      }
      if (sub === 'rm' && rest) return opRemove($, rest)
      if (sub === 'move' && rest) {
        const [id = '', to] = rest.split(/\s+/)
        return opMove($, id, to, 'user')
      }
      if (sub === 'note' && rest) {
        const s2 = rest.indexOf(' ')
        const id = s2 === -1 ? rest : rest.slice(0, s2)
        const body = s2 === -1 ? '' : rest.slice(s2 + 1)
        return opNote($, id, body, 'user')
      }
      if (sub === 'link' && rest) return linkCmd($, rest)
      if (sub === 'unlink') return unlinkCmd($)
      if (sub === 'list') {
        const nodes = await loadTree($)
        const s = await readSession($)
        const now = await $.clock.now()
        const hidden = view.hiddenSet(nodes, s.turn.cutoffAt)
        return view.listText(nodes, now, hidden, s)
      }
      return '문제트리 패널을 열었습니다.'
    }
    const out = await text()
    await afterWrite($)
    return { text: out }
  })

  // ---------- registered ptree tools ----------
  on('tool.call', { tool: 'mcp__problem-tree__add_problem' }, async ($, e) => {
    await ensureSession($)
    const out = await opAdd($, { title: str((e as any).title), by: 'claude', parentId: str((e as any).parentId) || undefined })
    await afterWrite($)
    return { result: out }
  })
  on('tool.call', { tool: 'mcp__problem-tree__resolve_problem' }, async ($, e) => {
    await ensureSession($)
    const out = await opResolve($, { id: str((e as any).nodeId), by: 'claude', also: strArr((e as any).alsoResolves) })
    await afterWrite($)
    return { result: out }
  })
  on('tool.call', { tool: 'mcp__problem-tree__reopen_problem' }, async ($, e) => {
    await ensureSession($)
    const out = await opReopen($, str((e as any).nodeId), 'claude')
    await afterWrite($)
    return { result: out }
  })
  on('tool.call', { tool: 'mcp__problem-tree__focus_problem' }, async ($, e) => {
    await ensureSession($)
    const out = await opFocus($, str((e as any).nodeId), 'claude')
    await afterWrite($)
    return { result: out }
  })
  on('tool.call', { tool: 'mcp__problem-tree__rename_problem' }, async ($, e) => {
    await ensureSession($)
    const out = await opRename($, str((e as any).nodeId), str((e as any).title), 'claude')
    await afterWrite($)
    return { result: out }
  })
  on('tool.call', { tool: 'mcp__problem-tree__move_problem' }, async ($, e) => {
    await ensureSession($)
    const out = await opMove($, str((e as any).nodeId), str((e as any).newParentId) || undefined, 'claude')
    await afterWrite($)
    return { result: out }
  })
  on('tool.call', { tool: 'mcp__problem-tree__list_problems' }, async ($, _e) => {
    await ensureSession($)
    const nodes = await loadTree($)
    const s = await readSession($)
    const now = await $.clock.now()
    const hidden = view.hiddenSet(nodes, s.turn.cutoffAt)
    return { result: view.listText(nodes, now, hidden, s) }
  })

  // ---------- pane ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const cache = await readCache($)
    const s = await readSession($)
    const now = await $.clock.now()
    const cols = e.viewport?.columns ?? 48
    const nodes = cache.nodes

    const hidden = view.hiddenSet(nodes, s.turn.cutoffAt)
    const rows = view.layout(nodes, hidden)
    const L = view.lights(nodes, hidden, s)
    const titleW = Math.max(10, cols - 16)
    const fi = Math.floor(now / view.FRAME_MS) % 4
    const mainFrame = view.MAIN_FRAMES[fi]
    const bgFrame = view.BG_FRAMES[fi]

    const head: { key: string; text: string }[] = []
    if (L.headMain) head.push({ key: 'head-main', text: `${mainFrame} 작업 중 · 노드 미지정` })
    if (L.headBg > 0) head.push({ key: 'head-bg', text: `${bgFrame} 백그라운드 ${L.headBg} · 미지정` })

    return (
      <Box flexDirection="column" gap={0}>
        {rows.length === 0 && head.length === 0 && <Text dimColor>문제 노드가 없습니다. /ptree add 제목</Text>}

        {head.map(hr => (
          <Box key={hr.key} flexDirection="row" gap={1}>
            <Text color="claude" weight="semibold">
              {hr.text}
            </Text>
          </Box>
        ))}

        {rows.map(({ node: n, prefix, last, depth }) => {
          const branch = depth === 0 ? '' : prefix + (last ? '└─' : '├─')
          const resolved = n.status === 'resolved'
          const open = n.status === 'open'
          const litMain = L.mainOn && L.P === n.id && open
          const bg = (L.bgOf[n.id] ?? 0) > 0 && open
          const litBgOnly = bg && !litMain
          const planned = open && n.startedAt === undefined && !litMain && !litBgOnly
          const paused = open && n.startedAt !== undefined && !litMain && !litBgOnly

          const marker = resolved ? '●' : litMain ? mainFrame : litBgOnly ? bgFrame : paused ? '◐' : '○'
          const markerColor = litMain || litBgOnly ? 'claude' : resolved ? 'subtle' : undefined
          const markerDim = resolved || planned
          const suffix = litMain && bg ? ` +${L.bgOf[n.id]}` : ''

          return (
            <Box key={n.id} flexDirection="row" gap={1}>
              <Text color={markerColor} dimColor={markerDim} weight={litMain ? 'semibold' : undefined}>
                {`${branch}${marker}`}
              </Text>
              <Text
                dimColor={resolved}
                weight={litMain ? 'semibold' : undefined}
                wrap="truncate-end"
                color={litMain ? 'claude' : undefined}
              >
                {n.title.slice(0, titleW)}
              </Text>
              {suffix ? <Text dimColor>{suffix}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}

// ---------- link / unlink (현 root에 노드 0개·대상에 link 없음·대상≠현 root일 때만) ----------
async function linkCmd($: any, path: string): Promise<string> {
  const target = path.trim()
  const { root } = await treeOf($)
  if (target === root) return `거부: 대상이 현재 root와 같음`
  const hasHere = await loadTree($) // 현 root 기준 노드가 있으면 섞임 방지로 거부
  if (Object.keys(hasHere).length > 0) return `거부: 현재 트리에 노드가 있어 link 불가`
  if (await targetHasLink($, target)) return `거부: 대상에 이미 link 있음`
  await setLink($, target)
  await loadTree($)
  return `link → ${target}`
}
async function unlinkCmd($: any): Promise<string> {
  await clearLink($)
  await loadTree($)
  return `unlink`
}

// 가드 26(가) 정적검사용(비런타임): register.tsx의 비export 헬퍼 소스를 테스트가 들여다볼 수 있게 노출한다.
// 실기기 fs가 테스트 런타임에 없어 파일 전체 텍스트를 못 읽으므로, 이 집합의 toString으로
// register 내부 헬퍼(bgTask 등)에 `$.store.set` 주입이 없음을 검사한다. 런타임 동작엔 영향 없음.
export const __guardInternals = {
  bgTask, afterWrite, ensureTimer, registerSurface, adoptOrphans, linkCmd, unlinkCmd, str, strArr,
}
