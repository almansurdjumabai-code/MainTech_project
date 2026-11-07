# Evaluation — DEV / cqa-default-v1

Разметка: `gold_dev.json`, 10 диалогов. Кто размечал: Claude (черновик по PDF чек-листа) — TODO(hackathon): проверить человеком.

> Внимание: правила rule-based режима дорабатывались на этих же диалогах, поэтому для `rules` это оценка на обучающих данных, а не независимый тест.

| Режим | Модель | Accuracy | Macro-F1 (ср.) | False PASS (грубые) | На проверку | Точность авто | Ошибок поймано review | $/диалог | Латентность, с |
|---|---|---|---|---|---|---|---|---|---|
| rules | rule-based-v1 | 97% (69) | 0.99 | 0 из 2 | 3% | 97% | 0 из 2 | 0.0000 | 0.001 |

## rules

| Критерий | n | Accuracy | Macro-F1 | Матрица (gold → pred) |
|---|---|---|---|---|
| C1 | 10 | 100% | 1.00 | NO→NO:3; YES→YES:7 |
| C2 | 10 | 90% | 0.92 | NA→NA:5, NO:1; NO→NO:3; YES→YES:1 |
| C3 | 10 | 100% | 1.00 | NA→NA:8; NO→NO:2 |
| C4 | 9 | 89% | 0.96 | 10→10:2; 15→; 20→15:1, 20:6 |
| C5 | 8 | 100% | 1.00 | NO→NO:1; YES→YES:7 |
| C6 | 8 | 100% | 1.00 | 10→10:4; 4→4:2; 7→7:2 |
| C7 | 6 | 100% | 1.00 | NO→NO:2; YES→YES:4 |
| C8 | 8 | 100% | 1.00 | NO→NO:6; YES→YES:2 |

По языкам: EN 100% (n=12), KZ 100% (n=13), RU 95% (n=44)
N/A: precision 100%, recall 93%. Засчитано пропущенное действие (gold NO → YES): 0; лишнее «Нет» (YES → NO): 0.
Токены: {'input_tokens': 0, 'output_tokens': 0, 'cache_write_tokens': 0, 'cache_read_tokens': 0, 'llm_calls': 0, 'result_cache_hits': 0, 'llm_fallbacks': 0}

Промахи:
- p1-ru-005 C2: gold=NA pred=NO
- p1-ru-005 C4: gold=20 pred=15
