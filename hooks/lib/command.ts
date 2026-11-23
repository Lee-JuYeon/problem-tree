// (b) COMMAND — `/ptree <하위명령> …` 해석과 실행. 슬래시 커맨드도 도구와 같은 ops를 쓴다.

import { add, resolve, reopen, focus, rename, move, remove, note, list } from './ops'
import { loadTree, treeOf, setLink, clearLink, targetHasLink } from './store'
import { TITLE_MAX } from './view'

type Any = any

export const COMMAND = 'ptree'
export const ARGUMENT_HINT =
  '[add <제목> | resolve <id> | reopen <id> | focus <id> | rename <id> <제목> | rm <id> | move <id> [부모id] | note <id> <글> | link <경로> | unlink | list]'
const OPENED = '문제트리 패널을 열었습니다.'

/** "첫 낱말 나머지" 가르기. 나머지는 앞뒤 공백을 뗀다. */
const split = (s: string): [head: string, rest: string] => {
  const sp = s.indexOf(' ')
  return sp === -1 ? [s, ''] : [s.slice(0, sp), s.slice(sp + 1).trim()]
}

/** 커맨드 인자 한 줄을 실행하고 결과 문구를 돌려준다. 모르는 하위명령·인자 없음 = 패널만 연 것. */
export async function runCommand($: Any, args: string): Promise<string> {
  const [head, rest] = split(args.trim())
  const sub = head.toLowerCase()
  if (sub === 'unlink') return unlinkCmd($)
  if (sub === 'list') return list($)
  if (!rest) return OPENED
  switch (sub) {
    case 'add':
      return add($, { title: rest.slice(0, TITLE_MAX), by: 'user' })
    case 'resolve':
      return resolve($, { id: rest, by: 'user' })
    case 'reopen':
      return reopen($, rest, 'user')
    case 'focus':
      return focus($, rest, 'user')
    case 'rename': {
      const [id, title] = split(rest)
      if (!title) return `사용법: /ptree rename <id> <새 제목>`
      return rename($, id, title.slice(0, TITLE_MAX), 'user')
    }
    case 'rm':
      return remove($, rest)
    case 'move': {
      const [id = '', to] = rest.split(/\s+/)
      return move($, id, to, 'user')
    }
    case 'note': {
      // 메모 본문은 다듬지 않는다(앞뒤 공백 포함 그대로).
      const sp = rest.indexOf(' ')
      return note($, sp === -1 ? rest : rest.slice(0, sp), sp === -1 ? '' : rest.slice(sp + 1), 'user')
    }
    case 'link':
      return linkCmd($, rest)
    default:
      return OPENED
  }
}

// ---------- link / unlink (현 root에 노드 0개·대상에 link 없음·대상≠현 root일 때만) ----------
// (export: 가드 '가'의 정적검사가 본문에 닿도록 — 비export 헬퍼는 검사가 못 본다)
export async function linkCmd($: Any, path: string): Promise<string> {
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
export async function unlinkCmd($: Any): Promise<string> {
  await clearLink($)
  await loadTree($)
  return `unlink`
}
