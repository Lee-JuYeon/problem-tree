import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { PtreeTree, PtreeNode, PtreeUi, PtreeHistory } from '../types'

const PANE = 'problem-tree'
const STALE_DAYS = 2
const DAY = 86_400_000
const TITLE_MAX = 16
const FRAME_MS = 400
// current(진행 중) 애니메이션: 비었다 차오르고 꽉 찬 채 한 박자 머묾
const FRAMES = ['○', '◐', '●', '●'] as const

const EMPTY_TREE: PtreeTree = { version: 1, seq: 0, nodes: {}, focusId: undefined, rejected: [] }
const EMPTY_UI: PtreeUi = { running: false }

const treeAtom = atom({ plugin: 'problem-tree', key: 'tree' } as const, EMPTY_TREE)
const uiAtom = atom({ plugin: 'problem-tree', key: 'ui' } as const, EMPTY_UI)

// 메인 턴이 도는 동안만 돌리는 애니메이션 타이머(모듈 변수 → 리로드 시 초기화)
let animTimer: Timer | undefined

// ---------- pure helpers (operate on a cloned draft) ----------

const keyFor = (cwd: string) => `tree:${cwd}`
const clone = (t: PtreeTree): PtreeTree => JSON.parse(JSON.stringify(t))
const norm = (s: string) => s.toLowerCase().replace(/[.,!?;:·]/g, '').replace(/\s+/g, ' ').trim()

function log(n: PtreeNode, at: number, event: PtreeHistory['event'], by: PtreeHistory['by'], ref?: string) {
  n.history.push({ at, event, by, ref })
  if (n.history.length > 20) n.history = n.history.slice(-20)
}

const resolveParent = (t: PtreeTree, want?: string): string | undefined => (want && t.nodes[want] ? want : undefined)

function addNode(t: PtreeTree, title: string, by: 'user' | 'claude', at: number, opts?: { parent?: string }): PtreeNode {
  const id = 'n' + ++t.seq
  // 사용자(/ptree add)는 지금 focus 밑에 잇는다. Claude는 focus를 상속하지 않는다:
  // parentId 생략 = 루트(독립 문제). 숨은 상태(focusId)에 따라 붙는 자리가 달라지면 안 됨.
  const parent = resolveParent(t, by === 'user' ? (opts?.parent ?? t.focusId) : opts?.parent)
  const node: PtreeNode = {
    id,
    title: title.slice(0, TITLE_MAX),
    status: 'open',
    createdAt: at,
    touchedAt: at,
    parent,
    reopenCount: 0,
    history: [],
  }
  log(node, at, 'add', by)
  t.nodes[id] = node
  // 사용자가 직접 추가하면 그걸 작업하려는 것 → focus 이동.
  // Claude가 턴 도중 추가한 건 지금 하는 일(current)을 뺏으면 안 됨 → focus 유지.
  if (by === 'user') t.focusId = id
  return node
}

// 해결 뒤 focus: 부모가 open이면 부모로, 아니면 없음(손 안 댄 노드로 튀어 ○→◐ 오염되는 걸 막음)
function refocusAfterResolve(t: PtreeTree, resolvedId: string) {
  const cur = t.focusId
  if (cur !== resolvedId && cur && t.nodes[cur]?.status === 'open') return
  const parent = t.nodes[resolvedId]?.parent
  t.focusId = parent && t.nodes[parent]?.status === 'open' ? parent : undefined
}

function doResolve(t: PtreeTree, id: string, at: number, by: 'user' | 'claude', alsoResolves?: string[]) {
  const n = t.nodes[id]
  if (!n || n.status !== 'open') return
  n.status = 'resolved'
  n.resolvedAt = at
  n.touchedAt = at
  log(n, at, 'resolve', by)
  for (const other of alsoResolves ?? []) {
    const o = t.nodes[other]
    if (o && o.status === 'open') {
      o.status = 'resolved'
      o.resolvedAt = at
      o.touchedAt = at
      o.resolvedBy = id
      log(o, at, 'merge', by, id)
    }
  }
  refocusAfterResolve(t, id)
}

function doReopen(t: PtreeTree, id: string, at: number, by: 'user' | 'claude') {
  const n = t.nodes[id]
  if (!n || n.status !== 'resolved') return
  n.status = 'open'
  n.reopenCount++
  n.touchedAt = at
  n.resolvedAt = undefined
  n.resolvedBy = undefined
  // startedAt은 지우지 않는다 — 재개된 건 "멈춤"이 맞다
  log(n, at, 'reopen', by)
  t.focusId = id
}

function doRemove(t: PtreeTree, id: string) {
  const n = t.nodes[id]
  if (!n) return
  // 자식은 삭제 노드의 부모로 승격(고아 방지)
  for (const c of Object.values(t.nodes)) if (c.parent === id) c.parent = n.parent
  t.rejected = [...t.rejected, norm(n.title)].slice(-50)
  delete t.nodes[id]
  if (t.focusId === id) t.focusId = undefined
}

// id를 newParent 밑에 달면 순환이 되는가. newParent에서 부모를 타고 올라가다 id를 만나면 순환.
// newParent === id(자기 자신)도 여기서 잡힌다. 이미 순환인 사슬 밑으로도 못 단다(방문집합으로 멈춤).
function wouldCycle(t: PtreeTree, id: string, newParent?: string): boolean {
  const seen = new Set<string>()
  let cur = newParent
  while (cur !== undefined && t.nodes[cur]) {
    if (cur === id || seen.has(cur)) return true
    seen.add(cur)
    cur = t.nodes[cur]?.parent
  }
  return false
}

// 이동 거부 사유(없으면 undefined). 최종 판정은 doMove가 쓰기 시점 트리로 내린다 —
// 핸들러의 사전 호출은 빠른 거부(쓸데없는 저장 방지) 전용이다.
function moveError(t: PtreeTree, id: string, newParent?: string): string | undefined {
  const n = t.nodes[id]
  if (!n) return `없는 노드: ${id}`
  if (newParent !== undefined && !t.nodes[newParent]) return `없는 부모: ${newParent} — 목록으로 확인(루트로 보내려면 부모 id를 생략)`
  if (newParent === id) return `거부: ${id}를 자기 자신 밑으로 옮길 수 없음`
  if (wouldCycle(t, id, newParent)) return `거부: ${newParent}는 ${id}의 하위 노드 — 순환이 됨`
  if (n.parent === newParent) return `변화 없음: ${id}는 이미 ${newParent ? '부모 ' + newParent : '루트'}`
  return undefined
}

// 서브트리째 옮긴다(자식의 parent는 그대로 → 따라옴). 구조 편집이라 focus·touchedAt은 안 건드림.
// 반환 = 실제로 일어난 일의 문구. 쓰기 시점 트리로 다시 판정하므로(같은 턴의 다른 호출이 먼저
// 트리를 바꿨을 수 있다) 호출자는 사전 판정이 아니라 이 반환값을 그대로 사용자/모델에게 돌려준다.
function doMove(t: PtreeTree, id: string, newParent: string | undefined, at: number, by: 'user' | 'claude'): string {
  const err = moveError(t, id, newParent)
  const n = t.nodes[id]
  if (err || !n) return err ?? `없는 노드: ${id}`
  n.parent = newParent
  log(n, at, 'move', by, newParent)
  const willPrune = newParent === undefined && n.status === 'resolved' ? ' (하위까지 전부 완료면 다음 턴 시작 때 정리됨)' : ''
  return `이동 ${id} → ${newParent ? '부모 ' + newParent : '루트'}${willPrune}`
}

// 부모 링크 정리: ①없는 노드를 가리키는 parent → 루트로 ②순환 → 끊는다(순환에 낀 노드를 루트로).
// ①을 두면 화면엔 루트로 보이다가 나중에 그 id의 노드가 생기면 그 밑으로 딸려 들어간다.
// ②는 패널에서 노드를 숨기고 pruneDone 재귀를 터뜨린다(스택 초과 → 훅 skip).
// 정상 트리에선 아무것도 안 바꾼다.
function repairParents(t: PtreeTree) {
  for (const n of Object.values(t.nodes)) if (n.parent !== undefined && !t.nodes[n.parent]) n.parent = undefined
  for (const n of Object.values(t.nodes)) {
    const seen = new Set<string>([n.id])
    let cur = n.parent
    while (cur !== undefined && t.nodes[cur]) {
      if (cur === n.id) {
        n.parent = undefined
        break
      }
      if (seen.has(cur)) break // n이 끼지 않은 순환 — 그 노드 차례에 끊긴다
      seen.add(cur)
      cur = t.nodes[cur]?.parent
    }
  }
}

// ---------- staleness / pruning / layout ----------

const staleDays = (n: PtreeNode, now: number) => Math.floor((now - n.touchedAt) / DAY)

type Row = { node: PtreeNode; prefix: string; last: boolean; depth: number }

// 완료된 "나무" 정리(사용자 확정 B=다음 턴 시작 때 호출, b=완료 가지 접기).
// - 루트~잎 전부 resolved → 그 나무 통째 삭제(흔적 지움 = 미해결만 남긴다는 본질)
// - 열린 조상 밑의 "완료 가지"(그 노드+자손 전부 resolved) → 자손만 지우고 노드는 ● 한 줄로 접음
// 부모 자동완료는 안 함(부모도 문제 본체). rejected는 안 건드림(같은 제목 재추가 가능).
function pruneDone(t: PtreeTree) {
  repairParents(t) // 아래 재귀는 순환·끊긴 부모 없는 트리를 전제한다
  const nodes = t.nodes
  const childrenOf = (id: string) => Object.values(nodes).filter(n => n.parent === id)
  const fullyResolved = (id: string): boolean => {
    const n = nodes[id]
    if (!n || n.status !== 'resolved') return false
    return childrenOf(id).every(c => fullyResolved(c.id))
  }
  const descendants = (id: string, acc: string[] = []): string[] => {
    for (const c of childrenOf(id)) {
      acc.push(c.id)
      descendants(c.id, acc)
    }
    return acc
  }
  const del = new Set<string>()
  for (const n of Object.values(nodes)) {
    if (!fullyResolved(n.id)) continue
    const parent = n.parent ? nodes[n.parent] : undefined
    if (parent && fullyResolved(parent.id)) continue // 완료 가지의 꼭대기만 처리(위에서 흡수됨)
    if (!parent) del.add(n.id) // 루트 완료 → 자기까지(나무 통째)
    descendants(n.id).forEach(id => del.add(id)) // 자손은 두 경우 다 삭제
  }
  for (const id of del) delete nodes[id]
  if (t.focusId && !nodes[t.focusId]) t.focusId = undefined
}

function layout(t: PtreeTree): Row[] {
  const kids: Record<string, PtreeNode[]> = {}
  const roots: PtreeNode[] = []
  for (const n of Object.values(t.nodes)) {
    const p = n.parent && t.nodes[n.parent] ? n.parent : undefined
    if (p) (kids[p] ||= []).push(n)
    else roots.push(n)
  }
  const byAge = (a: PtreeNode, b: PtreeNode) => a.createdAt - b.createdAt
  roots.sort(byAge)
  Object.values(kids).forEach(list => list.sort(byAge))
  const rows: Row[] = []
  const walk = (list: PtreeNode[], prefix: string, depth: number) => {
    list.forEach((n, i) => {
      const last = i === list.length - 1
      rows.push({ node: n, prefix, last, depth })
      // 루트(depth 0)는 세로선 없이 자식이 바로 ├─/└─로 붙는다
      const childPrefix = depth === 0 ? '' : prefix + (last ? '  ' : '│ ')
      const ks = kids[n.id]
      if (ks) walk(ks, childPrefix, depth + 1)
    })
  }
  walk(roots, '', 0)
  return rows
}

// current = 메인 턴이 도는 중 + 그 노드가 focus + open
const isCurrent = (t: PtreeTree, n: PtreeNode, running: boolean) => running && t.focusId === n.id && n.status === 'open'

// ---------- store-backed mutation ----------

async function apply($: any, mutator: (t: PtreeTree, at: number) => void) {
  const at = await $.clock.now()
  const ui = (await read($, uiAtom)) as PtreeUi
  await update($, treeAtom, (prev: PtreeTree) => {
    const out = clone(prev)
    mutator(out, at)
    // 턴이 도는 동안 focus된 open 노드 = 지금 작업 중.
    // startedAt은 최초 1회(계획만○ → 진행중/멈춤 전환점), touchedAt은 매번 갱신
    // (작업 중인 노드가 ⚠방치로 잘못 뜨는 것 방지 — turn.start마다 이 지점을 지남).
    if (ui.running && out.focusId) {
      const f = out.nodes[out.focusId]
      if (f && f.status === 'open') {
        if (f.startedAt === undefined) f.startedAt = at
        f.touchedAt = at
      }
    }
    return out
  })
  const latest = await read($, treeAtom)
  const cwd = await $.session.cwd()
  await $.store.set(keyFor(cwd), latest)
}

const setUi = ($: any, patch: Partial<PtreeUi>) => update($, uiAtom, (u: PtreeUi) => ({ ...u, ...patch }))

function listText(t: PtreeTree, now: number, running: boolean): string {
  const ns = Object.values(t.nodes).sort((a, b) => a.createdAt - b.createdAt)
  if (ns.length === 0) return '(문제 노드 없음)'
  return ns
    .map(n => {
      const tag =
        n.status === 'resolved'
          ? 'resolved'
          : isCurrent(t, n, running)
            ? 'current'
            : n.startedAt === undefined
              ? 'planned'
              : `paused ${staleDays(n, now)}d`
      const par = n.parent ? ` ←${n.parent}` : ''
      const nt = n.note ? ` 📝${n.note}` : ''
      return `${n.id} [${tag}] ${n.title}${par}${nt}`
    })
    .join('\n')
}

// ---------- tool input helper ----------

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const tooLong = (s: string) => s.length > TITLE_MAX

// =================================================================

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ptree',
      description: '문제해결 노드트리 패널',
      argumentHint: '[add <제목> | resolve <id> | reopen <id> | focus <id> | rename <id> <제목> | rm <id> | move <id> [부모id] | note <id> <글> | list]',
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
        '지금부터 이 노드를 작업한다고 선언한다 → 진행중(current, 애니메이션 ●). 사용자 승인 불필요, Claude가 작업 대상을 바꿀 때마다 자동으로 호출한다. 메인 턴이 도는 동안 focus된 open 노드가 current, 턴이 끝나면 멈춤(◐)으로 남는다.',
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

    // cross-session store → atom 시드 (+ 구버전 proposed 노드 마이그레이션)
    const cwd = await $.session.cwd()
    const saved = (await $.store.get(keyFor(cwd))) as PtreeTree | undefined
    if (saved && saved.version === 1) {
      for (const n of Object.values(saved.nodes)) {
        const anyN = n as any
        if (anyN.status === 'proposed') anyN.status = 'open'
        delete anyN.pending
        delete anyN.proposalReason
      }
      pruneDone(saved) // 재로드 시 이미 완료된 나무는 정리하고 시드
      await update($, treeAtom, () => saved)
      await $.store.set(keyFor(cwd), saved)
    }

    void $.ui.open({ id: PANE, title: '문제트리', columns: 48 })
    // stale 일수 갱신용(느린 주기). current 애니메이션은 turn.start가 켠다.
    $.clock.every(3_600_000, () => void $.ui.invalidate('ui.render'))

    return next(e)
  })

  // ---------- 메인 턴이 도는 동안만 current 애니메이션 ----------
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // 서브에이전트 턴은 무시
    await setUi($, { running: true })
    if (!animTimer) animTimer = $.clock.every(FRAME_MS, () => void $.ui.invalidate('ui.render'))
    await apply($, t => pruneDone(t)) // 완료된 나무 정리(B) + focus된 open 노드 startedAt 기록
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (animTimer) {
      animTimer.cancel()
      animTimer = undefined
    }
    await setUi($, { running: false })
    void $.ui.invalidate('ui.render')
    return next(e)
  })

  // ---------- slash command ----------
  on('command.run', { command: 'ptree' }, async ($, e) => {
    const raw = (e.args ?? '').trim()
    const sp = raw.indexOf(' ')
    const sub = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase()
    const rest = sp === -1 ? '' : raw.slice(sp + 1).trim()
    await $.ui.open({ id: PANE, title: '문제트리', columns: 48 })

    if (sub === 'add' && rest) {
      const title = rest.slice(0, TITLE_MAX)
      await apply($, (t, at) => addNode(t, title, 'user', at))
      return { text: `노드 추가: "${title}"` }
    }
    if (sub === 'resolve' && rest) {
      const n = (await read($, treeAtom)).nodes[rest]
      if (!n) return { text: `없는 노드: ${rest}` }
      if (n.status !== 'open') return { text: `${rest}는 open이 아님(${n.status}) — 해결 불가` }
      await apply($, (t, at) => doResolve(t, rest, at, 'user'))
      return { text: `${rest} 해결` }
    }
    if (sub === 'reopen' && rest) {
      const n = (await read($, treeAtom)).nodes[rest]
      if (!n) return { text: `없는 노드: ${rest}` }
      if (n.status !== 'resolved') return { text: `${rest}는 resolved가 아님(${n.status}) — 재개 불가` }
      await apply($, (t, at) => doReopen(t, rest, at, 'user'))
      return { text: `${rest} 재개` }
    }
    if (sub === 'focus' && rest) {
      const n = (await read($, treeAtom)).nodes[rest]
      if (!n) return { text: `없는 노드: ${rest}` }
      if (n.status !== 'open') return { text: `${rest}는 open이 아님(${n.status}) — 포커스 불가` }
      await apply($, (t, at) => {
        const x = t.nodes[rest]
        if (x) {
          t.focusId = rest
          x.touchedAt = at
          log(x, at, 'focus', 'user')
        }
      })
      return { text: `포커스: ${rest}` }
    }
    if (sub === 'rename' && rest) {
      const s2 = rest.indexOf(' ')
      const id = s2 === -1 ? rest : rest.slice(0, s2)
      const title = (s2 === -1 ? '' : rest.slice(s2 + 1).trim()).slice(0, TITLE_MAX)
      if (!title) return { text: `사용법: /ptree rename <id> <새 제목>` }
      const t0 = await read($, treeAtom)
      if (!t0.nodes[id]) return { text: `없는 노드: ${id}` }
      if (Object.values(t0.nodes).some(x => x.id !== id && norm(x.title) === norm(title))) return { text: `중복 제목` }
      await apply($, (t, at) => {
        const x = t.nodes[id]
        if (x) {
          x.title = title
          log(x, at, 'rename', 'user')
        }
      })
      return { text: `이름 변경 ${id}: ${title}` }
    }
    if (sub === 'rm' && rest) {
      if (!(await read($, treeAtom)).nodes[rest]) return { text: `없는 노드: ${rest}` }
      await apply($, t => doRemove(t, rest))
      return { text: `삭제: ${rest}` }
    }
    if (sub === 'move' && rest) {
      const [id = '', to] = rest.split(/\s+/)
      const err = moveError(await read($, treeAtom), id, to)
      if (err) return { text: err }
      let done = ''
      await apply($, (t, at) => {
        done = doMove(t, id, to, at, 'user')
      })
      return { text: done }
    }
    if (sub === 'note' && rest) {
      const s2 = rest.indexOf(' ')
      const id = s2 === -1 ? rest : rest.slice(0, s2)
      const text = s2 === -1 ? '' : rest.slice(s2 + 1)
      if (!(await read($, treeAtom)).nodes[id]) return { text: `없는 노드: ${id}` }
      await apply($, (t, at) => {
        const n = t.nodes[id]
        if (n) {
          n.note = text
          n.touchedAt = at
          log(n, at, 'note', 'user')
        }
      })
      return { text: `메모 저장: ${id}` }
    }
    if (sub === 'list') {
      const t = await read($, treeAtom)
      const ui = await read($, uiAtom)
      const now = await $.clock.now()
      return { text: listText(t, now, ui.running) }
    }
    return { text: '문제트리 패널을 열었습니다.' }
  })

  // ---------- registered tools ----------
  on('tool.call', { tool: 'mcp__problem-tree__add_problem' }, async ($, e) => {
    const title = str((e as any).title)
    const parentId = str((e as any).parentId) || undefined
    if (!title) return { result: '거부: title 비어 있음' }
    if (tooLong(title)) return { result: `거부: 제목 ${TITLE_MAX}자 이내로(지금 ${title.length}자). 더 짧게 다시.` }
    const t0 = await read($, treeAtom)
    const nn = norm(title)
    const dup = Object.values(t0.nodes).find(n => n.status !== 'resolved' && norm(n.title) === nn)
    if (dup) return { result: `중복: 이미 ${dup.id} 로 존재(무시됨)` }
    if (t0.rejected.includes(nn)) return { result: `전에 삭제된 제목(무시됨)` }
    if (parentId && !t0.nodes[parentId]) return { result: `없는 부모: ${parentId} — 추가 안 됨. list_problems로 확인(루트면 parentId 생략)` }
    let out = ''
    await apply($, (t, at) => {
      // 쓰기 시점 재검사(apply는 직렬화 → 같은 제목 병렬 add도 하나만 통과, 선재 틈 차단)
      const d = Object.values(t.nodes).find(n => n.status !== 'resolved' && norm(n.title) === nn)
      if (d) {
        out = `중복: 이미 ${d.id} 로 존재(무시됨)`
        return
      }
      if (t.rejected.includes(nn)) {
        out = `전에 삭제된 제목(무시됨)`
        return
      }
      if (parentId && !t.nodes[parentId]) {
        out = `없는 부모: ${parentId} — 추가 안 됨. list_problems로 확인(루트면 parentId 생략)`
        return
      }
      const node = addNode(t, title, 'claude', at, { parent: parentId })
      out = `추가 ${node.id}(계획만 ○, ${node.parent ? '부모 ' + node.parent : '루트'}) — focus는 그대로`
    })
    return { result: out }
  })

  on('tool.call', { tool: 'mcp__problem-tree__resolve_problem' }, async ($, e) => {
    const id = str((e as any).nodeId)
    const also = strArr((e as any).alsoResolves)
    const t0 = await read($, treeAtom)
    const n = t0.nodes[id]
    if (!n) return { result: `없는 노드: ${id}` }
    if (n.status !== 'open') return { result: `${id}는 open 상태가 아님(${n.status})` }
    await apply($, (t, at) => doResolve(t, id, at, 'claude', also))
    return { result: `해결 ${id}${also.length ? ` (+${also.join(',')})` : ''}` }
  })

  on('tool.call', { tool: 'mcp__problem-tree__reopen_problem' }, async ($, e) => {
    const id = str((e as any).nodeId)
    const t0 = await read($, treeAtom)
    const n = t0.nodes[id]
    if (!n) return { result: `없는 노드: ${id} — 완료돼 삭제된 문제면 재발 시 add_problem으로 새로 만들어` }
    if (n.status !== 'resolved') return { result: `${id}는 resolved 상태가 아님(${n.status})` }
    await apply($, (t, at) => doReopen(t, id, at, 'claude'))
    return { result: `재개 ${id}` }
  })

  // 지금부터 이 노드를 작업한다 → focus 이동. 턴이 도는 중이면 즉시 current가 됨.
  on('tool.call', { tool: 'mcp__problem-tree__focus_problem' }, async ($, e) => {
    const id = str((e as any).nodeId)
    const t0 = await read($, treeAtom)
    const n = t0.nodes[id]
    if (!n) return { result: `없는 노드: ${id}` }
    if (n.status !== 'open') return { result: `${id}는 open이 아님(${n.status}) — 작업 대상 불가` }
    await apply($, (t, at) => {
      const x = t.nodes[id]
      if (x) {
        t.focusId = id
        x.touchedAt = at
        log(x, at, 'focus', 'claude')
      }
    })
    return { result: `작업 시작 ${id}(진행중 ●)` }
  })

  on('tool.call', { tool: 'mcp__problem-tree__rename_problem' }, async ($, e) => {
    const id = str((e as any).nodeId)
    const title = str((e as any).title)
    if (!title) return { result: '거부: title 비어 있음' }
    if (tooLong(title)) return { result: `거부: 제목 ${TITLE_MAX}자 이내로(지금 ${title.length}자). 더 짧게 다시.` }
    const t0 = await read($, treeAtom)
    if (!t0.nodes[id]) return { result: `없는 노드: ${id}` }
    if (Object.values(t0.nodes).some(x => x.id !== id && norm(x.title) === norm(title))) return { result: `중복 제목(무시됨)` }
    await apply($, (t, at) => {
      const x = t.nodes[id]
      if (x) {
        x.title = title
        log(x, at, 'rename', 'claude')
      }
    })
    return { result: `이름 변경 ${id}: ${title}` }
  })

  on('tool.call', { tool: 'mcp__problem-tree__move_problem' }, async ($, e) => {
    const id = str((e as any).nodeId)
    const to = str((e as any).newParentId) || undefined
    const err = moveError(await read($, treeAtom), id, to) // 빠른 거부
    if (err) return { result: err }
    let done = ''
    await apply($, (t, at) => {
      done = doMove(t, id, to, at, 'claude') // 쓰기 시점 판정 = 실제 결과
    })
    return { result: done }
  })

  on('tool.call', { tool: 'mcp__problem-tree__list_problems' }, async ($, _e) => {
    const t = await read($, treeAtom)
    const ui = await read($, uiAtom)
    const now = await $.clock.now()
    return { result: listText(t, now, ui.running) }
  })

  // ---------- pane ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const t = await read($, treeAtom)
    const ui = await read($, uiAtom)
    const now = await $.clock.now()
    const cols = e.viewport?.columns ?? 48

    const rows = layout(t)
    const titleW = Math.max(10, cols - 16)
    const frame = FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length]

    return (
      <Box flexDirection="column" gap={0}>
        {rows.length === 0 && <Text dimColor>문제 노드가 없습니다. /ptree add 제목</Text>}

        {rows.map(({ node: n, prefix, last, depth }) => {
          // 루트(depth 0)는 커넥터 없이 마커만. 자식부터 ├─/└─로 자연스레 이어진다.
          const branch = depth === 0 ? '' : prefix + (last ? '└─' : '├─')
          const resolved = n.status === 'resolved'
          const open = n.status === 'open'
          const current = isCurrent(t, n, ui.running)
          const planned = open && n.startedAt === undefined && !current
          const paused = open && n.startedAt !== undefined && !current
          const days = staleDays(n, now)
          const stale = (planned || paused) && days >= STALE_DAYS

          const marker = resolved ? '●' : current ? frame : paused ? '◐' : '○'
          const markerColor = current ? 'claude' : stale ? 'warning' : resolved ? 'subtle' : undefined
          const markerDim = resolved || planned

          return (
            <Box key={n.id} flexDirection="row" gap={1}>
              <Text color={markerColor} dimColor={markerDim}>
                {`${branch}${stale ? '⚠' : ''}${marker}`}
              </Text>
              <Text dimColor={resolved} weight={current ? 'semibold' : undefined} wrap="truncate-end" color={current ? 'claude' : undefined}>
                {n.title.slice(0, titleW)}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
