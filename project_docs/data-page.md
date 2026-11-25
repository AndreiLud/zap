# The data page: how each number is made

The data page (`/dados`, `/en/data`) explains how Zap works, how it learned truco and what changes when people play. This document says, for every figure, where its numbers come from, which script made them, the formula behind them and the rule that picks the words of its title. The page links here from its closing block.

Every number on the page comes from code that ran. Nothing is typed into a text: the texts in `locales/data.*.json` hold placeholders, and a test refuses a digit in them (`web/test/locales.test.ts`).

## Where the numbers come from

| Source | Made by | What it holds |
| --- | --- | --- |
| `web/src/data/generated/facts-view.json` | `tools/data/facts-view.ts` | The part of `facts.json` the page reads (strength, characters, model, reading of the opponent, explorer test, brake), each block with its `measuredAt`, plus what the site serves today (`served`) and facts derived from hashes the bundle drops (`derived`: whether the twin of the reading test is the served file, the version whose decisions F6 counted, whether the head to head rows and the control explorer measured the file the explorer test judges, and whether the control explorer was measured against the file it trained against). |
| `web/src/data/generated/exact.json` | `tools/data/exact.ts` | Exact counts over the deck (no sampling): manilha odds and how often each card beats, ties and loses. |
| `web/src/data/generated/curve.json`, `headline.json` | `tools/data/curve.ts` | The training curve of every version in `tools/data/sources.json`, and the hands of training behind each version. |
| `web/src/data/generated/cycle-rules.json` | `tools/data/cycle-rules.ts` | The rules of the weekly cycle from `training/cycle/config/prod.toml` (the duel, the A/B test, the marks of each layer). |
| `web/src/data/generated/sim.json`, `replays.json` | `tools/data/simulate.ts` | Matches of Zap against Zap (run A) and of each character against Zap (run B), with the model in `sources.json`, fixed seeds, so a rerun gives the same file. |
| `GET /api/live` | the Worker | Finished matches with at least one person, moves people made, the version in play and whether reading is on. Asked every minute while the page is visible. |
| `GET /api/summary` | the weekly cycle (`summary.json`) | What the cycle learned from people: the score of people against Zap, the versions, the layers. Until the first summary the figures that need it show their waiting state. |

Each generated file starts with a `provenance` object: the script, the command, when it ran, the machine, the input files with their sha256, and the seed for simulations. `web/test/data-generated.test.ts` regenerates the cheap files and compares, and checks that the simulation ran on the model that is served. The page bundle gets the files without the hashes and the machine, and `facts-view.json` with only the keys the pages read (`tools/data/page-keys.ts`; a build step in `web/vite.config.ts`); the files in the repository keep everything.

Loading: part 1, the reading section and the closing load with the page (their chunk, its static imports and the language's data texts are preloaded from the page's HTML). The plan's four chapters load in their own chunk, with `sim.json`, `exact.json` and their styles, when the reader comes within 800 px of them or follows a link into them; until then each keeps its anchor and heading. `replays.json` and the replay viewer load near F23.

Rounding: `facts-view.json` keeps 5 decimals (one more than any number on the page, so the page never rounds twice); the other files keep 4 decimals for shares. A value that would round to zero keeps 3 significant digits, so no interval end changes sign.

## Shared rules

* **Score.** In the duplicate format every deal is played twice with the seats swapped, and a pair scores 1, 0.5 or 0. The page talks about games won. A difference of 0.01 in mean score is said as "1 game in every 100".
* **Intervals.** Shares of counts use the Wilson 95% interval (`tools/data/lib/stats.ts`). Mean scores use the normal 95% interval with the sample standard deviation. The training curve keeps only the mean, so its band is the largest half width a score can have, `1.96 sqrt(m (1 - m) / pairs)`, said as "margin of up to". The reading of a person uses 80% intervals and says so.
* **Titles.** A title states the finding. Each data driven title is a pure function in `web/src/data/findings.ts` or `web/src/data/parts/chapter-data.ts`, unit tested on fixtures for every variant. A title claims a direction only when the interval supports it; otherwise it uses its "within noise" wording.
* **States.** A figure is `ready`, `empty` (the data exists but has nothing yet), `notMeasured` (a key is null in `facts-view.json`) or `unavailable` (the summary did not load).

## Part 1: how it works

### F1 Every game becomes a lesson (`ciclo`)

A diagram of the weekly cycle. The duel rules come from `cycle-rules.json` (`gate.p0`, `gate.p1`, `alpha`, `beta`, the segment and panel margins); the gain sought is `p1 - p0`. The line under it says whether a promoted version has trained on people's games yet (`summary.versions[].data.validMatches`). The stored play of step 2 is an illustration, not a measurement.

### F2 How Zap learned (`aprendeu`)

Four steps and a facts row: inputs, weights and size of the model in play (from the model file, `parseModel` of `ai/src/mlp.ts`), and the median decision time (`ai.decisionTime.decisionMs.p50`). The hands of training are the sum of `hands` in the metrics of every run in the lineage of the version in play (`curve.json`).

### F3 The training curve (`curva`)

Games won against the tuned rules player at each evaluation, with the band above. The lineage of the version in play is drawn from its start: v1 from `training/runs/main` up to its snapshot, then v2 from `training/runs/m6-twin`, whose steps count from where it started (v1's snapshot). Title rule (`curveTitle`): split the points into the first third and the rest and compare the mean climb per step; "fast then slow" only when the first third climbs at least three times faster and the two ends are apart by more than their margins.

### F4 Same cards twice (`duplicado`)

A static drawing of one deal played twice with the teams swapped. No numbers.

## Part 1: reading the opponent during the match (`leitura`)

Every word here follows the data: `/api/live` `adapt` (before it answers, `facts-view.served.readsOpponents`) and `ai.adaptation.explorer.criterion.pass`. With reading off the headings say "a test version", the status line says reading is off and why, and the gain figures say they measure a version that does not play today.

The status line, with reading off: when the criterion fails, it links to the explorer test. When it passes, it gives the largest one sided bound of every explorer judged (rounded away from the limit, as in F9), says the test version is not live and what the tables play (the version in play; "an earlier twin without reading" only when it is the bundled file with features `v2-empty`), and that reading goes live only if the owner adopts the test version, it wins the duel and it holds `ab.days` days against people (`cycle-rules.json`). The measurements that weigh against the test version are in the figure under F8 and in F9.

The status line, with reading on: when the cycle's summary shows an open test window for the version in play (`/api/summary` `ab.version` is that version), it adds that this is a test with people, the window's end (`ab.until`) and the share of quick play matches kept on the previous version (`ab.share`, `ab.control`). After a rollback the line says reading is off from `/api/live` and the rolled back version shows in F19; the line itself does not name it, since the summary does not say which version carried the reading. Before `/api/live` answers, the page uses the build's view: once the owner has recorded what the cycle serves (`tools/docs/record-release.ts`, `DEPLOY.md` section 9.6), `facts-view.served` names the cycle's version in play and whether its file reads, so the prerendered page matches the site.

### F5 What it counts, hand by hand (`leitura-conta`)

An explainer the reader can change. After `H` hands with `K` truco calls the reading is `(K + alpha p) / (H + alpha)`, starting at the population value `p` (`ai.adaptation.priors.segments['paulista-2'].raise`, `alpha` from `ai.adaptation.design`). The bar of how much the play may change is the safety net `B(n) = Bmax n / (n + nHalf)` over `Bmax` (`ai.adaptation.safetyNet`).

### F6 It starts small and grows with evidence (`leitura-provas`)

Top: the share of truco decisions taken with each amount of evidence (`ai.adaptation.evidence.pooled.share`; the decisions of the version named in its method, `derived.evidenceModel`, v1 today). Bottom, how much the play may adjust, both rising with evidence: the limit at the table `n / (n + nHalf)` and, in training, what the pull back to the play without reading leaves free, `n / (nW + n)` (the pull weighs `nW / (nW + n)`). Title rule (`evidenceTitle`): states the half point `nHalf`. The reading adds that the allowed change grows with each piece of evidence up to a cap, with the value at the last bin.

### F7 How much its play changes, hand by hand (`leitura-curva`)

The share of truco decisions whose most likely choice changed because of the reading, by hand of the match: the mean over the opponent styles weighted by decisions, and a band from the style that changes least to the one that changes most (`ai.adaptation.readingCurve`). Title rule (`readingCurveTitle`): "grows" only when hand 1 is under half a percent and hand 6 is above hand 2. The band is a spread across styles, not a sampling interval; when the hand with the fewest decisions has under a thousand per style, the reading says so and that part of the band is chance.

### F8 What reading adds to the score (`leitura-ganho`)

Per opponent style, the same network with and without reading, pair by pair (`ai.adaptation.perStyle.styles.*.gainVsAblated`), with 95% intervals. Title rule (`gainTitle`) on the pooled interval: gain when the lower bound is above zero, loss when the upper bound is below zero, otherwise "does not change the score by a measurable amount". The table also holds each style's gain over the twin and, when it is a seed floor (below), the row of the second twin against the twin.

### The test version against its twin (`leitura-gemea`)

Under F8, on the same games per 100 axis with their 95% intervals, against the opponent styles (`ai.adaptation.perStyle.pooled.allStyles`): the test version against the twin (`gainVsTwin`), the reading alone (`gainVsAblated`) and, only when both twins trained for as many iterations (`perStyle.twinIterations`), a second twin against the twin, by chance alone (`seedFloor`; the F8 table keeps that row under the same condition). Title rule: when the head to head rows measured the judged file against the twin of `perStyle` (`derived.headToHeadJudged`), `headToHeadTitle` on `ai.adaptation.headToHead.rows.adaptive-twin`, a share of the mean score with its interval: "beats its twin" only when the whole interval is above an even score, otherwise "is not stronger than its twin", which holds below an even score and within noise. Without those rows, `floorTitle`: "most of the gap is chance between two training runs" only when there is a seed floor, the reading part's upper bound is under half of the gap's lower bound and the network without reading against the twin (`ablatedVsTwin`) cannot be told apart from the seed floor; otherwise it names the figure. The reading gives the gain against the styles, the part of it that is reading and the seed floor when there is one. It calls the twin "the version that plays today" only when the build checked that the twin is the served file (`derived.twinServed`) and reading is off; when the build checked that it is not, the subtitle says the twin is not the version that plays today, so the head to head title is not read as a verdict on the version in play. With the head to head rows of the judged file, the reading ends with the same network with the reading off against the twin (`headToHead.rows.ablated-twin`, the value of `ai.adaptation.ablation.offPolicy.headToHead`): what a table with "Don't adapt to me" faces when the test version plays, in that person's favour.

### F9 The explorer test (`leitura-explorador`)

Every explorer the criterion judges (`ai.adaptation.explorer.criterion.verdicts`: the scripted searches, the trained explorer, the explorers trained for an earlier file (`otherTrained`) and the control): the reading part (score against the adaptive network minus against the same file with the statistics at no evidence) with its 95% interval, its one sided 95% upper bound and the limit (`requirement`). A search's explorer measured again on a later file keeps the number of the search that found it. The whisker runs from the 95% lower end to the one sided bound, the number the rule judges; the full two sided interval is in the table. Title rule (`explorerTitle`): pass or fail from `criterion.pass`, with the explorer that has the largest upper bound, its mean and the limit. A pass names how many explorers were measured and speaks of them only, counting the margin of error, never of every possible player. A bound within 0.1 game per 100 of the limit is shown with two decimals, rounded away from the limit (`boundValue`), so a failing bound never reads as the limit (1.046 is "1,05"). The subtitle states the rule; it says "at least" the size of the original grid, since a later search added a fresh family of shapes to it. A row's description reads the explorer's label when it is a switch from one style to another at a hand or after some evidence; the other shapes (back and forth, three phases, a partner on its own schedule) get no description. A search's second explorer is the best one from outside the training family that search knew, so its row says "from outside training at the time": a later attempt may measure it again against a file trained on a larger family, inside which it may now play. The reading names the scripted explorer with the largest bound and the search it came from, then the history line: the old rule (gain over the twin, one sided bound at most `explorer.requirement`), the search after which it changed (the smallest attempt the facts name, counting the searches that later attempts measured again, `firstSearch`) and how many explorers aimed at the reading Zap fail it. Then, when the control explorer measured the judged file (`derived.controlJudged`), a measure outside the rule from `ai.adaptation.explorer.control.fresh.asServed`: how much more an explorer trained against the test version takes from it as served than the control takes from the twin, pair by pair (`baseFinding`: "its base is easier to exploit" only when the interval is above zero, otherwise "takes no more"); when the control was measured against another file than the one it trained against (`derived.controlMeasuredOnOwn` false) the reading says the comparison is less clean; and when the trained explorer's bound is below zero, that the reading is not what it exploits. The trained explorer's row, and the rows of explorers trained for an earlier file, say they trained against a test version with a larger limit when that file's `adapt.bmax` is above the judged file's (`criterion.servedModel`). The control's row names the version it trained against when the build checked that it is the bundled file (`derived.controlTrainedOnServed`), and says "the twin" otherwise.

## Chapter 1: the game in numbers (`truco`)

* **F10 Manilha odds (`manilha`)**, `exact.json`. Paulista: 4 manilhas among the 39 cards left by the vira, `C(4,k) C(35,3-k) / C(39,3)` and `1 - C(35,6) / C(39,6)` for a team of two. Mineiro: 4 fixed manilhas among 40.
* **F11 Strength of each card (`forca-cartas`)**, `exact.json`: for each strength class the share of the other unseen cards it beats, ties and loses to, averaged over every vira in paulista.
* **F12 Your best card and the hand (`mao-tres-cartas`)**, `sim.json` run A: hands won by the observer's team by the strongest card it was dealt (one observer seat per hand, so observations are independent), classes with at least 500 observations. The title's manilha share pools the four manilha classes of 1 against 1 and says so; the table has that pooled row ("any manilha") for both table sizes.
* **F13 Playing first or last (`posicao`)**, run A: hands won by the side of the mão. The title names an edge only when both intervals are on the same side of 50%, and quotes the share of the side that plays first in each table size, the numbers of the chart.
* **F14 The first round (`primeira-rodada`)**, run A: hands won by the mão's team after winning, tying or losing round 1. The title quotes the "won" row per table size, and names its subject: the side that leads and wins round 1.
* **F15 When accepting pays (`aceitar-truco`)**, run A: with `W` the match win table of `ai/src/winprob.ts` fitted on the run and `L0`, `L1` the first two values of the ladder, the smallest chance of winning the hand for which accepting loses less match chance than running is `(W(a, b + L0) - W(a, b + L1)) / (W(a + L1, b) - W(a, b + L1))`. Only scores the variant can reach are shown.

## Chapter 2: how the AI progressed (`evolucao`)

* **F16 Strength against fixed rivals (`forca-versoes`)**: games won by each version against random play, the rules player, the tuned rules player and v1, 4,000 duplicate pairs each (`ai.strengthByVersion`, `ai.releases.*.headToHeadV1`); later versions from `summary.versions[].anchors`. Arrow keys move across the marks.
* **F17 People against Zap (`placar-pessoas`, `placar-modos`, `placar-semanas`)**: `summary.humansVsZap` with its Wilson interval, the scoreboard rows (each with at least 20 people), and weeks of `summary.cells` from three weeks on. Before the first summary the figures say when their numbers come (they cannot know the counts yet) and offer a game.
* **F18 People's data against the twin (`gemea`)**: `summary.versions[].twin` with the seed noise band of `summary.seedNoise`.
* **F19 Version history (`historico`)**: the releases in `facts.json` joined with `summary.versions`.

## Chapter 3: how the AI plays (`como-joga`)

* **F20 Truco and bluff by hand strength (`truco-forca`)**, `sim.json` run B: the share of chances to ask in which each character asked, by the hand estimate of `ai/src/heuristic.ts` in nine bins; strong is at least two thirds, weak under one third. The words say "chances", never "hands". Each character's panel repeats Zap in grey, named in the legend.
* **F21 The decision map (`mapa-decisao`)**, run B, Zap only: asking by strength and score band; answering by strength and the bet answered. A cell with fewer than 200 observations is hatched. Title rule (`mapTitle`): middle hands (bins 4 to 6) well behind against well ahead, and the title says exactly that comparison.
* **F22 The characters (`personagens`)**: three rates from the calibration of the served version (`ai.personasByVersion`; "hands with a truco call" is per hand), the bluff rate from `sim.json` run B when it measured the same version (the weak share of F20, so the page has one number per quantity), and the score against Zap on fresh deals with its 95% interval (`freshCheck.vsZap`). The characters stay in their designed order.
* **F23 Memorable hands (`maos-marcantes`)**, `replays.json`: four hands found in run A by fixed rules (the largest comeback after losing round 1, the weakest bluff the other side ran from, the first hand that reached twelve, the first mão de onze played and won), replayed move by move with the engine; the line is the chance to win the match that the acting seat estimated.

## Chapter 4: how people play (`pessoas`)

All from `summary.json`, and only from groups of at least 20 people.

* **F24 What turns on, and when (`marcas`)**: one meter per layer of the cycle, filled by its count over its mark from `cycle-rules.json`.
* **F25 Player types (`tipos`)**: the style groups the cycle found in the reading numbers, with the average of everyone as a tick.
* **F26 Where people disagree with Zap (`discordancias`)**: reserved; shows its waiting state until the measure is approved.
* **F27 Paulista against mineiro (`variantes`)**: people's win share against Zap per variant, pooled over weeks, with Wilson intervals.

## The live strip

"Last weekly training" is `summary.training.finishedAt`, the cycle's training with people; before the first summary it says there was none yet. The training of the version in play is in F3 and F19.

`GET /api/live` (`zap-live/1`), cached 60 seconds: `matches` counts finished matches with at least one person, `decisions` the moves people made themselves (a move the room made for a person is not counted). The page asks at load and then every minute while it is visible, each time past the browser's own cache (`cache: 'no-cache'`), so a reload never shows an older copy kept by the browser; it stops while the tab is hidden, and after 30 polls without a pointer, key or scroll it pauses until "Atualizar". A failed request keeps the last numbers and greys the dot.

## Checks

* `web/test/data-generated.test.ts`: generated files against their inputs.
* `web/test/data-findings.test.ts`, `web/test/data-chapters.test.ts`: every title variant.
* `web/test/data-format.test.ts`, `web/test/data-contrast.test.ts`: number formats in both languages and the label contrast of the heatmaps.
* `tests/e2e/data.spec.ts`: every figure renders or shows its state, the tables, the tap terms, the keyboard (the focus ring of the segmented buttons, the replay's buttons at the ends), the links, no sideways scroll and no clipped chart word at 100% and 200% text, and the live strip's polling.
