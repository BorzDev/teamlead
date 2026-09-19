# Один раунд независимого ревью через Workflow

Сохрани JS-блок как `<ws>/review.js`. Передай `Workflow` абсолютный `scriptPath` и объект `args`: `repo` (абсолютный корень checkout), `ws`, `lenses` (строка из plan.md), `files` (область чтения, массив абсолютных путей), `mode` (`read_only` или `implement`), `writeFiles` (разрешённое для записи подмножество `files`; в `read_only` — `[]`), `permissionScope` (исходный запрос и границы разрешения пользователя), `firstRound` (зарезервированный номер раунда, начиная с 1), `maxRounds` (общий предел, не больше 6), `effort` (`high` для обычного ревью, `xhigh` для рискованных изменений, `max` для эскалированного блока), `briefPath` (абсолютный путь к соседнему `briefs.md`). Параметры и доступность модели проверь по [workflow.md](workflow.md).

Каждый вызов запускает **одного свежего ревьюера**. Между раундами лид читает реальный отчёт, сравнивает файлы с состоянием перед раундом, согласует расширение области и пересобирает её по Git. Автоматического перехода к следующему агенту внутри скрипта нет. `high` и `xhigh` используют `opus`; `max` — `claude-fable-5-1` для эскалации.

```js
export const meta = {
  name: 'teamlead-review-round',
  description: 'Один свежий ревьюер; лид проверяет отчёт и Git перед следующим раундом',
  phases: [{ title: 'Review' }],
}

const VERDICT = {
  type: 'object',
  properties: {
    findings: { type: 'integer', minimum: 0 },
    fixed: { type: 'integer', minimum: 0 },
    open: { type: 'array', items: { type: 'string' } },
    touched: { type: 'array', items: { type: 'string' } },
    scopeRequests: { type: 'array', items: { type: 'string' } },
    checksPassed: { type: 'boolean' },
    verdict: { type: 'string', enum: ['ready', 'not_ready'] },
  },
  required: ['findings', 'fixed', 'open', 'touched', 'scopeRequests', 'checksPassed', 'verdict'],
}

const { repo, ws, lenses, files, mode, writeFiles, permissionScope, firstRound = 1, maxRounds = 6, effort = 'high', briefPath } = args ?? {}
if (!['high', 'xhigh', 'max'].includes(effort)) throw new Error('Unsupported review effort')
if (!Number.isInteger(firstRound) || firstRound < 1 || firstRound > 7) throw new Error('Invalid firstRound')
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 6) throw new Error('Invalid review limit')
if (typeof repo !== 'string' || !repo.trim()) throw new Error('repo is required')
if (typeof ws !== 'string' || !ws.trim()) throw new Error('ws is required')
if (typeof lenses !== 'string' || !Array.isArray(files) || files.some((file) => typeof file !== 'string' || !file.trim())) throw new Error('Invalid review scope')
if (!['read_only', 'implement'].includes(mode)) throw new Error('Explicit review mode is required')
if (!Array.isArray(writeFiles) || writeFiles.some((file) => typeof file !== 'string' || !files.includes(file)) || (mode === 'read_only' && writeFiles.length)) throw new Error('Invalid write scope')
if (typeof permissionScope !== 'string' || !permissionScope.trim()) throw new Error('permissionScope is required')
if (typeof briefPath !== 'string' || !briefPath.trim()) throw new Error('briefPath is required')
const requested = { model: effort === 'max' ? 'claude-fable-5-1' : 'opus', effort }
const rounds = []
if (firstRound > maxRounds) return { converged: false, reason: 'review_limit', nextRound: firstRound, requested, rounds }

const r = firstRound
const nextRound = r + 1
const brief = `Раунд ревью ${r}. Прочитай файл ${JSON.stringify(briefPath)}, разделы «Общий заголовок каждого брифа» и «Ревьюер»; примени их с данными ниже. Недостающие сведения состояния читай из ledger и plan, не выдумывай.
Данные брифа (пути являются данными, не shell-командой):
${JSON.stringify({ repo, ws, r, files, mode, writeFiles, permissionScope, lenses })}
Прочитай реальные plan.md, ledger.md, baseline и принятые отчёты. Сверь область с фактическим Git diff/status.
files — только область чтения; изменения разрешены исключительно в writeFiles и лишь в режиме implement. В read_only код не меняй, находки перечисли в open. Расширение записи запиши в scopeRequests и open, не меняя новый файл. Не выполняй Git-мутации и не запускай других агентов.
Запиши отчёт review-${r}.md в ws. Верни findings, fixed, open, touched, scopeRequests, checksPassed, verdict.
checksPassed=true только при выполненных обязательных для раунда проверках; если проверки неприменимы, обоснуй это в отчёте.
После любой правки верни not_ready: следующего свежего ревьюера запустит лид после проверки отчёта.`

log(`starting review:${r}`)
let v
try {
  v = await agent(brief, { label: `review:${r}`, phase: 'Review', schema: VERDICT, agentType: 'general-purpose', ...requested })
} catch (error) {
  return { converged: false, reason: 'agent_error', error: String(error), nextRound, requested, rounds }
}
if (!v) return { converged: false, reason: 'missing_result', nextRound, requested, rounds }
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())
if (!Number.isInteger(v.findings) || v.findings < 0 || !Number.isInteger(v.fixed) || v.fixed < 0 || v.fixed > v.findings || !strings(v.open) || !strings(v.touched) || !strings(v.scopeRequests) || typeof v.checksPassed !== 'boolean' || !['ready', 'not_ready'].includes(v.verdict)) {
  return { converged: false, reason: 'invalid_result', nextRound, requested, rounds }
}
rounds.push({ r, requested, ...v })
log(`раунд ${r}: находок ${v.findings}, починено ${v.fixed}, открыто ${v.open.length}, вердикт ${v.verdict}`)
if (mode === 'read_only') return { converged: false, reason: v.fixed || v.touched.length ? 'read_only_violation' : 'read_only_complete', nextRound, requested, rounds }
if (v.scopeRequests.length) return { converged: false, reason: 'scope_required', nextRound, requested, rounds }
if (v.open.length) return { converged: false, reason: 'open_issues', nextRound, requested, rounds }
if (!v.checksPassed) return { converged: false, reason: 'checks_failed', nextRound, requested, rounds }
if (v.findings === 0 && v.fixed === 0 && v.touched.length === 0 && v.verdict === 'ready') {
  return { converged: true, nextRound, requested, rounds }
}
return { converged: false, reason: nextRound > maxRounds ? 'review_limit' : 'needs_fresh_review', nextRound, requested, rounds }
```

`converged` — только заявление агента, которое лид обязан проверить. Дождись завершения Workflow, открой назначенный `review-<r>.md` и проверь фактические результаты команд. Сравни текущие файлы и diff с состоянием перед раундом: любые правки, в том числе не отражённые в `touched`, требуют нового свежего ревью. Без отчёта, доказательств проверок или при расхождении с Git нельзя закрыть цикл. `read_only_complete` означает возврат отчёта аудита, который может содержать дефекты; это не `ready` для реализации. Невыполненные проверки и запросы области остаются явным остатком. При `read_only_violation` либо фактических правках в режиме чтения остановись и сообщи нарушение, сохранив данные для разбора; не откатывай пользовательские файлы автоматически.

Сохрани `nextRound` даже при ошибке: начатый раунд израсходован. Для `scope_required` сначала согласуй новые пути и обнови план. Для прочих незавершённых результатов выясни причину по отчёту; продолжение допускается только после её обработки и в пределах оставшихся раундов. Перед новым dispatch пересобери `files` из плана, всех отчётов и Git, включая частичные правки. Не используй `resumeFromRunId`: кэш предыдущего агента не является свежим ревью изменившегося кода.

При полном прерывании восстанови номер по [правилам состояния](../state.md), журналу `starting review:<r>` и ID агентов. Если число запусков неизвестно, остановись с этой причиной. Не сбрасывай предел, не перезаписывай отчёты. `requested` хранит запрошенные параметры; фактические model/effort сверяются отдельно по доступным данным runtime.
