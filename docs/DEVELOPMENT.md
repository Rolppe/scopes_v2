# How Scopes V2 was developed

Mikko Paaso set the requirements, designed the architecture and directed the work. The code was written by Claude Code agents from written briefs, and every task had to pass an automated gate and, for UI and device work, a run on a simulator or a real device. Mikko reviewed the results and decided what to keep.

This repository is the part of a larger private monorepo that concerns V2. The planning documents (architecture plan, implementation plan, most briefs, coordination logs) stayed in the monorepo. What remains here are the per-component working notes and a few briefs.

## The workflow

1. **Plan.** An architecture plan numbered its decisions (`ARK-nn`, `S-nn`, `K-nn`, `P-nn` in the notes). An implementation plan cut them into numbered tasks (`T-16` … `T-108` appear in commit subjects; `R-n` marks later corrections and follow-ups).
2. **Brief.** Each task became a brief with a fixed shape: the task; *Files* (`may`, `must not`, `read`); a *Contract* with the exact signatures; numbered *Do* steps; environment limits; *Acceptance* as shell commands; a six-line *Report* format; and a token budget. Examples: `ydin/briefit/R-2.md` (a convergence bug fix) and `ydin/briefit/T-50-ajo2.md` (a flaky test).
3. **Execute.** An executor agent did the work in the working tree or a separate git worktree and reported in the fixed format. The registers record the model and token use per task: most were Sonnet (for example R-2, about 47k tokens), harder ones Opus (T-35, T-55, T-56).
4. **Gate.** `gate.sh <task id>` in a component maps the id to its test files, runs them, then checks fences: the working tree is snapshotted before the run (the core's gate takes it with `--pohja`), and a new or changed path outside the task's allowed prefixes (`GATE_MAY`) or anywhere in the V1 tree makes the gate exit 2. `gate.sh --itsetesti` proves that the gate can fail. The exit code is the verdict.
5. **Review and commit.** A supervising session read the diff against the brief, re-ran the gates, and committed by path. The register records deviations from the brief and who approved them.
6. **Device acceptance.** UI work was accepted by XCUITest on the Mac and an iOS simulator, a two-device test (macOS app and simulator syncing through one test node), and an install script for a real iPhone. Production data was only touched when the human approved it in that conversation.
7. **Hand-over.** At the end of a session the state was *packed* (`pakkaa`) into the three notes files, and the next session *unpacked* (`pura`) them. That is why the notes are dense and dated.

Faults found in the agents' own work were recorded as entries in the register's fault table the same day, with a rule for next time (for example: heavy queries against a large database run under a memory limit; no `pgrep -f` in wait loops).

## Where the numbers come from

- 82 commits from 2026-10-19 to 2026-10-29, five active days (`git log --format=%ad --date=short | sort | uniq -c`).
- 76 commits carry a `Co-Authored-By` trailer: 57 Claude Opus 5.5 and 19 Claude Sonnet 5.5. All commits are authored by Mikko Paaso.
- The history was exported from the monorepo for the V2 paths; the first commits are the port of the Rust node (`T-16` … `T-20`), the latest feature commits are `T-101` and `T-108`.

## Map of the working notes

All of these are in Finnish. They are working notes, not documentation; they were kept in the repository as a record of the process and are not edited for readability. Paths in them use the old monorepo prefix `scopes2/`, which corresponds to the root of this repository.

| File | What it is |
|---|---|
| `<component>/REKISTERI.md` | The *register*: backlog and current state of a component. Sections: purpose and boundary, decisions (dated, with who decided), open items table, fault table, pointer to history. Begins with `SEURAAVA PAKETTI`, the next work packet. |
| `<component>/HISTORIA.md` | Change history: one dated entry per session or task with commit ids, gate results and findings that did not belong in the register. |
| `<component>/ARKISTO.md` | Archive: text removed or changed in the register, verbatim, oldest first. Nothing is deleted. |
| `REKISTERI.md`, `HISTORIA.md` (root) | Stubs from when the scope was created. The real notes are per component. |
| `ydin/briefit/` | Four briefs: `R-1` (register fields from the core, `rekisterit-meta` merging), `R-2` (sibling-unit convergence), `T-22-T-28-ajo2` and `T-50-ajo2` (flaky tests caused by fixed ports). |
| `ios/testit/t59/SUUNNITELMA.md` | Plan for one simulator acceptance task: windowed mirror, messages while the tunnel is closed. |
| `shared/V-605.md` | A design note: parallelising the Mac build gate with per-run build directories, locks and test ports. |
| `adapteri/vertailu/V1-SYNKKA.md` | Report listing how V1 changed after the adapter copied its modules, classified by whether the adapter must follow. |
| `adapteri/vanhasta/*.ero` | Diffs between a copied V1 module and the original, for the deliberate deviations. |
| `ydin/kaannos-mittaus.txt` | Output of the first cold build used for a memory and time measurement (before the TLS dependencies were removed). |
| `*/gate.sh`, `kaynnista.sh`, `ydin/julkaise.sh` | Gate scripts, the launcher and the release script. They assume the original environment (see the README). |

## Glossary

| Term | English | Where it appears |
|---|---|---|
| ydin | core; the Rust crate and node | `ydin/`, `scopes-ydin` |
| solmu | node (a running instance) | `scopes-solmu`, `solmu.rs`, `Solmu.swift` |
| yksikkö | unit, the replicated record | `yksikko.rs` |
| polku | path; the kind of a unit (`peili`, `tila`, `rekisterit/...`) | unit field `polku` |
| versio, aika | version vector, HLC timestamp | `Yksikko` fields |
| yhdistäjä | merger: `Lr`, `Lww`, `Lisays` (append) | `yksikko.rs` |
| vertainen | peer | `--vertainen`, `vertaiset.rs` |
| muutosloki, virta | change log, stream (SSE) | `muutosloki.rs`, `virta.rs`, `/api/virta` |
| varasto | store (SQLite) | `varasto.rs` |
| tiiviste, listat, hae, laheta | digest, lists, fetch, send: the replication steps | `replikointi.rs` |
| silta | bridge to V1 and to the adapter | `silta.rs` |
| vanha, vanhasta | the old (V1); "from the old", i.e. copies of V1 modules | `--vanha`, `adapteri/vanhasta/` |
| peili | mirror of a transcript file | `peili.rs`, `peili.mjs`, `/api/peili` |
| lähde, lähdetila | source, source state the adapter posts per device | `lahde.rs`, `lahdetila.rs`, `lahde.mjs` |
| toiminnot | actions (the adapter's action server) | `adapteri/toiminnot/` |
| näkymät | views, derived read models | `nakymat.rs` |
| skooppi | scope: one Claude Code session with its register | everywhere |
| rekisteri | register: a per-scope table of next step, open items and faults | `REKISTERI.md`, `/api/rekisterit` |
| LR | local register, V1's register replication engine | `lr.rs`, `lr_pariteetti.rs` |
| pariteetti | parity (same behaviour as the JavaScript original) | `pariteetti.mjs`, `lr_pariteetti.rs` |
| ikkuna | window: how many days of mirror a node keeps | `--peili-ikkuna-vrk` |
| tila | state; the shared UI state store | `tila.rs`, `Tilasynkka.swift` |
| kuittaus | acknowledgement (highest value wins) | `tila.rs` |
| liite | attachment | `liite.rs` |
| avain | key (the Bearer key) | `Avain.swift`, `--avain` |
| portti | port, and also gate (a verification script); context decides | `gate.sh` |
| aita, pohja | fence, baseline snapshot used by the gate | `gate.sh` |
| ajo | run; "ajo 2" is a second attempt at a task | brief names |
| pakkaa, pura | pack, unpack: hand-over between sessions | `HISTORIA.md` |
