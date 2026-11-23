// (b) PANE — 패널 그리기. 읽기만 한다(캐시 복제본·세션 뷰·시계) — 영속/세션 쓰기 0(가드 마).
// 무엇을 어떻게 표시할지(숨김·레이아웃·불)는 view의 순수함수가 정하고, 여기는 그것을 줄로 옮길 뿐이다.

import { readCache } from './lib/store'
import { readSession } from './lib/session'
import * as view from './lib/view'

// 패널 id 'problem-tree'는 register.tsx의 ui.render 매처(리터럴)와 같아야 한다.
export const PANE_OPEN = { id: 'problem-tree', title: '문제트리', columns: 48 } as const

export async function renderPane($: any, e: any) {
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
}
