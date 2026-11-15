// peek: 세션 atom probe 플러그인 + 헬퍼(JSX라 별도 .tsx로 분리).
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { PANE_PROPS, VP } from './harness'

export const PEEK = { plugin: 'ptree-peek', component: 'Pane', requestId: 'ptree-peek', props: PANE_PROPS } as const
export const OPTS = {
  plugins: [
    {
      name: 'ptree-peek',
      register(on: On) {
        on('ui.render', { component: 'Pane', requestId: 'ptree-peek' }, async ($, e) => {
          const { Text } = $.ui.resolve(e)
          const turn = (await $.state.get({ plugin: 'problem-tree', key: 'turn' } as any)).value
          const pointer = (await $.state.get({ plugin: 'problem-tree', key: 'pointer' } as any)).value
          const agentBind = (await $.state.get({ plugin: 'problem-tree', key: 'agentBind' } as any)).value
          const runningTasks = (await $.state.get({ plugin: 'problem-tree', key: 'runningTasks' } as any)).value
          const nodes = (await $.state.get({ plugin: 'problem-tree', key: 'nodes' } as any)).value
          return <Text>{JSON.stringify({ turn, pointer, agentBind, runningTasks, nodes })}</Text>
        })
      },
    },
  ],
}

export async function peek($: Engine): Promise<any> {
  const ui = await $.ui.mount({ ...PEEK, surface: 'terminal', viewport: VP } as any)
  const el = await ui.find({ type: 'Text' })
  await ui.unmount()
  return JSON.parse(el?.text ?? 'null')
}
