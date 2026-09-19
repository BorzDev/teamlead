# Запуск саб-агентов с effort по роли

Сохрани JS-блок как `<ws>/agents.js`. Вызови `Workflow` с абсолютным `scriptPath` и объектом `args`:

```json
{
  "tasks": [{"id": "implement-1", "role": "implement", "brief": "<самодостаточный бриф с абсолютными путями>"}],
  "independent": false
}
```

Роли: `lookup` — Opus / medium, `recon` и `implement` — Opus / high, `sensitive` — Opus / xhigh, `check` — Opus / low, `escalate` — Fable 5.1 / max. Для нескольких задач `independent: true` означает, что лид уже проверил непересечение файлов и ресурсов; иначе отправляй их отдельными последовательными вызовами. Размер партии не превышает доступный лимит среды; большие планы дели на партии. Ревью запускается отдельным [шаблоном](review-workflow.md) после всех исполнителей.

```js
export const meta = {
  name: 'teamlead-agents',
  description: 'Запуск назначенных задач с явным effort по роли',
  phases: [{ title: 'Tasks' }],
}

const levels = {
  lookup: 'medium',
  recon: 'high',
  implement: 'high',
  sensitive: 'xhigh',
  check: 'low',
  escalate: 'max',
}

const { tasks, independent = false } = args ?? {}
if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 16) {
  throw new Error('tasks must contain 1–16 assigned tasks')
}
if (tasks.length > 1 && independent !== true) {
  throw new Error('Parallel tasks require confirmed independent scopes')
}
const ids = new Set()
for (const task of tasks) {
  if (!task || typeof task.id !== 'string' || !task.id.trim() || ids.has(task.id)) {
    throw new Error('Every task needs a unique nonempty id')
  }
  if (typeof task.role !== 'string' || !Object.prototype.hasOwnProperty.call(levels, task.role)) {
    throw new Error(`Unsupported role: ${task.role}`)
  }
  if (typeof task.brief !== 'string' || !task.brief.trim()) {
    throw new Error(`Missing brief: ${task.id}`)
  }
  ids.add(task.id)
}

const run = async (task) => {
  const requested = { model: task.role === 'escalate' ? 'claude-fable-5-1' : 'opus', effort: levels[task.role] }
  try {
    const output = await agent(task.brief, {
      ...requested,
      agentType: 'general-purpose',
      label: task.id,
      phase: 'Tasks',
    })
    return { id: task.id, role: task.role, requested, returned: output != null, output }
  } catch (error) {
    return { id: task.id, role: task.role, requested, returned: false, output: null, error: String(error) }
  }
}

const raw = tasks.length === 1
  ? [await run(tasks[0])]
  : await parallel(tasks.map((task) => () => run(task)))
const results = tasks.map((task, i) => raw[i] ?? {
  id: task.id,
  role: task.role,
  requested: { model: task.role === 'escalate' ? 'claude-fable-5-1' : 'opus', effort: levels[task.role] },
  returned: false,
  output: null,
})
return { allReturned: results.every((result) => result.returned), results }
```

Дождись завершения задачи Workflow. `allReturned` говорит только о наличии ответов, а не о готовности реализации. Открой каждый назначенный отчёт, проверь DONE/BLOCKED и результаты команд. При `returned: false` установи причину и передай её лиду; не удаляй потерянные задачи из результата. При полном прерывании сначала установи, завершились ли агенты, чтобы повтор не редактировал файлы одновременно с прежним запуском. Не применяй `resumeFromRunId` для повторной проверки или работы по изменившимся файлам: он может вернуть кэшированный ответ. `requested` — параметры вызова, не доказательство применённого runtime уровня.
