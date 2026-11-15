#!/usr/bin/env node
// 일회용 수동 마이그레이션 (스펙 (e)A). ★이 세션에서는 실행하지 않는다.★
// 사용자가 모든 Claude 세션을 종료하고, store 파일을 백업한 뒤 직접 돌린다.
//
//   node scripts/migrate_consolidate_2026-11-15.mjs <store.json 경로>            # 드라이런(기본)
//   node scripts/migrate_consolidate_2026-11-15.mjs <store.json 경로> --apply    # 실제 쓰기
//
// 하는 일:
//  1) Laibrio 3개 레거시 키(tree:<Laibrio>, /Laibrio_AI, /Laibrio_AI/reports) 중
//     max(touchedAt, history.at)이 가장 큰(=가장 최신 작업) 사본을 고른다.
//     예상은 Laibrio_AI. 다르면 멈추고 보고(STOP) — 사용자가 직접 판단.
//  2) 고른 사본을 tree:<Laibrio>(루트)에 덮고, 하위 2개 키를 삭제.
//  3) 탐침 cwd 트리 키(probe-cwd/empty-cwd) 삭제.
//  4) Laibrio 트리가 32노드·n1~n38을 보존하는지 확인.
// 코드의 migrate()가 다음 세션 시작 때 tree:<root> → node:<treeKey>:<id>로 변환한다.
// (탐침 inline json 4개 파일 삭제는 이 스크립트가 아니라 사용자가 파일 단위로 지운다.)

import { readFileSync, writeFileSync } from 'node:fs'

const LAIBRIO = '/Users/cavss/Desktop/Projects/unicons/Laibrio'
const K_ROOT = `tree:${LAIBRIO}`
const K_AI = `tree:${LAIBRIO}/Laibrio_AI`
const K_REPORTS = `tree:${LAIBRIO}/Laibrio_AI/reports`

const path = process.argv[2]
const apply = process.argv.includes('--apply')
if (!path) {
  console.error('사용법: node migrate_consolidate_2026-11-15.mjs <store.json 경로> [--apply]')
  process.exit(2)
}

const STOP = msg => {
  console.error('STOP:', msg)
  process.exit(1)
}

// store 파일은 { "<key>": <value>, ... } 맵으로 가정. 다른 래핑이면 .data/.store를 벗긴다.
const raw = JSON.parse(readFileSync(path, 'utf8'))
const map = raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.data ?? raw.store ?? raw)
if (!map || typeof map !== 'object') STOP('store 맵을 찾지 못함 — 파일 구조 확인')

const richness = tree => {
  if (!tree || !tree.nodes) return -1
  let max = 0
  for (const n of Object.values(tree.nodes)) {
    max = Math.max(max, Number(n.touchedAt ?? 0), Number(n.createdAt ?? 0))
    for (const h of n.history ?? []) max = Math.max(max, Number(h.at ?? 0))
  }
  return max
}

const copies = { reports: map[K_REPORTS], ai: map[K_AI], root: map[K_ROOT] }
const scored = Object.entries(copies)
  .filter(([, v]) => v)
  .map(([k, v]) => ({ k, score: richness(v), nodes: Object.keys(v.nodes ?? {}).length }))
  .sort((a, b) => b.score - a.score)
if (scored.length === 0) STOP('Laibrio 레거시 tree: 키가 하나도 없음')
console.log('후보:', scored)

const best = scored[0]
if (best.k !== 'ai') STOP(`가장 최신 사본이 Laibrio_AI가 아니라 '${best.k}' — 사용자 확인 필요`)
const chosen = copies[best.k]

// 32노드·n1~n38 보존 확인
const ids = Object.keys(chosen.nodes ?? {})
const missing = []
for (let i = 1; i <= 38; i++) if (chosen.nodes[`n${i}`] === undefined) missing.push(`n${i}`)
console.log(`선택 사본 노드수=${ids.length}, n1~n38 누락=${missing.length ? missing.join(',') : '없음'}`)
if (ids.length < 30) STOP(`노드수 ${ids.length}가 비정상(32 예상) — 확인 필요`)

// 변경 계획
const toDelete = [K_AI, K_REPORTS]
for (const key of Object.keys(map)) {
  if (key.startsWith('tree:') && (key.includes('probe-cwd') || key.includes('empty-cwd'))) toDelete.push(key)
}
console.log('계획: ', K_ROOT, '← 최신 사본 덮기')
console.log('계획: 삭제', toDelete)

if (!apply) {
  console.log('\n(드라이런) --apply 를 붙이면 실제로 씁니다. 백업 먼저!')
  process.exit(0)
}

map[K_ROOT] = chosen
for (const key of toDelete) delete map[key]
writeFileSync(path, JSON.stringify(raw, null, 2))
console.log('적용 완료. 다음 세션 시작 때 코드 migrate()가 node: 키로 변환합니다.')
