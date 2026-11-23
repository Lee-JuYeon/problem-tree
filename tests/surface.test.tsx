// 특성화(characterization): 리팩토링 전에 "지금 이렇게 보이고 이렇게 답한다"를 글자 그대로 잠근다.
// 표면 = 등록되는 커맨드·도구, 도구/커맨드가 돌려주는 문구, 패널이 그리는 줄.
import { expect, test } from 'claude-code/testing'
import { boot, start, run, call, turnStart, turnDone, nodeIds, mountPane, bash, stop, ROOT } from './harness'

const addId = async ($: any, store: any, title: string, parentId?: string): Promise<string> => {
  const before = new Set(nodeIds(store))
  await call($, 'add_problem', { title, ...(parentId ? { parentId } : {}) })
  return nodeIds(store).find(id => !before.has(id))!
}
const res = async (p: Promise<{ result?: unknown }>) => String((await p).result)
const cmd = async ($: any, args: string) => String(((await run($, args)) as any).text)
const lines = async ($: any): Promise<string[]> => {
  const ui = await mountPane($)
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text ?? '')
}

test('S1: session.start가 등록하는 표면 — 커맨드 1개·도구 7개·패널 1개', async ($, on) => {
  const { store } = boot(on)
  await start($)
  expect(store.commands.map(c => c.name)).toEqual(['ptree'])
  expect(store.commands[0].argumentHint).toBe(
    '[add <제목> | resolve <id> | reopen <id> | focus <id> | rename <id> <제목> | rm <id> | move <id> [부모id] | note <id> <글> | link <경로> | unlink | list]',
  )
  expect(store.tools.map(t => [t.name, t.isDeferred, (t.inputSchema.required ?? []).join(','), Object.keys(t.inputSchema.properties).join(',')])).toEqual([
    ['add_problem', false, 'title', 'title,parentId'],
    ['resolve_problem', false, 'nodeId,reason', 'nodeId,reason,alsoResolves'],
    ['reopen_problem', false, 'nodeId,reason', 'nodeId,reason'],
    ['rename_problem', false, 'nodeId,title', 'nodeId,title'],
    ['focus_problem', false, 'nodeId', 'nodeId'],
    ['list_problems', false, '', ''],
    ['move_problem', false, 'nodeId', 'nodeId,newParentId'],
  ])
  expect(store.tools.every(t => typeof t.description === 'string' && t.description.length > 10)).toBe(true)
  expect(store.opens).toEqual([{ id: 'problem-tree', title: '문제트리', columns: 48 }])
})

test('S2: MCP 도구가 돌려주는 문구(성공·거부 전부)', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  await start($)
  expect(await res(call($, 'list_problems', {}))).toBe('(문제 노드 없음)')
  expect(await res(call($, 'add_problem', { title: '' }))).toBe('거부: title 비어 있음')
  expect(await res(call($, 'add_problem', { title: '가나다라마바사아자차카타파하가나다' }))).toBe('거부: 제목 16자 이내로(지금 17자). 더 짧게 다시.')
  expect(await res(call($, 'add_problem', { title: 'A', parentId: 'zzzz' }))).toBe(
    '없는 부모: zzzz — 추가 안 됨. list_problems로 확인(루트면 parentId 생략)',
  )
  const out = await res(call($, 'add_problem', { title: '루트 문제' }))
  const a = nodeIds(store)[0]!
  expect(out.replaceAll(a, 'ID')).toBe(ADD_ROOT)
  expect(await res(call($, 'add_problem', { title: '루트  문제!' }))).toBe(`중복: 이미 ${a} 로 존재(무시됨)`)
  await bt.clock.advance(1000)
  const before = new Set(nodeIds(store))
  const outChild = await res(call($, 'add_problem', { title: '자식', parentId: a }))
  const b = nodeIds(store).find(id => !before.has(id))!
  expect(outChild.replaceAll(a, 'PA').replaceAll(b, 'ID')).toBe(ADD_CHILD)
  expect(await res(call($, 'focus_problem', { nodeId: 'zzzz' }))).toBe('없는 노드: zzzz')
  expect(await res(call($, 'focus_problem', { nodeId: b }))).toBe(`작업 시작 ${b}(진행중 ●)`)
  expect(await res(call($, 'rename_problem', { nodeId: b, title: '' }))).toBe('거부: title 비어 있음')
  expect(await res(call($, 'rename_problem', { nodeId: b, title: '루트 문제' }))).toBe('중복 제목(무시됨)')
  expect(await res(call($, 'rename_problem', { nodeId: b, title: '새이름' }))).toBe(`이름 변경 ${b}: 새이름`)
  expect(await res(call($, 'move_problem', { nodeId: a, newParentId: b }))).toBe(`거부: ${b}는 ${a}의 하위 노드 — 순환이 됨`)
  expect(await res(call($, 'move_problem', { nodeId: a, newParentId: a }))).toBe(`거부: ${a}를 자기 자신 밑으로 옮길 수 없음`)
  expect(await res(call($, 'move_problem', { nodeId: b, newParentId: a }))).toBe(`변화 없음: ${b}는 이미 부모 ${a}`)
  expect(await res(call($, 'move_problem', { nodeId: b, newParentId: 'zzzz' }))).toBe(
    '없는 부모: zzzz — 목록으로 확인(루트로 보내려면 부모 id를 생략)',
  )
  expect(await res(call($, 'move_problem', { nodeId: b }))).toBe(`이동 ${b} → 루트`)
  expect(await res(call($, 'move_problem', { nodeId: b, newParentId: a }))).toBe(`이동 ${b} → 부모 ${a}`)
  expect(await res(call($, 'reopen_problem', { nodeId: b, reason: 'r' }))).toBe(`${b}는 resolved 상태가 아님(open)`)
  expect(await res(call($, 'resolve_problem', { nodeId: b, reason: 'r', alsoResolves: [a] }))).toBe(`해결 ${b} (+${a})`)
  expect(await res(call($, 'resolve_problem', { nodeId: b, reason: 'r' }))).toBe(`${b}는 open 상태가 아님(resolved)`)
  expect(await res(call($, 'reopen_problem', { nodeId: b, reason: 'r' }))).toBe(`재개 ${b}`)
  expect(await res(call($, 'reopen_problem', { nodeId: 'zzzz', reason: 'r' }))).toBe(
    '없는 노드: zzzz — 완료돼 삭제된 문제면 재발 시 add_problem으로 새로 만들어',
  )
  expect((await res(call($, 'list_problems', {}))).replaceAll(a, 'AAAA').replaceAll(b, 'BBBB')).toBe(LIST_1)
})

test('S3: /ptree 커맨드가 돌려주는 문구', async ($, on) => {
  const bt = boot(on)
  const { store } = bt
  await start($)
  expect(await cmd($, '')).toBe('문제트리 패널을 열었습니다.')
  expect(await cmd($, 'nonsense x')).toBe('문제트리 패널을 열었습니다.')
  expect(await cmd($, 'add')).toBe('문제트리 패널을 열었습니다.')
  expect(await cmd($, 'add 사용자 문제')).toBe('노드 추가: "사용자 문제"')
  const a = nodeIds(store)[0]!
  await bt.clock.advance(1000)
  expect(await cmd($, 'add 가나다라마바사아자차카타파하가나다라마')).toBe('노드 추가: "가나다라마바사아자차카타파하가나"') // 16자로 잘림
  const b = nodeIds(store).find(id => id !== a)!
  expect(await cmd($, `rename ${b}`)).toBe('사용법: /ptree rename <id> <새 제목>')
  expect(await cmd($, `rename ${b} 둘째`)).toBe(`이름 변경 ${b}: 둘째`)
  expect(await cmd($, `note ${b} 메모 한 줄`)).toBe(`메모 저장: ${b}`)
  expect(await cmd($, `focus ${a}`)).toBe(`포커스: ${a}`)
  expect(await cmd($, `move ${b}`)).toBe(`이동 ${b} → 루트`)
  expect(await cmd($, `move ${b} ${a}`)).toBe(`이동 ${b} → 부모 ${a}`)
  expect((await cmd($, 'list')).replaceAll(a, 'AAAA').replaceAll(b, 'BBBB')).toBe(LIST_2)
  expect(await cmd($, `resolve ${b}`)).toBe(`해결 ${b}`)
  expect(await cmd($, `reopen ${b}`)).toBe(`재개 ${b}`)
  expect(await cmd($, `rm ${b}`)).toBe(`삭제: ${b}`)
  expect(await cmd($, `rm ${b}`)).toBe(`없는 노드: ${b}`)
  expect(await cmd($, 'add 둘째')).toBe('전에 삭제된 제목(무시됨)')
  expect(await cmd($, `link ${ROOT}`)).toBe('거부: 대상이 현재 root와 같음')
  expect(await cmd($, 'link /elsewhere')).toBe('거부: 현재 트리에 노드가 있어 link 불가')
  expect(await cmd($, 'unlink')).toBe('unlink')
  expect(store.opens.length).toBe(1 + 20) // session.start 1 + 커맨드마다 패널 열기
})

test('S4: 패널이 그리는 줄(빈 트리·가지·마커·머리줄)', async ($, on) => {
  const b = boot(on)
  const { store } = b
  await start($)
  expect(await lines($)).toEqual(['문제 노드가 없습니다. /ptree add 제목'])
  const a = await addId($, store, '뿌리')
  await b.clock.advance(1000)
  const c1 = await addId($, store, '가지1', a)
  await b.clock.advance(1000)
  const c2 = await addId($, store, '가지2', a)
  await b.clock.advance(1000)
  const g = await addId($, store, '손자', c1)
  await b.clock.advance(1000)
  await addId($, store, '둘째뿌리')
  expect(await lines($)).toEqual(PANE_PLANNED)
  await turnStart($, 't1')
  expect((await lines($))[0]).toMatch(/^[○◐●] 작업 중 · 노드 미지정$/)
  await call($, 'focus_problem', { nodeId: g })
  await bash($, { __bg: 'bg1' })
  await turnDone($, 't1')
  await stop($, [{ id: 'bg1', type: 'shell', status: 'running', description: 'x' }, { id: 'bg2', type: 'shell', status: 'running', description: 'y' }])
  await call($, 'resolve_problem', { nodeId: c2, reason: 'r' })
  const got = await lines($)
  expect(got.map(t => t.replace(/[◇◈◆]/g, '◆'))).toEqual(PANE_MIXED)
})

const ADD_ROOT = '추가 ID(계획만 ○, 루트) — focus는 그대로'
const ADD_CHILD = '추가 ID(계획만 ○, 부모 PA) — focus는 그대로'
const LIST_1 = 'AAAA [resolved] 루트 문제\nBBBB [paused 0d] 새이름 ←AAAA'
const LIST_2 = 'AAAA [paused 0d] 사용자 문제\nBBBB [paused 0d] 둘째 ←AAAA 📝메모 한 줄'
const PANE_PLANNED: string[] = ['○', '뿌리', '├─○', '가지1', '│ └─○', '손자', '└─○', '가지2', '○', '둘째뿌리']
const PANE_MIXED: string[] = ['◆ 백그라운드 1 · 미지정', '○', '뿌리', '├─○', '가지1', '│ └─◆', '손자', '└─●', '가지2', '○', '둘째뿌리']
